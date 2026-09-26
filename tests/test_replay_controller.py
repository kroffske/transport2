"""Sender rejects clock drift and acknowledgments from another TCP session."""

from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from threading import Thread

import pandas as pd
import pytest

from scripts.replay_ndtp import validate_backend_clock, wait_for_ack, wait_for_session


@contextmanager
def controller(ready=None, readbacks=None):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/ready":
                payload = self.server.ready
            else:
                payload = self.server.readbacks[0]
                if len(self.server.readbacks) > 1:
                    self.server.readbacks.pop(0)
            self.server.calls += 1
            body = json.dumps(payload).encode()
            self.send_response(200)
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.ready = ready or {"source_clock": "dataset_wall", "clock_mapping": {
        "dataset_origin": "2026-01-06T00:00:00", "epoch_origin": 1700000000}}
    server.readbacks = list(readbacks or [])
    server.calls = 0
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server, f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def outcome(session, kind="accepted"):
    return {"revision": 1, "unit_id": 7, "request_id": 2,
            "session_id": session, "outcome": kind}


def test_sender_requires_matching_backend_clock_origin():
    with controller() as (_, url):
        validate_backend_clock(url, pd.Timestamp("2026-01-06"), 1700000000, 1)
        with pytest.raises(ValueError, match="clock origins differ"):
            validate_backend_clock(url, pd.Timestamp("2026-01-06"), 1700003600, 1)
    with controller(ready={"source_clock": "utc", "clock_mapping": None}) as (_, url):
        with pytest.raises(ValueError, match="clock origins differ"):
            validate_backend_clock(url, pd.Timestamp("2026-01-06"), 1700000000, 1)


def test_ack_from_other_session_cannot_complete_sender_step():
    readbacks = [{"outcome_gap": False, "outcomes": [outcome("old-session")]},
                 {"outcome_gap": False, "outcomes": [outcome("own-session")]}]
    with controller(readbacks=readbacks) as (server, url):
        result = wait_for_ack(url, 0, 7, 2, "own-session", 1)
        assert result["session_id"] == "own-session"
        assert server.calls == 2
    for readback, message in [({"outcome_gap": True, "outcomes": []}, "journal gap"),
                              ({"outcome_gap": False, "outcomes": [outcome("own-session", "dropped_queue_full")]},
                               "dropped_queue_full")]:
        with controller(readbacks=[readback]) as (_, url):
            with pytest.raises(RuntimeError, match=message):
                wait_for_ack(url, 0, 7, 2, "own-session", 1)


def test_sender_requires_unique_handshake_session():
    with controller(readbacks=[{"active_sessions": {"7": ["own-session"]}}]) as (_, url):
        assert wait_for_session(url, 7, 0, 1) == "own-session"
    with controller(readbacks=[{"active_sessions": {"7": ["old", "new"]}}]) as (_, url):
        with pytest.raises(RuntimeError, match="Multiple active"):
            wait_for_session(url, 7, 0, 1)
