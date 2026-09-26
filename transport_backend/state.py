"""Bounded, point-in-time telemetry state for one Backend process.

``history_limit`` bounds records and duplicate identities per mapped vehicle.
``stale_after_s`` is the maximum age of the latest valid GPS event. Counters
``accepted``, ``dropped``, and ``errors`` include reason-specific counterparts.
No old snapshot is mutated: an as-of query filters both event and receive time.
"""

from __future__ import annotations

from collections import Counter, deque
import csv
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import RLock
from typing import Iterable, Mapping


TIME_FORMAT = "%Y-%m-%d %H:%M:%S.%f"


def time_text(value: datetime) -> str:
    if value.tzinfo is not None:
        raise ValueError("state clocks must be naive values in an explicit clock domain")
    return value.strftime(TIME_FORMAT)


def parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value)


@dataclass(frozen=True)
class ClockMapping:
    """Reversible synthetic epoch <-> naive dataset wall clock mapping.

    ``origin_epoch`` is a synthetic Unix second, not a timezone assertion.
    ``origin_wall`` is a naive dataset timestamp. The caller's replay clock
    controls receive availability independently of host wall time.
    """

    origin_epoch: int
    origin_wall: datetime

    def __post_init__(self) -> None:
        if self.origin_wall.tzinfo is not None:
            raise ValueError("origin_wall must be naive dataset wall time")

    def from_epoch(self, seconds: int) -> datetime:
        return self.origin_wall + timedelta(seconds=seconds - self.origin_epoch)

    def to_epoch(self, wall: datetime) -> int:
        if wall.tzinfo is not None:
            raise ValueError("dataset wall time must be naive")
        delta = (wall - self.origin_wall).total_seconds()
        if not delta.is_integer():
            raise ValueError("NDTP timestamps have whole-second precision")
        return self.origin_epoch + int(delta)


def wire_event_time(seconds: int, mapping: ClockMapping | None) -> datetime:
    if mapping is not None:
        return mapping.from_epoch(seconds)
    return datetime.fromtimestamp(seconds, tz=timezone.utc).replace(tzinfo=None)


def load_unit_mapping(paths: Iterable[str | Path]) -> dict[int, str]:
    """Build and validate an explicit unit_id -> tr_id mapping from traffic CSVs."""
    result: dict[int, str] = {}
    for path in paths:
        with open(path, newline="", encoding="utf-8") as handle:
            reader = csv.DictReader(handle)
            if not {"unit_id", "tr_id"}.issubset(reader.fieldnames or []):
                raise ValueError(f"{path}: missing unit_id/tr_id columns")
            for row in reader:
                if not row["unit_id"] or not row["tr_id"]:
                    raise ValueError(f"{path}: empty unit_id/tr_id")
                unit, tr_id = int(row["unit_id"]), row["tr_id"]
                if unit in result and result[unit] != tr_id:
                    raise ValueError(f"unit_id {unit} maps to both {result[unit]} and {tr_id}")
                result[unit] = tr_id
    if not result:
        raise ValueError("unit mapping is empty")
    return result


@dataclass(frozen=True)
class Telemetry:
    unit_id: int
    tr_id: str
    event_time: str
    receive_time: str
    location_valid: bool
    lon: float
    lat: float
    speed: float
    heading: float
    alt: float
    packet_id: str
    session_id: str
    request_id: int
    source_clock: str
    frame_id: str
    received_at_utc: str

    def traffic_row(self) -> dict[str, object]:
        """Rows accepted by transport_ml.data.TRAFFIC_COLUMNS."""
        return {key: getattr(self, key) for key in (
            "tr_id", "event_time", "receive_time", "location_valid",
            "lon", "lat", "speed", "heading")}

    def as_dict(self) -> dict[str, object]:
        return dict(vars(self))


class TelemetryState:
    def __init__(self, unit_mapping: Mapping[int, str], *, history_limit: int = 4096,
                 stale_after_s: float = 45.0, source_clock: str = "utc"):
        if not unit_mapping or history_limit < 1 or stale_after_s <= 0:
            raise ValueError("mapping nonempty, history_limit >= 1, stale_after_s > 0")
        if source_clock not in {"utc", "dataset_wall"}:
            raise ValueError("source_clock must be utc or dataset_wall")
        self.unit_mapping = {int(k): str(v) for k, v in unit_mapping.items()}
        if len(set(self.unit_mapping.values())) != len(self.unit_mapping):
            raise ValueError("each tr_id must have exactly one unit_id")
        self.history_limit = history_limit
        self.stale_after_s = stale_after_s
        self.source_clock = source_clock
        self._history: dict[str, deque[Telemetry]] = {
            tr: deque(maxlen=history_limit) for tr in self.unit_mapping.values()}
        self._identities: dict[str, deque[tuple[object, ...]]] = {
            tr: deque(maxlen=history_limit) for tr in self.unit_mapping.values()}
        self._sessions: dict[int, set[str]] = {unit: set() for unit in self.unit_mapping}
        self._counters: Counter[str] = Counter()
        self._processed_revision = 0
        self._last_processed: dict[str, object] | None = None
        self._last_accepted: dict[str, object] | None = None
        self._lock = RLock()

    def count(self, name: str, amount: int = 1) -> None:
        with self._lock:
            self._counters[name] += amount

    def observe_queue_depth(self, depth: int) -> None:
        with self._lock:
            self._counters["max_queue_depth"] = max(self._counters["max_queue_depth"], depth)

    def counters(self) -> dict[str, int]:
        with self._lock:
            return dict(self._counters)

    def ingest_readback(self) -> dict[str, object]:
        """Ack surface for lockstep replay; revisions rise after state processing.

        ``accepted_revision`` rises only for new telemetry. ``processed_revision``
        also rises for semantic duplicates. The caller can match unit/request/
        session/frame IDs and outcome before advancing its replay clock.
        """
        with self._lock:
            return {"accepted_revision": self._counters["accepted"],
                    "processed_revision": self._processed_revision,
                    "last_processed": (dict(self._last_processed)
                                       if self._last_processed is not None else None),
                    "last_accepted": (dict(self._last_accepted)
                                      if self._last_accepted is not None else None)}

    def mark_processed(self, record: Telemetry, outcome: str) -> None:
        with self._lock:
            self._processed_revision += 1
            identity = {"unit_id": record.unit_id, "request_id": record.request_id,
                        "session_id": record.session_id, "frame_id": record.frame_id,
                        "event_time": record.event_time,
                        "receive_time": record.receive_time, "outcome": outcome}
            self._last_processed = identity
            if outcome == "accepted":
                self._last_accepted = identity

    def connected(self, unit_id: int, session_id: str) -> None:
        with self._lock:
            self._sessions[unit_id].add(session_id)
            self._counters["connections"] += 1

    def disconnected(self, unit_id: int, session_id: str) -> None:
        with self._lock:
            self._sessions[unit_id].discard(session_id)
            self._counters["disconnects"] += 1

    def accept(self, record: Telemetry) -> bool:
        if self.unit_mapping.get(record.unit_id) != record.tr_id:
            raise ValueError("telemetry unit/tr mapping mismatch")
        if record.source_clock != self.source_clock:
            raise ValueError("telemetry clock domain mismatch")
        # Wire payload semantics, not global requestId: repeat on a reconnect
        # is still a duplicate, whereas a correction at the same event time is not.
        identity = (record.unit_id, record.event_time, record.location_valid,
                    record.lon, record.lat, record.speed, record.heading, record.alt)
        with self._lock:
            seen = self._identities[record.tr_id]
            if identity in seen:
                self._counters["dropped"] += 1
                self._counters["dropped_duplicate"] += 1
                return False
            history = self._history[record.tr_id]
            if len(history) == self.history_limit:
                self._counters["dropped"] += 1
                self._counters["dropped_history_eviction"] += 1
            history.append(record)
            seen.append(identity)
            self._counters["accepted"] += 1
            return True

    def history(self, tr_id: str, at: datetime, *, window_s: float | None = None) -> list[dict[str, object]]:
        """Latest received correction per event, with event/receive <= at."""
        if at.tzinfo is not None:
            raise ValueError("at must use the state's naive clock domain")
        with self._lock:
            records = list(self._history[tr_id])
        available: dict[str, Telemetry] = {}
        for record in records:
            event = parse_time(record.event_time)
            receive = parse_time(record.receive_time)
            if event > at or receive > at:
                continue
            if window_s is not None and (at - event).total_seconds() > window_s:
                continue
            previous = available.get(record.event_time)
            if previous is None or record.receive_time >= previous.receive_time:
                available[record.event_time] = record
        return [available[key].as_dict() for key in sorted(available)]

    def snapshot(self, tr_id: str, at: datetime) -> dict[str, object]:
        records = self.history(tr_id, at)
        current = records[-1] if records else None
        if current is None:
            reason = "no_available_gps"
            age = None
        else:
            age = max(0.0, (at - parse_time(str(current["event_time"]))).total_seconds())
            reason = ("invalid_gps" if not current["location_valid"] else
                      "stale_gps" if age > self.stale_after_s else None)
        unit_id = next(unit for unit, tr in self.unit_mapping.items() if tr == tr_id)
        with self._lock:
            connected = bool(self._sessions[unit_id])
        if not connected:
            reason = "disconnected"
        return {"tr_id": tr_id, "unit_id": unit_id, "telemetry": current,
                "connected": connected, "degraded": reason is not None,
                "reason": reason, "gps_age_s": age, "source_clock": self.source_clock}
