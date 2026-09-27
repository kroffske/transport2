"""Backend target, causal prediction, replay control and degradation behavior."""

from datetime import datetime, timedelta
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import socket
from threading import Event, Thread
import time
from itertools import count

import pytest

from fastapi.testclient import TestClient
import pandas as pd

from scripts.replay_ndtp import handshake, navigation
from transport_backend.ingest import NDTPServer
from transport_backend.orchestration import ModelClient, ModelFailure, Orchestrator
from transport_backend.schedule import Schedule
from transport_backend.service import ReplayClock, create_app
from transport_backend.run import RunRegistry
from transport_backend.state import ClockMapping, Telemetry, TelemetryState
from transport_ml.data import read_plan



@pytest.fixture
def running_flow():
    flows = []

    def create(*args, **kwargs):
        flow = Orchestrator(*args, **kwargs).start()
        flows.append(flow)
        return flow

    yield create
    for flow in flows:
        flow.close()


def _replay_run(state, clock):
    """Caller-owned dataset_wall clock, wired the way the service wires replay."""
    return RunRegistry("dataset_wall", state.unit_mapping,
                       mapping=ClockMapping(1_700_000_000, datetime(2026, 1, 6)), clock=clock)


def _current(row):
    """Normal and computed on the vehicle's full current context."""
    return row["status"] == "normal" and not row["prediction_updating"]


def _wait_vehicle(flow, predicate):
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        row = flow.snapshot()["vehicles"][0]
        if predicate(row):
            return row
        time.sleep(0.005)
    raise AssertionError(f"vehicle did not reach expected state: {row}")


def _session(client, unit=1):
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        sessions = client.get("/v1/ingest").json()["active_sessions"].get(str(unit), [])
        if len(sessions) == 1:
            return sessions[0]
        time.sleep(0.005)
    raise AssertionError("handshake did not create one active session")


def _plan(path):
    path.write_text(
        "tt_action_item_id,tr_id,time_begin,geom,time_fact_begin\n"
        's1,v,2026-01-06 00:00:00,POINT (37.0 55.0),2099-01-01 00:00:00\n'
        's2,v,2026-01-06 00:13:00,POINT (37.1 55.1),2099-01-01 00:00:00\n'
        's3,v,2026-01-06 00:14:00,POINT (37.2 55.2),2099-01-01 00:00:00\n',
        encoding="utf-8")


def _record(event="2026-01-06 00:00:30", receive="2026-01-06 00:00:31",
            lon=37.0, lat=55.0, speed=0.0, request_id=2):
    return Telemetry(unit_id=1, tr_id="v", event_time=event, receive_time=receive,
                     location_valid=True, lon=lon, lat=lat, speed=speed,
                     heading=0.0, alt=0.0, packet_id=str(request_id),
                     session_id="s", request_id=request_id,
                     source_clock="dataset_wall", frame_id=str(request_id),
                     received_at_utc=receive)


class _Model:
    def __init__(self):
        self.requests = []
        self.fail = False

    def predict(self, request):
        self.requests.append(request)
        if self.fail:
            raise ModelFailure("ml_unreachable_or_timeout")
        return {"applicability": "supported", "quality": "normal",
                "prediction_s": 150.0, "predicted_arrival": "2026-01-06T00:15:30",
                "model_version": "test", "artifact_sha256": "test", "reason": None}


def test_target_stop_detection_and_ambiguous_stop(tmp_path):
    path = tmp_path / "schedule_plan.csv"
    _plan(path)
    schedule = Schedule(read_plan(path))
    assert schedule.target("v", datetime(2026, 1, 6, 0, 3)).stop_id == "s3"
    assert schedule.target("v", datetime(2026, 1, 6, 0, 3, 1)).stop_id == "s3"
    assert schedule.target("v", datetime(2026, 1, 6, 0, 4)) is None
    at = datetime(2026, 1, 6, 0, 1)
    assert schedule.observed_deviation("v", at, []) is None
    row = _record()
    assert schedule.observed_deviation("v", at, [row.as_dict()]) == 30.0
    assert schedule.observed_deviation("v", at, [row.as_dict(),
           _record(event="2026-01-06 00:00:45", receive="2026-01-06 00:00:46").as_dict()]) == 30.0
    ambiguous = tmp_path / "ambiguous.csv"
    ambiguous.write_text('tt_action_item_id,tr_id,time_begin,geom\n'
                         'a,v,2026-01-06 00:00:00,POINT (37.0 55.0)\n'
                         'b,v,2026-01-06 00:00:10,POINT (37.0 55.0)\n', encoding="utf-8")
    assert Schedule(read_plan(ambiguous)).observed_deviation("v", at, [row.as_dict()]) is None


def test_first_stop_observation_survives_history_eviction_and_late_future_packets(tmp_path):
    path = tmp_path / "schedule_plan.csv"
    _plan(path)
    schedule = Schedule(read_plan(path))
    state = TelemetryState({1: "v"}, source_clock="dataset_wall", history_limit=4)
    origin = datetime(2026, 1, 6)
    for seconds in range(0, 1801, 30):
        at = origin + timedelta(seconds=seconds)
        assert state.accept(_record(event=at.isoformat(), receive=at.isoformat(), request_id=seconds + 2))
        assert schedule.observed_deviation("v", at, state.history("v", at)) == 0.0
    assert len(state.history("v", at)) == 4
    assert schedule.counters()["stop_observation_count"] == 1
    assert schedule.counters()["stop_seen_frame_count"] <= state.history_limit
    # A correction first available now cannot revise the committed first arrival.
    late = _record(event="2026-01-05 23:59:50", receive="2026-01-06 00:30:01", request_id=2000)
    assert state.accept(late)
    at = origin + timedelta(seconds=1801)
    assert schedule.observed_deviation("v", at, state.history("v", at)) == 0.0
    assert schedule.counters()["stop_late_evidence_ignored"] == 1
    # Future event is not detector evidence despite having arrived at the socket.
    future = _record(event="2026-01-06 00:35:00", receive="2026-01-06 00:30:02",
                     lon=37.1, lat=55.1, request_id=2001)
    assert state.accept(future)
    at += timedelta(seconds=1)
    assert schedule.observed_deviation("v", at, state.history("v", at)) == 0.0
    assert schedule.counters()["stop_observation_count"] == 1


def test_bounded_worker_coalesces_captures_source_inputs_and_discards_old_target(tmp_path, running_flow):
    path = tmp_path / "schedule_plan.csv"
    _plan(path)
    plan = read_plan(path)
    plan = pd.concat([plan.assign(tr_id=tr) for tr in ("v", "w", "x")], ignore_index=True)
    schedule = Schedule(plan)
    state = TelemetryState({1: "v", 2: "w", 3: "x"}, source_clock="dataset_wall")
    for unit in (1, 2, 3):
        state.connected(unit, "s")
    now = [datetime(2026, 1, 6, 0, 1)]
    server = NDTPServer(state, run=_replay_run(state, lambda: now[0]))

    class SlowModel(_Model):
        def __init__(self):
            super().__init__()
            self.started, self.release = Event(), Event()

        def predict(self, request):
            self.started.set()
            assert self.release.wait(timeout=2)
            return super().predict(request)

    model = SlowModel()
    flow = running_flow(state, server, schedule, model,
                        predict_interval_s=10, queue_limit=1)
    try:
        assert state.accept(_record())
        flow.on_ingest(1)
        assert model.started.wait(timeout=1)
        assert state.accept(replace(_record(), unit_id=2, tr_id="w"))
        flow.on_ingest(2)
        now[0] = datetime(2026, 1, 6, 0, 1, 20)
        assert state.accept(replace(_record(event="2026-01-06 00:01:19", receive="2026-01-06 00:01:19",
                                           speed=20.0, request_id=4), unit_id=2, tr_id="w"))
        flow.on_ingest(2)
        assert state.accept(replace(_record(event="2026-01-06 00:01:19", receive="2026-01-06 00:01:19",
                                           request_id=4), unit_id=3, tr_id="x"))
        flow.on_ingest(3)
        started = time.monotonic()
        snapshot = flow.snapshot()
        assert time.monotonic() - started < 0.3
        processing = snapshot["processing"]
        assert processing["ml_active_jobs"] == 1
        assert processing["ml_queue_depth"] == processing["ml_queue_limit"] == 1
        assert processing["ml_coalesced"] == 1
        assert processing["ml_dropped_queue_full"] >= 1
        assert not model.requests
        # New telemetry received after capture must not enter the queued ML input.
        assert state.accept(replace(_record(event="2026-01-06 00:01:18", receive="2026-01-06 00:04:00",
                                           lon=37.09, request_id=5), unit_id=2, tr_id="w"))
        now[0] = datetime(2026, 1, 6, 0, 3)
        model.release.set()
        deadline = time.monotonic() + 1
        while flow.processing_readback().get("ml_completed", 0) < 2 and time.monotonic() < deadline:
            time.sleep(0.005)
        assert flow.processing_readback()["ml_discarded_obsolete"] == 2
        assert len(model.requests) == 2
        captured = model.requests[1]
        assert captured["point"]["T"] == "2026-01-06T00:01:20"
        assert captured["point"]["target_stop_id"] == "s2"
        assert len(captured["telemetry"]) == 2
        assert all(datetime.fromisoformat(r["event_time"]) <= datetime(2026, 1, 6, 0, 1, 20)
                   and datetime.fromisoformat(r["receive_time"]) <= datetime(2026, 1, 6, 0, 1, 20)
                   for r in captured["telemetry"])
        assert all(row["prediction_s"] is None for row in flow.snapshot()["vehicles"])
        # A new fresh frame resumes inference for the new target, with a new identity.
        assert state.accept(_record(event="2026-01-06 00:03:01", receive="2026-01-06 00:03:01",
                                    lon=37.05, speed=20.0, request_id=6))
        now[0] = datetime(2026, 1, 6, 0, 3, 2)
        recovered = _wait_vehicle(flow, _current)
        assert recovered["target_stop_id"] == "s3"
        assert recovered["prediction_input_frame_id"] == "6"
    finally:
        model.release.set()


def test_previously_received_future_event_versions_full_context_and_requeues_after_completion(tmp_path, running_flow):
    path = tmp_path / "schedule_plan.csv"
    _plan(path)
    state = TelemetryState({1: "v"}, source_clock="dataset_wall")
    state.connected(1, "s")
    a = _record(event="2026-01-06 00:00:30", receive="2026-01-06 00:00:59", request_id=2)
    b = _record(event="2026-01-06 00:01:10", receive="2026-01-06 00:00:50",
                lon=37.05, speed=20.0, request_id=3)
    assert state.accept(b)
    assert state.accept(a)
    now = [datetime(2026, 1, 6, 0, 1)]
    server = NDTPServer(state, run=_replay_run(state, lambda: now[0]))

    class GatedModel(_Model):
        def __init__(self):
            super().__init__()
            self.started = [Event(), Event()]
            self.release = [Event(), Event()]

        def predict(self, request):
            index = len(self.requests)
            response = super().predict(request)
            self.started[index].set()
            assert self.release[index].wait(timeout=2)
            return response

    model = GatedModel()
    flow = running_flow(state, server, Schedule(read_plan(path)), model,
                        predict_interval_s=60, queue_limit=1)
    try:
        initial = flow.snapshot()["vehicles"][0]
        assert model.started[0].wait(timeout=1)
        assert len(model.requests[0]["telemetry"]) == 1
        assert model.requests[0]["telemetry"][0]["event_time"] == a.event_time
        now[0] = datetime(2026, 1, 6, 0, 1, 20)
        # No accepted packet or polling occurs before releasing this old-context job.
        model.release[0].set()
        assert model.started[1].wait(timeout=1)
        stale = flow.snapshot()["vehicles"][0]
        assert stale["event_time"] == b.event_time
        assert stale["input_frame_id"] == a.frame_id  # max-received identity did not change
        assert stale["input_context_revision"] > initial["input_context_revision"]
        assert stale["prediction_context_revision"] == initial["input_context_revision"]
        # T-7: a same-target success younger than fresh_s stays normal, flagged as
        # updating; the completion on the older context still raises no alert.
        assert stale["status"] == "normal"
        assert stale["prediction_updating"] is True
        assert stale["alert"] is None
        assert stale["last_success_at"] == "2026-01-06T00:01:00"
        assert model.requests[1]["point"]["T"] == "2026-01-06T00:01:20"
        assert {r["event_time"] for r in model.requests[1]["telemetry"]} == {a.event_time, b.event_time}
        model.release[1].set()
        fresh = _wait_vehicle(flow, _current)
        assert fresh["prediction_context_revision"] == fresh["input_context_revision"]
        assert fresh["last_success_at"] == "2026-01-06T00:01:20"
        assert fresh["alert"]["emitted_at"] == "2026-01-06T00:01:20"
        assert len(model.requests) == 2
        assert flow.snapshot()["vehicles"][0] == fresh
        assert initial["prediction_s"] is None  # earlier readback was not mutated
    finally:
        for release in model.release:
            release.set()


def test_invalid_correction_revokes_stop_confidence_until_new_confirmed_observation(tmp_path, running_flow):
    path = tmp_path / "schedule_plan.csv"
    _plan(path)
    schedule = Schedule(read_plan(path))
    state = TelemetryState({1: "v"}, source_clock="dataset_wall")
    state.connected(1, "s")
    first_input = _record()
    assert state.accept(first_input)
    now = [datetime(2026, 1, 6, 0, 1)]
    server = NDTPServer(state, run=_replay_run(state, lambda: now[0]))
    model = _Model()
    flow = running_flow(state, server, schedule, model, predict_interval_s=10)
    first = _wait_vehicle(flow, _current)
    assert first["cur_dev_s"] == 30.0
    correction = replace(first_input, location_valid=False, receive_time="2026-01-06 00:01:02",
                         frame_id="invalid:3", request_id=3, received_at_utc="2026-01-06 00:01:02")
    assert state.accept(correction)
    now[0] = datetime(2026, 1, 6, 0, 1, 2)
    revoked = flow.snapshot()["vehicles"][0]
    assert revoked["cur_dev_s"] is None
    assert revoked["cur_dev_source"] is None
    assert revoked["status"] == "unavailable"
    assert schedule.counters()["stop_observations_retracted"] == 1
    assert state.accept(_record(event="2026-01-06 00:01:10", receive="2026-01-06 00:01:11",
                                lon=37.05, speed=20.0, request_id=4))
    now[0] = datetime(2026, 1, 6, 0, 1, 11)
    moving = flow.snapshot()["vehicles"][0]
    assert moving["location_valid"] and moving["connected"] and moving["gps_age_s"] == 1.0
    assert moving["cur_dev_s"] is None
    assert moving["reason"] == "no_confident_observed_stop"
    assert len(model.requests) == 1
    assert moving["prediction_published_unix_ns"] == first["prediction_published_unix_ns"]
    assert state.accept(_record(event="2026-01-06 00:01:20", receive="2026-01-06 00:01:21",
                                request_id=5))
    now[0] = datetime(2026, 1, 6, 0, 1, 21)
    confirmed = _wait_vehicle(flow, _current)
    assert confirmed["cur_dev_s"] == 80.0
    assert model.requests[-1]["point"]["cur_dev_s"] == 80.0
    assert first["cur_dev_s"] == 30.0 and first["status"] == "normal"


def test_prediction_uses_only_available_fields_and_outage_retains_last_success(tmp_path, running_flow):
    path = tmp_path / "schedule_plan.csv"
    _plan(path)
    schedule = Schedule(read_plan(path))
    # No reconnect grace: this test observes a real disconnect immediately.
    state = TelemetryState({1: "v"}, source_clock="dataset_wall", reconnect_grace_s=0)
    state.connected(1, "s")
    assert state.accept(_record())
    # This correction has a past event but has not been received at prediction T.
    assert state.accept(_record(event="2026-01-06 00:00:40",
                                receive="2026-01-06 00:02:30", lon=37.001, request_id=3))
    clock = ReplayClock(datetime(2026, 1, 6, 0, 1))
    server = NDTPServer(state, run=_replay_run(state, clock.now))
    model = _Model()
    flow = running_flow(state, server, schedule, model, predict_interval_s=10)
    first = _wait_vehicle(flow, _current)
    assert first["status"] == "normal"
    assert first["cur_dev_s"] == 30.0
    assert first["cur_dev_source"] == "computed_stop"
    assert first["alert"]["kind"] == "new_signal"
    assert len(model.requests) == 1
    request = model.requests[0]
    assert request["point"]["cur_dev_s"] == 30.0
    assert len(request["telemetry"]) == 1
    assert set(request["telemetry"][0]) == {"tr_id", "event_time", "receive_time",
                                           "location_valid", "lon", "lat", "speed", "heading"}
    assert set(request["schedule_plan"][0]) == {"tt_action_item_id", "tr_id", "time_begin", "geom"}
    assert flow.snapshot()["revision"] == first["revision"]
    assert len(model.requests) == 1
    assert not state.accept(_record())
    clock.advance(datetime(2026, 1, 6, 0, 1, 5), 1, 3, "s", 0)
    assert flow.snapshot()["revision"] == first["revision"]
    assert len(model.requests) == 1
    clock.acknowledge([{"revision": 1, "unit_id": 1, "request_id": 3, "outcome": "duplicate", "session_id": "s"}])
    model.fail = True
    assert state.accept(_record(event="2026-01-06 00:01:19",
                                receive="2026-01-06 00:01:19", lon=37.05,
                                speed=20.0, request_id=4))
    clock.advance(datetime(2026, 1, 6, 0, 1, 20), 1, 4, "s", 0)
    failed = _wait_vehicle(flow, lambda row: row["reason"] == "ml_unreachable_or_timeout" and not row["prediction_pending"])
    assert failed["status"] == "degraded"
    assert failed["reason"] == "ml_unreachable_or_timeout"
    assert failed["prediction_s"] == 150.0
    assert failed["last_success_at"] == first["last_success_at"]
    assert failed["prediction_age_s"] == 20.0
    assert failed["alert"] == first["alert"]
    state.disconnected(1, "s")
    assert flow.snapshot()["vehicles"][0]["reason"] == "disconnected"
    state.connected(1, "s")
    model.fail = False
    clock.acknowledge([{"revision": 1, "unit_id": 1, "request_id": 4, "outcome": "accepted", "session_id": "s"}])
    assert state.accept(_record(event="2026-01-06 00:01:20",
                                receive="2026-01-06 00:01:20", lon=37.06,
                                speed=20.0, request_id=5))
    clock.advance(datetime(2026, 1, 6, 0, 1, 21), 1, 5, "s", 1)
    recovered = _wait_vehicle(flow, _current)
    assert recovered["status"] == "normal"
    assert recovered["last_success_at"] != first["last_success_at"]
    assert recovered["alert"] == first["alert"]  # cooldown prevents repeat signal


def test_frame_correlation_and_wall_publication_survive_polling_and_ml_outage(tmp_path, monkeypatch, running_flow):
    path = tmp_path / "schedule_plan.csv"
    _plan(path)
    state = TelemetryState({1: "v"}, source_clock="dataset_wall")
    state.connected(1, "s")
    first_input = replace(_record(), received_at_utc="2026-09-26 10:00:00.000001")
    # A correction arrived later, although its GPS event precedes the latest position.
    correction = replace(_record(event="2026-01-06 00:00:25",
                                  receive="2026-01-06 00:00:32", lon=37.0001,
                                  request_id=3), frame_id="s:3:2",
                         received_at_utc="2026-09-26 10:00:00.000002")
    assert state.accept(first_input)
    assert state.accept(correction)
    clock = ReplayClock(datetime(2026, 1, 6, 0, 1))
    server = NDTPServer(state, run=_replay_run(state, clock.now))
    model = _Model()
    flow = running_flow(state, server, Schedule(read_plan(path)), model,
                        predict_interval_s=10)
    wall_ns = count(1_790_417_000_000_000_001)
    monkeypatch.setattr("transport_backend.orchestration.time_ns", lambda: next(wall_ns))
    first = _wait_vehicle(flow, _current)
    assert first["input_frame_id"] == correction.frame_id
    assert first["input_request_id"] == correction.request_id
    assert first["input_session_id"] == correction.session_id
    assert first["input_received_at_utc"] == correction.received_at_utc
    assert first["event_time"] == first_input.event_time
    assert first["prediction_input_frame_id"] == correction.frame_id
    assert first["published_unix_ns"] >= 1_790_417_000_000_000_001
    assert first["prediction_published_unix_ns"] == first["published_unix_ns"]
    assert flow.snapshot()["vehicles"][0] == first

    new_input = replace(_record(event="2026-01-06 00:01:19",
                               receive="2026-01-06 00:01:19", lon=37.05,
                               speed=20.0, request_id=4), frame_id="s:4:3",
                        received_at_utc="2026-09-26 10:00:00.000003")
    assert state.accept(new_input)
    clock.advance(datetime(2026, 1, 6, 0, 1, 20), 1, 4, "s", 0)
    model.fail = True
    failed = _wait_vehicle(flow, lambda row: row["reason"] == "ml_unreachable_or_timeout" and not row["prediction_pending"])
    assert failed["status"] == "degraded"
    assert failed["input_frame_id"] == new_input.frame_id
    assert failed["input_received_at_utc"] == new_input.received_at_utc
    assert failed["published_unix_ns"] > first["published_unix_ns"]
    assert failed["prediction_input_frame_id"] == first["prediction_input_frame_id"]
    assert failed["prediction_published_unix_ns"] == first["prediction_published_unix_ns"]
    assert flow.snapshot()["vehicles"][0] == failed

    recovery_input = replace(_record(event="2026-01-06 00:01:39",
                                    receive="2026-01-06 00:01:39", lon=37.06,
                                    speed=20.0, request_id=5), frame_id="s:5:4",
                             received_at_utc="2026-09-26 10:00:00.000004")
    assert state.accept(recovery_input)
    clock.acknowledge([{"revision": 1, "unit_id": 1, "request_id": 4, "outcome": "accepted", "session_id": "s"}])
    clock.advance(datetime(2026, 1, 6, 0, 1, 40), 1, 5, "s", 1)
    model.fail = False
    recovered = _wait_vehicle(flow, _current)
    assert recovered["status"] == "normal"
    assert recovered["prediction_input_frame_id"] == recovery_input.frame_id
    assert recovered["prediction_published_unix_ns"] == recovered["published_unix_ns"]
    assert recovered["prediction_published_unix_ns"] > first["prediction_published_unix_ns"]


def test_replay_clock_socket_ack_duplicate_and_rejects_concurrent_step(tmp_path):
    data = tmp_path / "validate"
    data.mkdir()
    _plan(data / "schedule_plan.csv")
    (data / "traffic.csv").write_text("unit_id,tr_id\n1,v\n", encoding="utf-8")
    api = create_app(data_dir=tmp_path, model_url="http://127.0.0.1:1",
                     source_clock="dataset_wall", ndtp_port=0)
    with TestClient(api) as client:
        ready = client.get("/ready").json()
        assert ready["clock_mapping"] == {"dataset_origin": "2026-01-06T00:00:00",
                                           "epoch_origin": 1_700_000_000, "rate": 1}
        assert ready["run"] is None  # replay has no emulator run
        before_frame_ns = time.time_ns()
        with socket.create_connection((ready["ndtp_host"], ready["ndtp_port"])) as sock:
            sock.sendall(handshake(1))
            session = _session(client)
            payload = {"receive_time": "2026-01-06T00:00:31", "unit_id": 1, "request_id": 2, "session_id": session}
            first = client.post("/v1/replay/clock", json=payload)
            assert first.status_code == 200
            assert client.post("/v1/replay/clock", json=payload).status_code == 409
            assert client.post("/v1/replay/clock", json={**payload, "unit_id": 9}).status_code == 422
            row = pd.Series({"unit_id": 1, "event_time": pd.Timestamp("2026-01-06 00:00:30"),
                             "location_valid": True, "lon": 37.0, "lat": 55.0,
                             "speed": 0.0, "heading": 0.0})
            wire, _ = navigation(row, 2, pd.Timestamp("2026-01-06"), 1_700_000_000)
            sock.sendall(wire)
            for _ in range(100):
                ack = client.get("/v1/ingest?since_revision=0").json()
                if ack["outcomes"]:
                    break
                time.sleep(0.01)
            assert ack["outcomes"][0]["outcome"] == "accepted"
            accepted_outcome = ack["outcomes"][0]
            assert client.post("/v1/replay/clock", json={**payload,
                       "receive_time": "2026-01-06T00:00:29", "request_id": 3}).status_code == 409
            second = client.post("/v1/replay/clock", json={**payload,
                                 "receive_time": "2026-01-06T00:00:32", "request_id": 3})
            assert second.status_code == 200
            wire, _ = navigation(row, 3, pd.Timestamp("2026-01-06"), 1_700_000_000)
            sock.sendall(wire)
            for _ in range(100):
                ack = client.get("/v1/ingest?since_revision=1").json()
                if ack["outcomes"]:
                    break
                time.sleep(0.01)
            assert ack["outcomes"][0]["outcome"] == "duplicate"
            assert ack["counters"]["accepted"] == 1
            assert ack["counters"]["dropped_duplicate"] == 1
            for _ in range(100):
                vehicle = client.get("/v1/vehicles").json()["vehicles"][0]
                if vehicle["reason"] == "ml_unreachable_or_timeout":
                    break
                time.sleep(0.005)
            assert vehicle["cur_dev_s"] == 30.0
            assert vehicle["prediction_s"] is None
            assert vehicle["reason"] == "ml_unreachable_or_timeout"
            assert vehicle["input_frame_id"] == accepted_outcome["frame_id"]
            assert vehicle["input_request_id"] == 2
            assert vehicle["input_session_id"] == accepted_outcome["session_id"]
            assert vehicle["input_received_at_utc"] is not None
            assert before_frame_ns <= vehicle["published_unix_ns"] <= time.time_ns()
            assert vehicle["prediction_input_frame_id"] is None
            assert vehicle["prediction_published_unix_ns"] is None


def test_replay_session_collision_cannot_ack_another_connection_and_reconnect_resets_id(tmp_path):
    data = tmp_path / "validate"
    data.mkdir()
    _plan(data / "schedule_plan.csv")
    (data / "traffic.csv").write_text("unit_id,tr_id\n1,v\n", encoding="utf-8")
    api = create_app(data_dir=tmp_path, model_url="http://127.0.0.1:1",
                     source_clock="dataset_wall", ndtp_port=0)
    with TestClient(api) as client:
        ready = client.get("/ready").json()
        address = (ready["ndtp_host"], ready["ndtp_port"])
        row = pd.Series({"unit_id": 1, "event_time": pd.Timestamp("2026-01-06 00:00:30"),
                         "location_valid": True, "lon": 37.0, "lat": 55.0, "speed": 0.0, "heading": 0.0})
        with socket.create_connection(address) as original:
            original.sendall(handshake(1))
            session = _session(client)
            payload = {"receive_time": "2026-01-06T00:00:31", "unit_id": 1,
                       "request_id": 2, "session_id": session}
            assert client.post("/v1/replay/clock", json={k: v for k, v in payload.items()
                                                        if k != "session_id"}).status_code == 422
            assert client.post("/v1/replay/clock", json=payload).status_code == 200
            with socket.create_connection(address) as other:
                other.sendall(handshake(1))
                for _ in range(100):
                    sessions = client.get("/v1/ingest").json()["active_sessions"].get("1", [])
                    if len(sessions) == 2:
                        break
                    time.sleep(0.005)
                assert len(sessions) == 2
                assert client.post("/v1/replay/clock", json=payload).status_code == 409
                wire, _ = navigation(row, 2, pd.Timestamp("2026-01-06"), 1_700_000_000)
                other.sendall(wire)
                for _ in range(100):
                    wrong = client.get("/v1/ingest?since_revision=0").json()
                    if wrong["outcomes"]:
                        break
                    time.sleep(0.005)
                assert wrong["outcomes"][0]["session_id"] != session
            assert _session(client) == session
            # The foreign same-unit/request outcome did not clear the pending step.
            assert client.post("/v1/replay/clock", json=payload).status_code == 409
            row.lon = 37.0001
            wire, _ = navigation(row, 2, pd.Timestamp("2026-01-06"), 1_700_000_000)
            original.sendall(wire)
            for _ in range(100):
                correct = client.get("/v1/ingest?since_revision=1").json()
                if correct["outcomes"]:
                    break
                time.sleep(0.005)
            assert correct["outcomes"][0]["session_id"] == session
        for _ in range(100):
            if "1" not in client.get("/v1/ingest").json()["active_sessions"]:
                break
            time.sleep(0.005)
        with socket.create_connection(address) as reconnected:
            reconnected.sendall(handshake(1))
            new_session = _session(client)
            assert new_session != session
            assert client.post("/v1/replay/clock", json={**payload, "session_id": session}).status_code == 409
            assert client.post("/v1/replay/clock", json={**payload,
                "receive_time": "2026-01-06T00:00:32", "session_id": new_session}).status_code == 200
            row.lon = 37.0002
            wire, _ = navigation(row, 2, pd.Timestamp("2026-01-06"), 1_700_000_000)
            reconnected.sendall(wire)
            for _ in range(100):
                ack = client.get("/v1/ingest?since_revision=2").json()
                if ack["outcomes"]:
                    break
                time.sleep(0.005)
            assert ack["outcomes"][0]["session_id"] == new_session
            assert ack["outcomes"][0]["request_id"] == 2


def test_two_tcp_units_are_acknowledged_while_real_http_model_times_out(tmp_path, monkeypatch):
    started = Event()

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers["Content-Length"]))
            started.set()
            time.sleep(0.6)
            self.send_response(503)
            self.end_headers()

        def log_message(self, *_):
            pass

    slow_ml = HTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=slow_ml.serve_forever, daemon=True)
    thread.start()
    data = tmp_path / "validate"
    data.mkdir()
    _plan(data / "schedule_plan.csv")
    plan = pd.read_csv(data / "schedule_plan.csv")
    pd.concat([plan, plan.assign(tr_id="w")]).to_csv(data / "schedule_plan.csv", index=False)
    (data / "traffic.csv").write_text("unit_id,tr_id\n1,v\n2,w\n", encoding="utf-8")
    monkeypatch.setenv("ML_TIMEOUT_S", "0.2")
    api = create_app(data_dir=tmp_path, model_url=f"http://127.0.0.1:{slow_ml.server_port}",
                     source_clock="dataset_wall", ndtp_port=0)
    try:
        with TestClient(api) as client:
            ready = client.get("/ready").json()
            sockets = [socket.create_connection((ready["ndtp_host"], ready["ndtp_port"])) for _ in (1, 2)]
            try:
                for unit, sock in enumerate(sockets, start=1):
                    sock.sendall(handshake(unit))
                    session = _session(client, unit)
                    at = f"2026-01-06T00:01:0{unit}"
                    prior = client.post("/v1/replay/clock", json={"receive_time": at,
                                        "unit_id": unit, "request_id": 2, "session_id": session})
                    assert prior.status_code == 200
                    row = pd.Series({"unit_id": unit, "event_time": pd.Timestamp(at),
                                     "location_valid": True, "lon": 37.0, "lat": 55.0,
                                     "speed": 0.0, "heading": 0.0})
                    wire, _ = navigation(row, 2, pd.Timestamp("2026-01-06"), 1_700_000_000)
                    before = time.monotonic()
                    sock.sendall(wire)
                    for _ in range(100):
                        ack = client.get(f"/v1/ingest?since_revision={prior.json()['processed_revision']}").json()
                        if any(o["session_id"] == session for o in ack["outcomes"]):
                            break
                        time.sleep(0.002)
                    assert time.monotonic() - before < 0.15
                    assert ack["outcomes"][0]["outcome"] == "accepted"
                    if unit == 1:
                        assert started.wait(timeout=1)
                before = time.monotonic()
                readback = client.get("/v1/vehicles").json()
                assert time.monotonic() - before < 0.15
                assert readback["ingest"]["accepted"] == 2
                assert readback["processing"]["ml_active_jobs"] <= 1
                deadline = time.monotonic() + 1
                while time.monotonic() < deadline:
                    ack = client.get("/v1/ingest").json()
                    if ack["processing"]["ml_failed"] >= 2:
                        break
                    time.sleep(0.005)
                assert ack["processing"]["ml_failed"] == 2
                assert ack["counters"]["accepted"] == 2
                assert ack["counters"].get("errors", 0) == 0
            finally:
                for sock in sockets:
                    sock.close()
    finally:
        slow_ml.shutdown()
        thread.join(timeout=2)
        slow_ml.server_close()


def test_model_client_uses_direct_internal_http_despite_host_proxy(monkeypatch):
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            response = {"schema_version": "transport.ml-prediction.v1",
                        "sample_id": body["point"]["sample_id"],
                        "applicability": "unavailable", "quality": "unavailable",
                        "prediction_s": None, "model_version": "test",
                        "artifact_sha256": "test", "reason": "unsupported_day"}
            data = json.dumps(response).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *_):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:1")
        monkeypatch.setenv("NO_PROXY", "")
        client = ModelClient(f"http://127.0.0.1:{server.server_port}", 1)
        assert client.predict({"point": {"sample_id": "x"}})["reason"] == "unsupported_day"
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()


def test_live_utc_clock_does_not_remap_to_historical_model_day(tmp_path):
    data = tmp_path / "validate"
    data.mkdir()
    _plan(data / "schedule_plan.csv")
    (data / "traffic.csv").write_text("unit_id,tr_id\n1,v\n", encoding="utf-8")
    api = create_app(data_dir=tmp_path, source_clock="utc", ndtp_port=0)
    with TestClient(api) as client:
        assert client.get("/ready").json()["clock_mapping"] is None
        vehicle = client.get("/v1/vehicles").json()["vehicles"][0]
        assert vehicle["status"] == "unavailable"
        assert vehicle["reason"] == "unsupported_day"
        assert vehicle["prediction_s"] is None
        assert vehicle["input_frame_id"] is None
        assert vehicle["input_request_id"] is None
        assert vehicle["input_session_id"] is None
        assert vehicle["input_received_at_utc"] is None
        assert vehicle["prediction_input_frame_id"] is None
        assert vehicle["prediction_published_unix_ns"] is None
        assert client.post("/v1/replay/clock", json={"receive_time": "2026-01-06T00:00:00",
                        "unit_id": 1, "request_id": 2, "session_id": "s"}).status_code == 409
