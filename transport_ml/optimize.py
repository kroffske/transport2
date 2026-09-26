"""Bounded rolling-origin model search; never read validate outcomes.

Run: python -m transport_ml.optimize --data-dir data --out artifacts/ml/runs/t5-motion-v1
"""
from __future__ import annotations

import argparse
import itertools
import json
from pathlib import Path
import shutil
import sys
import time

from catboost import CatBoostRegressor
import numpy as np
import pandas as pd

from .data import file_manifest, read_plan, read_points, read_traffic
from .features import FeatureBuilder
from .inference import Predictor
from .predict import validate_submission, write_submission
from .validation import regression_metrics, paired_vehicle_bootstrap


def rolling_folds(points: pd.DataFrame) -> list[tuple[np.ndarray, np.ndarray]]:
    """Three fixed development blocks, with outcome maturity and history purge."""
    boundaries = pd.to_datetime(["2026-01-06 10:00", "2026-01-06 14:00",
                                 "2026-01-06 17:30", "2026-01-06 20:30"])
    mature = points.target_time_begin + pd.to_timedelta(points.target_delay_s.clip(lower=0), unit="s")
    folds = []
    for start, end in zip(boundaries[:-1], boundaries[1:]):
        fit = np.flatnonzero((points["T"] < start)
                            & (mature < start-pd.Timedelta(minutes=15)))
        evaluate = np.flatnonzero((points["T"] >= start) & (points["T"] < end)
                                 & (mature < end-pd.Timedelta(minutes=15)))
        if len(fit) < 100 or len(evaluate) < 20:
            raise ValueError("Insufficient rows for the frozen rolling folds")
        folds.append((fit, evaluate))
    return folds


def configurations() -> list[dict]:
    baseline = dict(name="t3_recipe", profile="legacy", target="residual", depth=5,
                    synthetic_weight=1., iterations=257)
    candidates = [baseline]
    for profile, target, depth, weight in itertools.product(
            ["legacy", "motion-v1"], ["direct", "residual"], [4, 6], [.25, 1.]):
        candidates.append(dict(name=f"{profile}_{target}_d{depth}_w{weight}", profile=profile,
                               target=target, depth=depth, synthetic_weight=weight, iterations=600))
    for depth, iterations in ((3, 600), (5, 600), (7, 600), (4, 800), (6, 800)):
        candidates.append(dict(name=f"motion-v1_residual_d{depth}_i{iterations}", profile="motion-v1",
                               target="residual", depth=depth, synthetic_weight=1., iterations=iterations))
    for depth in (4, 6):
        candidates.append(dict(name=f"motion-path_residual_d{depth}", profile="motion-v1",
                               feature_set="path", target="residual", depth=depth,
                               synthetic_weight=1., iterations=600))
    return candidates


def feature_columns(config: dict, X: pd.DataFrame, legacy_columns: list[str]) -> list[str]:
    if config["profile"] == "legacy":
        return legacy_columns
    if config.get("feature_set") == "path":
        return [name for name in X if not name.startswith("motion_") or name.startswith("motion_target_")]
    return list(X)


def fit_candidate(X: pd.DataFrame, points: pd.DataFrame, fit: np.ndarray, config: dict) -> CatBoostRegressor:
    y = points.target_delay_s.to_numpy(dtype=float)
    if config["target"] == "residual":
        y = y-points.cur_dev_s.to_numpy(dtype=float)
    weights = np.where(points.tr_id.astype(int).to_numpy() >= 9000000, config["synthetic_weight"], 1.)
    model = CatBoostRegressor(iterations=config["iterations"], depth=config["depth"],
                              learning_rate=.04, loss_function="MAE", l2_leaf_reg=8,
                              random_seed=42, thread_count=4, verbose=False, allow_writing_files=False)
    model.fit(X.iloc[fit], y[fit], sample_weight=weights[fit])
    return model


def candidate_prediction(model: CatBoostRegressor, X: pd.DataFrame, points: pd.DataFrame,
                         config: dict) -> np.ndarray:
    pred = model.predict(X, thread_count=2)
    if config["target"] == "residual":
        pred = pred+points.cur_dev_s.to_numpy(dtype=float)
    return pred


def save_json(path: Path, record: dict | list) -> None:
    path.write_text(json.dumps(record, indent=2, ensure_ascii=False, allow_nan=False), encoding="utf-8")


def run(args) -> None:
    out = args.out.resolve()
    staging = out.with_name(out.name+".partial")
    if out.exists():
        raise FileExistsError(out)
    staging.mkdir(parents=True, exist_ok=False)
    started = time.perf_counter()
    root = args.data_dir.resolve()
    comparator = args.comparator.resolve()
    old_meta = json.loads((comparator/"model_meta.json").read_text())
    configs = configurations()
    save_json(staging/"config.json", {
        "policy": "t5-rolling-real-v1", "argv": sys.argv, "candidates": configs,
        "selection": "minimum pooled real-vehicle rolling MAE; audit/test excluded",
        "availability": "received", "seed": 42, "audit_status": "historically exposed; diagnostic only",
        "score_formula": "clip((mae_zero-mae)/(mae_zero-MAE_TARGET),0,1)",
        "MAE_TARGET": None, "max_configurations": 24,
        "comparator": str(comparator), "task": args.task})
    source_paths = [root/"labels/labels_train.csv", root/"train/traffic.csv", root/"train/schedule.csv",
                    root/"labels/labels_test.csv", root/"test/traffic.csv", root/"test/schedule.csv",
                    root/"validate/points.csv", root/"validate/traffic.csv", root/"validate/schedule_plan.csv",
                    root/"sample_submission.csv"]
    save_json(staging/"sources.json", file_manifest(source_paths))
    save_json(staging/"code.json", file_manifest(sorted(Path(__file__).parent.glob("*.py"))))
    points = read_points(root/"labels/labels_train.csv", require_target=True)
    print(f"Building received-time motion features: {len(points)} rows", flush=True)
    builder = FeatureBuilder(read_traffic(root/"train/traffic.csv"), read_plan(root/"train/schedule.csv"),
                             "received", feature_profile="motion-v1")
    batch = builder.transform(points)
    X = batch.X
    X.to_pickle(staging/"train_features.pkl")
    legacy_columns = old_meta["feature_columns"]
    folds = rolling_folds(points)
    real = points.tr_id.astype(int).to_numpy() < 9000000
    y = points.target_delay_s.to_numpy(dtype=float)
    fold_manifest = []
    for fold, (fit, valid) in enumerate(folds):
        for role, indexes in (("fit", fit), ("validation", valid)):
            frame = points.iloc[indexes][["sample_id", "tr_id", "T", "target_time_begin"]].copy()
            frame["fold"], frame["role"] = fold, role
            fold_manifest.append(frame)
    pd.concat(fold_manifest).to_csv(staging/"fold_manifest.csv", index=False)
    oof = points[["sample_id", "tr_id", "T", "target_delay_s", "cur_dev_s"]].copy()
    oof["fold"] = -1
    for fold, (_, valid) in enumerate(folds):
        oof.loc[valid, "fold"] = fold
    results = []
    for config in configs:
        pred = np.full(len(points), np.nan)
        scores = []
        selected_X = X[feature_columns(config, X, legacy_columns)]
        for fit, valid in folds:
            model = fit_candidate(selected_X, points, fit, config)
            pred[valid] = candidate_prediction(model, selected_X.iloc[valid], points.iloc[valid], config)
            mask = valid[real[valid]]
            scores.append(float(np.abs(pred[mask]-y[mask]).mean()))
        observed = np.isfinite(pred)
        result = {**config, "real_mae_s": float(np.abs(pred[observed & real]-y[observed & real]).mean()),
                  "all_mae_s": float(np.abs(pred[observed]-y[observed]).mean()), "real_fold_mae_s": scores,
                  "real_n": int((observed & real).sum()), "all_n": int(observed.sum())}
        results.append(result)
        oof[config["name"]] = pred
        save_json(staging/"search_results.json", results)
        print(f"{config['name']}: real MAE={result['real_mae_s']:.3f}; folds={np.round(scores, 2)}", flush=True)
    oof.loc[oof.fold >= 0].to_csv(staging/"oof_predictions.csv", index=False)
    winner = min(results, key=lambda result: result["real_mae_s"])
    save_json(staging/"selection.json", winner)  # Written BEFORE opening audit or test metrics.
    print("Selected:", winner["name"], flush=True)
    selected_X = X[feature_columns(winner, X, legacy_columns)]
    audit_start = pd.Timestamp("2026-01-06 20:30")
    maturity = points.target_time_begin + pd.to_timedelta(points.target_delay_s.clip(lower=0), unit="s")
    fit = np.flatnonzero((points["T"] < audit_start) & (maturity < audit_start-pd.Timedelta(minutes=15)))
    audit = np.flatnonzero(points["T"] >= audit_start)
    audit_model = fit_candidate(selected_X, points, fit, winner)
    audit_model.save_model(str(staging/"diagnostic_model.cbm"))
    pred = candidate_prediction(audit_model, selected_X.iloc[audit], points.iloc[audit], winner)
    audit_frame = points.iloc[audit].copy()
    audit_frame["prediction"] = pred
    audit_frame.to_csv(staging/"audit_predictions.csv", index=False)
    metrics = {"selection": winner, "rolling_comparator": results[0], "platform_score": None,
               "audit_training_rows": len(fit), "audit_all": regression_metrics(y[audit], pred, points.cur_dev_s.iloc[audit]),
               "audit_real": regression_metrics(y[audit][real[audit]], pred[real[audit]], points.cur_dev_s.iloc[audit][real[audit]])}
    # Refit comparator on precisely the same rows as the diagnostic candidate.
    baseline = fit_candidate(X[legacy_columns], points, fit, configs[0])
    baseline_pred = candidate_prediction(baseline, X.iloc[audit][legacy_columns], points.iloc[audit], configs[0])
    metrics["audit_comparator_same_fit"] = regression_metrics(y[audit], baseline_pred, points.cur_dev_s.iloc[audit])
    metrics["audit_real_comparator_same_fit"] = regression_metrics(
        y[audit][real[audit]], baseline_pred[real[audit]], points.cur_dev_s.iloc[audit][real[audit]])
    metrics["audit_paired_delta"] = paired_vehicle_bootstrap(y[audit], pred, baseline_pred, points.tr_id.iloc[audit])
    model_dir = staging/"submission_model"
    model_dir.mkdir()
    refit = fit_candidate(selected_X, points, np.arange(len(points)), winner)
    refit.save_model(str(model_dir/f"{winner['target']}.cbm"))
    for name in ("q10.cbm", "q90.cbm", "risk.cbm"):
        shutil.copyfile(comparator/name, model_dir/name)
    meta = {**old_meta, "model_role": "submission_model", "selected": {"kind": winner["target"]},
            "feature_profile": winner["profile"], "feature_columns": list(selected_X),
            "selection_rule": "pooled real-vehicle rolling MAE; test/audit post-selection diagnostics only",
            "refitted_on_all_labels": True, "source_manifest": file_manifest(source_paths),
            "training_config": {"candidate": winner, "effective_params": refit.get_all_params(),
                                "training_rows": len(points), "labels_test_used_for_fit": False,
                                "auxiliary": "T-3 risk/quantiles copied unchanged; not evaluated for promotion"}}
    meta["trees"] = {name: count for name, count in old_meta["trees"].items() if name in ("risk", "q10", "q90")}
    meta["trees"][winner["target"]] = refit.tree_count_
    meta["regression_fit_rows"] = len(points)
    meta["evaluation_model_dir"] = None
    meta["measured_audit_metrics"] = False
    meta["audit_exposure"] = {**old_meta["audit_exposure"],
                               "historical_independence": "all current audit rows exposed by T-3; diagnostic only",
                               "previously_exposed_current_audit_points": len(audit),
                               "previously_exposed_fraction": 1.,
                               "current_run_selection_order": "selected_by_rolling_real_MAE_before_diagnostics"}
    meta["model_file_manifest"] = file_manifest(sorted(model_dir.glob("*.cbm")))
    meta["feature_schema_manifest"] = {"file": "feature_schema.json"}
    save_json(model_dir/"feature_schema.json", list(selected_X))
    meta["feature_schema_manifest"] = file_manifest([model_dir/"feature_schema.json"])[0]
    meta["split_manifest"] = file_manifest([staging/"fold_manifest.csv"])[0]
    save_json(model_dir/"model_meta.json", meta)
    predictor = Predictor(model_dir)
    test = read_points(root/"labels/labels_test.csv", require_target=True)
    test_batch = FeatureBuilder(read_traffic(root/"test/traffic.csv"), read_plan(root/"test/schedule.csv"),
                                "received", feature_profile=winner["profile"]).transform(test)
    test_pred = predictor.predict(test_batch)["prediction"]
    test_frame = test.copy()
    test_frame["prediction"] = test_pred
    test_frame.to_csv(staging/"test_predictions.csv", index=False)
    metrics["test_exposed_diagnostic"] = regression_metrics(test.target_delay_s, test_pred, test.cur_dev_s, test.tr_id)
    old = Predictor(comparator)
    old_pred = old.predict(test_batch)["prediction"]
    metrics["test_t3_submission_comparator"] = regression_metrics(test.target_delay_s, old_pred, test.cur_dev_s, test.tr_id)
    metrics["test_paired_delta"] = paired_vehicle_bootstrap(test.target_delay_s, test_pred, old_pred, test.tr_id)
    diagnostic_slices = []
    for name, frame, candidate, baseline_values in (
            ("audit", points.iloc[audit], pred, baseline_pred), ("test", test, test_pred, old_pred)):
        table = frame[["tr_id", "target_delay_s"]].copy()
        table["candidate_ae"] = np.abs(candidate-frame.target_delay_s.to_numpy())
        table["baseline_ae"] = np.abs(baseline_values-frame.target_delay_s.to_numpy())
        table = table.groupby("tr_id").agg(n=("candidate_ae", "size"), candidate_mae_s=("candidate_ae", "mean"),
                                           baseline_mae_s=("baseline_ae", "mean")).reset_index()
        table["surface"] = name
        table["delta_mae_s"] = table.candidate_mae_s-table.baseline_mae_s
        diagnostic_slices.append(table)
    pd.concat(diagnostic_slices).to_csv(staging/"vehicle_metrics.csv", index=False)
    metrics["MAE_TARGET_needed_for_score_070_on_test"] = (
        metrics["test_exposed_diagnostic"]["mae_s"]-.3*metrics["test_exposed_diagnostic"]["mae_zero_s"])/.7
    scoring = read_points(root/"validate/points.csv")
    scoring_batch = FeatureBuilder(read_traffic(root/"validate/traffic.csv"), read_plan(root/"validate/schedule_plan.csv"),
                                   "received", feature_profile=winner["profile"]).transform(scoring)
    predictions = predictor.predict(scoring_batch)["prediction"]
    template = pd.read_csv(root/"sample_submission.csv", sep=";", dtype={"sample_id": str})
    write_submission(scoring.sample_id, predictions, template, staging/"submission.csv")
    metrics["submission_readback"] = validate_submission(staging/"submission.csv", template.sample_id)
    pd.DataFrame({"feature": list(selected_X), "importance": refit.feature_importances_}).sort_values(
        "importance", ascending=False).to_csv(staging/"feature_importance.csv", index=False)
    metrics["elapsed_s"] = time.perf_counter()-started
    save_json(staging/"metrics.json", metrics)
    # Paths in metadata must refer to the final location after atomic publication.
    for path in (model_dir/"model_meta.json",):
        path.write_text(path.read_text().replace(str(staging), str(out)), encoding="utf-8")
    outputs = file_manifest([staging/"submission.csv", staging/"metrics.json"])
    for item in outputs:
        item["file"] = item["file"].replace(str(staging), str(out))
    save_json(staging/"completion.json", {"state": "complete", "elapsed_s": metrics["elapsed_s"],
                                         "outputs": outputs,
                                         "platform_readback": False})
    staging.rename(out)
    print(json.dumps(metrics, indent=2, ensure_ascii=False), flush=True)
    print(f"Completed run: {out}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--comparator", type=Path, default=Path("artifacts/t3-full-received-v2/submission_model"))
    parser.add_argument("--task", default=".tasks/T-5-2026-09-25-ml-score-0-70")
    run(parser.parse_args())


if __name__ == "__main__":
    main()
