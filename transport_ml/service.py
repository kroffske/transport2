"""HTTP boundary for the selected final model. Start with uvicorn transport_ml.service:app."""
from __future__ import annotations

from contextlib import asynccontextmanager
import os
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from .final_model import ArtifactUnavailable, FinalModel, SCHEMA_VERSION


class Point(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, strict=True)
    sample_id: str = Field(min_length=1)
    tr_id: str = Field(min_length=1)
    T: str = Field(description="Naive dataset-wall prediction time; no timezone conversion")
    target_stop_id: str = Field(min_length=1, description="tt_action_item_id of the planned arrival")
    target_time_begin: str = Field(description="Naive dataset-wall planned arrival in (T+600s, T+900s]")
    cur_dev_s: float


class Telemetry(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, strict=True)
    tr_id: str
    event_time: str
    receive_time: str
    location_valid: bool
    lon: float | None
    lat: float | None
    speed: float | None
    heading: float | None


class ScheduleArrival(BaseModel):
    # Historical CSVs may contain fact columns; they are discarded here.
    model_config = ConfigDict(extra="ignore", strict=True)
    tt_action_item_id: str
    tr_id: str
    time_begin: str
    geom: str


class PredictionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    point: Point
    telemetry: list[Telemetry] = Field(max_length=2000, description="Last 900 seconds of event/receive-time telemetry; may be empty")
    schedule_plan: list[ScheduleArrival] = Field(min_length=1, max_length=2000,
                                                  description="Known planned arrivals for this vehicle, including the exact target and predecessor; facts are ignored")


class PredictionResponse(BaseModel):
    schema_version: str
    model_version: str
    artifact_sha256: str
    sample_id: str
    prediction_s: float | None
    predicted_arrival: str | None
    applicability: Literal["supported", "unavailable"]
    quality: Literal["normal", "degraded", "unavailable"]
    reason: Literal["unsupported_vehicle", "unsupported_day", "stale_or_missing_telemetry"] | None


def create_app(model_dir: str | Path | None = None) -> FastAPI:
    directory = Path(model_dir if model_dir is not None else os.environ.get("MODEL_DIR", "artifacts/final"))

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        try:
            app.state.model = FinalModel(directory)
            app.state.artifact_error = None
        except ArtifactUnavailable as exc:
            app.state.model = None
            app.state.artifact_error = str(exc)
        yield

    api = FastAPI(title="Transport Final Model API", version=SCHEMA_VERSION, lifespan=lifespan)

    @api.get("/ready")
    def ready():
        model = api.state.model
        if model is None:
            raise HTTPException(status_code=503, detail=api.state.artifact_error)
        return {"status": "ready", "schema_version": SCHEMA_VERSION,
                "model_version": model.model_version, "artifact_sha256": model.artifact_sha256}

    @api.post("/v1/predict", response_model=PredictionResponse)
    def predict(request: PredictionRequest):
        model = api.state.model
        if model is None:
            raise HTTPException(status_code=503, detail=api.state.artifact_error)
        try:
            return model.predict(request.point.model_dump(),
                                 [row.model_dump() for row in request.telemetry],
                                 [row.model_dump() for row in request.schedule_plan])
        except (ValueError, KeyError, TypeError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except ArtifactUnavailable as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

    return api


app = create_app()
