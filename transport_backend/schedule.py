"""Planned arrivals and conservative GPS-only stop observations.

The plan contains no factual arrival columns. A stop is observed only from a
past, valid, slow GPS point close to one unambiguous planned stop. Its event
time is an approximation of arrival, never a ground-truth arrival timestamp.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from collections import Counter
from bisect import bisect_left, bisect_right
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


@dataclass
class StopObservation:
    event_time: datetime
    frame_id: str


@dataclass
class StopProgress:
    """One first observation per known planned arrival; no retained GPS stream."""

    first_observations: dict[str, StopObservation] = field(default_factory=dict)
    seen_frames: set[str] = field(default_factory=set)
    last_stop: Arrival | None = None
    last_evidence_event: datetime | None = None
    last_source_time: datetime | None = None
    confident: bool = False


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
        self._times: dict[str, list[datetime]] = {}
        self._progress: dict[str, StopProgress] = {}
        self._counters: Counter[str] = Counter()
        for tr_id, group in plan.groupby("tr_id", sort=False):
            self.by_vehicle[str(tr_id)] = [
                Arrival(str(row.tt_action_item_id), row.time_begin.to_pydatetime(),
                        float(row.stop_lon), float(row.stop_lat), str(row.geom))
                for row in group.itertuples(index=False)]
            self._times[str(tr_id)] = [stop.time for stop in self.by_vehicle[str(tr_id)]]
            self._progress[str(tr_id)] = StopProgress()

    def target(self, tr_id: str, at: datetime) -> Arrival | None:
        low, high = at + timedelta(seconds=600), at + timedelta(seconds=900)
        return next((stop for stop in self.by_vehicle.get(tr_id, ())
                     if low < stop.time <= high), None)

    def ml_rows(self, tr_id: str) -> list[dict[str, str]]:
        return [stop.ml_row(tr_id) for stop in self.by_vehicle.get(tr_id, ())]

    def observed_deviation(self, tr_id: str, at: datetime,
                           history: list[dict[str, object]]) -> float | None:
        """Deviation at the latest ordered, confident observed stop.

        Process newly available frames in receive order. First observations
        belong to this detector, not the ML rolling window. Each vehicle retains
        at most one event per planned arrival plus IDs in the bounded state
        history supplied by its caller. Late evidence never reverses the
        committed stop sequence. A same-event correction can retract its GPS
        evidence; future confidence then requires a confirmed stop again.
        """
        stops = self.by_vehicle.get(tr_id, ())
        if not stops:
            return None
        progress = self._progress[tr_id]
        if progress.last_source_time is not None and at < progress.last_source_time:
            raise ValueError("stop detector source time must not move backwards")
        progress.last_source_time = at
        available = [row for row in history
                     if datetime.fromisoformat(str(row["event_time"])) <= at
                     and datetime.fromisoformat(str(row["receive_time"])) <= at]
        new = [row for row in available if str(row["frame_id"]) not in progress.seen_frames]
        progress.seen_frames = {str(row["frame_id"]) for row in available}
        new.sort(key=lambda row: (str(row["receive_time"]), str(row["received_at_utc"])))
        for row in new:
            event = datetime.fromisoformat(str(row["event_time"]))
            speed = row["speed"]
            lon, lat = row["lon"], row["lat"]
            near: list[int] = []
            if (row["location_valid"] and speed is not None and lon is not None and lat is not None
                    and all(math.isfinite(float(x)) for x in (speed, lon, lat))
                    and float(speed) <= self.stop_speed_kmh):
                times = self._times[tr_id]
                start = bisect_left(times, event - timedelta(seconds=self.observation_lag_s))
                end = bisect_right(times, event + timedelta(seconds=60))
                for index in range(start, end):
                    stop = stops[index]
                    if not math.isfinite(stop.lon) or not math.isfinite(stop.lat):
                        continue
                    if _distance_m(float(lon), float(lat), stop.lon, stop.lat) <= self.stop_radius_m:
                        near.append(index)
            # Explicit corrections revoke evidence even when their event is old.
            # An observation absent solely through history eviction remains kept.
            frame_id = str(row["frame_id"])
            for stop_id, observation in list(progress.first_observations.items()):
                if observation.event_time == event and observation.frame_id != frame_id:
                    if len(near) == 1 and stops[near[0]].stop_id == stop_id:
                        observation.frame_id = frame_id
                    else:
                        del progress.first_observations[stop_id]
                        if progress.last_stop is not None and progress.last_stop.stop_id == stop_id:
                            progress.confident = False
                        self._counters["stop_observations_retracted"] += 1
            if len(near) > 1:
                if progress.last_evidence_event is None or event >= progress.last_evidence_event:
                    progress.confident = False
                    progress.last_evidence_event = event
                    self._counters["stop_ambiguous"] += 1
                continue
            if not near:
                continue
            index = near[0]
            stop = stops[index]
            if progress.last_evidence_event is not None and event < progress.last_evidence_event:
                self._counters["stop_late_evidence_ignored"] += 1
                continue
            progress.last_evidence_event = event
            if progress.last_stop is not None and stop.time < progress.last_stop.time:
                progress.confident = False
                self._counters["stop_sequence_regression"] += 1
                continue
            if stop.stop_id not in progress.first_observations:
                progress.first_observations[stop.stop_id] = StopObservation(event, frame_id)
                self._counters["stop_observations"] += 1
            progress.last_stop = stop
            progress.confident = True
        if not progress.confident or progress.last_stop is None:
            return None
        first = progress.first_observations[progress.last_stop.stop_id]
        return (first.event_time - progress.last_stop.time).total_seconds()

    def observed_stop_ids(self, tr_id: str) -> frozenset[str]:
        """Planned arrivals the detector has already observed (first observations)."""
        progress = self._progress.get(tr_id)
        return frozenset(progress.first_observations) if progress is not None else frozenset()

    def counters(self) -> dict[str, int]:
        return {**self._counters,
                "stop_observation_count": sum(len(p.first_observations) for p in self._progress.values()),
                "stop_observation_limit": sum(len(stops) for stops in self.by_vehicle.values()),
                "stop_seen_frame_count": sum(len(p.seen_frames) for p in self._progress.values())}


def _distance_m(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    a1, b1, a2, b2 = map(math.radians, (lon1, lat1, lon2, lat2))
    term = (math.sin((b2 - b1) / 2) ** 2
            + math.cos(b1) * math.cos(b2) * math.sin((a2 - a1) / 2) ** 2)
    return 6371000 * 2 * math.asin(min(1.0, math.sqrt(term)))
