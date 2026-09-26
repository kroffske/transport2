"""NDTP Backend HTTP API. Start with uvicorn transport_backend.service:app."""

from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime, timezone
import os
from pathlib import Path
from threading import RLock
from typing import Literal

from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel, Field

from transport_ml.data import read_plan

from .ingest import NDTPServer
from .orchestration import ModelClient, Orchestrator
from .schedule import Schedule
from .state import ClockMapping, TelemetryState, load_unit_mapping


class ReplayClock:
    """Thread-safe source receive clock, advanced one acknowledged frame at a time."""

    def __init__(self, origin: datetime):
        self._time = origin
        self._pending: tuple[int, int, int] | None = None
        self._lock = RLock()

    def now(self) -> datetime:
        with self._lock:
            return self._time

    def advance(self, receive_time: datetime, unit_id: int, request_id: int,
                processed_revision: int) -> int:
        with self._lock:
            if self._pending is not None:
                raise ValueError("previous replay step is not acknowledged")
            if receive_time < self._time:
                raise ValueError("receive_time moves source clock backwards")
            self._time = receive_time
            self._pending = (unit_id, request_id, processed_revision)
            return processed_revision

    def acknowledge(self, outcomes: list[dict]) -> tuple[int, str] | None:
        with self._lock:
            if self._pending is None:
                return None
            unit_id, request_id, revision = self._pending
            for outcome in outcomes:
                if (outcome["revision"] > revision and outcome["unit_id"] == unit_id
                        and outcome["request_id"] == request_id):
                    self._pending = None
                    return unit_id, str(outcome["outcome"])
            return None


class ReplayStep(BaseModel):
    receive_time: str
    unit_id: int = Field(ge=1)
    request_id: int = Field(ge=1, le=0xFFFFFFFF)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def create_app(*, data_dir: str | Path | None = None, model_url: str | None = None,
               source_clock: Literal["dataset_wall", "utc"] | None = None,
               ndtp_host: str | None = None, ndtp_port: int | None = None) -> FastAPI:
    data = Path(data_dir if data_dir is not None else os.environ.get("DATA_DIR", "data"))
    model_endpoint = model_url or os.environ.get("MODEL_URL", "http://127.0.0.1:8000")
    domain = source_clock or os.environ.get("SOURCE_CLOCK", "dataset_wall")
    if domain not in {"dataset_wall", "utc"}:
        raise ValueError("SOURCE_CLOCK must be dataset_wall or utc")
    host = ndtp_host or os.environ.get("NDTP_HOST", "127.0.0.1")
    port = ndtp_port if ndtp_port is not None else int(os.environ.get("NDTP_PORT", "9201"))
    origin = datetime(2026, 1, 6)
    mapping = ClockMapping(1_700_000_000, origin) if domain == "dataset_wall" else None
    replay_clock = ReplayClock(origin) if domain == "dataset_wall" else None
    clock = replay_clock.now if replay_clock else _utc_now

    @asynccontextmanager
    async def lifespan(api: FastAPI):
        # Scan only the explicit unit/tr_id mapping; no traffic telemetry is loaded.
        mapping_table = load_unit_mapping([data / "validate" / "traffic.csv"])
        schedule = Schedule(read_plan(data / "validate" / "schedule_plan.csv"),
                            stop_radius_m=float(os.environ.get("STOP_RADIUS_M", "35")),
                            stop_speed_kmh=float(os.environ.get("STOP_SPEED_KMH", "3")),
                            observation_lag_s=float(os.environ.get("STOP_OBSERVATION_LAG_S", "900")))
        state = TelemetryState(mapping_table,
                               history_limit=int(os.environ.get("HISTORY_LIMIT", "4096")),
                               outcome_limit=int(os.environ.get("OUTCOME_LIMIT", "1024")),
                               stale_after_s=float(os.environ.get("STALE_AFTER_S", "45")),
                               source_clock=domain)
        server = NDTPServer(state, host=host, port=port, mapping=mapping,
                            clock=clock if replay_clock else None,
                            queue_limit=int(os.environ.get("NDTP_QUEUE_LIMIT", "256")),
                            max_clients=int(os.environ.get("NDTP_MAX_CLIENTS", "64")))
        model = ModelClient(model_endpoint, float(os.environ.get("ML_TIMEOUT_S", "3")))
        orchestrator = Orchestrator(state, server, schedule, clock, model,
                                    predict_interval_s=float(os.environ.get("PREDICT_INTERVAL_S", "60")),
                                    alert_cooldown_s=float(os.environ.get("ALERT_COOLDOWN_S", "300")))
        api.state.backend = (state, server, orchestrator, replay_clock)
        server.start()
        try:
            yield
        finally:
            server.close()

    api = FastAPI(title="Transport Backend API", version="transport.backend-vehicles.v1",
                  lifespan=lifespan)

    @api.get("/ready")
    def ready():
        _, server, _, _ = api.state.backend
        host, port = server.address
        return {"status": "ready", "source_clock": domain,
                "ndtp_host": host, "ndtp_port": port}

    @api.post("/v1/replay/clock")
    def advance_clock(step: ReplayStep):
        state, _, _, controller = api.state.backend
        if controller is None:
            raise HTTPException(status_code=409, detail="replay clock requires SOURCE_CLOCK=dataset_wall")
        try:
            at = datetime.fromisoformat(step.receive_time)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="invalid receive_time") from exc
        if at.tzinfo is not None:
            raise HTTPException(status_code=422, detail="receive_time must be naive dataset_wall")
        if step.unit_id not in state.unit_mapping:
            raise HTTPException(status_code=422, detail="unknown unit_id")
        prior = state.ingest_readback()["processed_revision"]
        try:
            revision = controller.advance(at, step.unit_id, step.request_id, prior)
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {"processed_revision": revision}

    @api.get("/v1/ingest")
    def ingest(since_revision: int = Query(default=0, ge=0)):
        state, server, orchestrator, controller = api.state.backend
        readback = state.ingest_readback(since_revision)
        if controller is not None:
            completed = controller.acknowledge(readback["outcomes"])
            if completed is not None and completed[1] == "accepted":
                orchestrator.on_ingest(completed[0])
        readback["counters"] = server.counters()
        readback["queue_depth"] = server.queue.qsize()
        return readback

    @api.get("/v1/vehicles")
    def vehicles():
        _, _, orchestrator, _ = api.state.backend
        return orchestrator.snapshot()

    return api


app = create_app()
