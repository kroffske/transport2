"""Timestamp-block validation, maturity purge and inspectable metric definitions."""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.metrics import average_precision_score, brier_score_loss, log_loss, precision_score, recall_score, roc_auc_score


def chronological_blocks(points: pd.DataFrame, history_s: int = 900) -> tuple[dict[str, np.ndarray], dict]:
    """Fixed 2026-01-06 clock blocks: fit/tune/calibration/audit.

    Before EACH next block, remove rows whose outcome information interval extends
    into that block's 15-minute telemetry lookback. Maturity includes positive delay.
    Exact timestamp boundaries, not sklearn's row-count gap on mixed vehicles.
    """
    boundaries = [pd.Timestamp("2026-01-06 14:00:00"),
                  pd.Timestamp("2026-01-06 17:30:00"),
                  pd.Timestamp("2026-01-06 20:30:00")]
    if points["T"].min() < pd.Timestamp("2026-01-06 00:00:00") or points["T"].max() > pd.Timestamp("2026-01-07 00:30:00"):
        raise ValueError("Frozen split expects the official 2026-01-06 service day through 00:30")
    end_of_label = points["target_time_begin"] + pd.to_timedelta(points["target_delay_s"].clip(lower=0), unit="s")
    starts, ends = [None]+boundaries, boundaries+[None]
    masks, meta = {}, {}
    for name, start, end in zip(["fit", "tune", "calibration", "audit"], starts, ends):
        original = pd.Series(True, index=points.index)
        if start is not None:
            original &= points["T"] >= start
        if end is not None:
            original &= points["T"] < end
        mask = original.copy()
        if end is not None:
            mask &= end_of_label < end-pd.Timedelta(seconds=history_s)
        masks[name] = np.flatnonzero(mask.to_numpy())
        meta[name] = {"n": int(mask.sum()), "purged": int(original.sum()-mask.sum()),
                      "T_min": str(points.loc[mask, "T"].min()), "T_max": str(points.loc[mask, "T"].max()),
                      "boundary_start": str(start), "boundary_end": str(end)}
        if mask.sum() < 20:
            raise ValueError(f"Block {name} too small after purge: {mask.sum()}")
    # Independent runtime check of the strongest leakage condition.
    for i, name in enumerate(["fit", "tune", "calibration"]):
        if not (end_of_label.iloc[masks[name]] < boundaries[i]-pd.Timedelta(seconds=history_s)).all():
            raise ValueError(f"{name} contains a label unavailable before the next block")
    return masks, meta


def regression_metrics(y, pred, cur, vehicles=None) -> dict:
    y, pred, cur = map(lambda v: np.asarray(v, dtype=float), [y, pred, cur])
    if not len(y) or not np.isfinite(pred).all():
        raise ValueError("Empty evaluation or nonfinite prediction")
    error = pred-y
    ae = np.abs(error)
    baseline = float(np.mean(np.abs(cur-y)))
    out = {"n": len(y), "mae_s": float(ae.mean()), "rmse_s": float(np.sqrt(np.mean(error**2))),
           "p95_absolute_error_s": float(np.quantile(ae, .95)), "bias_s": float(error.mean()),
           "within_30s": float((ae<=30).mean()), "within_60s": float((ae<=60).mean()),
           "mae_zero_s": float(np.abs(y).mean()), "mae_cur_dev_s": baseline,
           "gain_vs_cur_dev": float(1-ae.mean()/baseline) if baseline else None}
    for name, mask in {"late": y>120, "early": y < -60, "ontime": (y>=-60)&(y<=120)}.items():
        out[f"n_{name}"] = int(mask.sum())
        out[f"mae_{name}_s"] = float(ae[mask].mean()) if mask.any() else None
    if vehicles is not None:
        v = pd.DataFrame({"tr_id": np.asarray(vehicles), "ae": ae})
        out["macro_vehicle_mae_s"] = float(v.groupby("tr_id")["ae"].mean().mean())
    return out


def risk_metrics(y_late, probability, threshold=.5) -> dict:
    y, p = np.asarray(y_late, dtype=int), np.asarray(probability, dtype=float)
    alerts = p >= threshold
    two_classes = len(np.unique(y)) == 2
    return {"n": len(y), "late_prevalence": float(y.mean()),
            "average_precision": float(average_precision_score(y, p)) if y.sum() else None,
            "roc_auc": float(roc_auc_score(y, p)) if two_classes else None,
            "brier": float(brier_score_loss(y, p)), "log_loss": float(log_loss(y, p, labels=[0, 1])),
            "threshold": float(threshold), "n_alerts": int(alerts.sum()),
            "precision": float(precision_score(y, alerts, zero_division=0)),
            "recall": float(recall_score(y, alerts, zero_division=0))}


def select_alert_threshold(y_late, probability, target_precision=.8, minimum_alerts=5) -> float:
    """Select ONLY on calibration data. Audit precision is measured separately."""
    y, p = np.asarray(y_late, dtype=int), np.asarray(probability)
    candidates = []
    for threshold in np.unique(p):
        alert = p >= threshold
        if alert.sum() >= minimum_alerts and y[alert].mean() >= target_precision:
            candidates.append((int(y[alert].sum()), -float(threshold), float(threshold)))
    return max(candidates)[2] if candidates else 1.000001  # Explicitly disable unsupported alerts.


def interval_metrics(y, low, high) -> dict:
    y, low, high = map(np.asarray, [y, low, high])
    return {"nominal_coverage": .8, "empirical_coverage": float(((y>=low)&(y<=high)).mean()),
            "mean_width_s": float((high-low).mean())}


def paired_vehicle_bootstrap(y, pred, baseline, vehicles, seed=42, repeats=1000) -> dict:
    """Cluster CI of MAE(pred)-MAE(baseline); exploratory with only 13 vehicles."""
    delta = np.abs(np.asarray(pred)-np.asarray(y))-np.abs(np.asarray(baseline)-np.asarray(y))
    df = pd.DataFrame({"g": np.asarray(vehicles), "d": delta}).groupby("g")["d"].agg(["sum", "count"])
    rng = np.random.default_rng(seed)
    ix = rng.integers(0, len(df), size=(repeats, len(df)))
    means = df["sum"].to_numpy()[ix].sum(1)/df["count"].to_numpy()[ix].sum(1)
    return {"delta_mae_s": float(delta.mean()), "ci95_low_s": float(np.quantile(means,.025)),
            "ci95_high_s": float(np.quantile(means,.975)), "clusters": len(df),
            "note": "Vehicle-cluster bootstrap; does not establish future-day generalization."}
