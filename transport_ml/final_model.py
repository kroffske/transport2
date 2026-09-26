"""Selected final-model artifact and canonical point-in-time inference.

The dataset timestamps are naive dataset-wall values. The fixed clock origin is
part of the frozen model's feature contract, not a timezone declaration.
"""
from __future__ import annotations

import json
from pathlib import Path

from catboost import CatBoostRegressor
import numpy as np
import pandas as pd

from .data import POINT_COLUMNS, file_manifest, prepare_plan, prepare_traffic, validate_points
from .features import FeatureBuilder

SCHEMA_VERSION = "transport.ml-prediction.v1"
ORIGINS_SHA256 = "cb5d80f1546a793494c80e108642418d330d675ddf616ec9f56815206eb1f3f8"
MODEL_CLOCK_ORIGIN = pd.Timestamp("2026-01-06")
SUPPORTED_PREDICTION_START = pd.Timestamp("2026-01-06 00:00:00")
SUPPORTED_PREDICTION_END = pd.Timestamp("2026-01-07 00:30:00")


class ArtifactUnavailable(RuntimeError):
    """The selected persisted model cannot be served safely."""


class FinalModel:
    def __init__(self, directory: str | Path):
        self.directory = Path(directory)
        try:
            self.metadata = json.loads((self.directory / "final_model.json").read_text())
            manifest = self.metadata["model_manifest"]
            model_path = self.directory / "final_model.cbm"
            actual = file_manifest([model_path])[0]
            if (actual["sha256"], actual["bytes"]) != (manifest["sha256"], manifest["bytes"]):
                raise ValueError("final_model.cbm differs from final_model.json manifest")
            if manifest["sha256"] != "dc33437108c3e036089450c9b98771dacd014246fbb91d0df2a89d0c8e247122":
                raise ValueError("MODEL_DIR does not contain the selected final model")
            if self.metadata["selected_candidate"] != "canonical_rmse_d8" or self.metadata["target"] != "direct":
                raise ValueError("Unsupported final model metadata")
            origins_path = self.directory / "vehicle_origins.csv"
            if file_manifest([origins_path])[0]["sha256"] != ORIGINS_SHA256:
                raise ValueError("vehicle_origins.csv differs from selected origin mapping")
            origins = pd.read_csv(origins_path, dtype={"tr_id": str, "origin_vehicle": str})
            if origins.duplicated("tr_id").any() or origins[["tr_id", "origin_vehicle", "shift_ns"]].isna().any().any():
                raise ValueError("Invalid vehicle_origins.csv")
            shifts = pd.to_numeric(origins["shift_ns"], errors="raise")
            if not np.isfinite(shifts).all() or not (shifts == shifts.astype("int64")).all():
                raise ValueError("Invalid vehicle_origins.csv shift_ns")
            origins["shift_ns"] = shifts.astype("int64")
            self.origins = origins.set_index("tr_id")
            self.model = CatBoostRegressor().load_model(str(model_path))
            if self.metadata["feature_columns"] != self.model.feature_names_:
                raise ValueError("final_model.json feature columns differ from final_model.cbm")
            self.artifact_sha256 = actual["sha256"]
            self.model_version = self.metadata["selected_candidate"]
        except (OSError, KeyError, TypeError, ValueError) as exc:
            raise ArtifactUnavailable(f"MODEL_DIR {self.directory}: {exc}") from exc

    def predict(self, point: dict, telemetry: list[dict], schedule_plan: list[dict]) -> dict:
        points = validate_points(pd.DataFrame([point]))[POINT_COLUMNS]
        p = points.iloc[0]
        response = {"schema_version": SCHEMA_VERSION, "model_version": self.model_version,
                    "artifact_sha256": self.artifact_sha256, "sample_id": p.sample_id,
                    "prediction_s": None, "predicted_arrival": None,
                    "applicability": "unavailable", "quality": "unavailable", "reason": None}
        origin = self.origins.loc[p.tr_id] if p.tr_id in self.origins.index else None
        if origin is None:
            response["reason"] = "unsupported_vehicle"
            return response
        shift = pd.Timedelta(int(origin.shift_ns), unit="ns")
        canonical_T = p["T"] - shift
        canonical_target = p.target_time_begin - shift
        if not (SUPPORTED_PREDICTION_START <= canonical_T <= SUPPORTED_PREDICTION_END
                and canonical_target >= SUPPORTED_PREDICTION_START):
            response["reason"] = "unsupported_day"
            return response
        plan = prepare_plan(pd.DataFrame(schedule_plan))
        target = plan.loc[(plan.tr_id == p.tr_id) & (plan.tt_action_item_id == p.target_stop_id)]
        if len(target) != 1 or target.iloc[0].time_begin != p.target_time_begin:
            raise ValueError("point target_stop_id/target_time_begin disagrees with schedule_plan")
        if not np.isfinite(target.iloc[0][["stop_lon", "stop_lat"]].to_numpy(dtype=float)).all():
            raise ValueError("point target has invalid schedule_plan geometry")
        traffic = prepare_traffic(pd.DataFrame(telemetry)) if telemetry else None
        X = FeatureBuilder(traffic, plan, "received", feature_profile="motion-v1").transform(points).X
        X["vehicle"] = str(origin.origin_vehicle)
        X["origin_target_time_s"] = (canonical_target.value - MODEL_CLOCK_ORIGIN.value) / 1e9
        X["origin_prediction_time_s"] = (canonical_T.value - MODEL_CLOCK_ORIGIN.value) / 1e9
        columns = self.metadata["feature_columns"]
        if set(columns) - set(X):
            raise ArtifactUnavailable("Final model feature schema mismatch")
        prediction = float(self.model.predict(X[columns], thread_count=2)[0])
        if not np.isfinite(prediction):
            raise ArtifactUnavailable("Final model returned nonfinite prediction")
        packet_age = float(X.iloc[0]["packet_age_s"])
        position_age = float(X.iloc[0]["valid_position_age_s"])
        fresh = np.isfinite(packet_age) and packet_age <= 120 and np.isfinite(position_age) and position_age <= 120
        response.update(prediction_s=prediction,
                        predicted_arrival=(p.target_time_begin + pd.Timedelta(seconds=prediction)).isoformat(),
                        applicability="supported", quality="normal" if fresh else "degraded",
                        reason=None if fresh else "stale_or_missing_telemetry")
        return response
