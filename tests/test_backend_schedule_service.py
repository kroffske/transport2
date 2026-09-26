"""Backend target, causal prediction, replay control and degradation behavior."""

from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import socket
from threading import Thread
import time

from fastapi.testclient import TestClient
import pandas as pd

from scripts.replay_ndtp import handshake, navigation
from transport_backend.ingest import NDTPServer
from transport_backend.orchestration import ModelClient, ModelFailure, Orchestrator
from transport_backend.schedule import Schedule
from transport_backend.service import ReplayClock, create_app
from transport_backend.state import ClockMapping, Telemetry, TelemetryState
from transport_ml.data import read_plan


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


def test_prediction_uses_only_available_fields_and_outage_retains_last_success(tmp_path):
    path = tmp_path / "schedule_plan.csv"
    _plan(path)
    schedule = Schedule(read_plan(path))
    state = TelemetryState({1: "v"}, source_clock="dataset_wall")
    state.connected(1, "s")
    assert state.accept(_record())
    # This correction has a past event but has not been received at prediction T.
    assert state.accept(_record(event="2026-01-06 00:00:40",
                                receive="2026-01-06 00:02:30", lon=37.001, request_id=3))
    clock = ReplayClock(datetime(2026, 1, 6, 0, 1))
    server = NDTPServer(state, mapping=ClockMapping(1_700_000_000, datetime(2026, 1, 6)),
                        clock=clock.now)
    model = _Model()
    flow = Orchestrator(state, server, schedule, clock.now, model, predict_interval_s=10)
    first = next(v for v in flow.snapshot()["vehicles"] if v["tr_id"] == "v")
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
    clock.advance(datetime(2026, 1, 6, 0, 1, 5), 1, 3, 0)
    assert flow.snapshot()["revision"] == first["revision"]
    assert len(model.requests) == 1
    clock.acknowledge([{"revision": 1, "unit_id": 1, "request_id": 3, "outcome": "duplicate"}])
    model.fail = True
    assert state.accept(_record(event="2026-01-06 00:01:19",
                                receive="2026-01-06 00:01:19", lon=37.05,
                                speed=20.0, request_id=4))
    clock.advance(datetime(2026, 1, 6, 0, 1, 20), 1, 4, 0)
    failed = flow.snapshot()["vehicles"][0]
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
    clock.acknowledge([{"revision": 1, "unit_id": 1, "request_id": 4, "outcome": "accepted"}])
    assert state.accept(_record(event="2026-01-06 00:01:39",
                                receive="2026-01-06 00:01:39", lon=37.06,
                                speed=20.0, request_id=5))
    clock.advance(datetime(2026, 1, 6, 0, 1, 40), 1, 5, 1)
    recovered = flow.snapshot()["vehicles"][0]
    assert recovered["status"] == "normal"
    assert recovered["last_success_at"] != first["last_success_at"]
    assert recovered["alert"] == first["alert"]  # cooldown prevents repeat signal


def test_replay_clock_socket_ack_duplicate_and_rejects_concurrent_step(tmp_path):
    data = tmp_path / "validate"
    data.mkdir()
    _plan(data / "schedule_plan.csv")
    (data / "traffic.csv").write_text("unit_id,tr_id\n1,v\n", encoding="utf-8")
    api = create_app(data_dir=tmp_path, model_url="http://127.0.0.1:1",
                     source_clock="dataset_wall", ndtp_port=0)
    with TestClient(api) as client:
        ready = client.get("/ready").json()
        with socket.create_connection((ready["ndtp_host"], ready["ndtp_port"])) as sock:
            sock.sendall(handshake(1))
            payload = {"receive_time": "2026-01-06T00:00:31", "unit_id": 1, "request_id": 2}
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
            vehicle = client.get("/v1/vehicles").json()["vehicles"][0]
            assert vehicle["cur_dev_s"] == 30.0
            assert vehicle["prediction_s"] is None
            assert vehicle["reason"] == "ml_unreachable_or_timeout"


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
        vehicle = client.get("/v1/vehicles").json()["vehicles"][0]
        assert vehicle["status"] == "unavailable"
        assert vehicle["reason"] == "unsupported_day"
        assert vehicle["prediction_s"] is None
        assert client.post("/v1/replay/clock", json={"receive_time": "2026-01-06T00:00:00",
                        "unit_id": 1, "request_id": 2}).status_code == 409
