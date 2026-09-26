"""Exercise live consumer polling against an actual local Backend HTTP server."""

from __future__ import annotations

from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import shutil
import subprocess
from threading import Thread
import time

from fastapi.testclient import TestClient
import pytest

from consumer.service import create_app


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

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            assert self.path == "/v1/vehicles"
            if self.server.mode == "timeout":
                time.sleep(0.2)
            status = 503 if self.server.mode == "unavailable" else 200
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
        assert "fetch('/api/snapshot'" in page.text
        assert "id=\"vehicles\"" in page.text
        assert consumer.get("/ready").json() == {"status": "ready"}

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
        assert "последний известный" in consumer.get("/").text


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
        assert "последняя достоверная; возраст GPS" in consumer.get("/").text


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


@pytest.mark.skipif(shutil.which("node") is None, reason="Node is required to exercise browser polling JavaScript")
def test_browser_polling_failure_timeout_and_recovery():
    page = Path(__file__).parents[1] / "consumer" / "index.html"
    source = re.search(r"<script>(.*?)</script>", page.read_text(), re.S).group(1)
    # Execute the shipped script; emulate only browser I/O, DOM and wall time.
    driver = r"""
    const {readFileSync} = require('node:fs');
    const vm = require('node:vm');
    const assert = require('node:assert/strict');
    const input = JSON.parse(readFileSync(0, 'utf8'));
    let now = 0;
    class Element {
      constructor() { this.children = []; this.textContent = ''; this.className = ''; }
      appendChild(child) { this.children.push(child); }
      replaceChildren() { this.children = []; }
      get firstChild() { return this.children[0]; }
    }
    const elements = new Map();
    const byId = id => {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    };
    const requests = [], timeouts = new Map();
    let timerId = 0;
    const context = vm.createContext({
      document: {getElementById: byId, createElement: () => new Element()},
      Date: class extends Date { static now() { return now; } }, AbortController,
      // Deliberately allow a late response after abort to test freshness protection.
      fetch: (url, options) => new Promise((resolve, reject) => requests.push({resolve, reject, ...options})),
      setTimeout: callback => { timeouts.set(++timerId, callback); return timerId; },
      clearTimeout: id => timeouts.delete(id), setInterval: () => {},
    });
    const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
    const respond = data => ({ok: true, json: async () => data});
    const rowText = () => byId('vehicles').children[0].children.map(cell => cell.textContent).join(' ');
    (async () => {
      vm.runInContext(input.source, context);
      assert.equal(requests.length, 1);
      now = 1000;
      requests[0].resolve(respond(input.normal));
      await flush();
      assert.equal(byId('connection').textContent, 'Backend online');
      assert.equal(byId('snapshot-age').textContent, '1.0 s', 'include response delivery age');
      assert(!rowText().includes('последний известный'));

      const failedPoll = context.poll();
      requests[1].resolve({ok: false, status: 503});
      await failedPoll;
      assert(byId('connection').textContent.includes('Consumer offline'));
      assert.equal(byId('fetched-at').textContent, input.normal.fetched_at);
      assert(rowText().includes('последний известный'));
      assert.equal(byId('vehicles').children[0].className, 'stale');
      now = 4000;
      context.updateAge();
      assert.equal(byId('snapshot-age').textContent, '4.0 s');

      const hangingPoll = context.poll();
      await context.poll();
      assert.equal(requests.length, 3, 'only one request may be in flight');
      [...timeouts.values()][0]();
      now = 6500;
      requests[2].resolve(respond(input.normal));
      await hangingPoll;
      assert(byId('connection-reason').textContent.includes('timed out'));
      assert.equal(byId('fetched-at').textContent, input.normal.fetched_at);
      assert.equal(byId('snapshot-age').textContent, '6.5 s');
      assert(rowText().includes('последний известный'));

      const recoveredPoll = context.poll();
      const recovered = JSON.parse(JSON.stringify(input.normal));
      recovered.fetched_at = new Date(now).toISOString();
      recovered.snapshot.revision = 17;
      recovered.snapshot.vehicles[0].prediction_s = 213;
      requests[3].resolve(respond(recovered));
      await recoveredPoll;
      assert.equal(byId('connection').textContent, 'Backend online');
      assert.equal(byId('revision').textContent, '17');
      assert.equal(byId('snapshot-age').textContent, '0.0 s');
      assert.equal(byId('vehicles').children[0].className, '');
      assert(!rowText().includes('последний известный'));

      const backendOfflinePoll = context.poll();
      requests[4].resolve(respond({...recovered, status: 'offline', age_s: 5, reason: 'Backend HTTP 503'}));
      await backendOfflinePoll;
      assert(byId('connection').textContent.includes('Backend offline'));
      assert(rowText().includes('последний известный'));
      assert.equal(byId('snapshot-age').textContent, '5.0 s');
    })().catch(error => { console.error(error); process.exitCode = 1; });
    """
    result = subprocess.run([shutil.which("node"), "-e", driver], input=json.dumps({
        "source": source,
        "normal": {"status": "online", "snapshot": snapshot(16, 187.5),
                   "fetched_at": "1970-01-01T00:00:00+00:00", "age_s": 0, "reason": None},
    }), text=True, capture_output=True, timeout=10)
    assert result.returncode == 0, result.stderr
