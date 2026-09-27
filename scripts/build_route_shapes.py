"""Build road-following shapes between consecutive planned stops from GPS history.

For every vehicle of the validate plan and every consecutive planned stop pair
A -> B (the order ``read_plan`` gives: time_begin, then tt_action_item_id) the
script collects GPS passes from A to B across all available traffic files,
drops outlier passes, averages the consistent ones, pins the ends exactly to
the stop coordinates, smooths lightly and simplifies. Pairs without a usable
pass keep the straight segment and are flagged ``"source": "straight"``.

Usage: python scripts/build_route_shapes.py [--plots DIR]
Output: data/routes/route_shapes.json (format in transport_backend/route_shapes.py).
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from transport_ml.data import read_plan  # noqa: E402  (repository-root import)
from transport_backend.route_shapes import shape_sha  # noqa: E402

M_PER_DEG_LAT = 110_540.0
M_PER_DEG_LON_EQUATOR = 111_320.0

VISIT_RADIUS_M = 60.0          # a pass "reaches" a stop inside this radius
SHORT_PAIR_M = 80.0            # closer stops: straight segment, GPS cannot separate them
MAX_SPEED_MPS = 35.0           # implied speed above this marks a GPS jump
MIN_STEP_M = 3.0               # stationary jitter below this is dropped
MAX_GAP_STEP_M = 400.0         # a pass with a longer hole is not used
INLIER_M = 35.0                # passes this close (mean) to the medoid are averaged
SIMPLIFY_M = 6.0
TRAFFIC_FILES = ("train", "validate", "test")


def _scale(lat0: float) -> np.ndarray:
    return np.array([M_PER_DEG_LON_EQUATOR * math.cos(math.radians(lat0)), M_PER_DEG_LAT])


def load_gps(tr_ids: set[str]) -> tuple[dict[str, pd.DataFrame], list[str]]:
    frames = []
    for name in TRAFFIC_FILES:
        path = ROOT / "data" / name / "traffic.csv"
        if not path.exists():
            continue
        t = pd.read_csv(path, usecols=["tr_id", "event_time", "lon", "lat", "location_valid"],
                        dtype={"tr_id": str, "location_valid": str})
        frames.append(t[t["tr_id"].isin(tr_ids)])
    t = pd.concat(frames, ignore_index=True)
    t = t[t["location_valid"].str.lower().isin(["true", "1"])]
    t = t.dropna(subset=["lon", "lat"])
    t = t[t["lon"].between(30, 45) & t["lat"].between(50, 60)]
    t["event_time"] = pd.to_datetime(t["event_time"], format="mixed")
    t = t.drop_duplicates(["tr_id", "event_time"]).sort_values(["tr_id", "event_time"], kind="stable")
    days = sorted(t["event_time"].dt.strftime("%Y-%m-%d").unique().tolist())
    return {tr: g.reset_index(drop=True) for tr, g in t.groupby("tr_id", sort=True)}, days


def clean_track(xy: np.ndarray, sec: np.ndarray) -> np.ndarray:
    """Indices kept after dropping implausible jumps and stationary jitter."""
    keep = [0]
    for i in range(1, len(xy)):
        step = float(np.hypot(*(xy[i] - xy[keep[-1]])))
        dt = max(float(sec[i] - sec[keep[-1]]), 1.0)
        if step / dt > MAX_SPEED_MPS or step < MIN_STEP_M:
            continue
        keep.append(i)
    return np.array(keep, dtype=int)


def visits(dist: np.ndarray) -> np.ndarray:
    """Index of the closest point of every run of consecutive points inside the radius."""
    inside = dist <= VISIT_RADIUS_M
    out, i, n = [], 0, len(dist)
    while i < n:
        if inside[i]:
            j = i
            while j + 1 < n and inside[j + 1]:
                j += 1
            out.append(i + int(np.argmin(dist[i:j + 1])))
            i = j + 1
        else:
            i += 1
    return np.array(out, dtype=int)


def arc_length(line: np.ndarray) -> np.ndarray:
    return np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(line, axis=0).T))])


def resample(line: np.ndarray, n: int) -> np.ndarray:
    s = arc_length(line)
    u = np.linspace(0.0, s[-1], n)
    return np.column_stack([np.interp(u, s, line[:, 0]), np.interp(u, s, line[:, 1])])


def passes(xy: np.ndarray, sec: np.ndarray, vis_a: np.ndarray, vis_b: np.ndarray,
           straight_m: float) -> list[np.ndarray]:
    """GPS sub-tracks from a visit of A to the next visit of B (last A visit before it)."""
    budget_s = min(600.0 + straight_m / 2.0, 3600.0)
    max_len = 2.5 * straight_m + 600.0
    chosen: dict[int, int] = {}
    for i in vis_a:
        k = np.searchsorted(vis_b, i, side="right")
        if k < len(vis_b):
            chosen[int(vis_b[k])] = int(i)  # later A visits overwrite earlier ones
    out = []
    for j, i in sorted(chosen.items()):
        if sec[j] - sec[i] > budget_s or j - i < 1:
            continue
        track = xy[i:j + 1]
        steps = np.hypot(*np.diff(track, axis=0).T)
        if steps.max() > MAX_GAP_STEP_M or steps.sum() > max_len:
            continue
        out.append(track)
    return out


def average(tracks: list[np.ndarray]) -> tuple[np.ndarray, int]:
    lengths = np.array([arc_length(t)[-1] for t in tracks])
    med_len = float(np.median(lengths))
    tracks = [t for t, L in zip(tracks, lengths) if L <= 1.5 * med_len + 50.0]
    n_pts = int(np.clip(round(med_len / 10.0), 8, 300))
    res = np.stack([resample(t, n_pts) for t in tracks])  # (k, n, 2)
    if len(res) == 1:
        return res[0], 1
    d = np.hypot(*(res[:, None] - res[None, :]).transpose(3, 0, 1, 2)).mean(axis=2)
    medoid = int(np.argmin(d.sum(axis=1)))
    inliers = d[medoid] <= INLIER_M
    return np.median(res[inliers], axis=0), int(inliers.sum())


def smooth(line: np.ndarray, window: int = 5) -> np.ndarray:
    if len(line) <= window:
        return line
    pad = window // 2
    kernel = np.ones(window) / window
    out = line.copy()
    for c in range(2):
        padded = np.concatenate([np.full(pad, line[0, c]), line[:, c], np.full(pad, line[-1, c])])
        out[:, c] = np.convolve(padded, kernel, mode="valid")
    out[0], out[-1] = line[0], line[-1]
    return out


def simplify(line: np.ndarray, eps: float) -> np.ndarray:
    keep = np.zeros(len(line), dtype=bool)
    keep[[0, -1]] = True
    stack = [(0, len(line) - 1)]
    while stack:
        a, b = stack.pop()
        if b - a < 2:
            continue
        seg = line[b] - line[a]
        rel = line[a + 1:b] - line[a]
        norm = float(np.hypot(*seg))
        if norm < 1e-9:
            dist = np.hypot(*rel.T)
        else:
            dist = np.abs(seg[0] * rel[:, 1] - seg[1] * rel[:, 0]) / norm
        k = int(np.argmax(dist))
        if dist[k] > eps:
            m = a + 1 + k
            keep[m] = True
            stack += [(a, m), (m, b)]
    return line[keep]


def build_vehicle(stops: pd.DataFrame, gps: pd.DataFrame | None, scale: np.ndarray,
                  origin: np.ndarray) -> list[dict]:
    stops = stops.dropna(subset=["stop_lon", "stop_lat"])
    ids = stops["tt_action_item_id"].tolist()
    ll = stops[["stop_lon", "stop_lat"]].to_numpy(float)
    sxy = (ll - origin) * scale
    if gps is not None and len(gps):
        xy_all = (gps[["lon", "lat"]].to_numpy(float) - origin) * scale
        sec_all = (gps["event_time"] - gps["event_time"].iloc[0]).dt.total_seconds().to_numpy()
        keep = clean_track(xy_all, sec_all)
        xy, sec = xy_all[keep], sec_all[keep]
    else:
        xy, sec = np.zeros((0, 2)), np.zeros(0)
    visit_cache: dict[tuple, np.ndarray] = {}
    shape_cache: dict[tuple, tuple[np.ndarray | None, int]] = {}

    def stop_visits(p: np.ndarray) -> np.ndarray:
        key = (round(p[0], 1), round(p[1], 1))
        if key not in visit_cache:
            visit_cache[key] = visits(np.hypot(*(xy - p).T)) if len(xy) else np.zeros(0, int)
        return visit_cache[key]

    segments = []
    for k in range(len(ids) - 1):
        a, b = sxy[k], sxy[k + 1]
        straight_m = float(np.hypot(*(b - a)))
        key = (round(a[0], 1), round(a[1], 1), round(b[0], 1), round(b[1], 1))
        if key not in shape_cache:
            shape, n = None, 0
            if straight_m >= SHORT_PAIR_M and len(xy):
                tracks = passes(xy, sec, stop_visits(a), stop_visits(b), straight_m)
                if tracks:
                    mean, n = average(tracks)
                    mean[0], mean[-1] = a, b
                    shape = simplify(smooth(mean), SIMPLIFY_M)
            shape_cache[key] = (shape, n)
        shape, n = shape_cache[key]
        if shape is None:
            coords = [ll[k].tolist(), ll[k + 1].tolist()]
            source = "straight"
        else:
            inner = shape[1:-1] / scale + origin
            # Anchors stay exact stop coordinates; interior points are rounded (~0.1 m).
            coords = [ll[k].tolist(), *[[round(x, 6), round(y, 6)] for x, y in inner.tolist()],
                      ll[k + 1].tolist()]
            source = "gps"
        segments.append({"from_stop": ids[k], "to_stop": ids[k + 1], "coords": coords,
                         "source": source, "n": n})
    return segments


def _point_line_dist(pts: np.ndarray, line: np.ndarray) -> np.ndarray:
    start, delta = line[:-1], np.diff(line, axis=0)
    l2 = np.maximum((delta ** 2).sum(axis=1), 1e-9)
    out = np.empty(len(pts))
    for c in range(0, len(pts), 512):
        p = pts[c:c + 512, None, :]
        share = np.clip(((p - start) * delta).sum(axis=2) / l2, 0, 1)
        cand = start + share[..., None] * delta
        out[c:c + 512] = np.sqrt(((p - cand) ** 2).sum(axis=2)).min(axis=1)
    return out


def _plot(path: Path, title: str, pts: np.ndarray, ll: np.ndarray, new_line: np.ndarray,
          origin: np.ndarray, scale: np.ndarray) -> None:
    """Left: whole plan extent. Right: 1.6 km window around the densest stop area."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    sxy = (ll - origin) * scale
    near = (np.hypot(*(sxy[:, None] - sxy[None, :]).transpose(2, 0, 1)) < 800).sum(axis=1)
    centre = ll[int(np.argmax(near))]
    half = 800 / scale
    lo, hi = ll.min(axis=0), ll.max(axis=0)
    pad = np.maximum((hi - lo) * 0.08, half / 4)
    fig, axes = plt.subplots(1, 2, figsize=(18, 9), dpi=100)
    for ax, (x0, y0), (x1, y1) in ((axes[0], lo - pad, hi + pad),
                                   (axes[1], centre - half, centre + half)):
        if len(pts):
            ax.scatter(pts[:, 0], pts[:, 1], s=2, c="#f4a261", alpha=0.35, label="GPS (valid)")
        ax.plot(ll[:, 0], ll[:, 1], "--", c="grey", lw=0.9, label="plan: straight")
        ax.plot(new_line[:, 0], new_line[:, 1], c="#1d3557", lw=1.6, label="shape")
        ax.scatter(ll[:, 0], ll[:, 1], s=10, c="#e63946", zorder=3, label="planned stops")
        ax.set_xlim(x0, x1)
        ax.set_ylim(y0, y1)
        ax.set_aspect(1 / math.cos(math.radians(origin[1])))
    axes[0].set_title(title)
    axes[1].set_title("zoom 1.6 km")
    axes[0].legend(loc="best", fontsize=8)
    fig.savefig(path, bbox_inches="tight")
    plt.close(fig)


def report(result: dict, plan: pd.DataFrame, gps: dict[str, pd.DataFrame], plots: Path | None) -> None:
    segs = [s for v in result.values() for s in v["segments"]]
    gps_share = sum(s["source"] == "gps" for s in segs) / max(len(segs), 1)
    print(f"segments={len(segs)} gps={gps_share:.1%} straight={1 - gps_share:.1%}")
    n_hist = pd.Series([s["n"] for s in segs if s["source"] == "gps"]).clip(upper=5)
    print("gps passes averaged (5 = 5+):", n_hist.value_counts().sort_index().to_dict())
    size = len(json.dumps(result, separators=(",", ":")))
    print(f"json_bytes={size}")
    if plots is not None:
        plots.mkdir(parents=True, exist_ok=True)
    max_anchor = 0.0
    for tr_id, entry in result.items():
        stops = plan[plan["tr_id"] == tr_id].dropna(subset=["stop_lon", "stop_lat"])
        ll = stops[["stop_lon", "stop_lat"]].to_numpy(float)
        origin = ll.mean(axis=0)
        scale = _scale(origin[1])
        for s, (a, b) in zip(entry["segments"], zip(ll[:-1], ll[1:])):
            c = np.array(s["coords"])
            max_anchor = max(max_anchor, float(np.hypot(*((c[0] - a) * scale))),
                             float(np.hypot(*((c[-1] - b) * scale))))
        new_line = np.array([pt for i, s in enumerate(entry["segments"])
                             for pt in (s["coords"] if i == 0 else s["coords"][1:])])
        g = gps.get(tr_id)
        pts = g[["lon", "lat"]].to_numpy(float) if g is not None else np.zeros((0, 2))
        n_seg = len(entry["segments"])
        n_gps = sum(s["source"] == "gps" for s in entry["segments"])
        if len(pts) and len(ll) > 1:
            d_old = _point_line_dist((pts - origin) * scale, (ll - origin) * scale)
            d_new = _point_line_dist((pts - origin) * scale, (new_line - origin) * scale)
            print(f"{tr_id}: segs={n_seg} gps={n_gps} gps_pts={len(pts)} "
                  f"median_dist old={np.median(d_old):.1f}m new={np.median(d_new):.1f}m "
                  f"p90 old={np.percentile(d_old, 90):.0f}m new={np.percentile(d_new, 90):.0f}m")
        if plots is not None:
            _plot(plots / f"{tr_id}.png", f"{tr_id}: {n_gps}/{n_seg} segments from GPS",
                  pts, ll, new_line, origin, scale)
    print(f"max_anchor_offset_m={max_anchor:.3f}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--plan", type=Path, default=ROOT / "data" / "validate" / "schedule_plan.csv")
    parser.add_argument("--out", type=Path, default=ROOT / "data" / "routes" / "route_shapes.json")
    parser.add_argument("--plots", type=Path, default=None)
    args = parser.parse_args()
    plan = read_plan(args.plan)
    gps, days = load_gps(set(plan["tr_id"]))
    result = {}
    for tr_id, stops in plan.groupby("tr_id", sort=True):
        ll = stops[["stop_lon", "stop_lat"]].dropna().to_numpy(float)
        origin = ll.mean(axis=0) if len(ll) else np.array([37.6, 55.75])
        segments = build_vehicle(stops, gps.get(tr_id), _scale(origin[1]), origin)
        result[tr_id] = {"segments": segments, "built_from": days, "sha": shape_sha(segments)}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, separators=(",", ":"), sort_keys=True) + "\n")
    print(f"wrote {args.out} vehicles={len(result)} days={days}")
    report(result, plan, gps, args.plots)


if __name__ == "__main__":
    main()
