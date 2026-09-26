"""Load frozen artifacts and apply exactly the same prediction rules everywhere."""
from __future__ import annotations

import json
from pathlib import Path
import numpy as np
import pandas as pd
from catboost import CatBoostRegressor, CatBoostClassifier
from .features import FeatureBatch


def calibrated_probability(raw_margin: np.ndarray, config: dict) -> np.ndarray:
    z = np.asarray(raw_margin)*config["coefficient"] + config["intercept"]
    return 1/(1+np.exp(-np.clip(z, -40, 40)))


class Predictor:
    def __init__(self, directory: str | Path):
        self.directory = Path(directory)
        self.meta = json.loads((self.directory/"model_meta.json").read_text())
        self.regressors = {}
        for name in ["direct", "residual", "q10", "q90"]:
            path = self.directory/f"{name}.cbm"
            if path.exists():
                self.regressors[name] = CatBoostRegressor().load_model(str(path))
        self.risk = None
        if (self.directory/"risk.cbm").exists():
            self.risk = CatBoostClassifier().load_model(str(self.directory/"risk.cbm"))
        self.gru, self.scaler = None, None
        if self.meta["selected"]["kind"] in ("gru", "blend"):
            from .neural import load_gru
            self.gru, self.scaler = load_gru(self.directory)

    def component(self, name: str, X: pd.DataFrame, sequence: np.ndarray, cur: np.ndarray) -> np.ndarray:
        if name == "zero":
            return np.zeros(len(X))
        if name == "cur_dev":
            return cur.copy()
        if name == "median":
            return np.full(len(X), self.meta["fit_target_median"])
        if name in ("direct", "residual"):
            value = self.regressors[name].predict(X, thread_count=2)
            return value+cur if name == "residual" else value
        if name == "gru":
            from .neural import predict_gru
            return predict_gru(self.gru, self.scaler, X, sequence, cur)
        raise ValueError(f"Unknown component: {name}")

    def predict(self, batch: FeatureBatch) -> dict[str, np.ndarray]:
        missing = set(self.meta["feature_columns"])-set(batch.X)
        if missing:
            raise ValueError(f"Feature schema mismatch: missing {sorted(missing)}")
        X = batch.X[self.meta["feature_columns"]]
        cur = X["cur_dev_s"].to_numpy(dtype=float)
        cfg = self.meta["selected"]
        if cfg["kind"] == "blend":
            pred = ((1-cfg["gru_weight"])*self.component(cfg["tabular"], X, batch.sequence, cur)
                    +cfg["gru_weight"]*self.component("gru", X, batch.sequence, cur))
        else:
            pred = self.component(cfg["kind"], X, batch.sequence, cur)
        if self.risk is not None:
            margin = self.risk.predict(X, prediction_type="RawFormulaVal", thread_count=2)
            probability = calibrated_probability(margin, self.meta["risk_calibration"])
        else:
            probability = np.full(len(X), self.meta["fit_late_prevalence"])
        low = self.regressors["q10"].predict(X, thread_count=2)
        high = self.regressors["q90"].predict(X, thread_count=2)
        # Rearrangement corrects crossing; does NOT claim calibrated 80% coverage.
        low, high = np.minimum(low, high), np.maximum(low, high)
        if not np.isfinite(pred).all():
            raise ValueError("Nonfinite model prediction")
        return {"prediction": pred, "p_late": probability, "q10_s": low, "q90_s": high}
