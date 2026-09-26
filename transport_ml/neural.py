"""A small PyTorch GRU candidate, not a mandatory ensemble member.

Fixed physical scaling for sequence channels; tabular scaling fitted on FIT only.
Missingness masks are inputs, and no backwards filling of time series is used.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path
import numpy as np
import pandas as pd
import torch
from torch import nn
from torch.utils.data import DataLoader, TensorDataset

TARGET_SCALE = 120.0


class DelayGRU(nn.Module):
    def __init__(self, n_static: int, n_sequence: int, hidden: int = 24):
        super().__init__()
        self.gru = nn.GRU(n_sequence, hidden, batch_first=True)
        self.static = nn.Sequential(nn.Linear(n_static, 32), nn.ReLU(), nn.Dropout(.15))
        self.head = nn.Sequential(nn.Linear(hidden+32, 32), nn.ReLU(), nn.Dropout(.15), nn.Linear(32, 1))
        nn.init.zeros_(self.head[-1].weight)
        nn.init.zeros_(self.head[-1].bias)

    def forward(self, sequence: torch.Tensor, static: torch.Tensor) -> torch.Tensor:
        _, hidden = self.gru(sequence)
        return self.head(torch.cat([hidden[-1], self.static(static)], dim=1)).squeeze(-1)


def fit_scaler(X: pd.DataFrame) -> dict:
    med = X.median().fillna(0).to_numpy(dtype=np.float32)
    a = X.to_numpy(dtype=np.float32)
    filled = np.where(np.isfinite(a), a, med)
    scale = np.std(filled, axis=0)
    scale = np.where(scale < 1e-6, 1, scale)
    return {"columns": X.columns.tolist(), "median": med.tolist(), "scale": scale.tolist()}


def transform_static(X: pd.DataFrame, scaler: dict) -> np.ndarray:
    a = X[scaler["columns"]].to_numpy(dtype=np.float32)
    mask = ~np.isfinite(a)
    a = np.where(mask, np.asarray(scaler["median"], dtype=np.float32), a)
    a = (a-np.asarray(scaler["median"], dtype=np.float32))/np.asarray(scaler["scale"], dtype=np.float32)
    return np.concatenate([np.clip(a, -10, 10), mask.astype(np.float32)], axis=1).astype(np.float32)


def predict_gru(model: DelayGRU, scaler: dict, X: pd.DataFrame, sequence: np.ndarray,
                cur: np.ndarray, device: str = "cpu", batch_size: int = 256) -> np.ndarray:
    model.to(device).eval()
    static = transform_static(X, scaler)
    result = []
    with torch.inference_mode():
        for start in range(0, len(X), batch_size):
            z = model(torch.from_numpy(sequence[start:start+batch_size]).to(device),
                      torch.from_numpy(static[start:start+batch_size]).to(device))
            result.append(z.cpu().numpy())
    return np.asarray(cur, dtype=float)+TARGET_SCALE*np.concatenate(result)


def train_gru(X: pd.DataFrame, sequence: np.ndarray, y: np.ndarray, cur: np.ndarray,
              fit_index: np.ndarray, tune_index: np.ndarray, out: Path, epochs: int = 30,
              seed: int = 42, device: str = "cpu") -> tuple[DelayGRU, dict, dict]:
    torch.manual_seed(seed)
    np.random.seed(seed)
    torch.set_num_threads(2)
    if device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA requested but not available")
    scaler = fit_scaler(X.iloc[fit_index])
    static = transform_static(X, scaler)
    ds = TensorDataset(torch.from_numpy(sequence[fit_index]), torch.from_numpy(static[fit_index]),
                       torch.tensor((y[fit_index]-cur[fit_index])/TARGET_SCALE, dtype=torch.float32))
    loader = DataLoader(ds, batch_size=64, shuffle=True, generator=torch.Generator().manual_seed(seed), num_workers=0)
    model = DelayGRU(static.shape[1], sequence.shape[-1]).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-3)
    criterion = nn.L1Loss()
    best, best_epoch, bad_epochs, best_state = float("inf"), 0, 0, None
    history = []
    for epoch in range(1, epochs+1):
        model.train()
        for seq, tab, target in loader:
            optimizer.zero_grad(set_to_none=True)
            loss = criterion(model(seq.to(device), tab.to(device)), target.to(device))
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
        pred = predict_gru(model, scaler, X.iloc[tune_index], sequence[tune_index], cur[tune_index], device)
        mae = float(np.abs(pred-y[tune_index]).mean())
        history.append({"epoch": epoch, "tune_mae_s": mae})
        if mae < best-1e-5:
            best, best_epoch, bad_epochs = mae, epoch, 0
            best_state = copy.deepcopy({k: v.cpu() for k, v in model.state_dict().items()})
        else:
            bad_epochs += 1
        if bad_epochs >= 6:
            break
    model.load_state_dict(best_state)
    model.cpu().eval()
    torch.save(model.state_dict(), out/"gru.pt")
    config = {"scaler": scaler, "n_static": static.shape[1], "n_sequence": sequence.shape[-1], "hidden": 24}
    (out/"gru_config.json").write_text(json.dumps(config, indent=2), encoding="utf-8")
    return model, scaler, {"best_epoch": best_epoch, "tune_mae_s": best, "history": history, "device": device}


def load_gru(directory: Path) -> tuple[DelayGRU, dict]:
    cfg = json.loads((directory/"gru_config.json").read_text())
    model = DelayGRU(cfg["n_static"], cfg["n_sequence"], cfg["hidden"])
    model.load_state_dict(torch.load(directory/"gru.pt", map_location="cpu", weights_only=True))
    return model.eval(), cfg["scaler"]
