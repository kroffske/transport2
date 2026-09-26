"""Stateless ML API scaffold; NDTP TCP parsing and operational state belong to Backend.

Supply canonical last-15-minute telemetry and known schedule PLAN, not facts.
This endpoint is for integration testing, not an optimized high-throughput gateway.
"""
from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from .data import validate_points, prepare_traffic, prepare_plan
from .features import FeatureBuilder
from .inference import Predictor


class Point(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    sample_id: str
    tr_id: str
    T: str
    target_stop_id: str
    target_time_begin: str
    cur_dev_s: float


class PredictionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    point: Point
    telemetry: list[dict[str, Any]] = Field(default_factory=list, max_length=2000)
    schedule_plan: list[dict[str, Any]] = Field(default_factory=list, max_length=2000)


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.predictor = Predictor(os.environ.get("MODEL_DIR", "artifacts/context"))
    fallback = Path(os.environ.get("FALLBACK_MODEL_DIR", "artifacts/core"))
    app.state.fallback = Predictor(fallback) if (fallback/"model_meta.json").exists() else None
    if app.state.fallback is not None and app.state.fallback.meta["context"] != "labels-only":
        raise RuntimeError("Fallback must be a labels-only model")
    yield


app = FastAPI(title="Transport Delay ML", version="0.1.0", lifespan=lifespan)


@app.get("/health")
def health():
    return {"status": "ok", "model": app.state.predictor.meta["selected"],
            "availability_policy": app.state.predictor.meta["availability"]}


@app.post("/v1/predict")
def predict(request: PredictionRequest):
    try:
        point = validate_points(pd.DataFrame([request.point.model_dump()]))
        primary: Predictor = app.state.predictor
        context = primary.meta["context"] != "labels-only"
        traffic = prepare_traffic(pd.DataFrame(request.telemetry)) if request.telemetry and context else None
        plan = prepare_plan(pd.DataFrame(request.schedule_plan)) if request.schedule_plan and context else None
        batch = FeatureBuilder(traffic, plan, primary.meta["availability"], context_enabled=context,
                               feature_profile=primary.meta.get("feature_profile", "legacy")).transform(point)
        row = batch.X.iloc[0]
        age = row.get("packet_age_s", np.nan)
        nav_age = row.get("valid_position_age_s", np.nan)
        degraded = context and (not np.isfinite(age) or age>120 or not np.isfinite(nav_age) or nav_age>120 or row.get("plan_missing",1)>0)
        model = primary
        status = "normal"
        if degraded:
            status = "degraded"
            fallback = app.state.fallback
            if fallback is None:
                return {"sample_id": request.point.sample_id, "prediction_s": request.point.cur_dev_s,
                        "p_late": None, "alert": None, "status": status, "model": "cur_dev_fallback",
                        "pattern": "insufficient_fresh_data", "reason_is_causal": False,
                        "recommendation": "Проверьте связь и актуальность состояния ТС; отсутствие данных не означает низкий риск."}
            model = fallback
            batch = FeatureBuilder(context_enabled=False).transform(point)
        out = model.predict(batch)
        probability = float(out["p_late"][0])
        pattern = "no_specific_pattern"
        if not degraded and row.get("trailing_stop_s",0)>90:
            pattern = "prolonged_stationary_period"
        elif not degraded and row.get("w300_speed_mean",0)>5 and row.get("w60_speed_mean",np.inf)<.6*row.get("w300_speed_mean",0):
            pattern = "recent_speed_drop"
        elif request.point.cur_dev_s>120:
            pattern = "previous_stop_already_late"
        return {"sample_id": request.point.sample_id, "prediction_s": float(out["prediction"][0]),
                "predicted_arrival": str(point.iloc[0]["target_time_begin"]+pd.Timedelta(seconds=float(out["prediction"][0]))),
                "p_late": probability, "risk_calibrated": model.meta["risk_calibration"]["calibrated"],
                "q10_s": float(out["q10_s"][0]), "q90_s": float(out["q90_s"][0]),
                "interval_has_coverage_guarantee": False,
                "alert": bool(probability>=model.meta["alert_threshold"]) if not degraded else None,
                "status": status, "pattern": pattern, "reason_is_causal": False,
                "packet_age_s": float(age) if np.isfinite(age) else None,
                "model": model.meta["selected"], "feature_schema": model.meta["schema_version"],
                "availability_policy": model.meta["availability"],
                "recommendation": "Проверьте состояние ТС и участка; диспетчер подтверждает любое управляющее действие."}
    except (ValueError, KeyError, TypeError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
