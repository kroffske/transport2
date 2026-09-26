"""Train evaluation model on frozen clock blocks and refit submission regressor.

Usage:
    python -m transport_ml.train --data-dir data --context train --availability received --out artifacts/run/evaluation_model

The selected point regressor is refit on all train labels into sibling
submission_model. Audit metrics belong only to evaluation_model. Existing risk
and quantile artifacts remain auxiliary to the T-3 delay-regression decision.
"""
from __future__ import annotations

import argparse
import json
import platform
import shutil
import time
from pathlib import Path
from typing import TypedDict
import numpy as np
import pandas as pd
import catboost
from catboost import CatBoostRegressor, CatBoostClassifier
from sklearn.linear_model import LogisticRegression
from .data import read_points, read_plan, read_traffic, prepare_plan, file_manifest
from .features import FeatureBuilder, FeatureBatch
from .inference import Predictor, calibrated_probability
from .validation import (chronological_blocks, regression_metrics, risk_metrics,
                         select_alert_threshold, interval_metrics, paired_vehicle_bootstrap)
from .audit import ModelExposure, audit_exposure


class CommandOptions(TypedDict):
    context: str
    availability: str
    iterations_max: int
    depth: int
    seed: int
    train_gru: bool
    epochs: int
    torch_device: str
    catboost_device: str
    alert_precision: float


class PointRegressionConfig(TypedDict):
    iterations: int | None
    depth: int
    learning_rate: float
    loss_function: str
    eval_metric: str | None
    l2_leaf_reg: int
    random_seed: int
    thread_count: int
    task_type: str
    allow_writing_files: bool
    early_stopping_rounds: int | None
    use_best_model: bool
    eval_partition: str | None
    fit_partition: str


class RiskConfig(TypedDict):
    iterations_max: int
    depth: int
    learning_rate: float
    loss_function: str
    eval_metric: str
    l2_leaf_reg: int
    target_late_threshold_s: int
    random_seed: int
    thread_count: int
    task_type: str
    allow_writing_files: bool
    early_stopping_rounds: int
    use_best_model: bool
    fit_partition: str
    eval_partition: str


class RiskCalibrationConfig(TypedDict):
    method: str
    C: float
    solver: str
    random_state: int
    fit_partition: str
    alert_precision_target: float


class QuantileConfig(TypedDict):
    iterations_max: int
    depth: int
    learning_rate: float
    loss_functions: list[str]
    eval_metrics: list[str]
    l2_leaf_reg: int
    random_seed: int
    thread_count: int
    task_type: str
    allow_writing_files: bool
    early_stopping_rounds: int
    use_best_model: bool
    fit_partition: str
    eval_partition: str


class EvaluationAuxiliaryConfig(TypedDict):
    risk: RiskConfig
    risk_calibration: RiskCalibrationConfig
    quantiles: QuantileConfig


class SubmissionAuxiliaryConfig(TypedDict):
    source: str


class TrainingConfig(TypedDict):
    command_options: CommandOptions
    point_regression: PointRegressionConfig
    auxiliary: EvaluationAuxiliaryConfig | SubmissionAuxiliaryConfig


def save_json(path: Path, value: dict):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False), encoding="utf-8")


def training_config(args, role: str, selected_kind: str, trees: dict[str, int]) -> TrainingConfig:
    """Record effective parameters, including the fit policy omitted by CatBoost files."""
    command: CommandOptions = {"context": args.context, "availability": args.availability,
               "iterations_max": args.iterations, "depth": args.depth, "seed": args.seed,
               "train_gru": args.train_gru, "epochs": args.epochs,
               "torch_device": args.torch_device, "catboost_device": args.catboost_device,
               "alert_precision": args.alert_precision}
    point: PointRegressionConfig = {"iterations": args.iterations if role == "evaluation_model" else trees.get(selected_kind),
             "depth": args.depth, "learning_rate": .04, "loss_function": "MAE",
             "eval_metric": "MAE" if role == "evaluation_model" else None,
             "l2_leaf_reg": 8, "random_seed": args.seed, "thread_count": 4,
             "task_type": args.catboost_device, "allow_writing_files": False,
             "early_stopping_rounds": 70 if role == "evaluation_model" else None,
             "use_best_model": role == "evaluation_model",
             "eval_partition": "tune" if role == "evaluation_model" else None,
             "fit_partition": "fit" if role == "evaluation_model" else
                              ("all_labels_train" if selected_kind in ("direct", "residual") else "not_refitted_baseline")}
    return {"command_options": command, "point_regression": point,
            "auxiliary": ({"risk": {"iterations_max": args.iterations, "depth": 4,
                                    "learning_rate": .04, "loss_function": "Logloss",
                                    "eval_metric": "Logloss", "l2_leaf_reg": 8,
                                    "target_late_threshold_s": 120,
                                    "random_seed": args.seed, "thread_count": 4,
                                    "task_type": args.catboost_device, "allow_writing_files": False,
                                    "early_stopping_rounds": 70,
                                    "use_best_model": True, "fit_partition": "fit",
                                    "eval_partition": "tune"},
                           "risk_calibration": {"method": "Platt logistic regression when calibration block has at least 8 of each class",
                                                "C": 1., "solver": "lbfgs", "random_state": args.seed,
                                                "fit_partition": "calibration",
                                                "alert_precision_target": args.alert_precision},
                           "quantiles": {"iterations_max": args.iterations, "depth": args.depth,
                                         "learning_rate": .04, "loss_functions": ["Quantile:alpha=0.1", "Quantile:alpha=0.9"],
                                         "eval_metrics": ["Quantile:alpha=0.1", "Quantile:alpha=0.9"],
                                         "l2_leaf_reg": 8, "random_seed": args.seed,
                                         "thread_count": 4, "task_type": args.catboost_device,
                                         "allow_writing_files": False,
                                         "early_stopping_rounds": 70, "use_best_model": True,
                                         "fit_partition": "fit", "eval_partition": "tune"}}
                          if role == "evaluation_model" else
                          {"source": "copied unchanged from evaluation_model"})}


def model_exposure(sample_ids: pd.Series, workspace: Path) -> ModelExposure:
    count, sources = audit_exposure(sample_ids, workspace)
    return {"current_audit_points": len(sample_ids),
            "previously_exposed_current_audit_points": count,
            "previously_exposed_fraction": count / len(sample_ids),
            "previous_audit_sources": sources,
            "historical_independence": "repeated_local_evaluation; not_unseen",
            "current_run_selection_order": "selected_by_tune_before_current_audit_metrics"}


def refresh_existing_provenance(args) -> None:
    """Annotate verified persisted run artifacts without fitting or selecting again."""
    out = args.out
    submission_dir = out.parent/"submission_model"
    meta = json.loads((out/"model_meta.json").read_text(encoding="utf-8"))
    submission_meta = json.loads((submission_dir/"model_meta.json").read_text(encoding="utf-8"))
    report = json.loads((out/"metrics.json").read_text(encoding="utf-8"))
    if meta["seed"] != args.seed or meta["context"] != args.context or meta["availability"] != args.availability:
        raise ValueError("Declared refresh command disagrees with saved seed/context/availability")
    if meta["model_role"] != "evaluation_model" or submission_meta["model_role"] != "submission_model":
        raise ValueError("Expected separate evaluation_model and submission_model roles")
    selected_kind = meta["selected"]["kind"]
    if selected_kind in ("direct", "residual"):
        measured = CatBoostRegressor().load_model(str(out/f"{selected_kind}.cbm"))
        observed = measured.get_all_params()
        expected = {"iterations": args.iterations, "depth": args.depth,
                    "random_seed": args.seed, "loss_function": "MAE",
                    "task_type": args.catboost_device}
        if any(observed.get(key) != value for key, value in expected.items()):
            raise ValueError("Declared refresh training options disagree with saved evaluation model")
        if abs(observed["learning_rate"] - .04) > 1e-6 or observed["l2_leaf_reg"] != 8:
            raise ValueError("Saved evaluation model disagrees with effective training constants")
        refit = CatBoostRegressor().load_model(str(submission_dir/f"{selected_kind}.cbm"))
        if refit.tree_count_ != meta["trees"][selected_kind]:
            raise ValueError("Submission refit tree count disagrees with frozen evaluation selection")
    for field in ("split_manifest", "feature_schema_manifest"):
        recorded = meta[field]
        current = file_manifest([Path(recorded["file"])])[0]
        if current["sha256"] != recorded["sha256"]:
            raise ValueError(f"Saved {field} no longer matches recorded bytes")
    audit_points = pd.read_csv(out/"audit_predictions.csv", usecols=["sample_id"], dtype={"sample_id": str})
    if len(audit_points) != report["chronological_audit"]["regression"]["n"]:
        raise ValueError("Audit prediction count disagrees with saved metrics")
    exposure = model_exposure(audit_points.sample_id, args.data_dir.parent)
    for directory, record, role in ((out, meta, "evaluation_model"),
                                    (submission_dir, submission_meta, "submission_model")):
        current_models = file_manifest(sorted(directory.glob("*.cbm")))
        if "model_file_manifest" in record:
            expected_models = {Path(item["file"]).name: item["sha256"] for item in record["model_file_manifest"]}
            observed_models = {Path(item["file"]).name: item["sha256"] for item in current_models}
            if expected_models != observed_models:
                raise ValueError(f"{role} model bytes differ from recorded manifest")
        record["model_file_manifest"] = current_models
        record["training_config"] = training_config(args, role, selected_kind, meta["trees"])
        record["audit_exposure"] = exposure
        record["selection_rule"] = "minimum tune MAE on frozen blocks; current audit evaluated after selection, with prior row exposure recorded"
        save_json(directory/"model_meta.json", record)
    report["audit_exposure"] = exposure
    report["model_provenance"] = {
        "evaluation_model": {k: meta[k] for k in ("source_manifest", "split_manifest", "feature_schema_manifest", "model_file_manifest", "training_config")},
        "submission_model": {k: submission_meta[k] for k in ("source_manifest", "split_manifest", "feature_schema_manifest", "model_file_manifest", "training_config")}}
    save_json(out/"metrics.json", report)
    print(f"Refreshed persisted provenance for {out} and {submission_dir}; models and predictions unchanged")


def fit_regressor(X, target, fit, tune, args, loss="MAE"):
    model = CatBoostRegressor(iterations=args.iterations, depth=args.depth, learning_rate=.04,
                              loss_function=loss, eval_metric=loss, l2_leaf_reg=8,
                              random_seed=args.seed, thread_count=4, verbose=False,
                              allow_writing_files=False, task_type=args.catboost_device)
    model.fit(X.iloc[fit], target[fit], eval_set=(X.iloc[tune], target[tune]),
              early_stopping_rounds=70, use_best_model=True)
    return model


def load_context(root: Path, context: str):
    if context == "labels-only":
        return None, None, []
    partitions = ["train"] if context == "train" else ["train", "test"]
    traffic_paths = [root/p/"traffic.csv" for p in partitions if (root/p/"traffic.csv").exists()]
    plan_paths = [root/p/"schedule.csv" for p in partitions if (root/p/"schedule.csv").exists()]
    if not traffic_paths or not plan_paths:
        raise FileNotFoundError("Missing training telemetry/plan. Use --context available explicitly for the partial archive, or --context labels-only.")
    traffic = pd.concat([read_traffic(p) for p in traffic_paths], ignore_index=True)
    traffic = traffic.sort_values(["tr_id", "event_time", "receive_time"], kind="stable")
    plan = prepare_plan(pd.concat([read_plan(p) for p in plan_paths], ignore_index=True))
    return traffic, plan, traffic_paths+plan_paths


def report_predictions(points: pd.DataFrame, outputs: dict, meta: dict, path: Path) -> dict:
    y, cur = points["target_delay_s"].to_numpy(), points["cur_dev_s"].to_numpy()
    result = {"regression": regression_metrics(y, outputs["prediction"], cur, points["tr_id"]),
              "risk": risk_metrics(y>120, outputs["p_late"], meta["alert_threshold"]),
              "interval": interval_metrics(y, outputs["q10_s"], outputs["q90_s"]),
              "paired_bootstrap_vs_cur_dev": paired_vehicle_bootstrap(y, outputs["prediction"], cur, points["tr_id"])}
    already_late = cur > 120
    for name, mask in [("already_late", already_late), ("not_currently_late", ~already_late)]:
        result[name] = risk_metrics((y>120)[mask], outputs["p_late"][mask], meta["alert_threshold"]) if mask.any() else None
    pd.concat([points.reset_index(drop=True), pd.DataFrame(outputs)], axis=1).to_csv(path, index=False)
    return result


def run(args):
    root, out = args.data_dir, args.out
    out.mkdir(parents=True, exist_ok=True)
    if (out/"model_meta.json").exists():
        raise FileExistsError(f"{out} already has a model; select a new output directory")
    train_path = root/"labels"/"labels_train.csv"
    points = read_points(train_path, require_target=True)
    original_n = len(points)
    traffic, plan, source_paths = load_context(root, args.context)
    if args.context == "available":
        # Explicit partial-archive mode: use only points whose raw context can be joined.
        keys = set(zip(plan["tr_id"], plan["tt_action_item_id"]))
        covered = points["tr_id"].isin(traffic["tr_id"]) & pd.Series(
            [(v, s) in keys for v, s in zip(points["tr_id"], points["target_stop_id"])], index=points.index)
        points = points.loc[covered].reset_index(drop=True)
        print(f"EXPLICIT SHARED-CONTEXT MODE: kept {len(points)}/{original_n} train points; excluded {original_n-len(points)} without raw context.", flush=True)
    builder = FeatureBuilder(traffic, plan, args.availability, context_enabled=args.context!="labels-only")
    print(f"Building features for {len(points)} train points...", flush=True)
    started = time.perf_counter()
    batch = builder.transform(points)
    print(f"Features: {batch.X.shape}, sequence: {batch.sequence.shape}; {time.perf_counter()-started:.1f}s", flush=True)
    X, seq = batch.X, batch.sequence
    masks, split_meta = chronological_blocks(points)
    fit, tune, cal, audit = [masks[k] for k in ["fit", "tune", "calibration", "audit"]]
    split_export = points[["sample_id", "tr_id", "T", "target_time_begin"]].copy()
    split_export["split"] = "purged"
    for name, ix in masks.items():
        split_export.loc[ix, "split"] = name
    split_export.to_csv(out/"split_manifest.csv", index=False)
    (out/"feature_schema.json").write_text(
        json.dumps(X.columns.tolist(), indent=2), encoding="utf-8")
    y, cur = points["target_delay_s"].to_numpy(), points["cur_dev_s"].to_numpy()
    ylate = (y>120).astype(int)
    median = float(np.median(y[fit]))
    candidates = {"zero": np.zeros(len(points)), "cur_dev": cur.copy(), "median": np.full(len(points), median)}
    trees, models = {}, {}
    for name, target in [("direct", y), ("residual", y-cur)]:
        model = fit_regressor(X, target, fit, tune, args)
        model.save_model(str(out/f"{name}.cbm"))
        models[name] = model
        candidates[name] = model.predict(X) + (cur if name=="residual" else 0)
        trees[name] = model.tree_count_
    tuning = {name: float(np.abs(value[tune]-y[tune]).mean()) for name, value in candidates.items()}
    selected_name = min(tuning, key=tuning.get)
    selected = {"kind": selected_name}
    neural_report = None
    if args.train_gru:
        if args.context == "labels-only" or not np.any(seq[:, :, 6]):
            raise ValueError("GRU requires observed telemetry; use a context mode with valid sequences")
        from .neural import train_gru, predict_gru
        neural_model, scaler, neural_report = train_gru(X, seq, y, cur, fit, tune, out,
                                                       epochs=args.epochs, seed=args.seed, device=args.torch_device)
        candidates["gru"] = predict_gru(neural_model, scaler, X, seq, cur)
        tuning["gru"] = float(np.abs(candidates["gru"][tune]-y[tune]).mean())
        best_tabular = selected_name
        if tuning["gru"] < tuning[selected_name]:
            selected, selected_name = {"kind": "gru"}, "gru"
        for weight in [.25, .5, .75]:
            key = f"blend_{weight}"
            candidates[key] = (1-weight)*candidates[best_tabular]+weight*candidates["gru"]
            tuning[key] = float(np.abs(candidates[key][tune]-y[tune]).mean())
            if tuning[key] < tuning[selected_name]:
                selected_name = key
                selected = {"kind": "blend", "tabular": best_tabular, "gru_weight": weight}
    print("Tuning MAE (seconds):", tuning, "selected:", selected, flush=True)
    risk_calibration = {"coefficient": 1., "intercept": 0., "calibrated": False, "method": "identity"}
    cal_probability = np.full(len(cal), float(ylate[fit].mean()))
    if len(np.unique(ylate[fit])) == 2:
        risk = CatBoostClassifier(iterations=args.iterations, depth=4, learning_rate=.04,
                                  loss_function="Logloss", eval_metric="Logloss", l2_leaf_reg=8,
                                  random_seed=args.seed, thread_count=4, verbose=False,
                                  allow_writing_files=False, task_type=args.catboost_device)
        risk.fit(X.iloc[fit], ylate[fit], eval_set=(X.iloc[tune], ylate[tune]),
                 early_stopping_rounds=70, use_best_model=True)
        risk.save_model(str(out/"risk.cbm"))
        margin = np.asarray(risk.predict(X.iloc[cal], prediction_type="RawFormulaVal"))
        if min(np.bincount(ylate[cal], minlength=2)) >= 8 and np.std(margin) > 1e-8:
            calibrator = LogisticRegression(C=1., solver="lbfgs", random_state=args.seed)
            calibrator.fit(margin.reshape(-1, 1), ylate[cal])
            risk_calibration = {"coefficient": float(calibrator.coef_[0, 0]),
                                "intercept": float(calibrator.intercept_[0]), "calibrated": True,
                                "method": "Platt on disjoint chronological calibration block"}
        cal_probability = calibrated_probability(margin, risk_calibration)
        trees["risk"] = risk.tree_count_
    threshold = select_alert_threshold(ylate[cal], cal_probability, target_precision=args.alert_precision)
    for name, alpha in [("q10", .1), ("q90", .9)]:
        model = fit_regressor(X, y, fit, tune, args, loss=f"Quantile:alpha={alpha}")
        model.save_model(str(out/f"{name}.cbm"))
        trees[name] = model.tree_count_
    meta = {"schema_version": "1.0", "model_role": "evaluation_model",
            "feature_columns": X.columns.tolist(), "context": args.context,
            "availability": args.availability, "selected": selected, "fit_target_median": median,
            "fit_late_prevalence": float(ylate[fit].mean()), "risk_calibration": risk_calibration,
            "alert_threshold": threshold, "alert_precision_selection_target": args.alert_precision,
            "seed": args.seed, "trees": trees, "forecast_window_seconds": [600, 900],
            "late_threshold_s": 120, "history_seconds": 900, "refitted_on_all_labels": False,
            "clock": "Timezone-naive dataset clock; online UTC conversion must be explicitly configured",
            "source_manifest": file_manifest([train_path]+source_paths),
            "split_manifest": file_manifest([out/"split_manifest.csv"])[0],
            "feature_schema_manifest": file_manifest([out/"feature_schema.json"])[0],
            "selection_rule": "minimum tune MAE on frozen blocks; current audit evaluated after selection, with prior row exposure recorded",
            "test_exposure": "labels_test previously seen; same-day diagnostic only",
            "audit_exposure": model_exposure(points.iloc[audit].sample_id, root.parent),
            "training_config": training_config(args, "evaluation_model", selected_name, trees),
            "model_file_manifest": file_manifest(sorted(out.glob("*.cbm"))),
            "software": {"python": platform.python_version(), "pandas": pd.__version__,
                         "numpy": np.__version__, "catboost": catboost.__version__}}
    save_json(out/"model_meta.json", meta)
    predictor = Predictor(out)
    audit_batch = FeatureBatch(X.iloc[audit].reset_index(drop=True), seq[audit])
    audit_output = predictor.predict(audit_batch)
    report = {"data": {"labels_train_original_n": original_n, "training_points_used": len(points),
                       "feature_count": X.shape[1], "context": args.context,
                       "missing_telemetry_fraction": float(X["telemetry_missing"].mean()) if "telemetry_missing" in X else None},
              "split": split_meta, "tuning_mae_s": tuning, "selected": selected, "trees": trees,
              "neural": neural_report, "risk_calibration": risk_calibration,
              "chronological_audit": report_predictions(points.iloc[audit], audit_output, meta, out/"audit_predictions.csv")}
    report["regression_comparison"] = {
        block: {name: regression_metrics(y[ix], value[ix], cur[ix], points.iloc[ix]["tr_id"])
                for name, value in candidates.items()}
        for block, ix in (("tune", tune), ("calibration", cal), ("audit", audit))
    }
    report["chronological_audit"]["baselines"] = {
        name: regression_metrics(y[audit], candidates[name][audit], cur[audit], points.iloc[audit]["tr_id"])
        for name in ["zero", "cur_dev", "median"]}
    test_path = root/"labels"/"labels_test.csv"
    if test_path.exists():
        test = read_points(test_path, require_target=True)
        if set(points["sample_id"]) & set(test["sample_id"]):
            raise ValueError("Train/test sample IDs overlap")
        if set(zip(points["tr_id"], points["target_stop_id"])) & set(zip(test["tr_id"], test["target_stop_id"])):
            raise ValueError("Train/test targets overlap")
        test_builder = FeatureBuilder(context_enabled=False)
        if args.context != "labels-only":
            if not (root/"test"/"traffic.csv").exists() or not (root/"test"/"schedule.csv").exists():
                raise FileNotFoundError("Test context missing; cannot report a comparable context-model diagnostic")
            test_builder = FeatureBuilder(read_traffic(root/"test"/"traffic.csv"), read_plan(root/"test"/"schedule.csv"), args.availability)
        test_batch = test_builder.transform(test)
        report["official_test_same_day_diagnostic"] = report_predictions(test, predictor.predict(test_batch), meta, out/"official_test_predictions.csv")
        report["official_test_same_day_diagnostic"]["warning"] = "Interleaved times and the same vehicles; not evidence of future-day quality. Not used for tuning."
        report["official_test_same_day_diagnostic"]["baselines"] = {
            "zero": regression_metrics(test.target_delay_s, np.zeros(len(test)), test.cur_dev_s),
            "cur_dev": regression_metrics(test.target_delay_s, test.cur_dev_s, test.cur_dev_s),
            "fit_median": regression_metrics(test.target_delay_s, np.full(len(test),median), test.cur_dev_s)}
    # Model-only latency; expressly excludes feature building, networking and load.
    latency = []
    single = FeatureBatch(audit_batch.X.iloc[:1], audit_batch.sequence[:1])
    for i in range(25):
        start = time.perf_counter()
        predictor.predict(single)
        if i >= 5:
            latency.append((time.perf_counter()-start)*1000)
    report["local_model_only_latency_ms"] = {"p50": float(np.quantile(latency,.5)), "p95": float(np.quantile(latency,.95)), "samples": len(latency), "batch_size": 1}
    submission_dir = out.parent/"submission_model"
    if submission_dir.exists():
        raise FileExistsError(f"{submission_dir} already exists; select a new output parent")
    submission_dir.mkdir(parents=True)
    submission_meta = dict(meta)
    submission_meta["model_role"] = "submission_model"
    submission_meta["refitted_on_all_labels"] = selected_name in ("direct", "residual")
    submission_meta["regression_fit_rows"] = len(points) if selected_name in ("direct", "residual") else len(fit)
    submission_meta["evaluation_model_dir"] = str(out)
    submission_meta["measured_audit_metrics"] = False
    submission_meta["auxiliary_models"] = "risk and quantiles copied from evaluation_model; not T-3 selection evidence"
    if selected_name in ("direct", "residual"):
        full_target = y if selected_name == "direct" else y-cur
        refit = CatBoostRegressor(iterations=trees[selected_name], depth=args.depth, learning_rate=.04,
                                  loss_function="MAE", l2_leaf_reg=8, random_seed=args.seed,
                                  thread_count=4, verbose=False, allow_writing_files=False,
                                  task_type=args.catboost_device)
        refit.fit(X, full_target)
        refit.save_model(str(submission_dir/f"{selected_name}.cbm"))
    for auxiliary in ("risk.cbm", "q10.cbm", "q90.cbm"):
        if (out/auxiliary).exists():
            shutil.copyfile(out/auxiliary, submission_dir/auxiliary)
    submission_meta["training_config"] = training_config(args, "submission_model", selected_name, trees)
    submission_meta["model_file_manifest"] = file_manifest(sorted(submission_dir.glob("*.cbm")))
    save_json(submission_dir/"model_meta.json", submission_meta)
    report["audit_exposure"] = meta["audit_exposure"]
    report["model_provenance"] = {
        "evaluation_model": {k: meta[k] for k in ("source_manifest", "split_manifest", "feature_schema_manifest", "model_file_manifest", "training_config")},
        "submission_model": {k: submission_meta[k] for k in ("source_manifest", "split_manifest", "feature_schema_manifest", "model_file_manifest", "training_config")}}
    save_json(out/"metrics.json", report)
    print(json.dumps({"selected": selected, "chronological_audit": report["chronological_audit"]["regression"],
                      "official_test": report.get("official_test_same_day_diagnostic",{}).get("regression")}, indent=2), flush=True)
    print(f"Saved reproducible artifacts to {out}", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--context", choices=["train", "available", "labels-only"], default="train")
    parser.add_argument("--availability", choices=["event", "received"], default="event")
    parser.add_argument("--iterations", type=int, default=800)
    parser.add_argument("--depth", type=int, default=5)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--train-gru", action="store_true")
    parser.add_argument("--epochs", type=int, default=30)
    parser.add_argument("--torch-device", choices=["cpu", "cuda"], default="cpu")
    parser.add_argument("--catboost-device", choices=["CPU", "GPU"], default="CPU")
    parser.add_argument("--alert-precision", type=float, default=.8)
    parser.add_argument("--refresh-provenance-existing", action="store_true",
                        help="Annotate persisted run metadata without model fitting or prediction")
    args = parser.parse_args()
    if args.iterations < 1 or args.epochs < 1 or not 0 < args.alert_precision <= 1:
        parser.error("Invalid training budget or alert precision")
    if args.refresh_provenance_existing:
        refresh_existing_provenance(args)
    else:
        run(args)


if __name__ == "__main__":
    main()
