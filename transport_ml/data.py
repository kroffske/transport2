"""Data contracts. Facts are never loaded into the feature-building schedule."""
from __future__ import annotations

import hashlib
from pathlib import Path
import numpy as np
import pandas as pd

POINT_COLUMNS = ["sample_id", "tr_id", "T", "target_stop_id", "target_time_begin", "cur_dev_s"]
PLAN_COLUMNS = ["tt_action_item_id", "tr_id", "time_begin", "geom"]
TRAFFIC_COLUMNS = ["tr_id", "event_time", "receive_time", "location_valid", "lon", "lat", "speed", "heading"]


def parse_time(values: pd.Series) -> pd.Series:
    """Keep the dataset's wall clock; never silently convert it to a user's timezone."""
    out = pd.to_datetime(values, format="mixed", errors="raise")
    if isinstance(out.dtype, pd.DatetimeTZDtype) or not pd.api.types.is_datetime64_dtype(out):
        raise ValueError("Normalize all timestamps explicitly to the dataset clock, without timezone offsets.")
    if out.isna().any():
        raise ValueError("Required timestamp is missing")
    return out


def validate_points(frame: pd.DataFrame, require_target: bool = False) -> pd.DataFrame:
    required = POINT_COLUMNS + (["target_delay_s"] if require_target else [])
    missing = set(required) - set(frame)
    if missing:
        raise ValueError(f"Missing point columns: {sorted(missing)}")
    p = frame.copy().reset_index(drop=True)
    if p[required].isna().any().any():
        raise ValueError("Missing value in required point columns")
    for name in ["sample_id", "tr_id", "target_stop_id"]:
        p[name] = p[name].astype(str)
    if p["sample_id"].duplicated().any():
        raise ValueError("Duplicate sample_id")
    for name in ["T", "target_time_begin"]:
        p[name] = parse_time(p[name])
    for name in ["cur_dev_s"] + (["target_delay_s"] if require_target else []):
        p[name] = pd.to_numeric(p[name], errors="raise")
        if not np.isfinite(p[name]).all():
            raise ValueError(f"Nonfinite {name}")
    horizon = (p["target_time_begin"] - p["T"]).dt.total_seconds()
    if not ((horizon > 600) & (horizon <= 900)).all():
        raise ValueError("Target must lie strictly in (T+600s, T+900s]")
    return p


def read_points(path: Path, require_target: bool = False) -> pd.DataFrame:
    return validate_points(pd.read_csv(path, dtype={c: str for c in ["sample_id", "tr_id", "target_stop_id"]}), require_target)


def prepare_plan(frame: pd.DataFrame) -> pd.DataFrame:
    missing = set(PLAN_COLUMNS) - set(frame)
    if missing:
        raise ValueError(f"Missing schedule columns: {sorted(missing)}")
    # Strict allowlist: time_fact_begin, manual_fill, etc. can never become features.
    p = frame[PLAN_COLUMNS].copy()
    for name in ["tt_action_item_id", "tr_id"]:
        p[name] = p[name].astype(str)
    p["time_begin"] = parse_time(p["time_begin"])
    p = p.drop_duplicates()
    if p.duplicated(["tr_id", "tt_action_item_id"]).any():
        raise ValueError("Conflicting schedule records for one arrival ID")
    xy = p["geom"].fillna("").str.extract(r"POINT\s*\(\s*([-+\d.eE]+)\s+([-+\d.eE]+)\s*\)")
    p["stop_lon"] = pd.to_numeric(xy[0], errors="coerce")
    p["stop_lat"] = pd.to_numeric(xy[1], errors="coerce")
    valid = p["stop_lon"].between(-180, 180) & p["stop_lat"].between(-90, 90)
    p.loc[~valid, ["stop_lon", "stop_lat"]] = np.nan
    return p.sort_values(["tr_id", "time_begin", "tt_action_item_id"]).reset_index(drop=True)


def read_plan(path: Path) -> pd.DataFrame:
    return prepare_plan(pd.read_csv(path, usecols=lambda c: c in PLAN_COLUMNS,
                                    dtype={"tr_id": str, "tt_action_item_id": str}))


def prepare_traffic(frame: pd.DataFrame) -> pd.DataFrame:
    missing = set(TRAFFIC_COLUMNS) - {"receive_time"} - set(frame)
    if missing:
        raise ValueError(f"Missing telemetry columns: {sorted(missing)}")
    t = frame.copy()
    if "receive_time" not in t:
        t["receive_time"] = pd.NaT  # Strict receive-time mode will reject this input.
    t = t[TRAFFIC_COLUMNS].copy()
    t["tr_id"] = t["tr_id"].astype(str)
    t["event_time"] = parse_time(t["event_time"])
    if t["receive_time"].notna().all():
        t["receive_time"] = parse_time(t["receive_time"])
    else:
        t["receive_time"] = pd.to_datetime(t["receive_time"], format="mixed", errors="coerce")
    t["location_valid"] = t["location_valid"].astype(str).str.lower().isin(["true", "1"])
    for c in ["lon", "lat", "speed", "heading"]:
        t[c] = pd.to_numeric(t[c], errors="coerce")
    valid = t["location_valid"] & t["lon"].between(-180, 180) & t["lat"].between(-90, 90)
    t.loc[~valid, ["lon", "lat"]] = np.nan
    # 120 km/h is an explicit configurable-in-code sanity threshold, not a claimed legal limit.
    t.loc[~t["speed"].between(0, 120) | ~t["location_valid"], "speed"] = np.nan
    t.loc[~t["heading"].between(0, 360) | ~t["location_valid"], "heading"] = np.nan
    # Do NOT deduplicate globally: a later correction may not have arrived by prediction time.
    return t.sort_values(["tr_id", "event_time", "receive_time"], kind="stable").reset_index(drop=True)


def read_traffic(path: Path) -> pd.DataFrame:
    return prepare_traffic(pd.read_csv(path, usecols=lambda c: c in TRAFFIC_COLUMNS, dtype={"tr_id": str}))


def file_manifest(paths: list[Path]) -> list[dict]:
    out = []
    for path in paths:
        h = hashlib.sha256()
        with path.open("rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                h.update(chunk)
        out.append({"file": str(path), "bytes": path.stat().st_size, "sha256": h.hexdigest()})
    return out
