"""The single owner of the Backend source clock and of the demo run.

In ``SOURCE_CLOCK=simulation`` the process starts in ``waiting_driver`` without
a clock mapping. The emulator driver registers exactly one run per process
(``POST /v1/run``); only then does the dataset clock start, at
``dataset_start`` and ``speedup`` dataset seconds per wall second. Until
registration ``clock()`` is ``None``: NDTP navigation frames are rejected,
ticks and snapshots never consult the schedule. A second registration is a
conflict, so a second driver cannot silently take over the emulator.

Lifecycle: ``waiting_driver -> starting -> running -> completed | failed |
stalled``. ``completed``/``failed`` are reported by the driver and final;
``running`` means an accepted frame arrived within ``stall_after_s`` wall
seconds; otherwise the run is ``stalled`` (also from ``starting``).

Replay (``dataset_wall``) and live ``utc`` clocks are owned by their caller;
the registry only exposes them, has no run and serves every mapped vehicle.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
import math
import secrets
from threading import RLock
from time import time
from typing import Callable, Mapping

from .state import ClockMapping

RUN_SOURCE = "official_emulator"
MAX_SPEEDUP = 100
# The driver heartbeats at least every 10 s between POSTs; a longer period would
# also make a healthy run look stalled.
MAX_POST_PERIOD_S = 5.0
DRIVER_STATES = ("running", "completed", "failed")
FINAL_STATES = ("completed", "failed")


class RunConflict(RuntimeError):
    """The request contradicts the registered run (second driver, final state)."""

    def __init__(self, detail: str, run_id: str | None):
        super().__init__(detail)
        self.detail = detail
        self.run_id = run_id


class RunNotFound(LookupError):
    """No registered run has this ID."""


@dataclass(frozen=True)
class RunPlan:
    """What the driver will feed: window, pace, vehicles and display-only path."""

    dataset_start: datetime
    dataset_end: datetime
    speedup: int
    post_period_s: float
    units: tuple[int, ...]
    path: Mapping[int, tuple[tuple[float, float], ...]] = field(default_factory=dict)


@dataclass
class _DriverReport:
    state: str = "running"
    thinned_ratio: float | None = None
    repeat_ratio: float | None = None
    counters: dict[str, int] = field(default_factory=dict)
    reason: str | None = None
    reported_at_utc: str | None = None


class RunRegistry:
    def __init__(self, source_clock: str, unit_mapping: Mapping[int, str], *,
                 mapping: ClockMapping | None = None,
                 clock: Callable[[], datetime] | None = None,
                 wall: Callable[[], float] = time, stall_after_s: float = 30.0):
        if source_clock not in {"simulation", "dataset_wall", "utc"}:
            raise ValueError("source_clock must be simulation, dataset_wall or utc")
        if source_clock == "simulation" and (mapping is not None or clock is not None):
            raise ValueError("simulation clock is created by run registration")
        if source_clock == "dataset_wall" and (mapping is None or clock is None):
            raise ValueError("dataset_wall needs its replay mapping and clock")
        if source_clock == "utc" and mapping is not None:
            raise ValueError("utc must not use a ClockMapping")
        if not math.isfinite(stall_after_s) or stall_after_s <= 0:
            raise ValueError("stall_after_s must be finite and positive")
        self.source_clock = source_clock
        self.unit_mapping = dict(unit_mapping)
        self.stall_after_s = stall_after_s
        self._wall = wall
        self._external_clock = clock or (
            (lambda: datetime.now(timezone.utc).replace(tzinfo=None)) if source_clock == "utc" else None)
        self._mapping = mapping
        self._lock = RLock()
        self._run_id: str | None = None
        self._plan: RunPlan | None = None
        self._registered_wall: float | None = None
        self._registered_at_utc: str | None = None
        self._accepted_frames = 0
        self._last_frame_wall: float | None = None
        self._driver = _DriverReport()

    @property
    def mapping(self) -> ClockMapping | None:
        with self._lock:
            return self._mapping

    @property
    def run_id(self) -> str | None:
        with self._lock:
            return self._run_id

    def clock(self) -> datetime | None:
        """Current source time, or ``None`` while a simulation run is not registered."""
        return self.ingest_sample()[1]

    def ingest_sample(self) -> tuple[ClockMapping | None, datetime | None]:
        """Mapping and receive time sampled together at one ingestion boundary."""
        with self._lock:
            if self.source_clock != "simulation":
                return self._mapping, self._external_clock()
            if self._mapping is None:
                return None, None
            return self._mapping, self._mapping.from_epoch(self._wall())

    def vehicles(self) -> list[tuple[int, str]]:
        """(unit_id, tr_id) served by snapshots: the run's units, or all outside simulation."""
        with self._lock:
            if self.source_clock != "simulation":
                return list(self.unit_mapping.items())
            if self._plan is None:
                return []
            return [(unit, self.unit_mapping[unit]) for unit in self._plan.units]

    def path(self, unit_id: int) -> list[list[float]]:
        with self._lock:
            if self._plan is None:
                return []
            return [[lon, lat] for lon, lat in self._plan.path.get(unit_id, ())]

    def register(self, plan: RunPlan) -> dict:
        if self.source_clock != "simulation":
            raise RunConflict("run_requires_simulation_clock", None)
        with self._lock:
            # A second driver is a conflict whatever it asks for.
            if self._run_id is not None:
                raise RunConflict("run_already_registered", self._run_id)
            _validate_plan(plan, self.unit_mapping)
            now = self._wall()
            started = datetime.fromtimestamp(now, timezone.utc)
            self._run_id = f"run-{started:%Y%m%dT%H%M%S}-{secrets.token_hex(2)}"
            self._plan = plan
            self._mapping = ClockMapping(math.floor(now), plan.dataset_start, plan.speedup)
            self._registered_wall = now
            self._registered_at_utc = started.replace(tzinfo=None).isoformat()
            return {"run_id": self._run_id, "clock_mapping": self.mapping_readback(),
                    "run": self.readback()}

    def report(self, run_id: str, state: str, *, thinned_ratio: float, repeat_ratio: float,
               counters: Mapping[str, int] | None = None, reason: str | None = None) -> dict:
        if state not in DRIVER_STATES:
            raise ValueError(f"driver state must be one of {DRIVER_STATES}")
        for ratio in (thinned_ratio, repeat_ratio):
            if not math.isfinite(ratio) or not 0 <= ratio <= 1:
                raise ValueError("ratios must be within [0, 1]")
        with self._lock:
            if self._run_id is None or run_id != self._run_id:
                raise RunNotFound(run_id)
            if self._driver.state in FINAL_STATES:
                raise RunConflict("run_already_finished", self._run_id)
            reported = datetime.fromtimestamp(self._wall(), timezone.utc).replace(tzinfo=None)
            self._driver = _DriverReport(
                state, thinned_ratio, repeat_ratio, dict(counters or {}), reason,
                reported.isoformat())
            return self.readback()

    def frame_accepted(self) -> None:
        with self._lock:
            self._accepted_frames += 1
            self._last_frame_wall = self._wall()

    def mapping_readback(self) -> dict | None:
        with self._lock:
            if self._mapping is None:
                return None
            return {"epoch_origin": self._mapping.origin_epoch,
                    "dataset_origin": self._mapping.origin_wall.isoformat(),
                    "rate": self._mapping.rate}

    def readback(self, dataset_time: datetime | None = None) -> dict | None:
        """Run envelope; ``dataset_time`` lets a snapshot report its own clock sample."""
        if self.source_clock != "simulation":
            return None
        with self._lock:
            plan, driver = self._plan, self._driver
            if plan is None:
                return {"run_id": None, "state": "waiting_driver", "source": RUN_SOURCE,
                        "speedup": None, "post_period_s": None, "dataset_start": None,
                        "dataset_end": None, "dataset_time": None, "progress": None,
                        "thinned_ratio": None, "repeat_ratio": None, "vehicle_count": 0,
                        "accepted_frames": 0, "last_frame_age_s": None,
                        "registered_at_utc": None, "driver": None}
            now = self._wall()
            # The source clock keeps running after the window; the run's time stops at its end.
            at = min(dataset_time or self._mapping.from_epoch(now), plan.dataset_end)
            span = (plan.dataset_end - plan.dataset_start).total_seconds()
            progress = min(1.0, max(0.0, (at - plan.dataset_start).total_seconds() / span))
            last_age = now - self._last_frame_wall if self._last_frame_wall is not None else None
            return {"run_id": self._run_id, "state": self._state(now), "source": RUN_SOURCE,
                    "speedup": plan.speedup, "post_period_s": plan.post_period_s,
                    "dataset_start": plan.dataset_start.isoformat(),
                    "dataset_end": plan.dataset_end.isoformat(),
                    "dataset_time": at.isoformat(), "progress": round(progress, 4),
                    "thinned_ratio": driver.thinned_ratio, "repeat_ratio": driver.repeat_ratio,
                    "vehicle_count": len(plan.units), "accepted_frames": self._accepted_frames,
                    "last_frame_age_s": round(last_age, 3) if last_age is not None else None,
                    "registered_at_utc": self._registered_at_utc,
                    "driver": {"state": driver.state, "reason": driver.reason,
                               "counters": dict(driver.counters),
                               "reported_at_utc": driver.reported_at_utc}}

    def _state(self, now: float) -> str:
        if self._driver.state in FINAL_STATES:
            return self._driver.state
        last = self._last_frame_wall
        if now - (last if last is not None else self._registered_wall) > self.stall_after_s:
            return "stalled"
        return "running" if last is not None else "starting"


def _validate_plan(plan: RunPlan, unit_mapping: Mapping[int, str]) -> None:
    if plan.dataset_start.tzinfo is not None or plan.dataset_end.tzinfo is not None:
        raise ValueError("dataset window must be naive dataset wall time")
    if plan.dataset_end <= plan.dataset_start:
        raise ValueError("dataset_end must be after dataset_start")
    if type(plan.speedup) is not int or not 1 <= plan.speedup <= MAX_SPEEDUP:
        raise ValueError(f"speedup must be an integer in [1, {MAX_SPEEDUP}]")
    if not math.isfinite(plan.post_period_s) or not 1 <= plan.post_period_s <= MAX_POST_PERIOD_S:
        raise ValueError(f"post_period_s must be within [1, {MAX_POST_PERIOD_S:g}] seconds")
    if not plan.units or len(set(plan.units)) != len(plan.units):
        raise ValueError("units must be a nonempty list without repeats")
    unknown = sorted(unit for unit in plan.units if unit not in unit_mapping)
    if unknown:
        raise ValueError(f"unknown unit_id: {unknown}")
    extra = sorted(set(plan.path) - set(plan.units))
    if extra:
        raise ValueError(f"path for units outside the run: {extra}")
    for points in plan.path.values():
        for lon, lat in points:
            if not (math.isfinite(lon) and math.isfinite(lat)
                    and -180 <= lon <= 180 and -90 <= lat <= 90):
                raise ValueError("path coordinates must be finite WGS84 degrees")
