"""NDTP Backend HTTP API. Start with uvicorn transport_backend.service:app."""

from __future__ import annotations

from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime
import os
from pathlib import Path
from threading import RLock
from typing import Literal

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from transport_ml.data import read_plan

from .ingest import NDTPServer
from .orchestration import ModelClient, Orchestrator, RouteUnavailable
from .run import RunConflict, RunNotFound, RunPlan, RunRegistry
from .schedule import Schedule
from .state import ClockMapping, TelemetryState, load_unit_mapping


class ReplayClock:
    """Thread-safe source receive clock, advanced one acknowledged frame at a time."""

    def __init__(self, origin: datetime):
        self._time = origin
        self._pending: tuple[int, int, str, int] | None = None
        self._lock = RLock()

    def now(self) -> datetime:
        with self._lock:
            return self._time

    def advance(self, receive_time: datetime, unit_id: int, request_id: int,
                session_id: str, processed_revision: int) -> int:
        with self._lock:
            if self._pending is not None:
                raise ValueError("previous replay step is not acknowledged")
            if receive_time < self._time:
                raise ValueError("receive_time moves source clock backwards")
            self._time = receive_time
            self._pending = (unit_id, request_id, session_id, processed_revision)
            return processed_revision

    def acknowledge(self, outcomes: list[dict]) -> tuple[int, str] | None:
        with self._lock:
            if self._pending is None:
                return None
            unit_id, request_id, session_id, revision = self._pending
            for outcome in outcomes:
                if (outcome["revision"] > revision and outcome["unit_id"] == unit_id
                        and outcome["request_id"] == request_id
                        and outcome["session_id"] == session_id):
                    self._pending = None
                    return unit_id, str(outcome["outcome"])
            return None


class ReplayStep(BaseModel):
    receive_time: str
    unit_id: int = Field(ge=1)
    request_id: int = Field(ge=1, le=0xFFFFFFFF)
    session_id: str = Field(min_length=1, strict=True)


class RunRequest(BaseModel):
    """Driver registration of the process's single simulation run."""

    dataset_start: str
    dataset_end: str
    # Value bounds live in RunRegistry, after its conflict check: a second driver gets 409.
    speedup: int
    post_period_s: float
    units: list[int]
    # unit_id -> [[lon, lat], ...]: the driver's feeding plan, display-only.
    path: dict[int, list[tuple[float, float]]] = Field(default_factory=dict)
    source: Literal["official_emulator"] = "official_emulator"


class RunStateReport(BaseModel):
    """Driver heartbeat (``running``) or final state, with its pacing metrics."""

    state: Literal["running", "completed", "failed"]
    thinned_ratio: float = Field(ge=0, le=1)
    repeat_ratio: float = Field(ge=0, le=1)
    counters: dict[str, int] = Field(default_factory=dict)
    reason: str | None = Field(default=None, max_length=500)


@dataclass(frozen=True)
class Runtime:
    state: TelemetryState
    server: NDTPServer
    orchestrator: Orchestrator
    replay_clock: ReplayClock | None
    run: RunRegistry


def _dataset_time(value: str, name: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"invalid {name}") from exc
    if parsed.tzinfo is not None:
        raise HTTPException(status_code=422, detail=f"{name} must be naive dataset wall time")
    return parsed


def create_app(*, data_dir: str | Path | None = None, model_url: str | None = None,
               source_clock: Literal["dataset_wall", "utc", "simulation"] | None = None,
               ndtp_host: str | None = None, ndtp_port: int | None = None) -> FastAPI:
    data = Path(data_dir if data_dir is not None else os.environ.get("DATA_DIR", "data"))
    model_endpoint = model_url or os.environ.get("MODEL_URL", "http://127.0.0.1:8000")
    domain = source_clock or os.environ.get("SOURCE_CLOCK", "dataset_wall")
    if domain not in {"dataset_wall", "utc", "simulation"}:
        raise ValueError("SOURCE_CLOCK must be dataset_wall, utc or simulation")
    host = ndtp_host or os.environ.get("NDTP_HOST", "127.0.0.1")
    port = ndtp_port if ndtp_port is not None else int(os.environ.get("NDTP_PORT", "9201"))
    origin = datetime(2026, 1, 6)

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
                               reconnect_grace_s=float(os.environ.get("RECONNECT_GRACE_S", "3")),
                               source_clock=domain)
        replay_clock = ReplayClock(origin) if domain == "dataset_wall" else None
        stall_after_s = float(os.environ.get("RUN_STALL_AFTER_S", "30"))
        run = (RunRegistry(domain, mapping_table, mapping=ClockMapping(1_700_000_000, origin),
                           clock=replay_clock.now, stall_after_s=stall_after_s)
               if replay_clock is not None else
               RunRegistry(domain, mapping_table, stall_after_s=stall_after_s))
        server = NDTPServer(state, run=run, host=host, port=port,
                            queue_limit=int(os.environ.get("NDTP_QUEUE_LIMIT", "256")),
                            max_clients=int(os.environ.get("NDTP_MAX_CLIENTS", "64")))
        model = ModelClient(model_endpoint, float(os.environ.get("ML_TIMEOUT_S", "3")))
        orchestrator = Orchestrator(state, server, schedule, model,
                                    predict_interval_s=float(os.environ.get("PREDICT_INTERVAL_S", "60")),
                                    alert_cooldown_s=float(os.environ.get("ALERT_COOLDOWN_S", "300")),
                                    queue_limit=int(os.environ.get("ML_QUEUE_LIMIT", "32")),
                                    # Replay advances one acknowledged frame at a time; only the
                                    # emulator run needs its own tick.
                                    tick_interval_s=(float(os.environ.get("PREDICT_TICK_S", "1"))
                                                     if domain == "simulation" else None))
        api.state.backend = Runtime(state, server, orchestrator, replay_clock, run)
        orchestrator.start()
        try:
            server.start()
            yield
        finally:
            server.close()
            orchestrator.close()

    api = FastAPI(title="Transport Backend API", version="transport.backend-vehicles.v1",
                  lifespan=lifespan)

    def runtime() -> Runtime:
        return api.state.backend

    @api.get("/ready")
    def ready():
        rt = runtime()
        host, port = rt.server.address
        return {"status": "ready", "source_clock": domain,
                "ndtp_host": host, "ndtp_port": port,
                "clock_mapping": rt.run.mapping_readback(), "run": rt.run.readback()}

    @api.post("/v1/run", status_code=201)
    def register_run(request: RunRequest):
        rt = runtime()
        plan = RunPlan(_dataset_time(request.dataset_start, "dataset_start"),
                       _dataset_time(request.dataset_end, "dataset_end"),
                       request.speedup, request.post_period_s, tuple(request.units),
                       {unit: tuple(points) for unit, points in request.path.items()})
        try:
            return rt.run.register(plan)
        except RunConflict as exc:
            return JSONResponse(status_code=409, content={"detail": exc.detail, "run_id": exc.run_id})
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @api.post("/v1/run/{run_id}/state")
    def report_run_state(run_id: str, report: RunStateReport):
        rt = runtime()
        try:
            return rt.run.report(run_id, report.state, thinned_ratio=report.thinned_ratio,
                                 repeat_ratio=report.repeat_ratio, counters=report.counters,
                                 reason=report.reason)
        except RunNotFound as exc:
            raise HTTPException(status_code=404, detail="unknown_run_id") from exc
        except RunConflict as exc:
            return JSONResponse(status_code=409, content={"detail": exc.detail, "run_id": exc.run_id})

    @api.post("/v1/replay/clock")
    def advance_clock(step: ReplayStep):
        rt = runtime()
        state, controller = rt.state, rt.replay_clock
        if controller is None:
            raise HTTPException(status_code=409, detail="replay clock requires SOURCE_CLOCK=dataset_wall")
        at = _dataset_time(step.receive_time, "receive_time")
        if step.unit_id not in state.unit_mapping:
            raise HTTPException(status_code=422, detail="unknown unit_id")
        journal = state.ingest_readback()
        sessions = journal["active_sessions"].get(step.unit_id, [])
        if len(sessions) != 1 or sessions[0] != step.session_id:
            raise HTTPException(status_code=409, detail="unit_id must have exactly this one active session_id")
        prior = journal["processed_revision"]
        try:
            revision = controller.advance(at, step.unit_id, step.request_id, step.session_id, prior)
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {"processed_revision": revision}

    @api.get("/v1/ingest")
    def ingest(since_revision: int = Query(default=0, ge=0)):
        rt = runtime()
        readback = rt.state.ingest_readback(since_revision)
        if rt.replay_clock is not None:
            completed = rt.replay_clock.acknowledge(readback["outcomes"])
            if completed is not None and completed[1] == "accepted":
                rt.orchestrator.on_ingest(completed[0])
        readback["counters"] = rt.server.counters()
        readback["queue_depth"] = rt.server.queue.qsize()
        readback["processing"] = rt.orchestrator.processing_readback()
        readback["source_clock"] = domain
        readback["clock_mapping"] = rt.run.mapping_readback()
        readback["run"] = rt.run.readback()
        return readback

    @api.get("/v1/vehicles")
    def vehicles():
        return runtime().orchestrator.snapshot()

    @api.get("/v1/route/{tr_id}")
    def route(tr_id: str):
        try:
            return runtime().orchestrator.route(tr_id)
        except RouteUnavailable as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    return api


app = create_app()
