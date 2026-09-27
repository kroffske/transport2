"""Emulator driver: feed selection, pacing, emulator config/echo and run lifecycle over fake HTTP."""

from __future__ import annotations

import copy
from datetime import datetime, timedelta
from pathlib import Path

import pytest

from scripts.emulator_driver import (EXIT_CONFLICT, EXIT_FAILED, EXIT_OK, INTERVAL_MS, EchoMismatch,
                                     HttpFailure, Pacer, Point, Settings, check_echo,
                                     emulator_config, load_feed, nav_fields, run_driver)

START = datetime(2026, 1, 6, 6, 30)
HEADER = "packet_id,tr_id,unit_id,event_time,device_event_id,location_valid,gps_time,lon,lat,alt,speed,heading,receive_time,is_hist_data\n"


def _row(unit, event, receive, valid=True, lon=37.5, lat=55.7, speed=20, heading=90, hist=False):
    coords = f"{lon},{lat},150,{speed},{heading}" if valid else ",,,,"
    return f"1,{unit + 1000},{unit},{event},0,{valid},,{coords},{receive},{hist}\n"


def _traffic(tmp_path: Path, rows: list[str]) -> Path:
    path = tmp_path / "traffic.csv"
    path.write_text(HEADER + "".join(rows), encoding="utf-8")
    return path


def _settings(traffic: Path, **overrides) -> Settings:
    env = {"DEMO_TRAFFIC": str(traffic), "DEMO_WINDOW": "06:30-06:32", "DEMO_SPEEDUP": "5",
           "DEMO_POST_PERIOD_S": "2", "DEMO_REPEAT_MAX_S": "30", "EMULATOR_URL": "http://emu",
           "BACKEND_URL": "http://backend", "DEMO_READY_TIMEOUT_S": "5", **overrides}
    return Settings.from_env(env)


def test_feed_orders_by_event_time_skips_history_and_same_second_corrections(tmp_path):
    path = _traffic(tmp_path, [
        _row(1, "2026-01-06 06:30:20", "2026-01-06 06:30:21", lon=37.52),
        # Received later, but its GPS event is earlier: event_time order wins.
        _row(1, "2026-01-06 06:30:10", "2026-01-06 06:30:40", lon=37.51),
        # Same second, corrected later: only the last received row is kept.
        _row(1, "2026-01-06 06:30:20.400", "2026-01-06 06:30:25", lon=37.521),
        _row(1, "2026-01-06 06:30:30", "2026-01-06 06:30:31", hist=True),
        _row(1, "2026-01-06 06:30:40", "2026-01-06 06:30:41", valid=False),
        _row(1, "2026-01-06 06:29:59", "2026-01-06 06:30:00"),  # before the window
        _row(2, "2026-01-06 06:31:00", "2026-01-06 06:31:01", lon=-37.5, lat=-55.7),
    ])
    feed = load_feed(path, START, START + timedelta(minutes=2))
    assert feed.rows_in_window == 6 and feed.skipped_hist == 1 and feed.skipped_nonmonotonic == 1
    unit = feed.points[1]
    assert [p.event_time for p in unit] == [START + timedelta(seconds=s) for s in (10, 20, 40)]
    assert [p.lon for p in unit] == [37.51, 37.521, 0.0]
    assert unit[2].valid is False and unit[2].speed == 0.0
    assert load_feed(path, START, START + timedelta(minutes=2), frozenset({2})).points.keys() == {2}


def test_nav_fields_are_explicit_integer_and_clamped():
    point = Point(START, True, -37.6173215, 55.7551234, 42.6, 400.0, 157.2)
    fields = nav_fields(point)
    assert fields == {"longitude": 376173215, "latitude": 557551234, "extraDopBit5": True,
                      "extraDopBit6": False, "extraDopBit7": True, "speedAvg": 43, "speedMax": 43,
                      "course": 360, "altitude": 157}
    assert nav_fields(Point(START, True, 37.6, 55.7, -3, -5, -10))["course"] == 0
    invalid = nav_fields(Point(START, False, 0.0, 0.0, 0.0, 0.0, 0.0))
    assert invalid["extraDopBit7"] is False and invalid["longitude"] == invalid["latitude"] == 0
    config = emulator_config([(7, point, "new")], "backend", 9201)
    assert config == {"targetHost": "backend", "targetPort": 9201, "units": [
        {"unitId": 7, "intervalMs": INTERVAL_MS, "autoGenerate": False,
         "cells": [{"type": "G6CellNav00", "fields": fields}]}]}
    assert INTERVAL_MS == 3_600_000


def test_pacer_sends_latest_due_point_thins_repeats_then_removes_unit(tmp_path):
    rows = [_row(1, f"2026-01-06 06:30:{s:02d}", f"2026-01-06 06:30:{s:02d}.5", lon=37.5 + s / 1000)
            for s in (2, 4, 6, 8)]
    rows.append(_row(1, "2026-01-06 06:31:30", "2026-01-06 06:31:31"))
    feed = load_feed(_traffic(tmp_path, rows), START, START + timedelta(minutes=2))
    pacer = Pacer(feed, repeat_max_s=30)
    assert pacer.step(START + timedelta(seconds=1)) == []  # nothing due yet
    first = pacer.step(START + timedelta(seconds=7))
    assert [(u, p.event_time.second, kind) for u, p, kind in first] == [(1, 6, "new")]
    assert pacer.counters["points_thinned"] == 2  # 06:30:02 and :04 were never sent
    assert pacer.step(START + timedelta(seconds=12))[0][2] == "new"  # :08
    repeat = pacer.step(START + timedelta(seconds=38))  # 30 s after :08
    assert [(p.event_time.second, kind) for _, p, kind in repeat] == [(8, "repeat")]
    assert pacer.step(START + timedelta(seconds=39)) == []  # silent > 30 s: out of config
    assert pacer.counters["unit_removals"] == 1
    back = pacer.step(START + timedelta(seconds=95))
    assert [(p.event_time, kind) for _, p, kind in back] == [(START + timedelta(seconds=90), "new")]
    thinned, repeated = pacer.ratios()
    assert thinned == pytest.approx(2 / 5) and repeated == pytest.approx(1 / 4)


def test_echo_mismatch_is_detected():
    config = emulator_config([(7, Point(START, True, 37.6, 55.7, 10, 90, 150), "new")], "backend", 9201)
    check_echo(config, copy.deepcopy(config))
    flat = copy.deepcopy(config)
    flat["units"][0]["cells"][0]["fields"] = {}  # what the emulator echoes for flat keys
    with pytest.raises(EchoMismatch, match="fields differ"):
        check_echo(config, flat)
    missing = copy.deepcopy(config)
    missing["units"] = []
    with pytest.raises(EchoMismatch, match="unit count"):
        check_echo(config, missing)
    auto = copy.deepcopy(config)
    auto["units"][0]["autoGenerate"] = True
    with pytest.raises(EchoMismatch, match="pacing"):
        check_echo(config, auto)


def test_invalid_settings_are_rejected(tmp_path):
    with pytest.raises(ValueError, match="DEMO_POST_PERIOD_S"):
        _settings(tmp_path / "t.csv", DEMO_POST_PERIOD_S="0.5")
    with pytest.raises(ValueError, match="DEMO_POST_PERIOD_S"):
        _settings(tmp_path / "t.csv", DEMO_POST_PERIOD_S="6")  # heartbeat must stay <= 10 s
    assert _settings(tmp_path / "t.csv", DEMO_POST_PERIOD_S="5").post_period_s == 5.0
    with pytest.raises(ValueError, match="DEMO_WINDOW"):
        _settings(tmp_path / "t.csv", DEMO_WINDOW="08:30-06:30")
    defaults = Settings.from_env({})
    assert (defaults.speedup, defaults.post_period_s, defaults.repeat_max_s) == (5, 2.0, 30.0)
    assert (defaults.dataset_start, defaults.dataset_end) == (datetime(2026, 1, 6), datetime(2026, 1, 6, 23, 59))


class FakeWorld:
    """Backend and emulator over fake HTTP with a fake wall clock."""

    def __init__(self, *, conflict=False, corrupt_echo_at=None, registration=None):
        self.now = 1_790_000_000.0
        self.calls: list[tuple[str, str, object]] = []
        self.state_times: list[float] = []
        self.conflict = conflict
        self.registration = registration
        self.corrupt_echo_at = corrupt_echo_at
        self.configs: list[dict] = []

    def clock(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds

    def __call__(self, method, url, payload=None):
        self.calls.append((method, url, copy.deepcopy(payload)))
        if url == "http://backend/ready":
            return {"status": "ready", "source_clock": "simulation"}
        if url == "http://emu/api/config" and method == "GET":
            return {"targetHost": None, "units": []}
        if url == "http://backend/v1/run":
            if self.conflict:
                raise HttpFailure(409, {"detail": "run_already_registered", "run_id": "run-a"}, url)
            if self.registration is not None:
                return self.registration
            return {"run_id": "run-b", "clock_mapping": {
                "epoch_origin": int(self.now), "dataset_origin": payload["dataset_start"],
                "rate": payload["speedup"]}}
        if url == "http://emu/api/config":
            self.configs.append(payload)
            echo = copy.deepcopy(payload)
            if self.corrupt_echo_at == len(self.configs) and echo["units"]:
                echo["units"][0]["cells"][0]["fields"] = {}
            self.now += 0.05
            return echo
        if url == "http://backend/v1/run/run-b/state":
            self.state_times.append(self.now)
            return {"state": payload["state"]}
        raise AssertionError(f"unexpected call {method} {url}")


def _world_rows():
    return [_row(u, f"2026-01-06 06:30:{s:02d}", f"2026-01-06 06:30:{s:02d}.5")
            for u in (1, 2) for s in range(0, 60, 5)] + [
        _row(1, "2026-01-06 06:31:50", "2026-01-06 06:31:51")]


def test_second_driver_gets_409_and_never_touches_emulator_config(tmp_path):
    world = FakeWorld(conflict=True)
    code = run_driver(_settings(_traffic(tmp_path, _world_rows())), http=world,
                      clock=world.clock, sleep=world.sleep)
    assert code == EXIT_CONFLICT
    assert not [c for c in world.calls if c[0] == "POST" and c[1] == "http://emu/api/config"]


def test_driver_registers_streams_heartbeats_and_completes_at_window_end(tmp_path):
    world = FakeWorld()
    code = run_driver(_settings(_traffic(tmp_path, _world_rows())), http=world,
                      clock=world.clock, sleep=world.sleep)
    assert code == EXIT_OK
    registration = next(p for m, u, p in world.calls if u == "http://backend/v1/run")
    assert registration["units"] == [1, 2] and registration["speedup"] == 5
    assert registration["post_period_s"] == 2.0 and registration["source"] == "official_emulator"
    assert len(registration["path"]["1"]) == 13
    # Registration precedes the first emulator configuration.
    order = [u for m, u, _ in world.calls if m == "POST"]
    assert order[0] == "http://backend/v1/run" and order[1] == "http://emu/api/config"
    # 2-minute window at x5, a POST every 2 s (10 dataset s): 13 posts through 06:32, then cleanup.
    assert len(world.configs) == 14 and world.configs[-1]["units"] == []
    assert all(u["intervalMs"] == INTERVAL_MS for c in world.configs for u in c["units"])
    states = [p for _, u, p in world.calls if u.endswith("/v1/run/run-b/state")]
    assert states[0]["state"] == "running" and states[-1]["state"] == "completed"
    assert sum(s["state"] == "running" for s in states) >= 2
    gaps = [b - a for a, b in zip(world.state_times, world.state_times[1:])]
    assert gaps and max(gaps) <= 10.0  # heartbeat never later than 10 s
    final = states[-1]
    assert 0 < final["thinned_ratio"] < 1 and 0 < final["repeat_ratio"] < 1
    assert final["counters"]["points_sent"] + final["counters"]["points_thinned"] == 25


def test_echo_mismatch_fails_run_and_clears_emulator(tmp_path):
    world = FakeWorld(corrupt_echo_at=2)
    code = run_driver(_settings(_traffic(tmp_path, _world_rows())), http=world,
                      clock=world.clock, sleep=world.sleep)
    assert code == EXIT_FAILED
    assert world.configs[-1]["units"] == []
    final = [p for _, u, p in world.calls if u.endswith("/state")][-1]
    assert final["state"] == "failed" and "EchoMismatch" in final["reason"]


def test_failure_right_after_registration_is_reported_as_failed(tmp_path):
    # The run exists once registered: a broken registration answer still ends as "failed".
    world = FakeWorld(registration={"run_id": "run-b", "clock_mapping": {"epoch_origin": 1}})
    code = run_driver(_settings(_traffic(tmp_path, _world_rows())), http=world,
                      clock=world.clock, sleep=world.sleep)
    assert code == EXIT_FAILED
    final = [p for _, u, p in world.calls if u.endswith("/state")][-1]
    assert final["state"] == "failed" and "KeyError" in final["reason"]
    assert world.configs == [{"targetHost": "backend", "targetPort": 9201, "units": []}]
