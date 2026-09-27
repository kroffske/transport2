"""T-7 W11: planned-stop line check (off_route with hysteresis), heading, /v1/routes."""

from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from transport_backend.ingest import NDTPServer
from transport_backend.orchestration import Orchestrator
from transport_backend.run import RunRegistry
from transport_backend.schedule import M_PER_DEG_LAT, Schedule
from transport_backend.service import create_app
from transport_backend.state import ClockMapping, Telemetry, TelemetryState
from transport_ml.data import read_plan

DAY = datetime(2026, 1, 6)
LAT = 55.7
NORTH_1KM = 1000 / M_PER_DEG_LAT


def _write_plan(path: Path) -> None:
    rows = [
        # v: an east-west line in the morning.
        "v0,v,2026-01-06 06:00:00,POINT (37.50 55.7)",
        "v1,v,2026-01-06 06:20:00,POINT (37.51 55.7)",
        "v2,v,2026-01-06 06:40:00,POINT (37.52 55.7)",
        "v3,v,2026-01-06 07:00:00,POINT (37.53 55.7)",
        "v4,v,2026-01-06 07:14:00,POINT (10.0 10.0)",  # off the basemap
        "v5,v,2026-01-06 07:15:00,POINT (37.54 55.7)",
        "v6,v,2026-01-06 07:16:00,POINT (37.55 55.7)",
        # late: the day assignment starts in the evening.
        "l0,late,2026-01-06 20:25:00,POINT (37.40 55.8)",
        "l1,late,2026-01-06 20:40:00,POINT (37.41 55.8)",
        # one: a single planned stop cannot form a line.
        "o0,one,2026-01-06 06:50:00,POINT (37.6 55.6)",
    ]
    path.write_text("tt_action_item_id,tr_id,time_begin,geom\n" + "\n".join(rows) + "\n",
                    encoding="utf-8")


def _record(tr_id, unit, event, lon, lat, speed=0.0, heading=0.0, valid=True, request_id=2):
    return Telemetry(unit_id=unit, tr_id=tr_id, event_time=event, receive_time=event,
                     location_valid=valid, lon=lon, lat=lat, speed=speed, heading=heading, alt=0.0,
                     packet_id=str(request_id), session_id="s", request_id=request_id,
                     source_clock="dataset_wall", frame_id=f"{tr_id}:{request_id}",
                     received_at_utc=event)


class _Model:
    def predict(self, request):
        raise AssertionError("no prediction is expected in these fixtures")


@pytest.fixture
def world(tmp_path):
    path = tmp_path / "plan.csv"
    _write_plan(path)
    units = {1: "v", 2: "late", 3: "one", 4: "none"}
    state = TelemetryState(units, source_clock="dataset_wall", stale_after_s=3600)
    for unit in units:
        state.connected(unit, "s")
    now = [DAY + timedelta(hours=6, minutes=30)]
    run = RunRegistry("dataset_wall", units, mapping=ClockMapping(1_700_000_000, DAY),
                      clock=lambda: now[0])
    flow = Orchestrator(state, NDTPServer(state, run=run), Schedule(read_plan(path)), _Model())
    yield flow, state, now
    flow.close()


def _row(flow, tr_id):
    return next(row for row in flow.snapshot()["vehicles"] if row["tr_id"] == tr_id)


def test_distance_to_the_planned_stop_line(tmp_path):
    path = tmp_path / "plan.csv"
    _write_plan(path)
    schedule = Schedule(read_plan(path))
    assert schedule.route_offset_m("v", 37.505, LAT) == pytest.approx(0, abs=0.5)
    assert schedule.route_offset_m("v", 37.515, LAT + NORTH_1KM) == pytest.approx(1000, rel=0.005)
    # Beyond the line's end the distance is to the end point, not to an extension.
    assert schedule.route_offset_m("late", 37.40, 55.8 - NORTH_1KM) == pytest.approx(1000, rel=0.005)
    assert schedule.route_offset_m("one", 37.6, 55.6) is None  # fewer than two stops
    assert schedule.route_offset_m("unknown", 37.6, 55.6) is None


def test_off_route_hysteresis_rounding_and_null_cases(world):
    flow, state, now = world
    positions = [(0, "on"), (1000, "far"), (300, "between"), (200, "back")]
    expected = {"on": (0, False), "far": (1000, True), "between": (300, True), "back": (200, False)}
    for step, (metres, name) in enumerate(positions):
        event = DAY + timedelta(hours=6, minutes=30, seconds=10 * step + 1)
        assert state.accept(_record("v", 1, event.isoformat(" "), 37.515,
                                    LAT + metres / M_PER_DEG_LAT, request_id=step + 2))
        now[0] = event + timedelta(seconds=1)
        row = _row(flow, "v")
        assert (row["route_offset_m"], row["off_route"]) == expected[name], name
        assert row["route_offset_m"] % 10 == 0
    # An invalid latest fix keeps the last valid position for the check.
    assert state.accept(_record("v", 1, "2026-01-06 06:30:50", 0.0, 0.0, valid=False, request_id=9))
    now[0] = DAY + timedelta(hours=6, minutes=30, seconds=51)
    assert _row(flow, "v")["route_offset_m"] == 200
    # No valid position at all, or a plan with < 2 stops: unknown, not "on route".
    none = _row(flow, "none")
    assert (none["route_offset_m"], none["off_route"], none["route_not_started"]) == (None, None, None)
    assert state.accept(_record("one", 3, "2026-01-06 06:30:40", 37.6, 55.6, request_id=10))
    one = _row(flow, "one")
    assert (one["route_offset_m"], one["off_route"]) == (None, None)


def test_route_not_started_only_before_the_first_stop_and_outside_the_window(world):
    flow, state, now = world
    assert _row(flow, "late")["route_not_started"] is True  # first stop 20:25, now 06:30
    assert _row(flow, "v")["route_not_started"] is False
    now[0] = DAY + timedelta(hours=19, minutes=45)  # 20:25 is within now + 45 min
    assert _row(flow, "late")["route_not_started"] is False
    now[0] = DAY + timedelta(hours=23)
    assert _row(flow, "v")["route_not_started"] is False  # finished, not "not started"


def test_heading_from_latest_moving_valid_frame_within_120_s(world):
    flow, state, now = world
    assert _row(flow, "v")["heading"] is None  # no frames
    assert state.accept(_record("v", 1, "2026-01-06 06:30:00", 37.51, LAT, speed=20, heading=91.6))
    assert state.accept(_record("v", 1, "2026-01-06 06:30:30", 37.511, LAT, speed=2,
                                heading=10.0, request_id=3))  # too slow
    assert state.accept(_record("v", 1, "2026-01-06 06:30:40", 0.0, 0.0, speed=30, heading=200.0,
                                valid=False, request_id=4))  # invalid
    now[0] = DAY + timedelta(hours=6, minutes=31)
    assert _row(flow, "v")["heading"] == 92
    now[0] = DAY + timedelta(hours=6, minutes=32, seconds=1)  # moving frame is 121 s old
    assert _row(flow, "v")["heading"] is None


def test_routes_lists_window_lines_of_run_vehicles_with_flags(world):
    flow, state, now = world
    assert state.accept(_record("v", 1, "2026-01-06 06:29:00", 37.515, LAT + NORTH_1KM))
    now[0] = DAY + timedelta(hours=6, minutes=30)
    flow.snapshot()
    view = flow.routes()
    assert view["run_id"] is None  # replay has no run; every mapped vehicle is listed
    assert (view["window_start"], view["window_end"]) == ("2026-01-06T06:15:00", "2026-01-06T07:15:00")
    routes = {route["tr_id"]: route for route in view["routes"]}
    assert set(routes) == {"v", "late", "one", "none"}
    v = routes["v"]
    # 06:20..07:15 inclusive, time ordered; the off-map 07:14 stop is left out; 07:16 is outside.
    assert v["line_times"] == ["06:20:00", "06:40:00", "07:00:00", "07:15:00"]
    assert v["line"] == [[37.51, LAT], [37.52, LAT], [37.53, LAT], [37.54, LAT]]
    assert (v["off_route"], v["route_offset_m"], v["route_not_started"]) == (True, 1000, False)
    assert v["unit_id"] == 1
    assert routes["late"]["line"] == [] and routes["late"]["route_not_started"] is True


def test_routes_http_waits_for_run_then_serves_only_run_vehicles(tmp_path):
    data = tmp_path / "validate"
    data.mkdir()
    _write_plan(data / "schedule_plan.csv")
    (data / "traffic.csv").write_text("unit_id,tr_id\n1,v\n2,late\n", encoding="utf-8")
    api = create_app(data_dir=tmp_path, model_url="http://127.0.0.1:1",
                     source_clock="simulation", ndtp_port=0)
    with TestClient(api) as client:
        assert client.get("/v1/routes").json() == {"run_id": None, "clock_time": None,
                                                   "window_start": None, "window_end": None,
                                                   "routes": []}
        run_id = client.post("/v1/run", json={
            "dataset_start": "2026-01-06T06:30:00", "dataset_end": "2026-01-06T07:30:00",
            "speedup": 1, "post_period_s": 2, "units": [1]}).json()["run_id"]
        client.get("/v1/vehicles")
        view = client.get("/v1/routes").json()
        assert view["run_id"] == run_id
        assert [route["tr_id"] for route in view["routes"]] == ["v"]
        route = view["routes"][0]
        assert set(route) == {"tr_id", "unit_id", "line", "line_times", "off_route",
                              "route_offset_m", "route_not_started"}
        assert route["line_times"][0] == "06:20:00"
        assert (route["off_route"], route["route_offset_m"]) == (None, None)  # no position yet
        row = client.get("/v1/vehicles").json()["vehicles"][0]
        assert {"heading", "off_route", "route_offset_m", "route_not_started"} <= set(row)
