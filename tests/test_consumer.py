"""Exercise live consumer polling against an actual local Backend HTTP server."""

from __future__ import annotations

from contextlib import contextmanager
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import shutil
import subprocess
from threading import Thread
import time

import pytest
from fastapi.testclient import TestClient

from consumer.service import create_app

REPO = Path(__file__).resolve().parents[1]


def vehicle(prediction: float | None, revision: int, status: str = "normal") -> dict:
    return {
        "tr_id": "131672", "unit_id": 123, "lon": 37.6, "lat": 55.7,
        "location_valid": True, "event_time": "2026-01-06T03:34:55",
        "receive_time": "2026-01-06T03:35:00", "gps_age_s": 5.0,
        "target_stop_id": "53700172828", "target_time_begin": "2026-01-06T03:50:00",
        "cur_dev_s": 95.0, "cur_dev_source": "computed_stop",
        "prediction_s": prediction, "predicted_arrival": "2026-01-06T03:52:00" if prediction is not None else None,
        "model_version": "canonical_rmse_d8" if prediction is not None else None,
        "status": status, "reason": None if status == "normal" else "ml_timeout",
        "last_success_at": "2026-01-06T03:35:00", "revision": revision,
    }


def snapshot(revision: int, prediction: float | None, status: str = "normal") -> dict:
    return {
        "schema_version": "transport.backend-vehicles.v1", "revision": revision,
        "source_clock": "dataset_wall", "clock_time": "2026-01-06T03:35:00",
        "vehicles": [vehicle(prediction, revision, status)],
        "ingest": {"accepted": revision, "dropped": 0, "errors": 0, "queue_depth": 0},
    }


@contextmanager
def fake_backend():
    class Backend(ThreadingHTTPServer):
        mode = "ok"
        payload = snapshot(12, 120.0)
        routes: dict[str, dict] = {}
        overview: object = None

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.server.mode == "timeout":
                time.sleep(0.2)
            status = 503 if self.server.mode == "unavailable" else 200
            if self.path == "/v1/routes":
                body = json.dumps(self.server.overview).encode()
            elif self.path.startswith("/v1/route/"):
                route = self.server.routes.get(self.path.removeprefix("/v1/route/"))
                if status == 200 and route is None:
                    status, route = 404, {"detail": "unknown_tr_id"}
                body = json.dumps(route).encode()
            else:
                assert self.path == "/v1/vehicles"
                body = json.dumps(self.server.payload).encode()
            try:
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except BrokenPipeError:
                pass

        def log_message(self, *args):
            pass

    server = Backend(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server, f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=1)


def test_revisions_predictions_outages_and_recovery_over_http():
    with fake_backend() as (backend, url), TestClient(create_app(url, timeout_s=0.05)) as consumer:
        page = consumer.get("/")
        assert page.status_code == 200
        assert consumer.get("/static/app.js").status_code == 200
        assert consumer.get("/map/manifest.json").status_code == 200
        assert consumer.get("/map/moscow.pmtiles", headers={"range": "bytes=0-126"}).status_code == 206
        assert "id=\"vehicles\"" in page.text
        assert consumer.get("/ready").json() == {"status": "ready"}
        served = consumer.get("/static/app.js").content
        build = consumer.get("/api/build").json()["files"]
        assert set(build) == {"index.html", "static/app.js", "static/app.css", "static/map-worker.js"}
        assert build["static/app.js"] == hashlib.sha256(served).hexdigest()

        first = consumer.get("/api/snapshot").json()
        assert first["status"] == "online"
        assert first["snapshot"]["revision"] == 12
        assert first["snapshot"]["vehicles"][0]["prediction_s"] == 120.0
        assert first["age_s"] == 0

        backend.payload = snapshot(13, 187.5)
        second = consumer.get("/api/snapshot").json()
        assert second["status"] == "online"
        assert second["snapshot"]["revision"] == 13
        assert second["snapshot"]["vehicles"][0]["prediction_s"] == 187.5

        backend.mode = "timeout"
        time.sleep(0.02)
        timed_out = consumer.get("/api/snapshot").json()
        assert timed_out["status"] == "offline"
        assert "timed out" in timed_out["reason"].lower()
        assert timed_out["snapshot"] == second["snapshot"]
        assert timed_out["fetched_at"] == second["fetched_at"]
        assert timed_out["age_s"] > 0

        backend.mode = "unavailable"
        unavailable = consumer.get("/api/snapshot").json()
        assert unavailable["status"] == "offline"
        assert "503" in unavailable["reason"]
        assert unavailable["snapshot"]["revision"] == 13
        assert unavailable["fetched_at"] == second["fetched_at"]
        assert unavailable["age_s"] >= timed_out["age_s"]

        backend.mode = "ok"
        backend.payload = snapshot(14, 213.0)
        recovered = consumer.get("/api/snapshot").json()
        assert recovered["status"] == "online"
        assert recovered["snapshot"]["revision"] == 14
        assert recovered["snapshot"]["vehicles"][0]["prediction_s"] == 213.0
        assert recovered["fetched_at"] != second["fetched_at"]
        assert recovered["age_s"] == 0


def test_backend_degraded_and_missing_values_are_not_replaced():
    with fake_backend() as (backend, url), TestClient(create_app(url)) as consumer:
        backend.payload = snapshot(15, 187.5, "degraded")
        backend.payload["vehicles"][0].update({
            "lon": None, "lat": None, "location_valid": False,
            "cur_dev_s": None, "model_version": None,
        })
        result = consumer.get("/api/snapshot").json()
        assert result["status"] == "online"
        row = result["snapshot"]["vehicles"][0]
        assert row["status"] == "degraded"
        assert row["reason"] == "ml_timeout"
        assert row["cur_dev_s"] is None
        assert row["location_valid"] is False
        assert row["prediction_s"] == 187.5


def test_invalid_latest_location_keeps_last_valid_coordinates_and_age():
    with fake_backend() as (backend, url), TestClient(create_app(url)) as consumer:
        backend.payload = snapshot(16, 187.5, "degraded")
        backend.payload["vehicles"][0].update({
            "location_valid": False, "lon": 37.6, "lat": 55.7, "gps_age_s": 42.0,
            "reason": "invalid_latest_gps",
        })
        result = consumer.get("/api/snapshot").json()
        row = result["snapshot"]["vehicles"][0]
        assert result["status"] == "online"
        assert (row["lon"], row["lat"], row["gps_age_s"]) == (37.6, 55.7, 42.0)
        assert row["location_valid"] is False
        assert row["status"] == "degraded"


def test_initial_failure_and_bad_schema_do_not_claim_fresh_data():
    with fake_backend() as (backend, url), TestClient(create_app(url)) as consumer:
        backend.mode = "unavailable"
        failed = consumer.get("/api/snapshot").json()
        assert failed["status"] == "offline"
        assert failed["snapshot"] is None
        assert failed["fetched_at"] is None
        assert failed["age_s"] is None
        assert consumer.get("/ready").json() == {"status": "ready"}

        backend.mode = "ok"
        backend.payload = snapshot(16, None)
        online = consumer.get("/api/snapshot").json()
        assert online["snapshot"]["vehicles"][0]["prediction_s"] is None
        backend.payload = {"schema_version": "unexpected", "revision": 17, "vehicles": []}
        bad_schema = consumer.get("/api/snapshot").json()
        assert bad_schema["status"] == "offline"
        assert "schema_version" in bad_schema["reason"]
        assert bad_schema["snapshot"] == online["snapshot"]


def route(tr_id: str = "131672", revision: int = 12) -> dict:
    return {"run_id": "run-20260927T120501-3f9c", "tr_id": tr_id, "unit_id": 123,
            "vehicle_revision": revision, "path": [[37.6, 55.7], [37.61, 55.71]],
            "passed": [[37.6, 55.7, "03:34:55"]],
            "stops": [{"stop_id": "53700172828", "time": "03:50:00", "lon": 37.62, "lat": 55.72,
                       "role": "target"}],
            "stops_dropped": 0, "target_stop_id": "53700172828", "cur_dev_s": 95.0,
            "prediction_s": 120.0, "model_version": "canonical_rmse_d8", "artifact_sha256": "dc33"}


def test_route_proxy_online_not_found_and_offline_without_invented_data():
    with fake_backend() as (backend, url), TestClient(create_app(url, timeout_s=0.05)) as consumer:
        backend.routes = {"131672": route()}
        online = consumer.get("/api/route/131672")
        assert online.status_code == 200
        body = online.json()
        assert body["status"] == "online" and body["reason"] is None
        assert {key: body[key] for key in route()} == route()

        missing = consumer.get("/api/route/999")
        assert missing.status_code == 404
        assert missing.json()["status"] == "not_found" and missing.json()["reason"] == "unknown_tr_id"
        assert consumer.get("/api/route/..%2Fvehicles").status_code == 404

        backend.routes = {"131672": {**route(), "tr_id": "other"}}
        wrong = consumer.get("/api/route/131672")
        assert wrong.status_code == 503 and "identity" in wrong.json()["reason"]

        backend.routes = {"131672": route()}
        backend.mode = "unavailable"
        offline = consumer.get("/api/route/131672")
        assert offline.status_code == 503
        assert offline.json()["status"] == "offline" and "503" in offline.json()["reason"]
        assert "path" not in offline.json()  # no last-known route is invented
        backend.mode = "timeout"
        assert consumer.get("/api/route/131672").json()["status"] == "offline"


def test_build_identity_keeps_files_and_matches_host_recipe(monkeypatch):
    monkeypatch.delenv("SOURCE_COMMIT", raising=False)
    with fake_backend() as (_, url), TestClient(create_app(url)) as consumer:
        unknown = consumer.get("/api/build").json()
    assert set(unknown) == {"files", "source_commit", "dashboard_bundle_sha256", "consumer_static_sha256"}
    assert unknown["source_commit"] == "unknown"
    assert set(unknown["files"]) == {"index.html", "static/app.js", "static/app.css", "static/map-worker.js"}
    with fake_backend() as (_, url), TestClient(create_app(url, source_commit="abc123-dirty")) as consumer:
        known = consumer.get("/api/build").json()
    assert known["source_commit"] == "abc123-dirty"
    assert known["dashboard_bundle_sha256"] == unknown["dashboard_bundle_sha256"]
    if shutil.which("shasum") is None:
        pytest.skip("host recipe needs shasum")
    # T-6 m2.md recipe, run verbatim from the repository root.
    recipe = {
        "dashboard_bundle_sha256": "shasum -a 256 consumer/static/app.css consumer/static/app.js "
                                   "consumer/static/map-worker.js | shasum -a 256 | cut -d' ' -f1",
        "consumer_static_sha256": "shasum -a 256 consumer/index.html $(ls consumer/static/* | sort) "
                                  "| shasum -a 256 | cut -d' ' -f1",
    }
    for key, command in recipe.items():
        expected = subprocess.run(["sh", "-c", command], cwd=REPO, capture_output=True,
                                  text=True, check=True, env={"LC_ALL": "C", "PATH": "/usr/bin:/bin"}).stdout.strip()
        assert known[key] == expected, key


def test_routes_overview_proxy_online_and_offline_without_invented_lines():
    overview = {"run_id": "run-x", "clock_time": "2026-01-06T06:30:00",
                "window_start": "2026-01-06T06:15:00", "window_end": "2026-01-06T07:15:00",
                "routes": [{"tr_id": "131672", "unit_id": 123, "line": [[37.6, 55.7], [37.61, 55.71]],
                            "line_times": ["06:20:00", "06:40:00"], "off_route": False,
                            "route_offset_m": 20, "route_not_started": False}]}
    with fake_backend() as (backend, url), TestClient(create_app(url, timeout_s=0.05)) as consumer:
        backend.overview = overview
        online = consumer.get("/api/routes")
        assert online.status_code == 200
        assert online.json()["status"] == "online"
        assert {key: online.json()[key] for key in overview} == overview
        backend.overview = {**overview, "routes": [{"tr_id": "131672"}]}
        bad = consumer.get("/api/routes")
        assert bad.status_code == 503 and "routes shape" in bad.json()["reason"]
        backend.overview = overview
        backend.mode = "unavailable"
        offline = consumer.get("/api/routes")
        assert offline.status_code == 503 and offline.json()["status"] == "offline"
        assert "routes" not in offline.json()
