"""Backend prediction lifecycle over point-in-time NDTP state and plan.

Publication timestamps use host Unix wall-clock nanoseconds, independent of
the dataset replay clock. Input identity names the latest available received
frame; prediction identity and publication time belong to its saved success.
"""

from __future__ import annotations

from datetime import datetime, timedelta
import json
import math
import logging
from collections import Counter, OrderedDict
from dataclasses import dataclass
from threading import Condition, RLock, Thread
from time import time_ns
from typing import Callable
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, Request, build_opener

from transport_ml.data import TRAFFIC_COLUMNS

from .ingest import NDTPServer
from .schedule import Schedule
from .state import TelemetryState


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
    """

    def __init__(self, state: TelemetryState, server: NDTPServer, schedule: Schedule,
                 clock: Callable[[], datetime], model: ModelClient,
                 *, predict_interval_s: float = 60.0, alert_cooldown_s: float = 300.0,
                 queue_limit: int = 32):
        if (not math.isfinite(predict_interval_s) or not math.isfinite(alert_cooldown_s)
                or predict_interval_s <= 0 or alert_cooldown_s <= 0 or queue_limit < 1):
            raise ValueError("prediction interval/cooldown must be finite and positive; queue_limit >= 1")
        self.state, self.server, self.schedule = state, server, schedule
        self.clock, self.model = clock, model
        self.predict_interval_s = predict_interval_s
        self.alert_cooldown_s = alert_cooldown_s
        self.queue_limit = queue_limit
        self._lock = RLock()
        self._condition = Condition(self._lock)
        self._worker: Thread | None = None
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
        self._revision = 0
        self._seen_accepted = 0

    def start(self) -> "Orchestrator":
        with self._condition:
            if self._worker is not None:
                raise RuntimeError("prediction worker already started")
            self._worker = Thread(target=self._run, name="backend-ml", daemon=True)
            self._worker.start()
        return self

    def close(self) -> None:
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
            self._observe_accepted(self.state.counters().get("accepted", 0))
            self._update_row(unit_id, self.state.unit_mapping[unit_id], self.clock())

    def processing_readback(self) -> dict[str, int]:
        with self._lock:
            counts = {name: self._counters[name] for name in (
                "ml_enqueued", "ml_started", "ml_completed", "ml_succeeded", "ml_failed",
                "ml_unavailable", "ml_coalesced", "ml_dropped_queue_full",
                "ml_discarded_obsolete", "ml_canceled_on_close", "ml_max_queue_depth")}
            return {**counts, "ml_queue_depth": len(self._jobs),
                    "ml_queue_limit": self.queue_limit,
                    "ml_active_jobs": int(self._active is not None),
                    **self.schedule.counters(),
                    "stop_seen_frame_limit": self.state.history_limit * len(self.state.unit_mapping),
                    "context_history_frame_count": sum(len(c.history_frames) for c in self._contexts.values()),
                    "context_history_frame_limit": self.state.history_limit * len(self.state.unit_mapping)}

    def snapshot(self) -> dict:
        with self._lock:
            now = self.clock()
            counters = self.server.counters()
            self._observe_accepted(counters.get("accepted", 0))
            vehicles = [self._update_row(unit, tr, now)
                        for unit, tr in self.state.unit_mapping.items()]
            return {"schema_version": "transport.backend-vehicles.v1",
                    "revision": self._revision, "source_clock": self.state.source_clock,
                    "clock_time": now.isoformat(), "vehicles": vehicles,
                    "ingest": {"accepted": counters.get("accepted", 0),
                               "dropped": counters.get("dropped", 0),
                               "errors": counters.get("errors", 0),
                               "queue_depth": counters["queue_depth"]},
                    "processing": self.processing_readback()}

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
                self._queue(PredictionJob(unit_id, tr_id, now, target_id,
                                          frame_id, context_revision, context, float(cur_dev), request))
        success = self._last_success.get(tr_id)
        if success is not None and success["target_stop_id"] != target_id:
            success = None
        pending = (tr_id in self._jobs or self._active is not None and self._active.tr_id == tr_id)
        failure = self._last_failure.get(tr_id)
        failure_reason = failure[1] if failure is not None and failure[0] == target_id else None
        age_s = ((now - datetime.fromisoformat(success["last_success_at"])).total_seconds()
                 if success else None)
        status, reason = "unavailable", None
        if target is None:
            plan = self.schedule.by_vehicle.get(tr_id, ())
            reason = ("unsupported_day" if self.state.source_clock == "utc"
                      and plan and now > plan[-1].time + timedelta(days=1)
                      else "no_target_in_horizon")
        elif cur_dev is None:
            reason = "no_confident_observed_stop"
        elif state["degraded"]:
            status = "degraded" if success else "unavailable"
            reason = str(state["reason"])
        elif failure_reason is not None:
            status = "degraded" if success else "unavailable"
            reason = failure_reason
        elif pending:
            status, reason = "degraded", "prediction_pending"
        elif success is None:
            reason = "prediction_waiting_new_telemetry"
        elif success["prediction_context_revision"] != context_revision:
            status, reason = "degraded", "prediction_behind_input"
        elif age_s > self.predict_interval_s or success["quality"] != "normal":
            status, reason = "degraded", "prediction_aging"
        else:
            status = "normal"
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
                "target_stop_id": target_id,
                "target_time_begin": target.time.isoformat() if target else None,
                "cur_dev_s": cur_dev, "cur_dev_source": "computed_stop" if cur_dev is not None else None,
                "prediction_s": success["prediction_s"] if success else None,
                "predicted_arrival": success["predicted_arrival"] if success else None,
                "model_version": success["model_version"] if success else None,
                "artifact_sha256": success["artifact_sha256"] if success else None,
                "status": status, "reason": reason, "prediction_pending": pending,
                "last_success_at": success["last_success_at"] if success else None,
                "prediction_input_frame_id": success["prediction_input_frame_id"] if success else None,
                "prediction_context_revision": success["prediction_context_revision"] if success else None,
                "prediction_published_unix_ns": success["prediction_published_unix_ns"] if success else None,
                "prediction_age_s": max(0.0, age_s) if age_s is not None else None,
                "alert": (self._alerts.get(tr_id)
                          if success and self._alerts.get(tr_id, {}).get("target_stop_id") == target_id
                          else None), "revision": 0}

    def _queue(self, job: PredictionJob) -> None:
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
                now = self.clock()
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
                if not obsolete and error is None and response["applicability"] == "supported" and row["status"] == "normal":
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
