"""Serve a small live view of the Backend vehicle snapshot and route context."""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import os
from pathlib import Path
import re
from threading import Lock
from time import monotonic
from typing import Any
from urllib.parse import quote

from fastapi import FastAPI
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
import httpx


SCHEMA_VERSION = "transport.backend-vehicles.v1"
INDEX = Path(__file__).with_name("index.html")
ASSETS = Path(__file__).with_name("static")
MAP = Path(__file__).with_name("map")
# Files that make up the served dispatcher screen; their hashes identify the build a browser sees.
BUILD_FILES = ("index.html", "static/app.js", "static/app.css", "static/map-worker.js")
# `npm --prefix dashboard run build` outputs, in the order of the T-6 identity recipe.
DASHBOARD_BUNDLE = ("static/app.css", "static/app.js", "static/map-worker.js")
TR_ID = re.compile(r"^[0-9A-Za-z_-]{1,64}$")


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _shasum_listing(root: Path, names: list[str] | tuple[str, ...]) -> bytes:
    """Bytes `shasum -a 256 consumer/<name> ...` prints from the repository root."""
    return "".join(f"{_sha256((root / name).read_bytes())}  consumer/{name}\n"
                   for name in names).encode("utf-8")


def build_identity(root: Path, source_commit: str | None) -> dict[str, Any]:
    """Served-file hashes plus the T-6 build identity (m2.md recipe, same relative paths).

    ``dashboard_bundle_sha256`` hashes the listing of the three dashboard build
    outputs; ``consumer_static_sha256`` hashes the listing of ``index.html`` and
    every file in ``static/`` sorted by path. ``source_commit`` comes from the
    image build argument; without it the answer is ``unknown``, never a guess.
    """
    static = sorted(f"static/{path.name}" for path in (root / "static").iterdir()
                    if path.is_file() and not path.name.startswith("."))
    return {"files": {name: _sha256((root / name).read_bytes()) for name in BUILD_FILES},
            "source_commit": source_commit or "unknown",
            "dashboard_bundle_sha256": _sha256(_shasum_listing(root, DASHBOARD_BUNDLE)),
            "consumer_static_sha256": _sha256(_shasum_listing(root, ["index.html", *static]))}


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


class RouteReader:
    """Proxy one vehicle's route context; no cache, a failure is reported as offline."""

    def __init__(self, backend_url: str, timeout_s: float):
        if timeout_s <= 0:
            raise ValueError("BACKEND_TIMEOUT_S must be positive")
        self.url = backend_url.rstrip("/") + "/v1/route/"
        self.timeout_s = timeout_s

    def read(self, tr_id: str) -> tuple[int, dict[str, Any]]:
        checked_at = datetime.now(timezone.utc).isoformat()
        if not TR_ID.fullmatch(tr_id):
            return 404, {"status": "not_found", "reason": "invalid tr_id", "checked_at": checked_at}
        try:
            response = httpx.get(self.url + quote(tr_id, safe=""), timeout=self.timeout_s)
            if response.status_code == 404:
                detail = response.json().get("detail") if response.headers.get(
                    "content-type", "").startswith("application/json") else None
                return 404, {"status": "not_found", "reason": detail or "not_found",
                             "checked_at": checked_at}
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, dict) or payload.get("tr_id") != tr_id:
                raise ValueError("invalid Backend route identity")
            if (type(payload.get("vehicle_revision")) is not int
                    or not all(isinstance(payload.get(key), list) for key in ("path", "passed", "stops"))):
                raise ValueError("invalid Backend route shape")
        except (httpx.HTTPError, ValueError) as exc:
            return 503, {"status": "offline", "reason": str(exc), "checked_at": checked_at}
        return 200, {"status": "online", "reason": None, "checked_at": checked_at, **payload}


def create_app(backend_url: str | None = None, timeout_s: float | None = None,
               source_commit: str | None = None) -> FastAPI:
    backend_url = backend_url or os.environ.get("BACKEND_URL", "http://backend:8001")
    timeout_s = timeout_s if timeout_s is not None else float(os.environ.get("BACKEND_TIMEOUT_S", "1.0"))
    source_commit = source_commit if source_commit is not None else os.environ.get("SOURCE_COMMIT")
    reader = SnapshotReader(backend_url, timeout_s)
    routes = RouteReader(backend_url, timeout_s)
    app = FastAPI(title="Transport live consumer")
    app.mount("/static", StaticFiles(directory=ASSETS), name="static")
    app.mount("/map", StaticFiles(directory=MAP), name="map")

    @app.get("/", response_class=HTMLResponse)
    def index() -> str:
        return INDEX.read_text(encoding="utf-8")

    @app.get("/api/snapshot")
    def snapshot() -> dict[str, Any]:
        return reader.read()

    @app.get("/api/route/{tr_id}")
    def route(tr_id: str) -> JSONResponse:
        status, body = routes.read(tr_id)
        return JSONResponse(status_code=status, content=body)

    @app.get("/api/build")
    def build() -> dict[str, Any]:
        # Hashed on every request, so the answer always matches the bytes being served.
        return build_identity(INDEX.parent, source_commit)

    @app.get("/ready")
    def ready() -> dict[str, str]:
        return {"status": "ready"}

    return app


app = create_app()
