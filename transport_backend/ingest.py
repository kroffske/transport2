"""TCP NDTP server with bounded queue and explicit clock domains.

``queue_limit`` caps pending telemetry frames; a full queue drops the newest
frame and records its outcome. ``max_clients`` caps concurrent handler threads.
``max_frame_size`` caps per-client framing memory. History/outcome limits and
stale threshold belong to TelemetryState.
``clock`` is called at completed-frame ingest, before queueing; replay supplies
its own dataset-wall clock. ``received_at_utc`` always records host wall time.
"""

from __future__ import annotations

from datetime import datetime, timezone
from queue import Empty, Full, Queue
import socket
from threading import Event, Lock, Thread
from typing import Callable
from uuid import uuid4

from .ndtp import FrameStream, NDTPError, parse_frame
from .state import ClockMapping, Telemetry, TelemetryState, time_text, wire_event_time


class NDTPServer:
    def __init__(self, state: TelemetryState, *, host: str = "127.0.0.1", port: int = 0,
                 queue_limit: int = 256, max_frame_size: int = 65550,
                 max_clients: int = 64,
                 mapping: ClockMapping | None = None,
                 clock: Callable[[], datetime] | None = None):
        if queue_limit < 1 or max_clients < 1:
            raise ValueError("queue_limit and max_clients must be positive")
        if (mapping is None) != (state.source_clock == "utc"):
            raise ValueError("dataset_wall needs ClockMapping; utc must not use it")
        if state.source_clock == "dataset_wall" and clock is None:
            raise ValueError("dataset_wall needs an explicit replay clock")
        self.state = state
        self.host = host
        self.port = port
        self.max_frame_size = max_frame_size
        self.max_clients = max_clients
        self.mapping = mapping
        self.clock = clock or (lambda: datetime.now(timezone.utc).replace(tzinfo=None))
        self.queue: Queue[Telemetry] = Queue(maxsize=queue_limit)
        self._stop = Event()
        self._listener: socket.socket | None = None
        self._accept_thread: Thread | None = None
        self._worker: Thread | None = None
        self._handlers: dict[socket.socket, Thread] = {}
        self._handlers_lock = Lock()

    @property
    def address(self) -> tuple[str, int]:
        if self._listener is None:
            raise RuntimeError("server not started")
        address = self._listener.getsockname()
        return str(address[0]), int(address[1])

    def start(self) -> "NDTPServer":
        if self._listener is not None:
            raise RuntimeError("server already started")
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind((self.host, self.port))
        listener.listen()
        listener.settimeout(0.2)
        self._listener = listener
        self._worker = Thread(target=self._consume, daemon=True)
        self._accept_thread = Thread(target=self._accept, daemon=True)
        self._worker.start()
        self._accept_thread.start()
        return self

    def close(self) -> None:
        self._stop.set()
        if self._listener is not None:
            self._listener.close()
        if self._accept_thread is not None:
            self._accept_thread.join(timeout=2)
        with self._handlers_lock:
            handlers = list(self._handlers.items())
        for client, _ in handlers:
            try:
                client.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            client.close()
        for _, handler in handlers:
            handler.join(timeout=2)
        self.queue.join()
        if self._worker is not None:
            self._worker.join(timeout=2)
        self._listener = None

    def __enter__(self) -> "NDTPServer":
        return self.start()

    def __exit__(self, *_: object) -> None:
        self.close()

    def flush(self) -> None:
        """Wait for already queued telemetry to reach state."""
        self.queue.join()

    def counters(self) -> dict[str, int]:
        with self._handlers_lock:
            active_clients = len(self._handlers)
        return {**self.state.counters(), "queue_depth": self.queue.qsize(),
                "queue_limit": self.queue.maxsize,
                "active_clients": active_clients, "max_clients": self.max_clients}

    def _accept(self) -> None:
        assert self._listener is not None
        while not self._stop.is_set():
            try:
                client, _ = self._listener.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            with self._handlers_lock:
                if self._stop.is_set() or len(self._handlers) >= self.max_clients:
                    rejected = True
                else:
                    rejected = False
                    handler = Thread(target=self._handle, args=(client,), daemon=True)
                    self._handlers[client] = handler
                    handler.start()
            if rejected:
                client.close()
                self.state.count("dropped_connections_limit")
                continue

    def _handle(self, client: socket.socket) -> None:
        session = uuid4().hex
        unit: int | None = None
        sequence = 0
        framer = FrameStream(self.max_frame_size)
        client.settimeout(0.2)
        try:
            while not self._stop.is_set():
                try:
                    chunk = client.recv(16384)
                except socket.timeout:
                    continue
                except OSError:
                    break
                if not chunk:
                    break
                raws, framing_errors = framer.feed(chunk)
                if framing_errors:
                    self.state.count("errors", framing_errors)
                    self.state.count("errors_framing", framing_errors)
                for raw in raws:
                    # Sample both clocks at the actual ingestion boundary.
                    received = self.clock()
                    host_received = datetime.now(timezone.utc).replace(tzinfo=None)
                    try:
                        frame = parse_frame(raw)
                    except NDTPError as exc:
                        self.state.count("errors")
                        self.state.count("errors_crc" if "CRC" in str(exc) else "errors_frame")
                        continue
                    if frame.handshake_unit_id is not None:
                        if unit is not None or frame.unit_id not in self.state.unit_mapping:
                            self.state.count("errors")
                            self.state.count("errors_handshake")
                            continue
                        unit = frame.unit_id
                        self.state.connected(unit, session)
                        continue
                    if unit is None or frame.unit_id != unit:
                        self.state.count("errors")
                        self.state.count("errors_identity")
                        continue
                    assert frame.navigation is not None
                    nav = frame.navigation
                    sequence += 1
                    identity = f"{session}:{frame.request_id}:{sequence}"
                    record = Telemetry(
                        unit_id=unit,
                        tr_id=self.state.unit_mapping[unit],
                        event_time=time_text(wire_event_time(nav.timestamp, self.mapping)),
                        receive_time=time_text(received),
                        location_valid=nav.location_valid,
                        lon=nav.lon, lat=nav.lat, speed=float(nav.speed),
                        heading=float(nav.heading), alt=float(nav.alt),
                        packet_id=f"{session}:{frame.request_id}",
                        session_id=session, request_id=frame.request_id,
                        source_clock=self.state.source_clock, frame_id=identity,
                        received_at_utc=time_text(host_received),
                    )
                    try:
                        self.queue.put_nowait(record)
                        self.state.observe_queue_depth(self.queue.qsize())
                    except Full:
                        self.state.count("dropped")
                        self.state.count("dropped_queue_full")
                        self.state.mark_processed(record, "dropped_queue_full")
        finally:
            if unit is not None:
                self.state.disconnected(unit, session)
            with self._handlers_lock:
                self._handlers.pop(client, None)
            client.close()

    def _consume(self) -> None:
        while not self._stop.is_set() or not self.queue.empty():
            try:
                record = self.queue.get(timeout=0.1)
            except Empty:
                continue
            outcome = "rejected_state"
            try:
                outcome = "accepted" if self.state.accept(record) else "duplicate"
            except ValueError:
                self.state.count("errors")
                self.state.count("errors_state")
                self.state.count("dropped")
            finally:
                self.state.mark_processed(record, outcome)
                self.queue.task_done()
