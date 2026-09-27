"""Backend prediction lifecycle over point-in-time NDTP state and plan.

Publication timestamps use host Unix wall-clock nanoseconds, independent of
the dataset replay clock. Input identity names the latest available received
frame; prediction identity and publication time belong to its saved success.
The source clock and the set of served vehicles belong to ``server.run``.
"""

from __future__ import annotations

from datetime import datetime, timedelta
import json
import math
import logging
from collections import Counter, OrderedDict
from dataclasses import dataclass
from threading import Condition, Event, RLock, Thread
from time import time_ns
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, Request, build_opener

from transport_ml.data import TRAFFIC_COLUMNS

from .ingest import NDTPServer
from .schedule import Arrival, Schedule, nearest_on_polyline
from .state import TelemetryState

# Display area of the bundled basemap (consumer/map/manifest.json "coverage").
MAP_BBOX = (37.25, 55.50, 38.00, 56.00)
ROUTE_STOP_LIMIT = 40
ROUTE_BEFORE_NOW = timedelta(minutes=5)
ROUTE_AFTER_TARGET = timedelta(minutes=15)
ROUTE_AFTER_NOW_NO_TARGET = timedelta(minutes=30)
# One display window for the planned-stop line, overview and selected vehicle alike.
LINE_BEFORE_NOW = timedelta(minutes=15)
LINE_AFTER_NOW = timedelta(minutes=45)
# Where along the window line the vehicle is: only segments planned for
# [now - 10 min, now + 20 min] (shifted by the observed delay) are candidates,
# so an out-and-back line cannot snap onto the other trip.
SPLIT_BEFORE_NOW = timedelta(minutes=10)
SPLIT_AFTER_NOW = timedelta(minutes=20)
HEADING_MIN_SPEED_KMH = 3.0
HEADING_MAX_AGE_S = 120.0


class RouteUnavailable(LookupError):
    """The vehicle is not part of the current run or has no evaluated row yet."""


class ModelFailure(RuntimeError):
    """HTTP failure visible to the Backend snapshot."""


class ModelClient:
    def __init__(self, url: str, timeout_s: float):
        if not math.isfinite(timeout_s) or timeout_s <= 0:
            raise ValueError("ML timeout must be finite and positive")
        self.url = url.rstrip("/") + "/v1/predict"
        self.timeout_s = timeout_s
        # Internal service URLs must not inherit the host's HTTP proxy.
        self._opener = build_opener(ProxyHandler({}))

    def predict(self, request: dict) -> dict:
        try:
            body = json.dumps(request, allow_nan=False).encode("utf-8")
            with self._opener.open(Request(self.url, data=body, method="POST",
                                           headers={"Content-Type": "application/json"}),
                                   timeout=self.timeout_s) as response:
                result = json.load(response)
        except HTTPError as exc:
            raise ModelFailure(f"ml_http_{exc.code}") from exc
        except (URLError, TimeoutError, OSError) as exc:
            raise ModelFailure("ml_unreachable_or_timeout") from exc
        except (ValueError, TypeError) as exc:
            raise ModelFailure("ml_invalid_json") from exc
        if (not isinstance(result, dict)
                or result.get("schema_version") != "transport.ml-prediction.v1"
                or result.get("sample_id") != request["point"]["sample_id"]
                or result.get("applicability") not in {"supported", "unavailable"}
                or result.get("quality") not in {"normal", "degraded", "unavailable"}
                or not isinstance(result.get("model_version"), str)
                or not isinstance(result.get("artifact_sha256"), str)):
            raise ModelFailure("ml_schema_mismatch")
        if result["applicability"] == "supported":
            value = result.get("prediction_s")
            if (not isinstance(value, (int, float)) or isinstance(value, bool)
                    or not math.isfinite(value)
                    or not isinstance(result.get("predicted_arrival"), str)):
                raise ModelFailure("ml_schema_mismatch")
        return result


@dataclass(frozen=True)
class AvailableContext:
    """Bounded value identity of available telemetry and current domain inputs."""

    history_frames: tuple[str, ...]
    telemetry_frames: tuple[str, ...]
    cur_dev_s: float | None
    target_id: str | None


@dataclass(frozen=True)
class PredictionJob:
    unit_id: int
    tr_id: str
    at: datetime
    target_id: str
    frame_id: str
    context_revision: int
    context: AvailableContext
    cur_dev_s: float
    request: dict


class Orchestrator:
    """Bounded prediction worker; HTTP readbacks never execute model I/O.

    One active request and at most ``queue_limit`` pending vehicles exist.
    Replacing a pending vehicle coalesces its older request. Each job captures
    source T, target and past-only inputs before the worker sees it.
    With ``tick_interval_s`` an own wall-clock tick evaluates the run's
    vehicles, so predictions do not depend on anyone polling the snapshot.
    A success for the current target stays ``normal`` while its dataset age is
    at most ``fresh_s`` (1.5 x ``predict_interval_s``); newer input then only
    sets ``prediction_updating``.
    When the target changes, a job for the new target jumps the queue; until
    it answers, for at most ``prediction_hold_s`` of dataset time, the row
    keeps the last success as a whole pair (its target and its prediction).
    """

    def __init__(self, state: TelemetryState, server: NDTPServer, schedule: Schedule,
                 model: ModelClient, *, predict_interval_s: float = 60.0,
                 alert_cooldown_s: float = 300.0, queue_limit: int = 32,
                 tick_interval_s: float | None = None, off_route_m: float = 400.0,
                 off_route_clear_m: float = 250.0, prediction_hold_s: float = 180.0):
        if (not math.isfinite(predict_interval_s) or not math.isfinite(alert_cooldown_s)
                or predict_interval_s <= 0 or alert_cooldown_s <= 0 or queue_limit < 1):
            raise ValueError("prediction interval/cooldown must be finite and positive; queue_limit >= 1")
        if tick_interval_s is not None and (not math.isfinite(tick_interval_s) or tick_interval_s <= 0):
            raise ValueError("tick_interval_s must be finite and positive")
        if not (math.isfinite(off_route_m) and 0 < off_route_clear_m < off_route_m):
            raise ValueError("off-route thresholds need 0 < clear < set")
        if not (math.isfinite(prediction_hold_s) and prediction_hold_s >= 0):
            raise ValueError("prediction_hold_s must be finite and >= 0")
        self.state, self.server, self.schedule = state, server, schedule
        self.run, self.model = server.run, model
        self.predict_interval_s = predict_interval_s
        self.fresh_s = 1.5 * predict_interval_s
        self.prediction_hold_s = prediction_hold_s
        self.tick_interval_s = tick_interval_s
        self.off_route_m, self.off_route_clear_m = off_route_m, off_route_clear_m
        self.alert_cooldown_s = alert_cooldown_s
        self.queue_limit = queue_limit
        self._lock = RLock()
        self._condition = Condition(self._lock)
        self._worker: Thread | None = None
        self._ticker: Thread | None = None
        self._tick_stop = Event()
        self._stopping = False
        self._jobs: OrderedDict[str, PredictionJob] = OrderedDict()
        self._active: PredictionJob | None = None
        self._counters: Counter[str] = Counter()
        self._last_attempt: dict[str, datetime] = {}
        self._last_attempt_target: dict[str, str] = {}
        self._last_attempt_context_revision: dict[str, int] = {}
        self._last_attempt_contexts: dict[str, AvailableContext] = {}
        self._contexts: dict[str, AvailableContext] = {}
        self._context_revisions: dict[str, int] = {}
        self._last_failure: dict[str, tuple[str, str]] = {}
        self._last_success: dict[str, dict] = {}
        self._last_alert: dict[tuple[str, str], datetime] = {}
        self._alerts: dict[str, dict] = {}
        self._rows: dict[str, dict] = {}
        self._row_times: dict[str, datetime] = {}
        self._off_route: dict[str, bool] = {}  # hysteresis state per tr_id
        # (held success key, dataset time the hold started) per tr_id.
        self._hold_started: dict[str, tuple[tuple[str, str], datetime]] = {}
        self._revision = 0
        self._seen_accepted = 0

    def start(self) -> "Orchestrator":
        with self._condition:
            if self._worker is not None:
                raise RuntimeError("prediction worker already started")
            self._worker = Thread(target=self._run, name="backend-ml", daemon=True)
            self._worker.start()
            if self.tick_interval_s is not None:
                self._ticker = Thread(target=self._tick_loop, name="backend-tick", daemon=True)
                self._ticker.start()
        return self

    def close(self) -> None:
        self._tick_stop.set()
        if self._ticker is not None:
            self._ticker.join(timeout=10)
        with self._condition:
            self._stopping = True
            self._counters["ml_canceled_on_close"] += len(self._jobs)
            self._jobs.clear()
            self._condition.notify_all()
        if self._worker is not None:
            self._worker.join(timeout=10)
            if self._worker.is_alive():
                raise RuntimeError("prediction worker did not stop within 10 seconds")

    def __enter__(self) -> "Orchestrator":
        return self.start()

    def __exit__(self, *_: object) -> None:
        self.close()

    def on_ingest(self, unit_id: int) -> None:
        """Publish accepted state and enqueue captured work without waiting for ML."""
        with self._lock:
            now = self.run.clock()
            if now is None:
                return
            self._observe_accepted(self.state.counters().get("accepted", 0))
            self._update_row(unit_id, self.state.unit_mapping[unit_id], now)

    def tick(self) -> None:
        """Evaluate every run vehicle at one clock sample, enqueueing due predictions."""
        with self._lock:
            now = self.run.clock()
            if now is None:
                return
            self._observe_accepted(self.server.counters().get("accepted", 0))
            for unit, tr_id in self.run.vehicles():
                self._update_row(unit, tr_id, now)

    def _tick_loop(self) -> None:
        while not self._tick_stop.wait(self.tick_interval_s):
            try:
                self.tick()
            except Exception:
                with self._lock:
                    self._counters["tick_errors"] += 1
                logging.getLogger(__name__).exception("prediction tick failed")

    def processing_readback(self) -> dict[str, int]:
        with self._lock:
            counts = {name: self._counters[name] for name in (
                "ml_enqueued", "ml_started", "ml_completed", "ml_succeeded", "ml_failed",
                "ml_unavailable", "ml_coalesced", "ml_dropped_queue_full",
                "ml_discarded_obsolete", "ml_canceled_on_close", "ml_max_queue_depth",
                "tick_errors")}
            return {**counts, "ml_queue_depth": len(self._jobs),
                    "ml_queue_limit": self.queue_limit,
                    "ml_active_jobs": int(self._active is not None),
                    **self.schedule.counters(),
                    "stop_seen_frame_limit": self.state.history_limit * len(self.state.unit_mapping),
                    "context_history_frame_count": sum(len(c.history_frames) for c in self._contexts.values()),
                    "context_history_frame_limit": self.state.history_limit * len(self.state.unit_mapping)}

    def snapshot(self) -> dict:
        """Vehicles of the current run only; before registration an empty waiting view."""
        with self._lock:
            now = self.run.clock()
            counters = self.server.counters()
            self._observe_accepted(counters.get("accepted", 0))
            vehicles = ([] if now is None else
                        [self._update_row(unit, tr, now) for unit, tr in self.run.vehicles()])
            return {"schema_version": "transport.backend-vehicles.v1",
                    "revision": self._revision, "source_clock": self.state.source_clock,
                    "clock_mapping": self.run.mapping_readback(),
                    "clock_time": now.isoformat() if now is not None else None,
                    "run": self.run.readback(now), "vehicles": vehicles,
                    "ingest": {"accepted": counters.get("accepted", 0),
                               "dropped": counters.get("dropped", 0),
                               "errors": counters.get("errors", 0),
                               "rejected_no_run": counters.get("rejected_no_run", 0),
                               "queue_depth": counters["queue_depth"]},
                    "processing": self.processing_readback()}

    def routes(self) -> dict:
        """Route lines of all run vehicles in the display window, with off-route flags.

        Flags come from the last computed vehicle rows; the line runs through the
        plan's stops with ``now - 15 min <= time <= now + 45 min`` inside the map
        bbox along their road shapes; ``line_times`` is set on stop points only.
        """
        with self._lock:
            now = self.run.clock()
            if now is None:
                return {"run_id": None, "clock_time": None, "window_start": None,
                        "window_end": None, "routes": []}
            low, high = now - LINE_BEFORE_NOW, now + LINE_AFTER_NOW
            routes = []
            for unit_id, tr_id in self.run.vehicles():
                stops = self._window_line(tr_id, now)
                points, anchors = self.schedule.shape_line(tr_id, stops)
                times: list[str | None] = [None] * len(points)
                for index, stop in zip(anchors, stops):
                    times[index] = stop.time.strftime("%H:%M:%S")
                row = self._rows.get(tr_id, {})
                routes.append({"tr_id": tr_id, "unit_id": unit_id,
                               "line": [[lon, lat] for lon, lat in points],
                               "line_times": times,
                               "line_shape": "road" if self.schedule.has_shapes(tr_id) else "straight",
                               "off_route": row.get("off_route"),
                               "route_offset_m": row.get("route_offset_m"),
                               "route_not_started": row.get("route_not_started")})
            return {"run_id": self.run.run_id, "clock_time": now.isoformat(),
                    "window_start": low.isoformat(), "window_end": high.isoformat(),
                    "routes": routes}

    def route(self, tr_id: str) -> dict:
        """Route context of the last computed row: display path, passed GPS and plan stops.

        Target, deviation, prediction and revision come from the same row the
        snapshot served; the schedule is read, never re-evaluated here.
        """
        with self._lock:
            unit_id = next((unit for unit, tr in self.run.vehicles() if tr == tr_id), None)
            if unit_id is None:
                raise RouteUnavailable("unknown_tr_id")
            row, at = self._rows.get(tr_id), self._row_times.get(tr_id)
            if row is None or at is None:
                raise RouteUnavailable("vehicle_not_evaluated")
            plan = self.schedule.by_vehicle.get(tr_id, [])
            target_index = next((index for index, stop in enumerate(plan)
                                 if stop.stop_id == row["target_stop_id"]), None)
            target = plan[target_index] if target_index is not None else None
            low = at - ROUTE_BEFORE_NOW
            high = (target.time + ROUTE_AFTER_TARGET if target is not None
                    else at + ROUTE_AFTER_NOW_NO_TARGET)
            window = [(index, stop) for index, stop in enumerate(plan) if low <= stop.time <= high]
            shown = [(index, stop) for index, stop in window if _on_map(stop)]
            overflow = max(0, len(shown) - ROUTE_STOP_LIMIT)
            if overflow:
                # Drop the earliest stops, never the target.
                dropped = {index for index, _ in shown if index != target_index}
                dropped = set(sorted(dropped)[:overflow])
                shown = [(index, stop) for index, stop in shown if index not in dropped]
            observed = self.schedule.observed_stop_ids(tr_id)
            shift = timedelta(seconds=row["cur_dev_s"] or 0.0)

            def role(index: int, stop: Arrival) -> str:
                if index == target_index:
                    return "target"
                if stop.stop_id in observed or stop.time + shift < at:
                    return "passed"
                if target_index is None:
                    return "planned"
                return "before_target" if index < target_index else "after_target"

            passed = [[record["lon"], record["lat"],
                       datetime.fromisoformat(str(record["event_time"])).strftime("%H:%M:%S")]
                      for record in self.state.history(tr_id, at) if record["location_valid"]]
            return {"run_id": self.run.run_id, "tr_id": tr_id, "unit_id": unit_id,
                    "vehicle_revision": row["revision"], "clock_time": at.isoformat(),
                    "window_start": low.isoformat(), "window_end": high.isoformat(),
                    "path": self.run.path(unit_id), "passed": passed,
                    "stops": [{"stop_id": stop.stop_id, "time": stop.time.strftime("%H:%M:%S"),
                               "lon": stop.lon, "lat": stop.lat, "role": role(index, stop)}
                              for index, stop in shown],
                    "stops_dropped": len(window) - len(shown) - overflow,
                    "stops_truncated": overflow,
                    "target_stop_id": row["target_stop_id"],
                    "target_time_begin": row["target_time_begin"],
                    "cur_dev_s": row["cur_dev_s"], "prediction_s": row["prediction_s"],
                    "prediction_updating": row["prediction_updating"],
                    "prediction_state": row["prediction_state"],
                    "prediction_held_from_target": row["prediction_held_from_target"],
                    "planned_target_stop_id": row["planned_target_stop_id"],
                    "model_version": row["model_version"],
                    "artifact_sha256": row["artifact_sha256"],
                    "route_line": self._route_line(tr_id, row, at)}

    def _window_line(self, tr_id: str, now: datetime) -> list[Arrival]:
        """Planned stops of the display window inside the map, in time order."""
        return [stop for stop in self.schedule.stops_between(
            tr_id, now - LINE_BEFORE_NOW, now + LINE_AFTER_NOW) if _on_map(stop)]

    def _route_line(self, tr_id: str, row: dict, at: datetime) -> dict:
        """Split the window line at the vehicle: dim passed part, bright part ahead.

        The split is the projection of the last valid position onto the road
        shape of the nearest stop-to-stop segment planned for
        ``[at - 10 min, at + 20 min]`` shifted back by ``cur_dev_s`` (a late
        vehicle is where the plan was earlier). Off route,
        without position or without such a segment there is no split.
        """
        stops = self._window_line(tr_id, at)
        points, anchors = self.schedule.shape_line(tr_id, stops)
        line = [[lon, lat] for lon, lat in points]
        lon, lat = row["lon"], row["lat"]
        # The leader goes to the whole-assignment line, as the off-route check does,
        # so it exists even when the display window holds no stop.
        nearest = (self.schedule.route_nearest(tr_id, float(lon), float(lat))
                   if lon is not None and lat is not None else None)
        view = {"line": line, "line_shape": "road" if self.schedule.has_shapes(tr_id) else "straight",
                "passed": [], "ahead": [], "split": None,
                "nearest": [nearest[0], nearest[1]] if nearest else None,
                "off_route": row["off_route"], "route_offset_m": row["route_offset_m"]}
        if lon is None or lat is None:
            return {**view, "split_reason": "no_position"}
        if row["off_route"]:
            return {**view, "split_reason": "off_route"}
        center = at - timedelta(seconds=row["cur_dev_s"] or 0.0)
        low, high = center - SPLIT_BEFORE_NOW, center + SPLIT_AFTER_NOW
        candidates = [i for i in range(len(stops) - 1)
                      if stops[i].time <= high and stops[i + 1].time >= low]
        # Equal distances (the same street both ways) go to the segment closest in time.
        candidates.sort(key=lambda i: abs((stops[i].time + (stops[i + 1].time - stops[i].time) / 2
                                           - center).total_seconds()))
        # Stops stay the anchors in time; the split is projected onto their road shape.
        found = nearest_on_polyline(points, float(lon), float(lat),
                                    [part for i in candidates
                                     for part in range(anchors[i], anchors[i + 1])])
        if found is None:
            return {**view, "split_reason": "no_segment"}
        segment, split_lon, split_lat, _ = found
        split = [split_lon, split_lat]
        return {**view, "passed": line[:segment + 1] + [split], "ahead": [split] + line[segment + 1:],
                "split": split, "split_reason": "on_route"}

    def _observe_accepted(self, count: int) -> None:
        if count > self._seen_accepted:
            self._revision += count - self._seen_accepted
            self._seen_accepted = count

    def _observe_context(self, tr_id: str, context: AvailableContext) -> int:
        if self._contexts.get(tr_id) != context:
            self._contexts[tr_id] = context
            self._context_revisions[tr_id] = self._context_revisions.get(tr_id, 0) + 1
        return self._context_revisions[tr_id]

    def _update_row(self, unit_id: int, tr_id: str, now: datetime, *, enqueue: bool = True) -> dict:
        row = self._vehicle(unit_id, tr_id, now, enqueue)
        prior = self._rows.get(tr_id)
        if prior is None or any(row[key] != prior[key] for key in row
                                if key not in {"revision", "gps_age_s", "prediction_age_s"}):
            self._revision += 1
            row["revision"] = self._revision
            row["published_unix_ns"] = time_ns()
            if (row["prediction_input_frame_id"] is not None
                    and row["prediction_published_unix_ns"] is None):
                row["prediction_published_unix_ns"] = row["published_unix_ns"]
                self._last_success[tr_id]["prediction_published_unix_ns"] = row["published_unix_ns"]
        else:
            row["revision"] = prior["revision"]
            row["published_unix_ns"] = prior["published_unix_ns"]
        self._rows[tr_id] = row
        self._row_times[tr_id] = now
        return row

    def _vehicle(self, unit_id: int, tr_id: str, now: datetime, enqueue: bool) -> dict:
        state = self.state.snapshot(tr_id, now)
        latest = state["telemetry"]
        target = self.schedule.target(tr_id, now)
        # Detector ownership extends past the model's 900-second input window.
        history = self.state.history(tr_id, now)
        latest_frame = (max(history, key=lambda row: (str(row["receive_time"]),
                                                    str(row["received_at_utc"])))
                        if history else None)
        frame_id = str(latest_frame["frame_id"]) if latest_frame else None
        cur_dev = self.schedule.observed_deviation(tr_id, now, history)
        target_id = target.stop_id if target else None
        traffic = [row for row in history
                   if (now - datetime.fromisoformat(str(row["event_time"]))).total_seconds() <= 900][-2000:]
        context = AvailableContext(
            tuple(str(row["frame_id"]) for row in history),
            tuple(str(row["frame_id"]) for row in traffic), cur_dev, target_id)
        context_revision = self._observe_context(tr_id, context)
        if enqueue and target is not None and cur_dev is not None and not state["degraded"]:
            last = self._last_attempt.get(tr_id)
            failed = self._last_failure.get(tr_id)
            captured_context = self._last_attempt_contexts.get(tr_id)
            captured_frames = set(captured_context.history_frames) if captured_context is not None else set()
            became_available = (last is not None and any(
                str(row["frame_id"]) not in captured_frames
                and datetime.fromisoformat(str(row["receive_time"])) <= last for row in history))
            due = (frame_id is not None
                   and context_revision != self._last_attempt_context_revision.get(tr_id)
                   and (tr_id in self._jobs or last is None
                        or became_available
                        or captured_context is not None and captured_context.cur_dev_s != cur_dev
                        or failed is not None and failed[0] == target_id
                        or (now - last).total_seconds() >= self.predict_interval_s
                        or self._last_attempt_target.get(tr_id) != target_id))
            if due:
                request = {"point": {"sample_id": f"{tr_id}_{now:%Y%m%d%H%M%S%f}",
                                     "tr_id": tr_id, "T": now.isoformat(),
                                     "target_stop_id": target_id,
                                     "target_time_begin": target.time.isoformat(),
                                     "cur_dev_s": float(cur_dev)},
                           "telemetry": [{key: row[key] for key in TRAFFIC_COLUMNS}
                                         for row in traffic],
                           "schedule_plan": self.schedule.ml_rows(tr_id)}
                # A new target is answered first: its row holds the old pair meanwhile.
                self._queue(PredictionJob(unit_id, tr_id, now, target_id,
                                          frame_id, context_revision, context, float(cur_dev), request),
                            first=self._last_attempt_target.get(tr_id) != target_id)
        success = self._last_success.get(tr_id)
        held = None
        if success is not None and success["target_stop_id"] != target_id:
            held = self._held_pair(tr_id, success, target_id, now)
            success = None
        pending = (tr_id in self._jobs or self._active is not None and self._active.tr_id == tr_id)
        failure = self._last_failure.get(tr_id)
        failure_reason = failure[1] if failure is not None and failure[0] == target_id else None
        age_s = ((now - datetime.fromisoformat(success["last_success_at"])).total_seconds()
                 if success else None)
        # Newer input than the current-target success, or a job in flight.
        updating = pending or (success is not None
                               and success["prediction_context_revision"] != context_revision)
        status, reason = "unavailable", None
        if target is None:
            plan = self.schedule.by_vehicle.get(tr_id, ())
            reason = ("unsupported_day" if self.state.source_clock == "utc"
                      and plan and now > plan[-1].time + timedelta(days=1)
                      else "no_target_in_horizon")
        elif cur_dev is None:
            reason = "no_confident_observed_stop"
        elif state["degraded"]:
            status = "degraded" if success or held else "unavailable"
            reason = str(state["reason"])
        elif failure_reason is not None:
            status = "degraded" if success or held else "unavailable"
            reason = failure_reason
        elif held is not None:
            status, reason = "degraded", "prediction_held_previous_target"
        elif success is None:
            status, reason = (("degraded", "prediction_pending") if pending
                              else ("unavailable", "prediction_waiting_new_telemetry"))
        elif age_s > self.fresh_s or success["quality"] != "normal":
            status, reason = "degraded", "prediction_aging"
        else:
            status = "normal"
        # The shown pair: the current target with its own prediction, or, while
        # held, the previous target with its prediction. Never mixed.
        shown, shown_target = ((held, held["target"]) if held is not None
                               else (success, target))
        if held is not None:
            age_s = (now - datetime.fromisoformat(held["last_success_at"])).total_seconds()
            updating = True
        return {"tr_id": tr_id, "unit_id": unit_id,
                "input_frame_id": frame_id,
                "input_context_revision": context_revision,
                "input_request_id": latest_frame["request_id"] if latest_frame else None,
                "input_session_id": latest_frame["session_id"] if latest_frame else None,
                "input_received_at_utc": latest_frame["received_at_utc"] if latest_frame else None,
                "lon": state["lon"], "lat": state["lat"],
                "location_valid": bool(latest["location_valid"]) if latest else False,
                "event_time": latest["event_time"] if latest else None,
                "receive_time": latest["receive_time"] if latest else None,
                "gps_age_s": state["gps_age_s"], "connected": state["connected"],
                "heading": _heading(history, now),
                **self._route_check(tr_id, state["lon"], state["lat"], now),
                "target_stop_id": shown_target.stop_id if shown_target else None,
                "target_time_begin": shown_target.time.isoformat() if shown_target else None,
                "target_lon": (shown_target.lon if shown_target
                               and _finite(shown_target.lon, shown_target.lat) else None),
                "target_lat": (shown_target.lat if shown_target
                               and _finite(shown_target.lon, shown_target.lat) else None),
                "planned_target_stop_id": target_id,
                "cur_dev_s": cur_dev, "cur_dev_source": "computed_stop" if cur_dev is not None else None,
                "prediction_s": shown["prediction_s"] if shown else None,
                "predicted_arrival": shown["predicted_arrival"] if shown else None,
                "model_version": shown["model_version"] if shown else None,
                "artifact_sha256": shown["artifact_sha256"] if shown else None,
                "prediction_state": ("updating" if held is not None
                                     else "fresh" if success is not None else "none"),
                "prediction_held_from_target": held["target_stop_id"] if held is not None else None,
                "status": status, "reason": reason, "prediction_pending": pending,
                "prediction_updating": updating,
                "last_success_at": shown["last_success_at"] if shown else None,
                "prediction_input_frame_id": shown["prediction_input_frame_id"] if shown else None,
                "prediction_context_revision": shown["prediction_context_revision"] if shown else None,
                "prediction_published_unix_ns": shown["prediction_published_unix_ns"] if shown else None,
                "prediction_age_s": max(0.0, age_s) if age_s is not None else None,
                "alert": (self._alerts.get(tr_id)
                          if success and self._alerts.get(tr_id, {}).get("target_stop_id") == target_id
                          else None), "revision": 0}

    def _held_pair(self, tr_id: str, success: dict, target_id: str | None,
                   now: datetime) -> dict | None:
        """The last success for another target while its hold lasts, with its plan stop.

        The hold starts when the row first shows this success held and lasts
        ``prediction_hold_s`` of dataset time. No current target means the run
        has nothing left to predict, so nothing is held.
        """
        if target_id is None or self.prediction_hold_s <= 0:
            self._hold_started.pop(tr_id, None)
            return None
        key = (success["target_stop_id"], success["last_success_at"])
        started = self._hold_started.get(tr_id)
        if started is None or started[0] != key or now < started[1]:
            started = self._hold_started[tr_id] = (key, now)
        if (now - started[1]).total_seconds() > self.prediction_hold_s:
            return None
        stop = next((stop for stop in self.schedule.by_vehicle.get(tr_id, ())
                     if stop.stop_id == success["target_stop_id"]
                     and stop.time.isoformat() == success.get("target_time_begin")), None)
        if stop is None:
            return None
        return {**success, "target": stop}

    def _route_check(self, tr_id: str, lon: float | None, lat: float | None, now: datetime) -> dict:
        """Spatial check of the last valid position against the day's planned-stop line."""
        offset = (self.schedule.route_offset_m(tr_id, float(lon), float(lat))
                  if lon is not None and lat is not None else None)
        off_route = None
        if offset is not None:
            # Hysteresis: set above off_route_m, clear only below off_route_clear_m.
            was_off = self._off_route.get(tr_id, False)
            off_route = offset > self.off_route_m or (was_off and offset >= self.off_route_clear_m)
            self._off_route[tr_id] = off_route
        plan = self.schedule.by_vehicle.get(tr_id, ())
        not_started = (None if not plan else
                       plan[0].time > now and not self.schedule.stops_between(
                           tr_id, now - LINE_BEFORE_NOW, now + LINE_AFTER_NOW))
        return {"route_offset_m": int(round(offset / 10.0)) * 10 if offset is not None else None,
                "off_route": off_route, "route_not_started": not_started}

    def _queue(self, job: PredictionJob, *, first: bool = False) -> None:
        """Queue or coalesce ``job``; ``first`` puts it ahead of other vehicles."""
        if self._stopping:
            return
        if job.tr_id in self._jobs:
            self._counters["ml_coalesced"] += 1
        elif len(self._jobs) >= self.queue_limit:
            self._counters["ml_dropped_queue_full"] += 1
            self._last_failure[job.tr_id] = (job.target_id, "prediction_queue_full")
            self._last_attempt[job.tr_id] = job.at
            self._last_attempt_target[job.tr_id] = job.target_id
            self._last_attempt_context_revision[job.tr_id] = job.context_revision
            self._last_attempt_contexts[job.tr_id] = job.context
            return
        self._jobs[job.tr_id] = job
        if first:
            self._jobs.move_to_end(job.tr_id, last=False)
        self._last_attempt[job.tr_id] = job.at
        self._last_attempt_target[job.tr_id] = job.target_id
        self._last_attempt_context_revision[job.tr_id] = job.context_revision
        self._last_attempt_contexts[job.tr_id] = job.context
        self._counters["ml_enqueued"] += 1
        self._counters["ml_max_queue_depth"] = max(self._counters["ml_max_queue_depth"], len(self._jobs))
        self._condition.notify()

    def _run(self) -> None:
        while True:
            with self._condition:
                self._condition.wait_for(lambda: self._stopping or bool(self._jobs))
                if self._stopping:
                    return
                _, job = self._jobs.popitem(last=False)
                self._active = job
                self._counters["ml_started"] += 1
            error = None
            response = None
            try:
                response = self.model.predict(job.request)
            except ModelFailure as exc:
                error = str(exc)
            except Exception:
                logging.getLogger(__name__).exception("ML worker failed for %s", job.frame_id)
                error = "ml_worker_error"
            with self._lock:
                self._active = None
                self._counters["ml_completed"] += 1
                if error is not None:
                    self._counters["ml_failed"] += 1
                now = self.run.clock()
                target = self.schedule.target(job.tr_id, now)
                previous = self._last_success.get(job.tr_id)
                obsolete = (target is None or target.stop_id != job.target_id or now < job.at
                            or previous is not None and datetime.fromisoformat(previous["last_success_at"]) > job.at)
                if obsolete:
                    self._counters["ml_discarded_obsolete"] += 1
                elif error is not None:
                    self._last_failure[job.tr_id] = (job.target_id, error)
                elif response["applicability"] == "supported" and response["prediction_s"] is not None:
                    self._last_success[job.tr_id] = {
                        "target_stop_id": job.target_id, "prediction_s": response["prediction_s"],
                        "predicted_arrival": response["predicted_arrival"],
                        "model_version": response["model_version"],
                        "artifact_sha256": response["artifact_sha256"],
                        "target_time_begin": job.request["point"]["target_time_begin"],
                        "last_success_at": job.at.isoformat(), "quality": response["quality"],
                        "prediction_input_frame_id": job.frame_id,
                        "prediction_context_revision": job.context_revision,
                        "prediction_published_unix_ns": None}
                    self._last_failure.pop(job.tr_id, None)
                    self._counters["ml_succeeded"] += 1
                else:
                    self._last_failure[job.tr_id] = (job.target_id, str(response.get("reason") or "ml_unavailable"))
                    self._counters["ml_unavailable"] += 1
                row = self._vehicle(job.unit_id, job.tr_id, now, enqueue=True)
                # Only a prediction on the current full context may raise an alert.
                if (not obsolete and error is None and response["applicability"] == "supported"
                        and row["status"] == "normal" and not row["prediction_updating"]):
                    self._consider_alert(job.tr_id, job.target_id, now, job.cur_dev_s,
                                         float(response["prediction_s"]), row["status"], target.time)
                self._update_row(job.unit_id, job.tr_id, now, enqueue=False)

    def _consider_alert(self, tr_id: str, target_id: str, now: datetime,
                        cur_dev_s: float, prediction_s: float, status: str,
                        target_time: datetime) -> None:
        if status != "normal" or prediction_s <= 120:
            return
        key = (tr_id, target_id)
        previous = self._last_alert.get(key)
        if previous is not None and (now - previous).total_seconds() < self.alert_cooldown_s:
            return
        self._last_alert[key] = now
        self._alerts[tr_id] = {"target_stop_id": target_id, "emitted_at": now.isoformat(),
                               "target_time_begin": target_time.isoformat(),
                               "target_window_start": (now + timedelta(seconds=600)).isoformat(),
                               "target_window_end": (now + timedelta(seconds=900)).isoformat(),
                               "kind": "known_prior_delay" if cur_dev_s > 120 else "new_signal",
                               "known_delay_s": cur_dev_s, "threshold_s": 120.0}


def _finite(*values: float) -> bool:
    return all(math.isfinite(value) for value in values)


def _on_map(stop: Arrival) -> bool:
    west, south, east, north = MAP_BBOX
    return _finite(stop.lon, stop.lat) and west <= stop.lon <= east and south <= stop.lat <= north


def _heading(history: list[dict], now: datetime) -> int | None:
    """Course of the latest valid frame faster than 3 km/h within the last 120 s of data."""
    for record in reversed(history):  # ordered by event_time
        age = (now - datetime.fromisoformat(str(record["event_time"]))).total_seconds()
        if age > HEADING_MAX_AGE_S:
            return None
        speed, heading = record["speed"], record["heading"]
        if (record["location_valid"] and speed is not None and heading is not None
                and _finite(float(speed), float(heading)) and float(speed) > HEADING_MIN_SPEED_KMH):
            return max(0, min(360, round(float(heading))))
    return None
