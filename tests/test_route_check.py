"""T-7 W11: planned-stop line check (off_route with hysteresis), heading, /v1/routes."""

from __future__ import annotations

from datetime import datetime, timedelta
import json
import math
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from transport_backend.ingest import NDTPServer
from transport_backend.orchestration import Orchestrator
from transport_backend.route_shapes import parse_route_shapes
from transport_backend.run import RunRegistry
from transport_backend.schedule import M_PER_DEG_LAT, M_PER_DEG_LON_EQUATOR, Schedule
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
        assert set(route) == {"tr_id", "unit_id", "line", "line_times", "line_shape", "off_route",
                              "route_offset_m", "route_not_started"}
        assert route["line_times"][0] == "06:20:00"
        assert route["line_shape"] == "straight"  # no data/routes/route_shapes.json
        assert (route["off_route"], route["route_offset_m"]) == (None, None)  # no position yet
        row = client.get("/v1/vehicles").json()["vehicles"][0]
        assert {"heading", "off_route", "route_offset_m", "route_not_started"} <= set(row)


# ------------------------------------------------ vehicle point on the window line

def test_route_line_splits_at_projection_or_explains_why_not(world):
    flow, state, now = world
    fifty_north = LAT + 50 / M_PER_DEG_LAT
    assert state.accept(_record("v", 1, "2026-01-06 06:29:50", 37.515, fifty_north, speed=20))
    assert state.accept(_record("late", 2, "2026-01-06 06:29:50", 37.405, 55.8, request_id=3))
    now[0] = DAY + timedelta(hours=6, minutes=30)
    flow.snapshot()
    view = flow.route("v")["route_line"]
    assert view["split_reason"] == "on_route"
    assert view["split"] == pytest.approx([37.515, LAT])
    line = [[37.51, LAT], [37.52, LAT], [37.53, LAT], [37.54, LAT]]  # same as /v1/routes
    assert view["line"] == line == flow.routes()["routes"][0]["line"]
    assert view["passed"][:-1] == line[:1] and view["passed"][-1] == view["split"]
    assert view["ahead"][0] == view["split"] and view["ahead"][1:] == line[1:]
    # No position, and a vehicle whose planned line lies outside the window.
    assert flow.route("none")["route_line"]["split_reason"] == "no_position"
    late = flow.route("late")["route_line"]
    assert late["split_reason"] == "no_segment" and late["split"] is None and late["line"] == []
    assert late["nearest"] == pytest.approx([37.405, 55.8])  # on the whole-day line
    # Far off the assignment: no split, only the nearest point for a leader line.
    assert state.accept(_record("v", 1, "2026-01-06 06:30:10", 37.515, LAT + NORTH_1KM, request_id=4))
    now[0] = DAY + timedelta(hours=6, minutes=30, seconds=11)
    flow.snapshot()
    off = flow.route("v")["route_line"]
    assert off["split_reason"] == "off_route"
    assert (off["passed"], off["ahead"], off["split"]) == ([], [], None)
    assert off["nearest"] == pytest.approx([37.515, LAT])


class _Unavailable:
    def predict(self, request):
        return {"applicability": "unavailable", "quality": "unavailable", "reason": "test",
                "model_version": "t", "artifact_sha256": "t", "prediction_s": None}


@pytest.fixture
def line_world(tmp_path):
    path = tmp_path / "plan.csv"
    out_and_back = [("A", "06:20", 37.50), ("B", "06:30", 37.51), ("C", "06:40", 37.52),
                    ("B2", "06:50", 37.51), ("A2", "07:00", 37.50), ("B3", "07:10", 37.51)]
    rows = [f"{name},ob,2026-01-06 {time}:00,POINT ({lon} {LAT})" for name, time, lon in out_and_back]
    # Stops every 2 minutes, 126 m apart, for a vehicle running 12 minutes late.
    rows += [f"s{i},slow,{DAY + timedelta(hours=6, minutes=2 * i):%Y-%m-%d %H:%M:%S},"
             f"POINT ({37.50 + 0.002 * i:.3f} {LAT})" for i in range(41)]
    path.write_text("tt_action_item_id,tr_id,time_begin,geom\n" + "\n".join(rows) + "\n",
                    encoding="utf-8")
    units = {1: "ob", 2: "slow"}
    state = TelemetryState(units, source_clock="dataset_wall", stale_after_s=3600)
    for unit in units:
        state.connected(unit, "s")
    now = [DAY + timedelta(hours=6, minutes=25)]
    run = RunRegistry("dataset_wall", units, mapping=ClockMapping(1_700_000_000, DAY),
                      clock=lambda: now[0])
    flow = Orchestrator(state, NDTPServer(state, run=run), Schedule(read_plan(path)), _Unavailable())
    yield flow, state, now
    flow.close()


def test_out_and_back_line_splits_on_the_current_trip(line_world):
    flow, state, now = line_world
    assert state.accept(_record("ob", 1, "2026-01-06 06:24:50", 37.505, LAT, speed=20))
    flow.snapshot()
    outbound = flow.route("ob")["route_line"]
    # 37.505 lies on A->B (06:20-06:30) and on B2->A2 (06:50-07:00); only the first is due.
    assert outbound["split"] == pytest.approx([37.505, LAT])
    assert outbound["passed"][:-1] == [[37.50, LAT]]
    assert outbound["ahead"][1:] == [[37.51, LAT], [37.52, LAT], [37.51, LAT], [37.50, LAT], [37.51, LAT]]
    assert state.accept(_record("ob", 1, "2026-01-06 06:54:50", 37.505, LAT, speed=20, request_id=3))
    now[0] = DAY + timedelta(hours=6, minutes=55)
    flow.snapshot()
    inbound = flow.route("ob")["route_line"]
    # Window now starts at C; B2->A2 and A2->B3 both cover 37.505: the one due now wins.
    assert inbound["line"][0] == [37.52, LAT]
    assert inbound["passed"][:-1] == [[37.52, LAT], [37.51, LAT]]
    assert inbound["ahead"][1:] == [[37.50, LAT], [37.51, LAT]]


def test_split_interval_follows_the_observed_delay(line_world):
    flow, state, now = line_world
    # Standing at s5 (planned 06:10) at 06:22: 12 minutes late.
    assert state.accept(_record("slow", 2, "2026-01-06 06:22:00", 37.510, LAT, speed=0))
    assert state.accept(_record("slow", 2, "2026-01-06 06:24:00", 37.511, LAT, speed=20, request_id=3))
    flow.snapshot()
    row = next(r for r in flow.snapshot()["vehicles"] if r["tr_id"] == "slow")
    assert row["cur_dev_s"] == 720.0
    view = flow.route("slow")["route_line"]
    # s5->s6 (06:10-06:12) is outside [06:15, 06:45] but inside the delay-shifted interval.
    assert view["split_reason"] == "on_route"
    assert view["split"] == pytest.approx([37.511, LAT])
    assert view["passed"] == [[37.510, LAT], view["split"]]


def test_off_route_leader_exists_when_the_display_window_is_empty(world):
    flow, state, now = world
    # Like 130072: the assignment starts at 20:25, the vehicle is 1 km away at 06:30.
    assert state.accept(_record("late", 2, "2026-01-06 06:29:50", 37.405, 55.8 - NORTH_1KM))
    flow.snapshot()
    row = _row(flow, "late")
    view = flow.route("late")["route_line"]
    assert view["line"] == [] and view["split_reason"] == "off_route"
    assert view["off_route"] is row["off_route"] is True
    assert view["route_offset_m"] == row["route_offset_m"] == 1000
    assert view["nearest"] == pytest.approx([37.405, 55.8], abs=1e-6)
    # The leader length is the reported offset.
    position = (row["lon"], row["lat"])
    dx = (view["nearest"][0] - position[0]) * M_PER_DEG_LON_EQUATOR * math.cos(math.radians(position[1]))
    dy = (view["nearest"][1] - position[1]) * M_PER_DEG_LAT
    assert math.hypot(dx, dy) == pytest.approx(view["route_offset_m"], abs=10)
    none = flow.route("none")["route_line"]  # no plan and no position
    assert (none["nearest"], none["off_route"], none["route_offset_m"]) == (None, None, None)


# ------------------------------------------------------------ road shapes (W14)

# v1 -> v2 drives around a block 1 km north instead of the straight 626 m.
DETOUR = [[37.51, LAT], [37.51, LAT + NORTH_1KM], [37.52, LAT + NORTH_1KM], [37.52, LAT]]
SHAPES_RAW = {"v": {"segments": [
    {"from_stop": "v1", "to_stop": "v2", "coords": DETOUR, "source": "gps", "n": 3},
    # Not a consecutive plan pair: never used.
    {"from_stop": "v0", "to_stop": "v2", "coords": [[37.50, LAT], [37.40, 55.0], [37.52, LAT]],
     "source": "gps", "n": 1}], "built_from": ["2026-01-06"], "sha": "x"}}


@pytest.fixture
def shaped_world(tmp_path):
    path = tmp_path / "plan.csv"
    _write_plan(path)
    units = {1: "v", 2: "late"}
    state = TelemetryState(units, source_clock="dataset_wall", stale_after_s=3600)
    for unit in units:
        state.connected(unit, "s")
    now = [DAY + timedelta(hours=6, minutes=30)]
    run = RunRegistry("dataset_wall", units, mapping=ClockMapping(1_700_000_000, DAY),
                      clock=lambda: now[0])
    schedule = Schedule(read_plan(path), shapes=parse_route_shapes(SHAPES_RAW))
    flow = Orchestrator(state, NDTPServer(state, run=run), schedule, _Model())
    yield flow, state, now
    flow.close()


def test_whole_day_line_follows_road_shape_between_consecutive_stops(tmp_path):
    path = tmp_path / "plan.csv"
    _write_plan(path)
    shaped = Schedule(read_plan(path), shapes=parse_route_shapes(SHAPES_RAW))
    straight = Schedule(read_plan(path))
    # On the detour: on the road line, 1 km off the straight one.
    assert shaped.route_offset_m("v", 37.515, LAT + NORTH_1KM) == pytest.approx(0, abs=0.5)
    assert straight.route_offset_m("v", 37.515, LAT + NORTH_1KM) == pytest.approx(1000, rel=0.005)
    # The straight v1 -> v2 chord is gone: nearest are the detour's legs 0.005 deg
    # (~314 m) away; the whole-day projection uses the plan's mean latitude, which
    # the off-map (10, 10) stop skews, hence the loose bound.
    assert 300 < shaped.route_offset_m("v", 37.515, LAT) < 400
    lon, lat, _ = shaped.route_nearest("v", 37.515, LAT + NORTH_1KM + 0.0001)
    assert (lon, lat) == pytest.approx((37.515, LAT + NORTH_1KM))
    # Pairs without a shape (and the non-consecutive v0 -> v2) stay straight.
    assert shaped.route_offset_m("v", 37.505, LAT) == pytest.approx(0, abs=0.5)
    assert shaped.has_shapes("v") and not shaped.has_shapes("late")


def test_window_line_and_split_follow_the_road_shape(shaped_world):
    flow, state, now = shaped_world
    assert state.accept(_record("v", 1, "2026-01-06 06:29:50", 37.515, LAT + NORTH_1KM, speed=20))
    row = next(row for row in flow.snapshot()["vehicles"] if row["tr_id"] == "v")
    assert (row["off_route"], row["route_offset_m"]) == (False, 0)
    routes = {route["tr_id"]: route for route in flow.routes()["routes"]}
    line = DETOUR + [[37.53, LAT], [37.54, LAT]]
    assert routes["v"]["line"] == line and routes["v"]["line_shape"] == "road"
    # Planned times stay on the stop anchors; shape points in between carry none.
    assert routes["v"]["line_times"] == ["06:20:00", None, None, "06:40:00", "07:00:00", "07:15:00"]
    assert routes["late"]["line_shape"] == "straight"
    view = flow.route("v")["route_line"]
    assert view["line"] == line and view["line_shape"] == "road"
    assert view["split_reason"] == "on_route"
    assert view["split"] == pytest.approx([37.515, LAT + NORTH_1KM])
    assert view["passed"][:-1] == DETOUR[:2] and view["passed"][-1] == view["split"]
    assert view["ahead"][0] == view["split"] and view["ahead"][1:] == line[2:]
    assert view["nearest"] == pytest.approx([37.515, LAT + NORTH_1KM])
    assert view["off_route"] is False and view["route_offset_m"] == 0


def test_service_loads_route_shapes_from_the_data_dir(tmp_path):
    data = tmp_path / "validate"
    data.mkdir()
    _write_plan(data / "schedule_plan.csv")
    (data / "traffic.csv").write_text("unit_id,tr_id\n1,v\n", encoding="utf-8")
    (tmp_path / "routes").mkdir()
    (tmp_path / "routes" / "route_shapes.json").write_text(json.dumps(SHAPES_RAW), encoding="utf-8")
    api = create_app(data_dir=tmp_path, model_url="http://127.0.0.1:1",
                     source_clock="simulation", ndtp_port=0)
    with TestClient(api) as client:
        client.post("/v1/run", json={
            "dataset_start": "2026-01-06T06:30:00", "dataset_end": "2026-01-06T07:30:00",
            "speedup": 1, "post_period_s": 2, "units": [1]})
        client.get("/v1/vehicles")
        route = client.get("/v1/routes").json()["routes"][0]
        assert route["line_shape"] == "road"
        assert route["line"][:4] == DETOUR


# ------------------------------------------------------------- GPS hints

def test_gps_suspect_no_plan_out_of_map_and_far_from_route(world):
    flow, state, now = world
    now[0] = DAY + timedelta(hours=6, minutes=30)
    assert state.accept(_record("v", 1, "2026-01-06 06:29:00", 37.515, LAT))
    assert state.accept(_record("none", 4, "2026-01-06 06:29:50", 37.6, 55.7))
    assert state.accept(_record("late", 2, "2026-01-06 06:29:50", 37.1, 56.1))
    assert state.accept(_record("one", 3, "2026-01-06 06:29:50", 37.6, 55.6 + NORTH_1KM))
    rows = {row["tr_id"]: row for row in flow.snapshot()["vehicles"]}
    assert (rows["v"]["gps_suspect"], rows["v"]["gps_suspect_text"]) == (None, None)
    assert rows["none"]["gps_suspect"] == "no_plan"
    assert rows["none"]["gps_suspect_text"] == "Нет наряда в плане: маршрут и прогноз не строятся"
    assert rows["late"]["gps_suspect"] == "out_of_map"  # also far from its line: map wins
    # "one" has a single stop, so no line and no off-route flag: nothing to hint.
    assert rows["one"]["gps_suspect"] is None
    assert state.accept(_record("v", 1, "2026-01-06 06:29:55", 37.515, LAT + NORTH_1KM, request_id=3))
    far = next(row for row in flow.snapshot()["vehicles"] if row["tr_id"] == "v")
    assert far["off_route"] is True and far["gps_suspect"] == "far_from_route"


def test_gps_suspect_jump_expires_and_no_fix_leaves_status_alone(world):
    flow, state, now = world
    now[0] = DAY + timedelta(hours=6, minutes=30)
    # 1.25 km in 5 s along the line: a coordinate jump.
    assert state.accept(_record("v", 1, "2026-01-06 06:29:50", 37.505, LAT))
    assert state.accept(_record("v", 1, "2026-01-06 06:29:55", 37.525, LAT, request_id=3))
    row = next(row for row in flow.snapshot()["vehicles"] if row["tr_id"] == "v")
    assert row["gps_suspect"] == "jump"
    assert row["gps_suspect_text"] == "Скачок координат: быстрее 180 км/ч между соседними точками"
    revision = row["revision"]
    now[0] = DAY + timedelta(hours=6, minutes=35)  # the jump is 305 s old
    row = next(row for row in flow.snapshot()["vehicles"] if row["tr_id"] == "v")
    assert row["gps_suspect"] is None and row["revision"] > revision
    # Frames keep coming without a valid fix for more than 600 s of data.
    for index, second in enumerate(range(0, 700, 60)):
        at = DAY + timedelta(hours=6, minutes=35, seconds=second)
        assert state.accept(_record("v", 1, at.strftime("%Y-%m-%d %H:%M:%S"), 37.525, LAT,
                                    valid=False, request_id=10 + index))
    now[0] = DAY + timedelta(hours=6, minutes=46)
    row = next(row for row in flow.snapshot()["vehicles"] if row["tr_id"] == "v")
    assert row["gps_age_s"] > 600 and row["gps_suspect"] == "no_fix"
    assert row["gps_suspect_text"] == "Датчик на связи, но не даёт валидных координат"
    # A hint only: status and reason stay what they were.
    assert (row["status"], row["reason"]) == ("unavailable", "no_confident_observed_stop")
