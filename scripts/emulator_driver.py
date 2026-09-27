"""Feed the official NDTP emulator with project GPS points for one Backend run.

The emulator (``ndtp-telemetry-emulator``, unmodified) has no routes: every
``POST /api/config`` replaces its whole configuration and makes each unit send
one Nav00 right away. This driver therefore:

1. reads ``traffic.csv`` of the chosen dataset window itself (``is_hist_data``
   rows are skipped; per unit the points are ordered by ``event_time``, and a
   same-second correction keeps only the last received row);
2. waits for the Backend (``SOURCE_CLOCK=simulation``) and the emulator API,
   then registers the run with ``POST /v1/run`` *before* touching the emulator
   configuration: a second driver gets 409 and exits non-zero;
3. every ``DEMO_POST_PERIOD_S`` wall seconds posts one config with every
   active unit (``intervalMs=3600000``: one packet per POST). Each unit sends
   its latest point with ``event_time <=`` the Backend dataset time; earlier
   unsent points are thinned. Without a new point the last one is repeated,
   but for at most ``DEMO_REPEAT_MAX_S`` dataset seconds; after that the unit
   leaves the config until its next point. The echo of every POST is checked;
4. reports ``thinned_ratio``/``repeat_ratio`` heartbeats, clears the emulator
   config at the end and reports ``completed`` (or ``failed``).

The emulator stamps Nav00 with its own current time; the Backend maps that
time onto the dataset at the registered speedup. Delivery delays of the
original data therefore cannot be reproduced.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
import json
import math
import os
from pathlib import Path
import signal
import sys
import time
from typing import Callable, Protocol
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, Request, build_opener

import pandas as pd

INTERVAL_MS = 3_600_000
HEARTBEAT_S = 10.0
MAX_POST_PERIOD_S = 5.0  # same bound as the Backend's RunRegistry
EXIT_OK, EXIT_FAILED, EXIT_CONFIG, EXIT_CONFLICT = 0, 1, 2, 3
BOOL_TEXT = {"true": True, "1": True, "false": False, "0": False}


# ------------------------------------------------------------------ settings

@dataclass(frozen=True)
class Settings:
    traffic: Path
    dataset_start: datetime
    dataset_end: datetime
    speedup: int
    post_period_s: float
    repeat_max_s: float
    units: frozenset[int] | None
    emulator_url: str
    backend_url: str
    target_host: str
    target_port: int
    ready_timeout_s: float
    trace: Path | None

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "Settings":
        env = dict(os.environ if env is None else env)
        day = env.get("DEMO_DATE", "2026-01-06")
        window = env.get("DEMO_WINDOW", "06:30-08:30").replace("–", "-").replace(" ", "")
        try:
            first, last = window.split("-")
            start = datetime.fromisoformat(f"{day}T{first}")
            end = datetime.fromisoformat(f"{day}T{last}")
        except ValueError as exc:
            raise ValueError("DEMO_WINDOW must look like 06:30-08:30") from exc
        speedup = int(env.get("DEMO_SPEEDUP", "5"))
        period = float(env.get("DEMO_POST_PERIOD_S", "2"))
        repeat = float(env.get("DEMO_REPEAT_MAX_S", "30"))
        if end <= start:
            raise ValueError("DEMO_WINDOW end must be after its start")
        if speedup < 1:
            raise ValueError("DEMO_SPEEDUP must be an integer >= 1")
        if not math.isfinite(period) or not 1 <= period <= MAX_POST_PERIOD_S:
            # Nav00 timestamps have one-second resolution; the heartbeat bound needs short periods.
            raise ValueError(f"DEMO_POST_PERIOD_S must be within [1, {MAX_POST_PERIOD_S:g}]")
        if not math.isfinite(repeat) or repeat < 0:
            raise ValueError("DEMO_REPEAT_MAX_S must be >= 0")
        units = env.get("DEMO_UNITS", "").strip()
        data = Path(env.get("DATA_DIR", "data"))
        return cls(traffic=Path(env.get("DEMO_TRAFFIC", data / "validate" / "traffic.csv")),
                   dataset_start=start, dataset_end=end, speedup=speedup,
                   post_period_s=period, repeat_max_s=repeat,
                   units=frozenset(int(u) for u in units.split(",")) if units else None,
                   emulator_url=env.get("EMULATOR_URL", "http://emulator:18080").rstrip("/"),
                   backend_url=env.get("BACKEND_URL", "http://backend:8001").rstrip("/"),
                   target_host=env.get("NDTP_TARGET_HOST", "backend"),
                   target_port=int(env.get("NDTP_TARGET_PORT", "9201")),
                   ready_timeout_s=float(env.get("DEMO_READY_TIMEOUT_S", "180")),
                   trace=Path(env["DEMO_TRACE"]) if env.get("DEMO_TRACE") else None)


# ---------------------------------------------------------------- data feed

@dataclass(frozen=True)
class Point:
    event_time: datetime
    valid: bool
    lon: float
    lat: float
    speed: float
    heading: float
    alt: float


@dataclass(frozen=True)
class Feed:
    points: dict[int, list[Point]]
    rows_in_window: int
    skipped_hist: int
    skipped_nonmonotonic: int


def _flag(value: object) -> bool:
    text = str(value).strip().lower()
    if text not in BOOL_TEXT:
        raise ValueError(f"not a boolean: {value!r}")
    return BOOL_TEXT[text]


def load_feed(path: Path, start: datetime, end: datetime,
              units: frozenset[int] | None = None) -> Feed:
    """Window points per unit, ordered by event_time, one per event second."""
    columns = ["unit_id", "event_time", "receive_time", "location_valid",
               "lon", "lat", "alt", "speed", "heading", "is_hist_data"]
    rows = pd.read_csv(path, usecols=columns, dtype={"unit_id": int})
    for column in ("event_time", "receive_time"):
        rows[column] = pd.to_datetime(rows[column], format="mixed", errors="raise")
    rows = rows.loc[(rows.event_time >= start) & (rows.event_time <= end)]
    if units is not None:
        rows = rows.loc[rows.unit_id.isin(units)]
    in_window = len(rows)
    hist = rows.is_hist_data.map(_flag)
    rows = rows.loc[~hist].copy()
    # NDTP carries whole seconds; the last received correction of a second wins.
    rows["second"] = rows.event_time.dt.floor("s")
    rows = rows.sort_values(["unit_id", "second", "receive_time"], kind="stable")
    kept = rows.drop_duplicates(["unit_id", "second"], keep="last")
    points: dict[int, list[Point]] = {}
    for row in kept.itertuples(index=False):
        valid = (_flag(row.location_valid) and pd.notna(row.lon) and pd.notna(row.lat)
                 and -180 <= float(row.lon) <= 180 and -90 <= float(row.lat) <= 90)
        points.setdefault(int(row.unit_id), []).append(Point(
            row.second.to_pydatetime(), valid,
            float(row.lon) if valid else 0.0, float(row.lat) if valid else 0.0,
            _number(row.speed) if valid else 0.0, _number(row.heading) if valid else 0.0,
            _number(row.alt) if valid else 0.0))
    if not points:
        raise ValueError(f"no traffic rows in {start}..{end}")
    return Feed(points, in_window, int(hist.sum()), len(rows) - len(kept))


def _number(value: object) -> float:
    number = float(value) if pd.notna(value) else 0.0
    return number if math.isfinite(number) else 0.0


def nav_fields(point: Point) -> dict[str, object]:
    """Emulator G6CellNav00 fields; every validity/hemisphere bit is explicit."""
    return {"longitude": round(abs(point.lon) * 1e7), "latitude": round(abs(point.lat) * 1e7),
            "extraDopBit5": point.lat >= 0, "extraDopBit6": point.lon >= 0,
            "extraDopBit7": point.valid,
            "speedAvg": _clamp(point.speed, 65535), "speedMax": _clamp(point.speed, 65535),
            "course": _clamp(point.heading, 360), "altitude": _clamp(point.alt, 65535)}


def _clamp(value: float, high: int) -> int:
    return max(0, min(high, round(value)))


@dataclass
class _UnitCursor:
    points: list[Point]
    next_index: int = 0
    last_sent: Point | None = None
    in_config: bool = False


@dataclass
class Pacer:
    """Choose, per POST, which point each unit sends at dataset time ``t``."""

    feed: Feed
    repeat_max_s: float
    counters: dict[str, int] = field(default_factory=lambda: {
        "points_sent": 0, "points_thinned": 0, "points_repeated": 0,
        "unit_removals": 0, "posts": 0})
    _cursors: dict[int, _UnitCursor] = field(init=False)

    def __post_init__(self) -> None:
        self._cursors = {unit: _UnitCursor(points) for unit, points in sorted(self.feed.points.items())}

    def step(self, t: datetime) -> list[tuple[int, Point, str]]:
        """(unit, point, "new" | "repeat") for every unit in this POST."""
        chosen: list[tuple[int, Point, str]] = []
        for unit, cursor in self._cursors.items():
            start = cursor.next_index
            while cursor.next_index < len(cursor.points) and cursor.points[cursor.next_index].event_time <= t:
                cursor.next_index += 1
            due = cursor.next_index - start
            present = True
            if due:
                self.counters["points_sent"] += 1
                self.counters["points_thinned"] += due - 1
                cursor.last_sent = cursor.points[cursor.next_index - 1]
                chosen.append((unit, cursor.last_sent, "new"))
            elif (cursor.last_sent is not None
                  and (t - cursor.last_sent.event_time).total_seconds() <= self.repeat_max_s):
                self.counters["points_repeated"] += 1
                chosen.append((unit, cursor.last_sent, "repeat"))
            else:
                present = False  # not started yet, or silent longer than repeat_max_s
            if cursor.in_config and not present:
                self.counters["unit_removals"] += 1
            cursor.in_config = present
        self.counters["posts"] += 1
        return chosen

    def ratios(self) -> tuple[float, float]:
        sent, thinned = self.counters["points_sent"], self.counters["points_thinned"]
        repeated = self.counters["points_repeated"]
        return (thinned / (sent + thinned) if sent + thinned else 0.0,
                repeated / (sent + repeated) if sent + repeated else 0.0)


def emulator_config(chosen: list[tuple[int, Point, str]], host: str, port: int) -> dict:
    return {"targetHost": host, "targetPort": port,
            "units": [{"unitId": unit, "intervalMs": INTERVAL_MS, "autoGenerate": False,
                       "cells": [{"type": "G6CellNav00", "fields": nav_fields(point)}]}
                      for unit, point, _ in chosen]}


class EchoMismatch(RuntimeError):
    """The emulator did not keep the configuration it was sent."""


def check_echo(sent: dict, echo: object) -> None:
    if not isinstance(echo, dict):
        raise EchoMismatch("emulator echo is not a JSON object")
    if echo.get("targetHost") != sent["targetHost"] or echo.get("targetPort") != sent["targetPort"]:
        raise EchoMismatch("emulator echo target differs")
    units = echo.get("units")
    if not isinstance(units, list) or len(units) != len(sent["units"]):
        raise EchoMismatch("emulator echo unit count differs")
    by_id = {unit.get("unitId"): unit for unit in units if isinstance(unit, dict)}
    for expected in sent["units"]:
        actual = by_id.get(expected["unitId"])
        if actual is None:
            raise EchoMismatch(f"unit {expected['unitId']} missing from emulator echo")
        if actual.get("intervalMs") != INTERVAL_MS or actual.get("autoGenerate") is not False:
            raise EchoMismatch(f"unit {expected['unitId']} pacing differs in emulator echo")
        cells = actual.get("cells")
        if (not isinstance(cells, list) or len(cells) != 1
                or cells[0].get("type") != "G6CellNav00"
                or not isinstance(cells[0].get("fields"), dict)):
            raise EchoMismatch(f"unit {expected['unitId']} Nav00 cell differs in emulator echo")
        fields = cells[0]["fields"]
        wanted = expected["cells"][0]["fields"]
        wrong = sorted(key for key, value in wanted.items() if fields.get(key) != value)
        if wrong:
            raise EchoMismatch(f"unit {expected['unitId']} fields differ in emulator echo: {wrong}")


# -------------------------------------------------------------------- HTTP

class HttpFailure(RuntimeError):
    def __init__(self, status: int | None, body: object, url: str):
        super().__init__(f"{url}: HTTP {status}: {body}")
        self.status = status
        self.body = body


class Transport(Protocol):
    def __call__(self, method: str, url: str, payload: object | None = None) -> object: ...


def http_json(method: str, url: str, payload: object | None = None, *, timeout: float = 15.0) -> object:
    """JSON over HTTP without inherited proxies; non-2xx raises HttpFailure."""
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with build_opener(ProxyHandler({})).open(request, timeout=timeout) as response:
            return json.load(response)
    except HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        try:
            body = json.loads(body)
        except ValueError:
            pass
        raise HttpFailure(exc.code, body, url) from exc
    except (URLError, TimeoutError, OSError) as exc:
        raise HttpFailure(None, str(exc), url) from exc


# ------------------------------------------------------------------ driver

class Terminated(Exception):
    """SIGTERM from docker compose stop/recreate."""


def log(event: str, **fields: object) -> None:
    print(json.dumps({"event": event, **fields}, ensure_ascii=False, default=str), flush=True)


def wait_until(check: Callable[[], bool], timeout_s: float, what: str,
               clock: Callable[[], float], sleep: Callable[[float], None]) -> None:
    deadline = clock() + timeout_s
    last_error: object = None
    while clock() < deadline:
        try:
            if check():
                return
        except HttpFailure as exc:
            last_error = exc
        sleep(1.0)
    raise TimeoutError(f"{what} not ready within {timeout_s:.0f} s ({last_error})")


def run_driver(settings: Settings, *, http: Transport = http_json,
               clock: Callable[[], float] = time.time,
               sleep: Callable[[float], None] = time.sleep) -> int:
    feed = load_feed(settings.traffic, settings.dataset_start, settings.dataset_end, settings.units)
    units = sorted(feed.points)
    log("feed_loaded", units=len(units), rows_in_window=feed.rows_in_window,
        skipped_hist=feed.skipped_hist, skipped_nonmonotonic=feed.skipped_nonmonotonic,
        points=sum(len(p) for p in feed.points.values()))
    if settings.speedup * settings.post_period_s > 10:
        log("warning", message="speedup x period > 10 s of data per POST: expect heavy thinning",
            speedup=settings.speedup, post_period_s=settings.post_period_s)

    def backend_ready() -> bool:
        ready = http("GET", settings.backend_url + "/ready")
        if ready.get("source_clock") != "simulation":
            raise RuntimeError("Backend must run with SOURCE_CLOCK=simulation")
        return ready.get("status") == "ready"

    wait_until(backend_ready, settings.ready_timeout_s, "Backend", clock, sleep)
    # Read-only probe: the emulator configuration is untouched until registration succeeds.
    wait_until(lambda: isinstance(http("GET", settings.emulator_url + "/api/config"), dict),
               settings.ready_timeout_s, "emulator", clock, sleep)
    path = {str(unit): [[round(p.lon, 6), round(p.lat, 6)] for p in points if p.valid]
            for unit, points in feed.points.items()}
    try:
        registered = http("POST", settings.backend_url + "/v1/run", {
            "dataset_start": settings.dataset_start.isoformat(),
            "dataset_end": settings.dataset_end.isoformat(),
            "speedup": settings.speedup, "post_period_s": settings.post_period_s,
            "units": units, "path": path, "source": "official_emulator"})
    except HttpFailure as exc:
        if exc.status == 409:
            log("run_conflict", backend=exc.body,
                message="a run is already registered in this Backend; emulator config untouched")
            return EXIT_CONFLICT
        raise
    # From here on the run exists: every failure (including SIGTERM) must be reported.
    run_id = registered["run_id"]
    pacer = Pacer(feed, settings.repeat_max_s)
    state_url = f"{settings.backend_url}/v1/run/{run_id}/state"

    def report(state: str, reason: str | None = None) -> object:
        thinned, repeated = pacer.ratios()
        return http("POST", state_url, {
            "state": state, "thinned_ratio": round(thinned, 4), "repeat_ratio": round(repeated, 4),
            "counters": {**pacer.counters, "skipped_hist": feed.skipped_hist,
                         "skipped_nonmonotonic": feed.skipped_nonmonotonic},
            "reason": reason})

    def post_config(config: dict) -> None:
        check_echo(config, http("POST", settings.emulator_url + "/api/config", config))

    trace = None
    try:
        mapping = registered["clock_mapping"]
        origin_epoch = mapping["epoch_origin"]
        origin_wall = datetime.fromisoformat(mapping["dataset_origin"])
        rate = mapping["rate"]
        log("run_registered", run_id=run_id, clock_mapping=mapping, units=units)
        trace = settings.trace.open("a", encoding="utf-8") if settings.trace else None
        last_heartbeat = None
        post_started = clock()
        while True:
            wall = clock()
            t = origin_wall + timedelta(seconds=(wall - origin_epoch) * rate)
            chosen = pacer.step(min(t, settings.dataset_end))
            config = emulator_config(chosen, settings.target_host, settings.target_port)
            post_config(config)
            if trace is not None:
                trace.write(json.dumps({"wall": wall, "dataset_time": t.isoformat(), "units": [
                    {"unit_id": u, "event_time": p.event_time.isoformat(), "kind": kind,
                     "valid": p.valid} for u, p, kind in chosen]}) + "\n")
            # Report now if waiting for the next POST would exceed the heartbeat bound.
            if (last_heartbeat is None
                    or clock() - last_heartbeat + settings.post_period_s > HEARTBEAT_S):
                try:
                    report("running")
                except HttpFailure as exc:
                    if exc.status is not None:
                        raise  # the Backend no longer knows this run
                    log("heartbeat_failed", error=str(exc))
                last_heartbeat = clock()
                thinned, repeated = pacer.ratios()
                log("heartbeat", run_id=run_id, dataset_time=t.isoformat(),
                    in_config=len(chosen), thinned_ratio=round(thinned, 4),
                    repeat_ratio=round(repeated, 4), **pacer.counters)
            if t >= settings.dataset_end:
                break
            post_started = max(post_started + settings.post_period_s, clock())
            sleep(max(0.0, post_started - clock()))
        post_config(emulator_config([], settings.target_host, settings.target_port))
        report("completed")
        thinned, repeated = pacer.ratios()
        log("run_completed", run_id=run_id, thinned_ratio=round(thinned, 4),
            repeat_ratio=round(repeated, 4), **pacer.counters)
        return EXIT_OK
    except Exception as exc:  # includes Terminated (SIGTERM)
        reason = repr(exc)[:500]
        log("run_failed", run_id=run_id, error=reason)
        try:
            post_config(emulator_config([], settings.target_host, settings.target_port))
        except Exception as cleanup_error:  # the original failure is what we report
            log("cleanup_failed", step="emulator_config", error=repr(cleanup_error))
        try:
            report("failed", reason)
        except Exception as cleanup_error:
            log("cleanup_failed", step="backend_state", error=repr(cleanup_error))
        return EXIT_FAILED
    finally:
        if trace is not None:
            trace.close()


def main() -> int:
    try:
        settings = Settings.from_env()
    except ValueError as exc:
        log("config_error", error=str(exc))
        return EXIT_CONFIG

    def terminate(*_: object) -> None:
        raise Terminated()

    signal.signal(signal.SIGTERM, terminate)
    try:
        return run_driver(settings)
    except Exception as exc:  # before registration: nothing to clean up in the emulator
        log("driver_failed", error=repr(exc))
        return EXIT_FAILED


if __name__ == "__main__":
    sys.exit(main())
