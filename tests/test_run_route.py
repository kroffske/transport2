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
from transport_backend.route_catalog import route_catalog
from transport_backend.orchestration import MAP_BBOX, ModelFailure, Orchestrator, PredictionJob
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
        # v13 is a new target: its job was queued at once; meanwhile the row keeps
        # the whole v12 pair (target and its prediction), never v13 with the v12 value.
        assert model.requests[1]["point"]["target_stop_id"] == "v13"
        assert target["planned_target_stop_id"] == "v13"
        assert target["target_stop_id"] == "v12" and target["prediction_s"] == 150.0
        assert target["target_time_begin"] == "2026-01-06T00:12:00"
        assert (target["target_lon"], target["target_lat"]) == (37.512, 55.7)
        assert target["prediction_state"] == "updating"
        assert target["prediction_held_from_target"] == "v12"
        # W16: holding keeps the level (no green -> yellow -> green blink).
        assert target["status"] == "normal" and target["reason"] is None
        assert target["prediction_hold_reason"] == "target_changed"
        assert target["prediction_updating"] is True and target["alert"] is None
        assert target["last_success_at"] == first["last_success_at"]
        # Holding is quiet: an unchanged held row keeps its revision.
        assert flow.snapshot()["vehicles"][0]["revision"] == target["revision"]
    finally:
        model.release.set()
    # The answer for v13 replaces the held pair.
    current = _wait(lambda: (lambda r: r if r["prediction_state"] == "fresh" else None)(
        flow.snapshot()["vehicles"][0]))
    assert current["target_stop_id"] == "v13" and current["prediction_s"] == 150.0
    assert current["prediction_state"] == "fresh" and current["prediction_held_from_target"] is None
    assert current["planned_target_stop_id"] == "v13"
    assert current["last_success_at"] == "2026-01-06T00:02:31"


def test_held_pair_expires_after_prediction_hold(tmp_path, flows):
    path = tmp_path / "plan.csv"
    _simple_plan(path)
    state = TelemetryState({1: "v"}, source_clock="dataset_wall", stale_after_s=600)
    state.connected(1, "s")
    now = [DAY + timedelta(minutes=1, seconds=30)]
    run = RunRegistry("dataset_wall", state.unit_mapping,
                      mapping=ClockMapping(1_700_000_000, DAY), clock=lambda: now[0])
    server = NDTPServer(state, run=run)
    model = _Model(gate_after=1)
    flow = flows(state, server, Schedule(read_plan(path)), model,
                 predict_interval_s=60, prediction_hold_s=20)
    try:
        assert state.accept(_record(event="2026-01-06 00:01:20", lon=37.501))
        first = _wait(lambda: (lambda r: r if r["status"] == "normal" else None)(
            flow.snapshot()["vehicles"][0]))
        assert first["prediction_state"] == "fresh" and first["target_stop_id"] == "v12"
        now[0] = DAY + timedelta(minutes=2, seconds=31)  # target v13, its answer is gated
        held = flow.snapshot()["vehicles"][0]
        assert held["prediction_state"] == "updating" and held["target_stop_id"] == "v12"
        now[0] = DAY + timedelta(minutes=2, seconds=51)  # 20 s of data: still within the hold
        assert flow.snapshot()["vehicles"][0]["prediction_state"] == "updating"
        now[0] = DAY + timedelta(minutes=2, seconds=52)  # past the hold
        gone = flow.snapshot()["vehicles"][0]
        assert gone["prediction_state"] == "none" and gone["prediction_held_from_target"] is None
        assert gone["target_stop_id"] == gone["planned_target_stop_id"] == "v13"
        assert gone["prediction_s"] is None and gone["last_success_at"] is None
        assert gone["status"] == "degraded" and gone["reason"] == "prediction_pending"
        assert gone["revision"] > held["revision"]
    finally:
        model.release.set()


def test_new_target_job_goes_ahead_of_other_vehicles(tmp_path):
    path = tmp_path / "plan.csv"
    _simple_plan(path)
    state = TelemetryState({1: "v"}, source_clock="dataset_wall")
    run = RunRegistry("dataset_wall", state.unit_mapping,
                      mapping=ClockMapping(1_700_000_000, DAY), clock=lambda: DAY)
    flow = Orchestrator(state, NDTPServer(state, run=run), Schedule(read_plan(path)), _Model())

    def job(tr_id: str) -> PredictionJob:
        return PredictionJob(1, tr_id, DAY, "t", "f", 1, None, 0.0, {})

    with flow._lock:
        flow._queue(job("a"))
        flow._queue(job("b"))
        flow._queue(job("c"), first=True)
        flow._queue(job("b"), first=True)  # coalesced and moved ahead
    assert list(flow._jobs) == ["b", "c", "a"]


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
    plan = read_plan(path)
    flow = flows(state, NDTPServer(state, run=run), Schedule(plan, routes=route_catalog(plan)), _Model(),
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


def test_rows_and_overview_carry_the_derived_route(tmp_path, flows):
    flow, _, _ = _route_flow(tmp_path, flows)
    rows = {v["tr_id"]: v for v in flow.snapshot()["vehicles"]}
    overview = flow.routes()
    assert rows["v"]["route_key"] != rows["w"]["route_key"] and rows["v"]["route_label"] == "—"
    assert {r["tr_id"]: r["route_key"] for r in overview["routes"]} == {t: v["route_key"] for t, v in rows.items()}
    assert sorted(r["tr_ids"] for r in overview["catalog"]) == [["v"], ["w"]]


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


# ----------------------------------------------------- W16: no-flicker rows

def _dataset_flow(tmp_path, flows, rows, **kwargs):
    path = tmp_path / "plan.csv"
    _write_plan(path, rows)
    state = TelemetryState({1: "v"}, source_clock="dataset_wall", stale_after_s=45, reconnect_grace_s=0)
    state.connected(1, "s")
    now = [DAY + timedelta(minutes=1, seconds=30)]
    run = RunRegistry("dataset_wall", state.unit_mapping,
                      mapping=ClockMapping(1_700_000_000, DAY), clock=lambda: now[0])
    model = kwargs.pop("model", _Model())
    flow = flows(state, NDTPServer(state, run=run), Schedule(read_plan(path)), model,
                 predict_interval_s=60, **kwargs)
    return flow, state, now, model


def _row(flow):
    return flow.snapshot()["vehicles"][0]


def test_hold_300_s_covers_target_leaving_the_window_then_none(tmp_path, flows):
    # Stops every minute until 00:12, then a gap until 00:40: at 00:02:31 no stop is 10-15 min ahead.
    flow, state, now, _ = _dataset_flow(
        tmp_path, flows, _stop_rows("v", DAY, 13, 60, "v") + ["late,v,2026-01-06 00:40:00,POINT (37.6 55.7)"])
    assert state.accept(_record(event="2026-01-06 00:01:20", lon=37.501))
    first = _wait(lambda: (lambda r: r if r["prediction_state"] == "fresh" else None)(_row(flow)))
    assert first["target_stop_id"] == "v12" and first["status"] == "normal"
    request = 3
    for minute, second in ((2, 31), (5, 0), (7, 31), (7, 32)):
        now[0] = DAY + timedelta(minutes=minute, seconds=second)
        # Frames keep coming: the vehicle is present, only the forecast is gone.
        assert state.accept(_record(event=now[0].strftime("%Y-%m-%d %H:%M:%S"), lon=37.501,
                                    request_id=request))
        request += 1
        row = _row(flow)
        if (minute, second) != (7, 32):
            assert row["planned_target_stop_id"] is None
            assert row["prediction_state"] == "updating" and row["target_stop_id"] == "v12"
            assert row["prediction_hold_reason"] == "no_target_in_horizon"
            assert (row["status"], row["reason"], row["prediction_s"]) == ("normal", None, 150.0)
            assert row["alert"] is None and row["lost"] is False
    # 00:02:31 + 301 s: the hold is over.
    assert row["prediction_state"] == "none" and row["prediction_s"] is None
    assert (row["status"], row["reason"]) == ("unavailable", "no_target_in_horizon")


def test_hold_covers_pending_and_ml_failure_for_the_new_target(tmp_path, flows):
    class _FailSecond(_Model):
        def predict(self, request):
            response = super().predict(request)
            if len(self.requests) > 1:
                raise ModelFailure("ml_unreachable_or_timeout")
            return response

    flow, state, now, model = _dataset_flow(tmp_path, flows, _stop_rows("v", DAY, 61, 60, "v"),
                                            model=_FailSecond())
    assert state.accept(_record(event="2026-01-06 00:01:20", lon=37.501))
    _wait(lambda: (lambda r: r if r["prediction_state"] == "fresh" else None)(_row(flow)))
    now[0] = DAY + timedelta(minutes=2, seconds=31)  # target v13, its request fails
    assert state.accept(_record(event="2026-01-06 00:02:31", lon=37.501, request_id=3))
    failed = _wait(lambda: (lambda r: r if r["prediction_error"] else None)(_row(flow)))
    assert failed["prediction_error"] == "ml_unreachable_or_timeout"
    assert failed["prediction_state"] == "updating" and failed["target_stop_id"] == "v12"
    assert (failed["status"], failed["reason"]) == ("normal", None)


def test_vehicle_lost_only_after_300_s_without_frames(tmp_path, flows):
    flow, state, now, _ = _dataset_flow(tmp_path, flows, _stop_rows("v", DAY, 61, 60, "v"))
    assert state.accept(_record(event="2026-01-06 00:01:20", lon=37.501))
    _wait(lambda: (lambda r: r if r["prediction_state"] == "fresh" else None)(_row(flow)))
    state.disconnected(1, "s")  # the emulator dropped the unit for a while
    gap = _row(flow)
    assert (gap["connected"], gap["session_connected"], gap["lost"]) == (True, False, False)
    assert gap["reason"] != "disconnected" and gap["prediction_s"] == 150.0
    revision = gap["revision"]
    now[0] = DAY + timedelta(minutes=6, seconds=20)  # 300 s after the last frame
    present = _row(flow)
    assert present["lost"] is False and present["data_age_s"] == 300.0
    assert present["prediction_state"] in {"fresh", "updating"}
    now[0] = DAY + timedelta(minutes=6, seconds=21)
    lost = _row(flow)
    assert (lost["lost"], lost["connected"]) == (True, False)
    assert (lost["status"], lost["reason"]) == ("unavailable", "vehicle_lost")
    assert lost["prediction_s"] is None and lost["prediction_state"] == "none"
    assert lost["revision"] > revision
    # A new frame brings it back.
    state.connected(1, "s")
    assert state.accept(_record(event="2026-01-06 00:06:21", lon=37.506, request_id=9))
    assert _row(flow)["lost"] is False


def test_single_invalid_frame_with_recent_fix_does_not_blink(tmp_path, flows):
    flow, state, now, _ = _dataset_flow(tmp_path, flows, _stop_rows("v", DAY, 61, 60, "v"))
    assert state.accept(_record(event="2026-01-06 00:01:20", lon=37.501))
    first = _wait(lambda: (lambda r: r if r["prediction_state"] == "fresh" else None)(_row(flow)))
    assert state.accept(_record(event="2026-01-06 00:01:29", valid=False, request_id=3))
    row = _row(flow)
    assert row["location_valid"] is False and (row["status"], row["reason"]) == ("normal", None)
    assert row["prediction_s"] == first["prediction_s"]


def test_warming_until_the_first_forecast_and_never_again(tmp_path, flows):
    flow, state, now, _ = _dataset_flow(tmp_path, flows, _stop_rows("v", DAY, 61, 60, "v"),
                                        prediction_hold_s=20)
    # Moving between stops at 00:01:20: on the route, no confident stop yet.
    assert state.accept(_record(event="2026-01-06 00:01:20", lon=37.5015, speed=20.0))
    warming = _row(flow)
    assert warming["prediction_state"] == "warming" and warming["prediction_s"] is None
    assert warming["route_not_started"] is False
    # Next planned stop 00:02 (30 s), a target is already 10-15 min ahead: about 30 s.
    assert warming["warming_eta_s"] == 30
    assert warming["reason"] == "no_confident_observed_stop"
    assert state.accept(_record(event="2026-01-06 00:01:29", lon=37.501, request_id=3))
    now[0] = DAY + timedelta(minutes=1, seconds=30)
    fresh = _wait(lambda: (lambda r: r if r["prediction_state"] == "fresh" else None)(_row(flow)))
    assert fresh["warming_eta_s"] is None
    # After a forecast existed, losing it past the hold is "none", never "warming" again.
    now[0] = DAY + timedelta(minutes=2, seconds=31)
    state.accept(_record(event="2026-01-06 00:02:31", lon=37.5015, speed=20.0, request_id=4))
    _row(flow)
    now[0] = DAY + timedelta(minutes=2, seconds=52)
    assert _row(flow)["prediction_state"] in {"none", "fresh"}
