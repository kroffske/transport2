"""T-7 Backend run: registration, lifecycle, own prediction tick, freshness and route context."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import socket
from threading import Event
import time

import pytest
from fastapi.testclient import TestClient

from scripts.replay_ndtp import handshake
from transport_backend.ingest import NDTPServer
from transport_backend.ndtp import NAV, encode_frame
from transport_backend.orchestration import MAP_BBOX, Orchestrator
from transport_backend.run import RunConflict, RunNotFound, RunPlan, RunRegistry
from transport_backend.schedule import Schedule
from transport_backend.service import create_app
from transport_backend.state import ClockMapping, Telemetry, TelemetryState
from transport_ml.data import read_plan

DAY = datetime(2026, 1, 6)
REPO = Path(__file__).resolve().parents[1]


def _nav(unit: int, seconds: int, request: int, lon: float = 37.5, lat: float = 55.7,
         speed: int = 0, valid: bool = True) -> bytes:
    bits = 0x60 | (0x80 if valid else 0)
    body = bytes((0, 0)) + NAV.pack(seconds, round(lon * 1e7), round(lat * 1e7), bits, 0,
                                    speed, speed, 0, 0, 0, 0, 0)
    return encode_frame(unit, 1, 101, request, body)


def _record(tr_id="v", unit=1, event="2026-01-06 00:01:20", receive=None, lon=37.5, lat=55.7,
            speed=0.0, valid=True, request_id=2, clock="dataset_wall"):
    receive = receive or event
    return Telemetry(unit_id=unit, tr_id=tr_id, event_time=event, receive_time=receive,
                     location_valid=valid, lon=lon, lat=lat, speed=speed, heading=0.0, alt=0.0,
                     packet_id=str(request_id), session_id="s", request_id=request_id,
                     source_clock=clock, frame_id=f"{tr_id}:{request_id}",
                     received_at_utc=receive)


def _stop_rows(tr_id: str, start: datetime, count: int, step_s: int, prefix: str,
               lon0: float = 37.5, lat: float = 55.7) -> list[str]:
    return [f"{prefix}{i},{tr_id},{start + timedelta(seconds=i * step_s):%Y-%m-%d %H:%M:%S},"
            f"POINT ({lon0 + i * 0.001:.6f} {lat})" for i in range(count)]


def _write_plan(path: Path, rows: list[str]) -> None:
    path.write_text("tt_action_item_id,tr_id,time_begin,geom\n" + "\n".join(rows) + "\n",
                    encoding="utf-8")


def _simple_plan(path: Path) -> None:
    # One arrival per minute from 00:00, far enough apart (~64 m) to be unambiguous.
    _write_plan(path, _stop_rows("v", DAY, 61, 60, "v"))


class _Model:
    def __init__(self, gate_after: int | None = None):
        self.requests: list[dict] = []
        self.gate_after = gate_after
        self.release = Event()

    def predict(self, request):
        self.requests.append(request)
        if self.gate_after is not None and len(self.requests) > self.gate_after:
            assert self.release.wait(timeout=5)
        return {"applicability": "supported", "quality": "normal", "prediction_s": 150.0,
                "predicted_arrival": "2026-01-06T00:15:30", "model_version": "test",
                "artifact_sha256": "sha", "reason": None}


@pytest.fixture
def flows():
    created = []

    def create(*args, **kwargs):
        flow = Orchestrator(*args, **kwargs).start()
        created.append(flow)
        return flow

    yield create
    for flow in created:
        flow.close()


def _wait(predicate, timeout=2.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.005)
    raise AssertionError("condition not reached")


# --------------------------------------------------------------- run registry

def test_registry_lifecycle_stall_and_final_states():
    wall = [1_790_000_000.4]
    run = RunRegistry("simulation", {1: "v", 2: "w"}, wall=lambda: wall[0], stall_after_s=30)
    waiting = run.readback()
    assert waiting["state"] == "waiting_driver" and waiting["run_id"] is None
    assert run.clock() is None and run.vehicles() == [] and run.mapping_readback() is None
    with pytest.raises(ValueError, match="unknown unit_id"):
        run.register(RunPlan(DAY, DAY + timedelta(hours=2), 5, 2.0, (9,)))
    with pytest.raises(ValueError, match="post_period_s"):
        run.register(RunPlan(DAY, DAY + timedelta(hours=2), 5, 0.5, (1,)))
    with pytest.raises(ValueError, match="post_period_s"):
        run.register(RunPlan(DAY, DAY + timedelta(hours=2), 5, 6.0, (1,)))
    with pytest.raises(ValueError, match="speedup"):
        run.register(RunPlan(DAY, DAY + timedelta(hours=2), 101, 2.0, (1,)))
    registered = run.register(RunPlan(DAY, DAY + timedelta(hours=2), 5, 2.0, (1,),
                                      {1: ((37.5, 55.7), (37.51, 55.71))}))
    run_id = registered["run_id"]
    assert run_id.startswith("run-")
    assert registered["clock_mapping"] == {"epoch_origin": 1_790_000_000,
                                           "dataset_origin": "2026-01-06T00:00:00", "rate": 5}
    with pytest.raises(RunConflict) as conflict:
        run.register(RunPlan(DAY, DAY + timedelta(hours=2), 5, 2.0, (1,)))
    assert conflict.value.detail == "run_already_registered" and conflict.value.run_id == run_id
    # A second driver with other (even invalid) parameters is still a conflict, not a bad request.
    with pytest.raises(RunConflict):
        run.register(RunPlan(DAY, DAY + timedelta(hours=2), 500, 9.0, (9,)))
    assert run.vehicles() == [(1, "v")]
    assert run.path(1) == [[37.5, 55.7], [37.51, 55.71]]
    assert run.readback()["state"] == "starting"
    wall[0] += 12
    assert run.clock() == DAY + timedelta(seconds=62)
    view = run.readback()
    assert view["dataset_time"] == "2026-01-06T00:01:02"
    assert view["progress"] == round(62 / 7200, 4)
    run.frame_accepted()
    assert run.readback()["state"] == "running"
    wall[0] += 30.5
    assert run.readback()["state"] == "stalled"
    run.frame_accepted()
    assert run.readback()["state"] == "running"
    with pytest.raises(RunNotFound):
        run.report("run-other", "running", thinned_ratio=0.3, repeat_ratio=0.1)
    heartbeat = run.report(run_id, "running", thinned_ratio=0.3, repeat_ratio=0.1,
                           counters={"posts": 7})
    assert heartbeat["state"] == "running" and heartbeat["thinned_ratio"] == 0.3
    assert heartbeat["driver"]["counters"] == {"posts": 7}
    assert heartbeat["driver"]["reported_at_utc"] == datetime.fromtimestamp(wall[0], timezone.utc).replace(tzinfo=None).isoformat()
    assert run.report(run_id, "completed", thinned_ratio=0.31, repeat_ratio=0.1)["state"] == "completed"
    wall[0] += 3600  # the source clock runs on past the window
    final = run.readback()
    assert final["state"] == "completed"  # final: never becomes stalled
    assert final["dataset_time"] == "2026-01-06T02:00:00" and final["progress"] == 1.0
    assert run.clock() > DAY + timedelta(hours=2)
    with pytest.raises(RunConflict):
        run.report(run_id, "failed", thinned_ratio=0.3, repeat_ratio=0.1)


def test_registry_starting_without_frames_stalls_and_replay_has_no_run():
    wall = [100.0]
    run = RunRegistry("simulation", {1: "v"}, wall=lambda: wall[0], stall_after_s=30)
    run.register(RunPlan(DAY, DAY + timedelta(hours=1), 1, 1.0, (1,)))
    wall[0] += 31
    assert run.readback()["state"] == "stalled"
    replay = RunRegistry("dataset_wall", {1: "v", 2: "w"},
                         mapping=ClockMapping(1_700_000_000, DAY), clock=lambda: DAY)
    assert replay.readback() is None
    assert replay.vehicles() == [(1, "v"), (2, "w")]
    with pytest.raises(RunConflict, match="simulation"):
        replay.register(RunPlan(DAY, DAY + timedelta(hours=1), 1, 1.0, (1,)))


def test_map_bbox_matches_bundled_basemap_manifest():
    coverage = json.loads((REPO / "consumer/map/manifest.json").read_text())["coverage"]
    bbox = coverage.split("bbox ")[1].split(";")[0]
    assert tuple(float(x) for x in bbox.split(",")) == MAP_BBOX


# ------------------------------------------------------------ service (HTTP)

def _sim_app(tmp_path: Path):
    data = tmp_path / "validate"
    data.mkdir()
    _simple_plan(data / "schedule_plan.csv")
    (data / "traffic.csv").write_text("unit_id,tr_id\n1,v\n2,w\n", encoding="utf-8")
    return create_app(data_dir=tmp_path, model_url="http://127.0.0.1:1",
                      source_clock="simulation", ndtp_port=0)


def test_simulation_service_waits_for_driver_registers_once_and_serves_run_vehicles(tmp_path):
    with TestClient(_sim_app(tmp_path)) as client:
        assert client.app.state.backend.orchestrator.tick_interval_s == 1.0
        ready = client.get("/ready").json()
        assert ready["clock_mapping"] is None
        assert ready["run"]["state"] == "waiting_driver"
        waiting = client.get("/v1/vehicles")
        assert waiting.status_code == 200
        body = waiting.json()
        assert body["run"]["state"] == "waiting_driver" and body["run"]["run_id"] is None
        assert body["vehicles"] == [] and body["clock_time"] is None
        assert client.get("/v1/route/v").status_code == 404
        address = (ready["ndtp_host"], ready["ndtp_port"])
        with socket.create_connection(address) as sock:
            sock.sendall(handshake(1) + _nav(1, int(time.time()), 2))
            counters = _wait(lambda: (lambda c: c if c.get("rejected_no_run") else None)(
                client.get("/v1/ingest").json()["counters"]))
            assert counters.get("accepted", 0) == 0 and counters["connections"] == 1
            assert client.get("/v1/vehicles").json()["ingest"]["rejected_no_run"] == 1

            plan = {"dataset_start": "2026-01-06T00:05:00", "dataset_end": "2026-01-06T00:35:00",
                    "speedup": 5, "post_period_s": 2, "units": [1],
                    "path": {"1": [[37.5, 55.7], [37.501, 55.7]]}}
            assert client.post("/v1/run", json={**plan, "units": [9]}).status_code == 422
            assert client.post("/v1/run", json={**plan, "post_period_s": 0.5}).status_code == 422
            assert client.post("/v1/run", json={**plan, "post_period_s": 6}).status_code == 422
            assert client.post("/v1/run", json={**plan, "dataset_end": "2026-01-06T00:04:00"}).status_code == 422
            created = client.post("/v1/run", json=plan)
            assert created.status_code == 201
            run_id = created.json()["run_id"]
            assert created.json()["clock_mapping"]["rate"] == 5
            assert created.json()["clock_mapping"]["dataset_origin"] == "2026-01-06T00:05:00"
            second = client.post("/v1/run", json=plan)
            assert second.status_code == 409
            assert second.json() == {"detail": "run_already_registered", "run_id": run_id}
            other = client.post("/v1/run", json={**plan, "units": [9], "speedup": 500})
            assert other.status_code == 409 and other.json()["run_id"] == run_id
            ready = client.get("/ready").json()
            assert ready["run"]["run_id"] == run_id and ready["run"]["state"] == "starting"
            assert ready["clock_mapping"]["rate"] == 5

            snapshot = client.get("/v1/vehicles").json()
            assert [row["tr_id"] for row in snapshot["vehicles"]] == ["v"]  # only run units
            assert snapshot["run"]["speedup"] == 5 and snapshot["run"]["source"] == "official_emulator"
            assert snapshot["run"]["dataset_time"] == snapshot["clock_time"]
            assert "scenario_label" not in snapshot

            sock.sendall(_nav(1, int(time.time()), 3, speed=20))
            running = _wait(lambda: (lambda r: r if r["run"]["state"] == "running" else None)(
                client.get("/v1/vehicles").json()))
            assert running["run"]["accepted_frames"] == 1
            row = running["vehicles"][0]
            assert row["location_valid"] and row["target_lon"] is not None
            heartbeat = client.post(f"/v1/run/{run_id}/state", json={
                "state": "running", "thinned_ratio": 0.3, "repeat_ratio": 0.05,
                "counters": {"posts": 3}})
            assert heartbeat.status_code == 200
            assert client.get("/v1/vehicles").json()["run"]["thinned_ratio"] == 0.3
            assert client.post("/v1/run/run-x/state", json={
                "state": "running", "thinned_ratio": 0, "repeat_ratio": 0}).status_code == 404

            route = _wait(lambda: (lambda r: r.json() if r.status_code == 200 else None)(
                client.get("/v1/route/v")))
            assert route["run_id"] == run_id
            # The pre-registration frame never became run telemetry.
            assert len(route["passed"]) == 1
            assert route["path"] == [[37.5, 55.7], [37.501, 55.7]]
            assert client.get("/v1/route/w").status_code == 404  # not in the run
            assert client.get("/v1/route/nope").status_code == 404

            done = client.post(f"/v1/run/{run_id}/state", json={
                "state": "completed", "thinned_ratio": 0.31, "repeat_ratio": 0.05})
            assert done.status_code == 200 and done.json()["state"] == "completed"
            assert client.get("/v1/vehicles").json()["run"]["state"] == "completed"
            assert client.post(f"/v1/run/{run_id}/state", json={
                "state": "failed", "thinned_ratio": 0, "repeat_ratio": 0}).status_code == 409


def test_run_endpoint_refused_outside_simulation(tmp_path):
    data = tmp_path / "validate"
    data.mkdir()
    _simple_plan(data / "schedule_plan.csv")
    (data / "traffic.csv").write_text("unit_id,tr_id\n1,v\n", encoding="utf-8")
    api = create_app(data_dir=tmp_path, model_url="http://127.0.0.1:1",
                     source_clock="dataset_wall", ndtp_port=0)
    with TestClient(api) as client:
        # Replay is advanced frame by frame; no background prediction tick.
        assert client.app.state.backend.orchestrator.tick_interval_s is None
        response = client.post("/v1/run", json={
            "dataset_start": "2026-01-06T00:05:00", "dataset_end": "2026-01-06T00:35:00",
            "speedup": 1, "post_period_s": 2, "units": [1]})
        assert response.status_code == 409
        assert response.json()["detail"] == "run_requires_simulation_clock"
        assert client.get("/v1/vehicles").json()["run"] is None


# -------------------------------------------------------- tick and freshness

def test_predictions_are_enqueued_by_own_tick_without_snapshot_polling(tmp_path, flows):
    path = tmp_path / "plan.csv"
    _simple_plan(path)
    wall = [1_790_000_000.0]
    state = TelemetryState({1: "v"}, source_clock="simulation")
    run = RunRegistry("simulation", state.unit_mapping, wall=lambda: wall[0])
    server = NDTPServer(state, run=run)
    schedule = Schedule(read_plan(path))
    model = _Model()
    flow = flows(state, server, schedule, model, predict_interval_s=60, tick_interval_s=0.02)
    time.sleep(0.1)
    # Before registration the tick never consults the schedule nor calls the model.
    assert model.requests == [] and schedule.counters()["stop_seen_frame_count"] == 0
    state.connected(1, "s")
    # Vehicle stands at the 00:01 stop at 00:01:20: deviation +20 s.
    assert state.accept(_record(event="2026-01-06 00:01:20", lon=37.501, clock="simulation"))
    run.register(RunPlan(DAY + timedelta(minutes=1, seconds=30), DAY + timedelta(hours=1), 1, 2.0, (1,)))
    _wait(lambda: model.requests)
    point = model.requests[0]["point"]
    assert point["cur_dev_s"] == 20.0 and point["target_stop_id"] == "v12"
    _wait(lambda: flow.processing_readback()["ml_succeeded"] >= 1)


def test_fresh_prediction_stays_normal_updating_then_target_change_and_aging(tmp_path, flows):
    path = tmp_path / "plan.csv"
    _simple_plan(path)
    state = TelemetryState({1: "v"}, source_clock="dataset_wall", stale_after_s=600)
    state.connected(1, "s")
    now = [DAY + timedelta(minutes=1, seconds=30)]
    run = RunRegistry("dataset_wall", state.unit_mapping,
                      mapping=ClockMapping(1_700_000_000, DAY), clock=lambda: now[0])
    server = NDTPServer(state, run=run)
    model = _Model(gate_after=1)
    flow = flows(state, server, Schedule(read_plan(path)), model, predict_interval_s=60)
    try:
        assert state.accept(_record(event="2026-01-06 00:01:20", lon=37.501))
        first = _wait(lambda: (lambda r: r if r["status"] == "normal" else None)(
            flow.snapshot()["vehicles"][0]))
        assert first["target_stop_id"] == "v12" and first["prediction_updating"] is False
        assert (first["target_lon"], first["target_lat"]) == (37.512, 55.7)
        # A new frame for the same target: the success is younger than 90 s of data.
        assert state.accept(_record(event="2026-01-06 00:01:40", lon=37.52, speed=20.0, request_id=3))
        now[0] = DAY + timedelta(minutes=1, seconds=45)
        same = flow.snapshot()["vehicles"][0]
        assert same["status"] == "normal" and same["reason"] is None
        assert same["prediction_updating"] is True and same["prediction_s"] == 150.0
        assert len(model.requests) == 1  # not due yet: interval not elapsed
        # The target moves on to v13 (00:13 is now within the 10-15 min horizon).
        now[0] = DAY + timedelta(minutes=2, seconds=31)
        target = flow.snapshot()["vehicles"][0]
        _wait(lambda: len(model.requests) == 2)
        assert target["target_stop_id"] == "v13"
        # v13 is a new target: the v12 value is not shown for it; a job was queued at once.
        assert target["status"] == "degraded" and target["reason"] == "prediction_pending"
        assert target["prediction_s"] is None
        assert model.requests[1]["point"]["target_stop_id"] == "v13"
    finally:
        model.release.set()
    current = _wait(lambda: (lambda r: r if r["status"] == "normal" else None)(
        flow.snapshot()["vehicles"][0]))
    assert current["target_stop_id"] == "v13" and current["prediction_s"] == 150.0


def test_prediction_older_than_fresh_window_degrades_as_aging(tmp_path, flows):
    path = tmp_path / "plan.csv"
    # Sparse plan: the target stays the same for several minutes.
    _write_plan(path, _stop_rows("v", DAY, 2, 60, "v")
                + ["far,v,2026-01-06 00:15:00,POINT (37.6 55.7)"])
    state = TelemetryState({1: "v"}, source_clock="dataset_wall", stale_after_s=600)
    state.connected(1, "s")
    now = [DAY + timedelta(minutes=1, seconds=30)]
    run = RunRegistry("dataset_wall", state.unit_mapping,
                      mapping=ClockMapping(1_700_000_000, DAY), clock=lambda: now[0])
    model = _Model(gate_after=1)
    flow = flows(state, NDTPServer(state, run=run), Schedule(read_plan(path)), model,
                 predict_interval_s=60)
    try:
        assert state.accept(_record(event="2026-01-06 00:01:20", lon=37.501))
        first = _wait(lambda: (lambda r: r if r["status"] == "normal" else None)(
            flow.snapshot()["vehicles"][0]))
        assert first["target_stop_id"] == "far"
        now[0] = DAY + timedelta(minutes=2, seconds=59)  # age 89 s: fresh
        assert state.accept(_record(event="2026-01-06 00:02:50", lon=37.55, speed=20.0, request_id=3))
        fresh = flow.snapshot()["vehicles"][0]
        assert fresh["status"] == "normal" and fresh["prediction_updating"] is True
        now[0] = DAY + timedelta(minutes=3, seconds=1)  # age 91 s > 1.5 x 60 s
        aged = flow.snapshot()["vehicles"][0]
        assert aged["status"] == "degraded" and aged["reason"] == "prediction_aging"
        assert aged["prediction_s"] == 150.0 and aged["prediction_age_s"] == 91.0
    finally:
        model.release.set()


# ---------------------------------------------------------------- route

def _route_flow(tmp_path, flows):
    path = tmp_path / "plan.csv"
    rows = (_stop_rows("v", DAY, 61, 60, "v")
            + ["nocoord,v,2026-01-06 00:05:30,", "outside,v,2026-01-06 00:07:30,POINT (10.0 10.0)"]
            + _stop_rows("w", DAY, 240, 15, "w", lon0=37.3, lat=55.9))
    _write_plan(path, rows)
    state = TelemetryState({1: "v", 2: "w"}, source_clock="dataset_wall")
    state.connected(1, "s")
    state.connected(2, "s")
    now = [DAY + timedelta(minutes=6)]
    run = RunRegistry("dataset_wall", state.unit_mapping,
                      mapping=ClockMapping(1_700_000_000, DAY), clock=lambda: now[0])
    flow = flows(state, NDTPServer(state, run=run), Schedule(read_plan(path)), _Model(),
                 predict_interval_s=60)
    # Observed at the 00:01 stop (+20 s), then moving; one invalid fix.
    assert state.accept(_record(event="2026-01-06 00:01:20", lon=37.501))
    assert state.accept(_record(event="2026-01-06 00:03:00", lon=37.503, speed=25.0, request_id=3))
    assert state.accept(_record(event="2026-01-06 00:04:00", lon=0.0, lat=0.0, valid=False,
                                speed=0.0, request_id=4))
    assert state.accept(_record(event="2026-01-06 00:05:50", lon=37.5055, speed=25.0, request_id=5))
    return flow, state, now


def test_route_uses_snapshot_row_windows_stops_roles_and_counts_dropped(tmp_path, flows):
    flow, _, _ = _route_flow(tmp_path, flows)
    row = _wait(lambda: (lambda r: r if r["prediction_s"] is not None else None)(
        next(v for v in flow.snapshot()["vehicles"] if v["tr_id"] == "v")))
    route = flow.route("v")
    assert route["vehicle_revision"] == row["revision"]
    assert route["target_stop_id"] == row["target_stop_id"] == "v17"
    assert route["prediction_s"] == row["prediction_s"] == 150.0
    assert route["cur_dev_s"] == row["cur_dev_s"] == 20.0
    assert route["model_version"] == "test" and route["artifact_sha256"] == "sha"
    stops = route["stops"]
    # Window [00:01, 00:32]: 32 plan stops; the empty-geometry and off-map stops are dropped.
    assert [s["stop_id"] for s in stops] == [f"v{i}" for i in range(1, 33)]
    assert route["stops_dropped"] == 2 and route["stops_truncated"] == 0
    roles = {s["stop_id"]: s["role"] for s in stops}
    assert roles["v1"] == "passed"  # detector observation
    assert roles["v5"] == "passed"  # plan + 20 s < 00:06
    assert roles["v6"] == "before_target"  # 00:06:20 is still ahead
    assert roles["v16"] == "before_target" and roles["v17"] == "target"
    assert roles["v18"] == roles["v32"] == "after_target"
    assert stops[16]["time"] == "00:17:00" and (stops[16]["lon"], stops[16]["lat"]) == (37.517, 55.7)
    # Only valid GPS, labelled by event time.
    assert route["passed"] == [[37.501, 55.7, "00:01:20"], [37.503, 55.7, "00:03:00"],
                               [37.5055, 55.7, "00:05:50"]]


def test_route_keeps_target_when_more_than_forty_stops_and_planned_without_target(tmp_path, flows):
    flow, _, now = _route_flow(tmp_path, flows)
    flow.snapshot()
    dense = flow.route("w")
    stops = dense["stops"]
    assert len(stops) == 40
    assert dense["target_stop_id"] is not None
    assert stops[-1]["role"] == "after_target"
    assert [s["stop_id"] for s in stops if s["role"] == "target"] == [dense["target_stop_id"]]
    # Window [00:01:00, 00:31:15] holds w4..w125 (122 stops, every 15 s); the target is
    # w65 (00:16:15). Overflow 82 drops the earliest non-target stops: w4..w64, w66..w86.
    assert dense["target_stop_id"] == "w65"
    assert [s["stop_id"] for s in stops] == ["w65"] + [f"w{i}" for i in range(87, 126)]
    assert dense["stops_truncated"] == 82 and dense["stops_dropped"] == 0
    # After the plan ends there is no target: the remaining window is plain "planned".
    now[0] = DAY + timedelta(minutes=50)
    flow.snapshot()
    late = flow.route("v")
    assert late["target_stop_id"] is None
    assert {s["role"] for s in late["stops"]} <= {"passed", "planned"}
    assert "planned" in {s["role"] for s in late["stops"]}
    with pytest.raises(LookupError):
        flow.route("unknown")
