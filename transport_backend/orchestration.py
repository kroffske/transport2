"""Backend prediction lifecycle over point-in-time NDTP state and plan.

Publication timestamps use host Unix wall-clock nanoseconds, independent of
the dataset replay clock. Input identity names the latest available received
frame; prediction identity and publication time belong to its saved success.
"""

from __future__ import annotations

from datetime import datetime, timedelta
import json
import math
from threading import RLock
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


class Orchestrator:
    """Serializes one process's prediction, freshness and alert decisions."""

    def __init__(self, state: TelemetryState, server: NDTPServer, schedule: Schedule,
                 clock: Callable[[], datetime], model: ModelClient,
                 *, predict_interval_s: float = 60.0, alert_cooldown_s: float = 300.0):
        if (not math.isfinite(predict_interval_s) or not math.isfinite(alert_cooldown_s)
                or predict_interval_s <= 0 or alert_cooldown_s <= 0):
            raise ValueError("prediction interval and alert cooldown must be finite and positive")
        self.state, self.server, self.schedule = state, server, schedule
        self.clock, self.model = clock, model
        self.predict_interval_s = predict_interval_s
        self.alert_cooldown_s = alert_cooldown_s
        self._lock = RLock()
        self._last_attempt: dict[str, datetime] = {}
        self._last_attempt_target: dict[str, str] = {}
        self._last_attempt_frame: dict[str, str] = {}
        self._last_failure: dict[str, str] = {}
        self._last_success: dict[str, dict] = {}
        self._last_alert: dict[tuple[str, str], datetime] = {}
        self._alerts: dict[str, dict] = {}
        self._rows: dict[str, dict] = {}
        self._revision = 0
        self._seen_accepted = 0

    def on_ingest(self, unit_id: int) -> None:
        """Build the just-accepted vehicle result before replay advances time."""
        with self._lock:
            self._observe_accepted(self.state.counters().get("accepted", 0))
            tr_id = self.state.unit_mapping[unit_id]
            self._update_row(unit_id, tr_id, self.clock())

    def snapshot(self) -> dict:
        with self._lock:
            now = self.clock()
            counters = self.server.counters()
            self._observe_accepted(counters.get("accepted", 0))
            vehicles = []
            for unit_id, tr_id in self.state.unit_mapping.items():
                vehicles.append(self._update_row(unit_id, tr_id, now))
            return {"schema_version": "transport.backend-vehicles.v1",
                    "revision": self._revision, "source_clock": self.state.source_clock,
                    "clock_time": now.isoformat(), "vehicles": vehicles,
                    "ingest": {"accepted": counters.get("accepted", 0),
                               "dropped": counters.get("dropped", 0),
                               "errors": counters.get("errors", 0),
                               "queue_depth": counters["queue_depth"]}}

    def _observe_accepted(self, count: int) -> None:
        if count > self._seen_accepted:
            self._revision += count - self._seen_accepted
            self._seen_accepted = count

    def _update_row(self, unit_id: int, tr_id: str, now: datetime) -> dict:
        row = self._vehicle(unit_id, tr_id, now)
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

    def _vehicle(self, unit_id: int, tr_id: str, now: datetime) -> dict:
        state = self.state.snapshot(tr_id, now)
        latest = state["telemetry"]
        target = self.schedule.target(tr_id, now)
        history = self.state.history(tr_id, now, window_s=900)
        latest_frame = (max(history, key=lambda row: (str(row["receive_time"]),
                                                    str(row["received_at_utc"])))
                        if history else None)
        frame_id = str(latest_frame["frame_id"]) if latest_frame else None
        cur_dev = self.schedule.observed_deviation(tr_id, now, history)
        target_id = target.stop_id if target else None
        success = self._last_success.get(tr_id)
        if success is not None and success["target_stop_id"] != target_id:
            success = None
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
        else:
            last = self._last_attempt.get(tr_id)
            due = (frame_id is not None
                   and frame_id != self._last_attempt_frame.get(tr_id)
                   and (last is None or (now - last).total_seconds() >= self.predict_interval_s
                        or self._last_attempt_target.get(tr_id) != target_id))
            if due:
                self._last_attempt[tr_id] = now
                self._last_attempt_target[tr_id] = target_id
                self._last_attempt_frame[tr_id] = frame_id
                request = {"point": {"sample_id": f"{tr_id}_{now:%Y%m%d%H%M%S%f}",
                                     "tr_id": tr_id, "T": now.isoformat(),
                                     "target_stop_id": target_id,
                                     "target_time_begin": target.time.isoformat(),
                                     "cur_dev_s": float(cur_dev)},
                           "telemetry": [{key: row[key] for key in TRAFFIC_COLUMNS}
                                         for row in history[-2000:]],
                           "schedule_plan": self.schedule.ml_rows(tr_id)}
                try:
                    response = self.model.predict(request)
                    if response.get("applicability") == "supported" and response.get("prediction_s") is not None:
                        success = {"target_stop_id": target_id,
                                   "prediction_s": response["prediction_s"],
                                   "predicted_arrival": response["predicted_arrival"],
                                   "model_version": response["model_version"],
                                   "artifact_sha256": response["artifact_sha256"],
                                   "last_success_at": now.isoformat(),
                                   "prediction_input_frame_id": frame_id,
                                   "prediction_published_unix_ns": None,
                                   "quality": response["quality"]}
                        self._last_success[tr_id] = success
                        self._last_failure.pop(tr_id, None)
                        status = "normal" if response["quality"] == "normal" else "degraded"
                        reason = response.get("reason")
                        self._consider_alert(tr_id, target_id, now, float(cur_dev),
                                             float(response["prediction_s"]), status,
                                             target.time)
                    else:
                        status = "degraded" if success else "unavailable"
                        reason = str(response.get("reason") or "ml_unavailable")
                        self._last_failure[tr_id] = reason
                except ModelFailure as exc:
                    status = "degraded" if success else "unavailable"
                    reason = str(exc)
                    self._last_failure[tr_id] = reason
            else:
                if success:
                    age = (now - datetime.fromisoformat(success["last_success_at"])).total_seconds()
                    failure = self._last_failure.get(tr_id)
                    status = ("normal" if failure is None and age <= self.predict_interval_s
                              and success["quality"] == "normal" else "degraded")
                    reason = failure if failure is not None else (None if status == "normal" else "prediction_aging")
                else:
                    reason = (self._last_failure.get(tr_id, "prediction_waiting_retry")
                              if self._last_attempt_target.get(tr_id) == target_id
                              else "prediction_waiting_new_telemetry")
        age_s = ((now - datetime.fromisoformat(success["last_success_at"])).total_seconds()
                 if success else None)
        return {"tr_id": tr_id, "unit_id": unit_id,
                "input_frame_id": frame_id,
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
                "status": status, "reason": reason,
                "last_success_at": success["last_success_at"] if success else None,
                "prediction_input_frame_id": success["prediction_input_frame_id"] if success else None,
                "prediction_published_unix_ns": success["prediction_published_unix_ns"] if success else None,
                "prediction_age_s": max(0.0, age_s) if age_s is not None else None,
                "alert": (self._alerts.get(tr_id)
                          if success and self._alerts.get(tr_id, {}).get("target_stop_id") == target_id
                          else None),
                "revision": 0}

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
