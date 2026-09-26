"""Generate a strict sample_id;prediction submission from genuine scoring points."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import TypedDict
import numpy as np
import pandas as pd
from .data import read_points, read_traffic, read_plan, file_manifest
from .features import FeatureBuilder
from .inference import Predictor
from .audit import ModelExposure
from .train import TrainingConfig


class SubmissionReadback(TypedDict):
    rows: int
    columns: list[str]
    unique_ids: int
    finite_predictions: int
    template_order: bool


class SubmissionValidationReport(SubmissionReadback):
    source_manifest: list[dict[str, str | int]]
    model_file_manifest: list[dict[str, str | int]]
    model_metadata_manifest: dict[str, str | int]
    model_dir: str
    model_role: str
    availability: str
    training_config: TrainingConfig
    audit_exposure: ModelExposure
    status: str


def write_submission(sample_ids, predictions, template: pd.DataFrame, output: Path) -> pd.DataFrame:
    if list(template.columns) != ["sample_id", "prediction"]:
        raise ValueError("Template must have exactly sample_id;prediction columns")
    template = template.copy()
    template["sample_id"] = template["sample_id"].astype(str)
    ids = pd.Series(sample_ids, dtype=str).reset_index(drop=True)
    values = np.asarray(predictions, dtype=float)
    if len(ids) != len(values) or ids.duplicated().any() or template["sample_id"].duplicated().any():
        raise ValueError("Duplicate IDs or inconsistent prediction length")
    if ids.isna().any() or not np.isfinite(values).all():
        raise ValueError("Missing ID or nonfinite prediction")
    if set(ids) != set(template["sample_id"]):
        raise ValueError("Scoring point IDs do not exactly match the template; never invent missing rows")
    result = template[["sample_id"]].merge(pd.DataFrame({"sample_id": ids, "prediction": values}),
                                            on="sample_id", how="left", validate="one_to_one", sort=False)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix+".tmp")
    result.to_csv(temporary, sep=";", index=False, encoding="utf-8", float_format="%.6f")
    temporary.replace(output)
    return result


def validate_submission(path: Path, expected_ids: pd.Series) -> SubmissionReadback:
    """Reopen the physical CSV and validate the exact external contract."""
    result = pd.read_csv(path, sep=";", dtype={"sample_id": str})
    if list(result.columns) != ["sample_id", "prediction"]:
        raise ValueError("Submission must have exactly sample_id;prediction columns")
    if result.sample_id.isna().any() or result.sample_id.duplicated().any():
        raise ValueError("Submission contains missing or duplicate sample_id")
    if len(result) != len(expected_ids) or set(result.sample_id) != set(expected_ids.astype(str)):
        raise ValueError("Submission does not cover every validate sample_id exactly once")
    if result.sample_id.tolist() != expected_ids.astype(str).tolist():
        raise ValueError("Submission rows must follow exact template order")
    values = pd.to_numeric(result.prediction, errors="coerce").to_numpy(dtype=float)
    if not np.isfinite(values).all():
        raise ValueError("Submission contains a nonfinite or nonnumeric prediction")
    return {"rows": len(result), "columns": list(result), "unique_ids": int(result.sample_id.nunique()),
            "finite_predictions": int(np.isfinite(values).sum()),
            "template_order": True}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--data-dir", type=Path, required=True)
    p.add_argument("--model-dir", type=Path, required=True)
    p.add_argument("--output", type=Path, default=Path("submission.csv"))
    p.add_argument("--report", type=Path)
    args = p.parse_args()
    model = Predictor(args.model_dir)
    expected_models = {Path(item["file"]).name: (item["bytes"], item["sha256"])
                       for item in model.meta["model_file_manifest"]}
    actual_models = file_manifest(sorted(args.model_dir.glob("*.cbm")))
    actual_hashes = {Path(item["file"]).name: (item["bytes"], item["sha256"])
                     for item in actual_models}
    if actual_hashes != expected_models:
        raise ValueError("Saved .cbm files differ from model metadata manifest")
    point_path = args.data_dir/"validate"/"points.csv"
    template_path = args.data_dir/"sample_submission.csv"
    required = [point_path, template_path]
    context = model.meta["context"] != "labels-only"
    if context:
        required += [args.data_dir/"validate"/"traffic.csv", args.data_dir/"validate"/"schedule_plan.csv"]
    missing = [str(path) for path in required if not path.exists()]
    if missing:
        raise FileNotFoundError("Cannot generate a valid submission: missing " + ", ".join(missing))
    points = read_points(point_path)
    builder = FeatureBuilder(context_enabled=False)
    if context:
        builder = FeatureBuilder(read_traffic(required[2]), read_plan(required[3]), model.meta["availability"],
                                 feature_profile=model.meta.get("feature_profile", "legacy"))
    output = model.predict(builder.transform(points))
    template = pd.read_csv(template_path, sep=";", dtype={"sample_id": str})
    write_submission(points["sample_id"], output["prediction"], template, args.output)
    check = validate_submission(args.output, template.sample_id)
    report: SubmissionValidationReport = {
        **check, "source_manifest": file_manifest(required + [args.output]),
        "model_file_manifest": actual_models,
        "model_metadata_manifest": file_manifest([args.model_dir/"model_meta.json"])[0],
        "model_dir": str(args.model_dir), "model_role": model.meta["model_role"],
        "availability": model.meta["availability"],
        "training_config": model.meta["training_config"],
        "audit_exposure": model.meta["audit_exposure"],
        "status": "local_schema_and_coverage_validated; no platform readback"}
    report_path = args.report or args.output.with_suffix(".validation.json")
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Validated {report['rows']} finite predictions in template order at {args.output}")


if __name__ == "__main__":
    main()
