"""One feature implementation for historical batches and online point requests.

No label-dependent transforms, centered windows, backward filling or future facts.
Naive stop geometry features are NOT full road-network map matching.
"""
from __future__ import annotations

from dataclasses import dataclass
import numpy as np
import pandas as pd

WINDOWS = (60, 180, 300, 600, 900)
SEQ_CHANNELS = ["speed_100", "stopped", "heading_sin", "heading_cos", "target_dx_5km", "target_dy_5km", "speed_present", "position_present", "age_60s"]
SEQ_LENGTH = 60


def distance_m(lon1, lat1, lon2, lat2):
    a1, b1, a2, b2 = map(np.radians, [lon1, lat1, lon2, lat2])
    a = np.sin((b2-b1)/2)**2 + np.cos(b1)*np.cos(b2)*np.sin((a2-a1)/2)**2
    return 6371000 * 2 * np.arcsin(np.sqrt(np.clip(a, 0, 1)))


@dataclass
class FeatureBatch:
    X: pd.DataFrame
    sequence: np.ndarray


class FeatureBuilder:
    def __init__(self, traffic: pd.DataFrame | None = None, plan: pd.DataFrame | None = None,
                 availability: str = "event", context_enabled: bool = True,
                 feature_profile: str = "legacy"):
        if availability not in ("event", "received"):
            raise ValueError("availability must be event or received")
        self.availability = availability
        self.context_enabled = context_enabled
        if feature_profile not in ("legacy", "motion-v1"):
            raise ValueError("Unknown feature_profile")
        self.feature_profile = feature_profile
        self.traffic = {} if traffic is None else {str(k): g.reset_index(drop=True) for k, g in traffic.groupby("tr_id", sort=False)}
        self.times = {k: v["event_time"].to_numpy(dtype="datetime64[ns]") for k, v in self.traffic.items()}
        self.plans = {} if plan is None else {str(k): g.sort_values("time_begin").reset_index(drop=True) for k, g in plan.groupby("tr_id", sort=False)}
        self.plan_index = {k: {str(r.tt_action_item_id): i for i, r in g.iterrows()} for k, g in self.plans.items()}
        if availability == "received" and traffic is not None and traffic["receive_time"].isna().any():
            raise ValueError("Received-time replay requires receive_time on every input record")

    def history(self, point: dict) -> pd.DataFrame | None:
        vehicle = str(point["tr_id"])
        g = self.traffic.get(vehicle)
        if g is None:
            return None
        now = pd.Timestamp(point["T"])
        ts = self.times[vehicle]
        left = ts.searchsorted((now-pd.Timedelta(seconds=900)).to_datetime64(), side="right")
        right = ts.searchsorted(now.to_datetime64(), side="right")
        h = g.iloc[left:right]
        if self.availability == "received":
            h = h.loc[h["receive_time"] <= now]
        # Applied AFTER point-in-time filtering; corrections cannot leak backwards in time.
        return h.drop_duplicates("event_time", keep="last")

    def plan_features(self, point: dict) -> dict:
        result = {"plan_missing": 1.0, "target_lon": np.nan, "target_lat": np.nan,
                  "target_previous_gap_s": np.nan, "planned_stops_ahead": np.nan,
                  "planned_position_lon": np.nan, "planned_position_lat": np.nan}
        vehicle, stop = str(point["tr_id"]), str(point["target_stop_id"])
        g = self.plans.get(vehicle)
        i = self.plan_index.get(vehicle, {}).get(stop)
        if g is None or i is None:
            return result
        target = g.iloc[i]
        if target["time_begin"] != pd.Timestamp(point["target_time_begin"]):
            raise ValueError(f"Target time disagrees with schedule for {point['sample_id']}")
        result.update(plan_missing=0., target_lon=float(target["stop_lon"]), target_lat=float(target["stop_lat"]))
        if i:
            result["target_previous_gap_s"] = (target["time_begin"]-g.iloc[i-1]["time_begin"]).total_seconds()
        ts = g["time_begin"].to_numpy(dtype="datetime64[ns]")
        now = pd.Timestamp(point["T"])
        j = ts.searchsorted(now.to_datetime64(), side="right")
        result["planned_stops_ahead"] = float(max(0, i-j+1))
        # Linear interpolation between scheduled stops: known PLAN only, not factual arrivals.
        if 0 < j < len(g):
            prev, nxt = g.iloc[j-1], g.iloc[j]
            span = (nxt["time_begin"]-prev["time_begin"]).total_seconds()
            if 0 < span <= 1800:
                frac = (now-prev["time_begin"]).total_seconds()/span
                result["planned_position_lon"] = float(prev["stop_lon"] + frac*(nxt["stop_lon"]-prev["stop_lon"]))
                result["planned_position_lat"] = float(prev["stop_lat"] + frac*(nxt["stop_lat"]-prev["stop_lat"]))
        return result

    def motion_features(self, point: dict, history: pd.DataFrame | None) -> dict:
        """Signed schedule lag from past GPS projected onto nearby PLAN segments.

        This is local straight-segment geometry, not road-network map matching.
        Ambiguous or distant projections remain missing; no actual arrival is read.
        """
        result = {"motion_"+name: np.nan for name in (
            "lag_latest_s", "lag_median_60_s", "lag_median_180_s", "lag_median_300_s",
            "lag_median_900_s", "lag_change_s", "offset_m", "matched_fraction",
            "lag_minus_cur_s", "target_path_m", "target_path_speed_kmh",
            "target_segment_m", "target_segment_speed_kmh")}
        vehicle = str(point["tr_id"])
        plan = self.plans.get(vehicle)
        if plan is None or len(plan) < 2:
            return result
        now = pd.Timestamp(point["T"])
        target_index = self.plan_index[vehicle].get(str(point["target_stop_id"]))
        lon = plan.stop_lon.to_numpy(dtype=float)
        lat = plan.stop_lat.to_numpy(dtype=float)
        times = plan.time_begin.to_numpy(dtype="datetime64[ns]")
        gaps = np.diff(times)/np.timedelta64(1, "s")
        lengths = distance_m(lon[:-1], lat[:-1], lon[1:], lat[1:])
        if target_index is not None and target_index > 0:
            i = target_index-1
            result["motion_target_segment_m"] = float(lengths[i])
            if gaps[i] > 0:
                result["motion_target_segment_speed_kmh"] = float(lengths[i]/gaps[i]*3.6)
            j = max(0, times.searchsorted((now-pd.Timedelta(seconds=float(point["cur_dev_s"]))).to_datetime64())-1)
            if j < target_index:
                path = lengths[j:target_index]
                if np.isfinite(path).all():
                    result["motion_target_path_m"] = float(path.sum())
                    horizon = (pd.Timestamp(point["target_time_begin"])-now).total_seconds()
                    result["motion_target_path_speed_kmh"] = float(path.sum()/horizon*3.6)
        if history is None or not len(history):
            return result
        h = history.loc[history.lon.notna() & history.lat.notna()]
        if not len(h):
            return result
        # Time window disambiguates repeated visits without actual schedule facts.
        offset = (times-now.to_datetime64())/np.timedelta64(1, "s")
        cur = float(point["cur_dev_s"])
        eligible = ((offset[:-1] >= -cur-2100) & (offset[1:] <= -cur+1200)
                    & (gaps > 0) & (gaps <= 900) & (lengths >= 20)
                    & np.isfinite(lengths))
        ix = np.flatnonzero(eligible)
        if not len(ix):
            return result
        origin_lon, origin_lat = float(h.lon.iloc[-1]), float(h.lat.iloc[-1])
        scale_x = 111320*np.cos(np.radians(origin_lat))
        x, y = (lon-origin_lon)*scale_x, (lat-origin_lat)*111320
        hx = ((h.lon.to_numpy()-origin_lon)*scale_x)[:, None]
        hy = ((h.lat.to_numpy()-origin_lat)*111320)[:, None]
        dx, dy = x[ix+1]-x[ix], y[ix+1]-y[ix]
        fraction = np.clip(((hx-x[ix])*dx+(hy-y[ix])*dy)/(dx*dx+dy*dy), 0, 1)
        distance = np.hypot(hx-x[ix]-fraction*dx, hy-y[ix]-fraction*dy)
        event_offset = (h.event_time.to_numpy(dtype="datetime64[ns]")-now.to_datetime64())/np.timedelta64(1, "s")
        lag = event_offset[:, None]-(offset[ix]+fraction*gaps[ix])
        # Penalize implausible temporal matches, especially on crossing routes.
        cost = distance + .05*np.abs(lag-cur)
        best = np.argmin(cost, axis=1)
        rows = np.arange(len(h))
        matched_distance = distance[rows, best]
        matched_lag = lag[rows, best]
        valid = (matched_distance <= 250) & (np.abs(matched_lag-cur) <= 1200)
        result["motion_matched_fraction"] = float(valid.mean())
        ages = -event_offset
        for window in (60, 180, 300, 900):
            mask = valid & (ages <= window)
            if mask.any():
                result[f"motion_lag_median_{window}_s"] = float(np.median(matched_lag[mask]))
        if valid[-1] and ages[-1] <= 120:
            result["motion_lag_latest_s"] = float(matched_lag[-1])
            result["motion_offset_m"] = float(matched_distance[-1])
            result["motion_lag_minus_cur_s"] = float(matched_lag[-1]-cur)
        result["motion_lag_change_s"] = result["motion_lag_median_60_s"]-result["motion_lag_median_300_s"]
        return result

    def one(self, point: dict) -> tuple[dict, np.ndarray]:
        now = pd.Timestamp(point["T"])
        minute = now.hour*60 + now.minute + now.second/60
        cur = float(point["cur_dev_s"])
        f = {"cur_dev_s": cur, "abs_cur_dev_s": abs(cur),
             "horizon_s": (pd.Timestamp(point["target_time_begin"])-now).total_seconds(),
             "tod_sin": float(np.sin(2*np.pi*minute/1440)),
             "tod_cos": float(np.cos(2*np.pi*minute/1440)),
             "day_of_week": float(now.dayofweek)}
        sequence = np.zeros((SEQ_LENGTH, len(SEQ_CHANNELS)), dtype=np.float32)
        sequence[:, -1] = 1.
        if not self.context_enabled:
            return f, sequence
        f.update(self.plan_features(point))
        h = self.history(point)
        if self.feature_profile == "motion-v1":
            f.update(self.motion_features(point, h))
        empty = h is None or len(h) == 0
        f.update(telemetry_missing=float(empty), packet_age_s=np.nan, valid_position_age_s=np.nan,
                 latest_speed=np.nan, latest_heading_sin=np.nan, latest_heading_cos=np.nan,
                 latest_lon=np.nan, latest_lat=np.nan, trailing_stop_s=np.nan,
                 distance_to_target_m=np.nan, distance_to_planned_position_m=np.nan,
                 required_straight_speed_kmh=np.nan)
        for window in WINDOWS:
            prefix = f"w{window}_"
            for name in ["count", "valid_speed_fraction", "speed_mean", "speed_std", "speed_min", "speed_max",
                         "speed_q10", "speed_q90", "stopped_fraction", "span_s", "max_gap_s", "path_m"]:
                f[prefix+name] = 0. if name == "count" else np.nan
        if empty:
            return f, sequence
        ages = (now-h["event_time"]).dt.total_seconds().to_numpy()
        f["packet_age_s"] = float(ages[-1])
        last = h.iloc[-1]
        f["latest_speed"] = float(last["speed"])
        f["latest_heading_sin"] = float(np.sin(np.radians(last["heading"])))
        f["latest_heading_cos"] = float(np.cos(np.radians(last["heading"])))
        valid_position = h.loc[h["lon"].notna() & h["lat"].notna()]
        if len(valid_position):
            lp = valid_position.iloc[-1]
            f["valid_position_age_s"] = (now-lp["event_time"]).total_seconds()
            if f["valid_position_age_s"] <= 120:
                f["latest_lon"], f["latest_lat"] = float(lp["lon"]), float(lp["lat"])
                f["distance_to_target_m"] = float(distance_m(lp["lon"], lp["lat"], f["target_lon"], f["target_lat"]))
                f["distance_to_planned_position_m"] = float(distance_m(lp["lon"], lp["lat"], f["planned_position_lon"], f["planned_position_lat"]))
                f["required_straight_speed_kmh"] = f["distance_to_target_m"] / f["horizon_s"] * 3.6
        speeds = h["speed"].to_numpy()
        times = h["event_time"].to_numpy(dtype="datetime64[ns]")
        f["trailing_stop_s"] = 0.
        if np.isfinite(speeds[-1]) and speeds[-1] < 2 and ages[-1] <= 60:
            first = len(speeds)-1
            while first > 0 and np.isfinite(speeds[first-1]) and speeds[first-1] < 2:
                if (times[first]-times[first-1])/np.timedelta64(1, "s") > 45:
                    break
                first -= 1
            f["trailing_stop_s"] = float((times[-1]-times[first])/np.timedelta64(1, "s"))
        for window in WINDOWS:
            w = h.loc[ages < window]
            if not len(w):
                continue
            prefix = f"w{window}_"
            speed = w["speed"].dropna().to_numpy()
            f[prefix+"count"] = float(len(w))
            f[prefix+"valid_speed_fraction"] = float(len(speed)/len(w))
            if len(speed):
                for name, value in {"speed_mean": speed.mean(), "speed_std": speed.std(), "speed_min": speed.min(),
                                    "speed_max": speed.max(), "speed_q10": np.quantile(speed, .1),
                                    "speed_q90": np.quantile(speed, .9), "stopped_fraction": (speed < 2).mean()}.items():
                    f[prefix+name] = float(value)
            t = w["event_time"].to_numpy(dtype="datetime64[ns]")
            f[prefix+"span_s"] = float((t[-1]-t[0])/np.timedelta64(1, "s"))
            if len(w) > 1:
                dt = np.diff(t)/np.timedelta64(1, "s")
                f[prefix+"max_gap_s"] = float(max(dt.max(), (now-w.iloc[-1]["event_time"]).total_seconds()))
                lon, lat = w["lon"].to_numpy(), w["lat"].to_numpy()
                dist = distance_m(lon[:-1], lat[:-1], lon[1:], lat[1:])
                good = np.isfinite(dist) & (dt > 0) & (dt <= 60) & (dist/np.maximum(dt, 1)*3.6 <= 120)
                f[prefix+"path_m"] = float(dist[good].sum()) if good.any() else np.nan
        # Backward-asof resampling; never interpolate from a later observation.
        grid = now.to_datetime64() - np.arange(SEQ_LENGTH-1, -1, -1)*np.timedelta64(15, "s")
        indexes = times.searchsorted(grid, side="right")-1
        for k, ix in enumerate(indexes):
            if ix < 0:
                continue
            age = float((grid[k]-times[ix])/np.timedelta64(1, "s"))
            if age > 60:
                continue
            row = h.iloc[ix]
            speed_ok = np.isfinite(row["speed"])
            pos_ok = np.isfinite([row["lon"], row["lat"], f["target_lon"], f["target_lat"]]).all()
            heading = np.radians(row["heading"]) if np.isfinite(row["heading"]) else 0.
            dx = (row["lon"]-f["target_lon"])*111320*np.cos(np.radians(f["target_lat"]))/5000 if pos_ok else 0.
            dy = (row["lat"]-f["target_lat"])*111320/5000 if pos_ok else 0.
            sequence[k] = [row["speed"]/100 if speed_ok else 0., float(speed_ok and row["speed"] < 2),
                           np.sin(heading), np.cos(heading), np.clip(dx, -10, 10), np.clip(dy, -10, 10),
                           float(speed_ok), float(pos_ok), age/60]
        return f, sequence

    def transform(self, points: pd.DataFrame) -> FeatureBatch:
        features, sequences = [], []
        for point in points.to_dict("records"):
            f, sequence = self.one(point)
            features.append(f)
            sequences.append(sequence)
        X = pd.DataFrame(features).replace([np.inf, -np.inf], np.nan).astype(np.float32)
        forbidden = {"sample_id", "tr_id", "target_stop_id", "target_delay_s", "target_class", "time_fact_begin"}
        unexpected = forbidden.intersection(X.columns)
        if unexpected:
            raise ValueError(f"Forbidden outcome or identity feature columns: {sorted(unexpected)}")
        return FeatureBatch(X, np.stack(sequences))
