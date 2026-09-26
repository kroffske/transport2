"""Planned arrivals and conservative GPS-only stop observations.

The plan contains no factual arrival columns. A stop is observed only from a
past, valid, slow GPS point close to one unambiguous planned stop. Its event
time is an approximation of arrival, never a ground-truth arrival timestamp.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
import math
import pandas as pd


@dataclass(frozen=True)
class Arrival:
    stop_id: str
    time: datetime
    lon: float
    lat: float
    geom: str

    def ml_row(self, tr_id: str) -> dict[str, str]:
        return {"tt_action_item_id": self.stop_id, "tr_id": tr_id,
                "time_begin": self.time.isoformat(), "geom": self.geom}


class Schedule:
    """One owner for target choice and ordered stop matching."""

    def __init__(self, plan: pd.DataFrame, *, stop_radius_m: float = 35.0,
                 stop_speed_kmh: float = 3.0, observation_lag_s: float = 900.0):
        if (not all(math.isfinite(value) for value in
                    (stop_radius_m, stop_speed_kmh, observation_lag_s))
                or stop_radius_m <= 0 or stop_speed_kmh < 0 or observation_lag_s <= 0):
            raise ValueError("stop detector bounds must be finite; radius/lag positive, speed nonnegative")
        self.stop_radius_m = stop_radius_m
        self.stop_speed_kmh = stop_speed_kmh
        self.observation_lag_s = observation_lag_s
        self.by_vehicle: dict[str, list[Arrival]] = {}
        for tr_id, group in plan.groupby("tr_id", sort=False):
            self.by_vehicle[str(tr_id)] = [
                Arrival(str(row.tt_action_item_id), row.time_begin.to_pydatetime(),
                        float(row.stop_lon), float(row.stop_lat), str(row.geom))
                for row in group.itertuples(index=False)]

    def target(self, tr_id: str, at: datetime) -> Arrival | None:
        low, high = at + timedelta(seconds=600), at + timedelta(seconds=900)
        return next((stop for stop in self.by_vehicle.get(tr_id, ())
                     if low < stop.time <= high), None)

    def ml_rows(self, tr_id: str) -> list[dict[str, str]]:
        return [stop.ml_row(tr_id) for stop in self.by_vehicle.get(tr_id, ())]

    def observed_deviation(self, tr_id: str, at: datetime,
                           history: list[dict[str, object]]) -> float | None:
        """Deviation at the latest ordered, confident observed stop.

        Repeated stationary packets retain the first observation at that stop.
        A later ambiguous match invalidates the observation until a new
        confident stop appears. A backward route match is also ambiguous.
        """
        stops = self.by_vehicle.get(tr_id, ())
        last_stop_id: str | None = None
        last_plan_time: datetime | None = None
        last_deviation: float | None = None
        for row in history:
            event = datetime.fromisoformat(str(row["event_time"]))
            receive = datetime.fromisoformat(str(row["receive_time"]))
            if event > at or receive > at or not row["location_valid"]:
                continue
            speed = row["speed"]
            lon, lat = row["lon"], row["lat"]
            if (speed is None or lon is None or lat is None
                    or not all(math.isfinite(float(x)) for x in (speed, lon, lat))
                    or float(speed) > self.stop_speed_kmh):
                continue
            near: list[int] = []
            for index, stop in enumerate(stops):
                if (not math.isfinite(stop.lon) or not math.isfinite(stop.lat)
                        or stop.time > event + timedelta(seconds=60)
                        or (event - stop.time).total_seconds() > self.observation_lag_s):
                    continue
                if _distance_m(float(lon), float(lat), stop.lon, stop.lat) <= self.stop_radius_m:
                    near.append(index)
            if len(near) > 1:
                last_deviation = None
                continue
            if not near:
                continue
            index = near[0]
            stop = stops[index]
            if last_plan_time is not None and stop.time < last_plan_time:
                last_deviation = None
                continue
            if stop.stop_id != last_stop_id:
                last_stop_id = stop.stop_id
                last_plan_time = stop.time
                last_deviation = (event - stop.time).total_seconds()
        return last_deviation


def _distance_m(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    a1, b1, a2, b2 = map(math.radians, (lon1, lat1, lon2, lat2))
    term = (math.sin((b2 - b1) / 2) ** 2
            + math.cos(b1) * math.cos(b2) * math.sin((a2 - a1) / 2) ** 2)
    return 6371000 * 2 * math.asin(min(1.0, math.sqrt(term)))
