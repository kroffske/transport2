"""Selected artifact, frozen predictor parity, and HTTP point-in-time contract."""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import subprocess
import sys

from fastapi.testclient import TestClient
import numpy as np
import pandas as pd
import pytest

from transport_ml.data import read_plan, read_points, read_traffic
from transport_ml.final_model import FinalModel
from transport_ml.features import FeatureBuilder
from transport_ml.data import prepare_traffic, prepare_plan
from transport_ml.service import create_app


ROOT = Path(__file__).resolve().parents[1]
DATA = Path(os.environ.get("DATA_DIR", ROOT / "data")) / "validate"
MODEL = Path(os.environ.get("MODEL_DIR", ROOT / "models/final"))
SHA = "dc33437108c3e036089450c9b98771dacd014246fbb91d0df2a89d0c8e247122"


@pytest.fixture(scope="module")
def inputs():
    if not all(path.exists() for path in (DATA / "points.csv", DATA / "schedule_plan.csv", DATA / "traffic.csv", MODEL / "final_model.cbm")):
        pytest.skip("Local official validate data and selected model are required")
    points = read_points(DATA / "points.csv")
    plan = read_plan(DATA / "schedule_plan.csv")
    traffic = read_traffic(DATA / "traffic.csv")
    return points, plan, traffic


def request_for(point, plan, traffic):
    vehicle = point.tr_id
    selected_plan = plan.loc[plan.tr_id == vehicle, ["tt_action_item_id", "tr_id", "time_begin", "geom"]].copy()
    selected_plan["time_begin"] = selected_plan["time_begin"].astype(str)
    selected_traffic = traffic.loc[(traffic.tr_id == vehicle)
                                   & (traffic.event_time > point["T"] - pd.Timedelta(seconds=900))
                                   & (traffic.event_time <= point["T"])].copy()
    for name in ("event_time", "receive_time"):
        selected_traffic[name] = selected_traffic[name].astype(str)
    selected_traffic = selected_traffic.astype(object).where(selected_traffic.notna(), None)
    return {"point": {"sample_id": point.sample_id, "tr_id": vehicle, "T": str(point["T"]),
                      "target_stop_id": point.target_stop_id, "target_time_begin": str(point.target_time_begin),
                      "cur_dev_s": float(point.cur_dev_s)},
            "telemetry": selected_traffic.to_dict("records"),
            "schedule_plan": selected_plan.to_dict("records")}


def test_frozen_oracle_package_and_http_all_validate_points(inputs, tmp_path):
    points, plan, traffic = inputs
    output = tmp_path / "oracle.csv"
    script = MODEL / "final_model.py"
    if not script.exists():
        pytest.skip("Frozen final_model.py oracle is required")
    env = {**os.environ, "PYTHONPATH": str(ROOT)}
    result = subprocess.run([sys.executable, str(script), "predict", "--output", str(output)],
                            cwd=ROOT, env=env, text=True, capture_output=True, check=True)
    assert "'rows': 151" in result.stdout
    oracle = pd.read_csv(output, sep=";", dtype={"sample_id": str}).set_index("sample_id")["prediction"]
    assert len(points) == len(oracle) == 151
    package = FinalModel(MODEL)
    package_delta, http_delta = [], []
    with TestClient(create_app(MODEL)) as client:
        ready = client.get("/ready")
        assert ready.status_code == 200
        assert ready.json()["artifact_sha256"] == SHA
        for _, point in points.iterrows():
            request = request_for(point, plan, traffic)
            expected = float(oracle.loc[point.sample_id])
            package_result = package.predict(**request)
            api = client.post("/v1/predict", json=request)
            assert api.status_code == 200, (point.sample_id, api.text)
            result = api.json()
            assert result["applicability"] == "supported"
            assert result["artifact_sha256"] == SHA
            assert set(result) == {"schema_version", "model_version", "artifact_sha256", "sample_id",
                                   "prediction_s", "predicted_arrival", "applicability", "quality", "reason"}
            package_delta.append(abs(package_result["prediction_s"] - expected))
            http_delta.append(abs(result["prediction_s"] - expected))
            assert result["prediction_s"] == package_result["prediction_s"]
            arrival = pd.Timestamp(result["predicted_arrival"])
            assert abs((arrival - point.target_time_begin).total_seconds() - result["prediction_s"]) <= 1e-6
    assert max(package_delta) <= 1e-6
    assert max(http_delta) <= 1e-6
    print(f"151 points: package max delta={max(package_delta):.9f}s, HTTP max delta={max(http_delta):.9f}s")


def test_future_late_correction_and_fact_mutations_do_not_change_prediction(inputs):
    points, plan, traffic = inputs
    request = request_for(points.iloc[0], plan, traffic)
    assert request["telemetry"]
    with TestClient(create_app(MODEL)) as client:
        baseline = client.post("/v1/predict", json=request)
        assert baseline.status_code == 200
        baseline_prediction = baseline.json()["prediction_s"]
        altered = copy.deepcopy(request)
        future = copy.deepcopy(altered["telemetry"][-1])
        future["event_time"] = str(points.iloc[0]["T"] + pd.Timedelta(seconds=1))
        future["receive_time"] = str(points.iloc[0]["T"])
        future["speed"] = 0.0
        altered["telemetry"].append(future)
        correction = copy.deepcopy(altered["telemetry"][-2])
        correction["receive_time"] = str(points.iloc[0]["T"] + pd.Timedelta(seconds=1))
        correction["speed"] = 0.0
        altered["telemetry"].append(correction)
        for row in altered["schedule_plan"]:
            row["time_fact_begin"] = "2099-01-01 00:00:00"
        result = client.post("/v1/predict", json=altered)
        assert result.status_code == 200, result.text
        assert result.json()["prediction_s"] == baseline_prediction


def test_unsupported_input_and_invalid_target(inputs):
    points, plan, traffic = inputs
    request = request_for(points.iloc[0], plan, traffic)
    with TestClient(create_app(MODEL)) as client:
        unknown = copy.deepcopy(request)
        unknown["point"]["tr_id"] = "not-known"
        result = client.post("/v1/predict", json=unknown)
        assert result.status_code == 200
        assert result.json()["reason"] == "unsupported_vehicle"
        assert result.json()["prediction_s"] is None
        another_day = copy.deepcopy(request)
        for key in ("T", "target_time_begin"):
            another_day["point"][key] = str(pd.Timestamp(another_day["point"][key]) + pd.Timedelta(days=30))
        result = client.post("/v1/predict", json=another_day)
        assert result.status_code == 200
        assert result.json()["reason"] == "unsupported_day"
        assert result.json()["prediction_s"] is None
        bad_target = copy.deepcopy(request)
        bad_target["point"]["target_stop_id"] = "wrong"
        assert client.post("/v1/predict", json=bad_target).status_code == 422
        invalid = copy.deepcopy(request)
        invalid["point"]["cur_dev_s"] = "not-a-number"
        assert client.post("/v1/predict", json=invalid).status_code == 422
        invalid = copy.deepcopy(request)
        invalid["telemetry"][0].pop("receive_time")
        assert client.post("/v1/predict", json=invalid).status_code == 422
        schema = client.get("/openapi.json").json()
        response_schema = schema["components"]["schemas"]["PredictionResponse"]
        assert not any(key in response_schema["properties"] for key in ("p_late", "q10_s", "q90_s", "alert", "explanation"))


def test_previous_day_telemetry_is_history_after_midnight(inputs):
    _, plan, _ = inputs
    vehicle = "130072"
    target = plan.loc[(plan.tr_id == vehicle) & (plan.time_begin == pd.Timestamp("2026-01-07 00:18:00"))].iloc[0]
    point = {"sample_id": "midnight-context", "tr_id": vehicle, "T": "2026-01-07 00:05:00",
             "target_stop_id": target.tt_action_item_id, "target_time_begin": str(target.time_begin),
             "cur_dev_s": 0.0}
    telemetry = [{"tr_id": vehicle, "event_time": "2026-01-06 23:59:30",
                  "receive_time": "2026-01-07 00:00:02", "location_valid": True,
                  "lon": 37.5, "lat": 55.7, "speed": 12.0, "heading": 90.0}]
    schedule = plan.loc[plan.tr_id == vehicle, ["tt_action_item_id", "tr_id", "time_begin", "geom"]].copy()
    schedule["time_begin"] = schedule["time_begin"].astype(str)
    feature = FeatureBuilder(prepare_traffic(pd.DataFrame(telemetry)), prepare_plan(schedule),
                             "received", feature_profile="motion-v1").transform(pd.DataFrame([point])).X.iloc[0]
    assert feature["telemetry_missing"] == 0
    assert feature["packet_age_s"] == 330
    with TestClient(create_app(MODEL)) as client:
        result = client.post("/v1/predict", json={"point": point, "telemetry": telemetry,
                                                   "schedule_plan": schedule.to_dict("records")})
        assert result.status_code == 200, result.text
        assert result.json()["applicability"] == "supported"
        assert np.isfinite(result.json()["prediction_s"])


def test_missing_and_corrupt_artifact_fail_readiness(inputs, tmp_path):
    for directory in (tmp_path / "missing", tmp_path / "corrupt", tmp_path / "corrupt-metadata"):
        directory.mkdir()
        if directory.name == "corrupt":
            (directory / "final_model.json").write_bytes((MODEL / "final_model.json").read_bytes())
            (directory / "final_model.cbm").write_bytes(b"corrupt")
            (directory / "vehicle_origins.csv").write_bytes((MODEL / "vehicle_origins.csv").read_bytes())
        if directory.name == "corrupt-metadata":
            metadata = json.loads((MODEL / "final_model.json").read_text())
            metadata["feature_columns"] = metadata["feature_columns"][:-1]
            (directory / "final_model.json").write_text(json.dumps(metadata))
            (directory / "final_model.cbm").symlink_to(MODEL / "final_model.cbm")
            (directory / "vehicle_origins.csv").write_bytes((MODEL / "vehicle_origins.csv").read_bytes())
        with TestClient(create_app(directory)) as client:
            assert client.get("/ready").status_code == 503
            request = request_for(inputs[0].iloc[0], inputs[1], inputs[2])
            assert client.post("/v1/predict", json=request).status_code == 503


def test_alternate_valid_origin_mapping_fails_readiness(inputs, tmp_path):
    (tmp_path / "final_model.json").write_bytes((MODEL / "final_model.json").read_bytes())
    (tmp_path / "final_model.cbm").symlink_to(MODEL / "final_model.cbm")
    origins = pd.read_csv(MODEL / "vehicle_origins.csv", dtype={"tr_id": str, "origin_vehicle": str})
    vehicle = inputs[0].iloc[0].tr_id
    original = origins.loc[origins.tr_id == vehicle, "origin_vehicle"].iloc[0]
    replacement = origins.loc[origins.origin_vehicle != original, "origin_vehicle"].iloc[0]
    origins.loc[origins.tr_id == vehicle, "origin_vehicle"] = replacement
    origins.to_csv(tmp_path / "vehicle_origins.csv", index=False)
    with TestClient(create_app(tmp_path)) as client:
        ready = client.get("/ready")
        assert ready.status_code == 503
        assert "vehicle_origins.csv differs" in ready.json()["detail"]
        request = request_for(inputs[0].iloc[0], inputs[1], inputs[2])
        assert client.post("/v1/predict", json=request).status_code == 503
