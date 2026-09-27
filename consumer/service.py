"""Serve a small live view of the Backend vehicle snapshot."""

from __future__ import annotations

from datetime import datetime, timezone
import os
from pathlib import Path
from threading import Lock
from time import monotonic
from typing import Any

from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
import httpx


SCHEMA_VERSION = "transport.backend-vehicles.v1"
INDEX = Path(__file__).with_name("index.html")
ASSETS = Path(__file__).with_name("static")
MAP = Path(__file__).with_name("map")


class SnapshotReader:
    """Own the last successful Backend response and its retrieval time."""

    def __init__(self, backend_url: str, timeout_s: float):
        if timeout_s <= 0:
            raise ValueError("BACKEND_TIMEOUT_S must be positive")
        self.url = backend_url.rstrip("/") + "/v1/vehicles"
        self.timeout_s = timeout_s
        self._lock = Lock()
        self._snapshot: dict[str, Any] | None = None
        self._fetched_at: str | None = None
        self._fetched_monotonic: float | None = None

    def read(self) -> dict[str, Any]:
        # Serialize requests so a slower response cannot replace a newer snapshot.
        with self._lock:
            checked_at = datetime.now(timezone.utc).isoformat()
            try:
                response = httpx.get(self.url, timeout=self.timeout_s)
                response.raise_for_status()
                payload = response.json()
                if not isinstance(payload, dict) or payload.get("schema_version") != SCHEMA_VERSION:
                    raise ValueError("invalid Backend schema_version")
                if type(payload.get("revision")) is not int or not isinstance(payload.get("vehicles"), list):
                    raise ValueError("invalid Backend snapshot shape")
                if not all(isinstance(vehicle, dict) for vehicle in payload["vehicles"]):
                    raise ValueError("invalid Backend vehicle shape")
            except (httpx.HTTPError, ValueError) as exc:
                age_s = (monotonic() - self._fetched_monotonic) if self._fetched_monotonic is not None else None
                return {
                    "status": "offline",
                    "reason": str(exc),
                    "checked_at": checked_at,
                    "fetched_at": self._fetched_at,
                    "age_s": age_s,
                    "snapshot": self._snapshot,
                }

            self._snapshot = payload
            self._fetched_at = datetime.now(timezone.utc).isoformat()
            self._fetched_monotonic = monotonic()
            return {
                "status": "online",
                "reason": None,
                "checked_at": checked_at,
                "fetched_at": self._fetched_at,
                "age_s": 0.0,
                "snapshot": payload,
            }


def create_app(backend_url: str | None = None, timeout_s: float | None = None) -> FastAPI:
    backend_url = backend_url or os.environ.get("BACKEND_URL", "http://backend:8001")
    timeout_s = timeout_s if timeout_s is not None else float(os.environ.get("BACKEND_TIMEOUT_S", "1.0"))
    reader = SnapshotReader(backend_url, timeout_s)
    app = FastAPI(title="Transport live consumer")
    app.mount("/static", StaticFiles(directory=ASSETS), name="static")
    app.mount("/map", StaticFiles(directory=MAP), name="map")

    @app.get("/", response_class=HTMLResponse)
    def index() -> str:
        return INDEX.read_text(encoding="utf-8")

    @app.get("/api/snapshot")
    def snapshot() -> dict[str, Any]:
        return reader.read()

    @app.get("/ready")
    def ready() -> dict[str, str]:
        return {"status": "ready"}

    return app


app = create_app()
