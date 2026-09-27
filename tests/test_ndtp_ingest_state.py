from __future__ import annotations

from datetime import datetime, timedelta, timezone
import socket
import struct
from threading import Event
import time

import pytest

from transport_backend import ClockMapping, NDTPServer, TelemetryState, load_unit_mapping
from transport_backend.ndtp import NAV, NDTPError, FrameStream, crc16_modbus, encode_frame, parse_frame


UNIT = 664030
TR = "115106"
ORIGIN = datetime(2026, 1, 6, 12, 30, 0)
MAPPING = ClockMapping(1_700_000_000, ORIGIN)


def handshake(unit: int = UNIT, request: int = 1) -> bytes:
    return encode_frame(unit, 0, 100, request, struct.pack("<HHHIII", 6, 2, 0, unit, 65535, 0))


def nav(seconds: int = 1_700_000_001, *, request: int = 2, lon: int = 376173210,
        valid: bool = True, extra: bytes = b"", unit: int = UNIT) -> bytes:
    bits = 0x60 | (0x80 if valid else 0)
    body = bytes((0, 0)) + NAV.pack(seconds, lon, 557551234, bits, 0, 35, 40, 95, 0, 120, 8, 2)
    return encode_frame(unit, 1, 101, request, body + extra)


def await_counter(server: NDTPServer, key: str, expected: int, *, flush: bool = True) -> None:
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        if server.counters().get(key, 0) >= expected:
            if flush:
                server.flush()
            return
        time.sleep(0.01)
    pytest.fail(f"{key} did not reach {expected}: {server.counters()}")


def connect(server: NDTPServer) -> socket.socket:
    return socket.create_connection(server.address, timeout=2)


def test_simulation_socket_maps_both_clocks_and_rejects_future_event() -> None:
    origin = int(datetime.now(timezone.utc).timestamp()) - 2
    mapping = ClockMapping(origin, ORIGIN)
    receive = [ORIGIN + timedelta(seconds=2, milliseconds=500)]
    state = TelemetryState({UNIT: TR}, source_clock="simulation")
    with NDTPServer(state, mapping=mapping, clock=lambda: receive[0]) as server:
        with connect(server) as client:
            client.sendall(handshake() + nav(origin + 1))
            await_counter(server, "accepted", 1)
            record = state.snapshot(TR, receive[0])["telemetry"]
            assert record["event_time"] == "2026-01-06 12:30:01.000000"
            assert record["event_at_utc"] == datetime.fromtimestamp(
                origin + 1, timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f")
            assert state.ingest_readback()["last_accepted"]["event_at_utc"] == record["event_at_utc"]
            client.sendall(nav(origin + 10, request=3))
            await_counter(server, "errors_state", 1)
            assert state.counters()["accepted"] == 1
            assert state.ingest_readback()["last_processed"]["outcome"] == "rejected_state"


def test_packed_crc_and_unsupported_cell_rejected() -> None:
    assert crc16_modbus(b"123456789") == 0x4B37
    frame = parse_frame(nav(extra=bytes((8, 0)) + bytes(6)))
    assert frame.navigation is not None
    assert frame.navigation.lon == 37.617321
    assert frame.navigation.lat == 55.7551234
    assert frame.navigation.speed == 35
    assert frame.navigation.heading == 95
    default_sensors = (bytes((8, 0)) + bytes(6) + bytes((16, 0)) + bytes(8)
                       + bytes((2, 0)) + bytes(26) + bytes((10, 0)) + bytes(37))
    assert parse_frame(nav(extra=default_sensors)).navigation == frame.navigation
    with pytest.raises(NDTPError, match="unknown cell type 99"):
        parse_frame(nav(extra=bytes((99, 0, 1, 2))))
    with pytest.raises(NDTPError, match="truncated cell type 10"):
        parse_frame(nav(extra=bytes((10, 0)) + bytes(36)))
    with pytest.raises(NDTPError, match="handshake unit"):
        parse_frame(encode_frame(UNIT, 0, 100, 1,
                                 struct.pack("<HHHIII", 6, 2, 0, UNIT + 1, 65535, 0)))


def test_framer_fragment_coalesce_and_size_bound() -> None:
    framer = FrameStream(max_frame_size=128)
    a, b = handshake(), nav()
    assert framer.feed(a[:7]) == ([], 0)
    frames, errors = framer.feed(a[7:] + b)
    assert frames == [a, b]
    assert errors == 0
    oversized = b"\x7e\x7e" + struct.pack("<H", 600)
    frames, errors = framer.feed(oversized + a)
    assert frames == [a]
    assert errors > 0
    assert len(framer.buffer) < framer.max_frame_size


def test_socket_fragment_crc_unknown_reconnect_and_correction() -> None:
    now = [ORIGIN + timedelta(seconds=1)]
    state = TelemetryState({UNIT: TR}, history_limit=3, stale_after_s=5,
                           source_clock="dataset_wall")
    with NDTPServer(state, mapping=MAPPING, clock=lambda: now[0], max_frame_size=128) as server:
        wall_before = datetime.now(timezone.utc).replace(tzinfo=None)
        first = connect(server)
        h = handshake()
        first.sendall(h[:4])
        first.sendall(h[4:] + nav())
        await_counter(server, "accepted", 1)
        current = state.snapshot(TR, now[0])
        assert current["telemetry"]["tr_id"] == TR
        assert current["telemetry"]["source_clock"] == "dataset_wall"
        assert current["telemetry"]["event_time"] == "2026-01-06 12:30:01.000000"
        assert not current["degraded"]
        assert set(state.history(TR, now[0])[0]) >= {"packet_id", "session_id", "request_id", "frame_id", "received_at_utc"}
        ack = state.ingest_readback()
        assert ack["accepted_revision"] == ack["processed_revision"] == 1
        assert ack["last_accepted"]["unit_id"] == UNIT
        assert ack["last_accepted"]["request_id"] == 2
        assert ack["last_accepted"]["received_at_utc"] == current["telemetry"]["received_at_utc"]
        received_wall = datetime.fromisoformat(ack["last_accepted"]["received_at_utc"])
        assert wall_before <= received_wall <= datetime.now(timezone.utc).replace(tzinfo=None)
        assert ack["last_accepted"]["received_at_utc"] != ack["last_accepted"]["receive_time"]
        bad = bytearray(nav(request=3))
        bad[-1] ^= 1
        first.sendall(bytes(bad) + nav(extra=bytes((99, 0)), request=4) + nav(request=5))
        await_counter(server, "errors_crc", 1)
        await_counter(server, "errors_frame", 1)
        await_counter(server, "dropped_duplicate", 1)
        assert server.counters()["accepted"] == 1
        first.close()
        await_counter(server, "disconnects", 1)
        assert state.snapshot(TR, now[0])["reason"] == "disconnected"

        second = connect(server)
        second.sendall(handshake(request=1) + nav(request=2))
        await_counter(server, "connections", 2)
        await_counter(server, "dropped_duplicate", 2)
        ack = state.ingest_readback()
        assert ack["accepted_revision"] == 1
        assert ack["last_processed"]["outcome"] == "duplicate"
        assert ack["last_processed"]["request_id"] == 2
        assert ack["last_processed"]["session_id"] != ack["last_accepted"]["session_id"]
        now[0] = ORIGIN + timedelta(seconds=4)
        correction = nav(request=2, lon=376173211)
        second.sendall(correction)
        await_counter(server, "accepted", 2)
        assert state.history(TR, ORIGIN + timedelta(seconds=1))[0]["lon"] == 37.617321
        assert state.history(TR, now[0])[0]["lon"] == 37.6173211
        assert state.snapshot(TR, now[0])["telemetry"]["lon"] == 37.6173211
        now[0] = ORIGIN + timedelta(seconds=10)
        assert state.snapshot(TR, now[0])["reason"] == "stale_gps"
        second.sendall(nav(1_700_000_010, request=3))
        await_counter(server, "accepted", 3)
        assert state.snapshot(TR, now[0])["reason"] is None
        second.close()


def test_receive_availability_negative_lag_and_bounded_history() -> None:
    now = [ORIGIN]
    state = TelemetryState({UNIT: TR}, history_limit=2, source_clock="dataset_wall")
    with NDTPServer(state, mapping=MAPPING, clock=lambda: now[0]) as server:
        client = connect(server)
        client.sendall(handshake() + nav(1_700_000_010))
        await_counter(server, "accepted", 1)
        assert state.history(TR, ORIGIN) == []  # event is in future despite early receive
        assert state.history(TR, ORIGIN + timedelta(seconds=10))[0]["receive_time"] == "2026-01-06 12:30:00.000000"
        now[0] = ORIGIN + timedelta(seconds=20)
        client.sendall(nav(1_700_000_020, request=3) + nav(1_700_000_021, request=4))
        await_counter(server, "accepted", 3)
        assert len(state.history(TR, now[0] + timedelta(seconds=1))) == 2
        assert server.counters()["dropped_history_eviction"] == 1
        assert server.counters()["queue_depth"] == 0
        client.close()


def test_mapping_from_real_data_and_clock_domains() -> None:
    path = "/Users/ravius/projects/transport2/data/validate/traffic.csv"
    mapping = load_unit_mapping([path])
    assert mapping[UNIT] == TR
    assert MAPPING.to_epoch(MAPPING.from_epoch(1_700_000_010)) == 1_700_000_010
    replay = ClockMapping(1_700_000_000, datetime(2026, 1, 6))
    assert replay.from_epoch(1_700_000_000) == datetime(2026, 1, 6)
    assert replay.to_epoch(datetime(2026, 1, 6, 0, 0, 15)) == 1_700_000_015
    with pytest.raises(ValueError, match="explicit replay clock"):
        NDTPServer(TelemetryState({UNIT: TR}, source_clock="dataset_wall"), mapping=MAPPING)


def test_queue_overload_is_bounded_and_observable() -> None:
    release = Event()

    class SlowState(TelemetryState):
        def accept(self, record):  # type: ignore[override]
            release.wait(2)
            return super().accept(record)

    state = SlowState({UNIT: TR}, history_limit=2, outcome_limit=32,
                      source_clock="dataset_wall")
    with NDTPServer(state, mapping=MAPPING, clock=lambda: ORIGIN,
                    queue_limit=1) as server:
        client = connect(server)
        try:
            frames = b"".join(nav(1_700_000_001 + i, request=2 + i) for i in range(20))
            client.sendall(handshake() + frames)
            await_counter(server, "dropped_queue_full", 1, flush=False)
        finally:
            release.set()
            client.close()
        server.flush()
        counters = server.counters()
        assert counters["max_queue_depth"] == 1
        assert counters["queue_depth"] == 0
        assert counters["dropped_queue_full"] >= 1
        assert counters["accepted"] >= 1
        assert len(state.history(TR, ORIGIN + timedelta(seconds=15))) <= 2
        readback = state.ingest_readback()
        assert readback["processed_revision"] == 20
        assert len(readback["outcomes"]) == 20
        assert {entry["request_id"] for entry in readback["outcomes"]} == set(range(2, 22))
        assert sum(entry["outcome"] == "dropped_queue_full" for entry in readback["outcomes"]) == counters["dropped_queue_full"]
        assert all(entry["session_id"] and entry["frame_id"] for entry in readback["outcomes"])


def test_outcome_journal_eviction_reports_gap() -> None:
    state = TelemetryState({UNIT: TR}, outcome_limit=3, source_clock="dataset_wall")
    with NDTPServer(state, mapping=MAPPING, clock=lambda: ORIGIN) as server:
        client = connect(server)
        client.sendall(handshake() + b"".join(
            nav(1_700_000_001 + i, request=2 + i) for i in range(5)))
        await_counter(server, "accepted", 5)
        readback = state.ingest_readback(0)
        assert readback["processed_revision"] == 5
        assert readback["oldest_outcome_revision"] == 3
        assert readback["outcome_gap"] is True
        assert [item["revision"] for item in readback["outcomes"]] == [3, 4, 5]
        assert state.ingest_readback(2)["outcome_gap"] is False
        assert server.counters()["outcome_evictions"] == 2
        client.close()


def test_invalid_gps_keeps_last_valid_position_and_age() -> None:
    now = [ORIGIN + timedelta(seconds=1)]
    state = TelemetryState({UNIT: TR}, stale_after_s=5, source_clock="dataset_wall")
    with NDTPServer(state, mapping=MAPPING, clock=lambda: now[0]) as server:
        client = connect(server)
        client.sendall(handshake() + nav())
        await_counter(server, "accepted", 1)
        now[0] = ORIGIN + timedelta(seconds=2)
        client.sendall(nav(1_700_000_002, request=3, lon=0, valid=False))
        await_counter(server, "accepted", 2)
        snapshot = state.snapshot(TR, now[0])
        assert snapshot["reason"] == "invalid_gps"
        assert snapshot["telemetry"]["location_valid"] is False
        assert snapshot["lon"] == snapshot["last_valid_gps"]["lon"] == 37.617321
        assert snapshot["lat"] == 55.7551234
        assert snapshot["gps_age_s"] == 1
        now[0] = ORIGIN + timedelta(seconds=10)
        assert state.snapshot(TR, now[0])["gps_age_s"] == 9
        client.sendall(nav(1_700_000_010, request=4, lon=376173215))
        await_counter(server, "accepted", 3)
        recovered = state.snapshot(TR, now[0])
        assert recovered["reason"] is None
        assert recovered["lon"] == 37.6173215
        assert recovered["gps_age_s"] == 0
        client.close()


def test_reconnect_handlers_are_reaped_and_clients_limited() -> None:
    state = TelemetryState({UNIT: TR}, source_clock="dataset_wall")
    with NDTPServer(state, mapping=MAPPING, clock=lambda: ORIGIN,
                    max_clients=1) as server:
        first = connect(server)
        first.sendall(handshake())
        await_counter(server, "connections", 1)
        assert len(state.ingest_readback()["active_sessions"][UNIT]) == 1
        extra = connect(server)
        extra.sendall(handshake())
        await_counter(server, "dropped_connections_limit", 1)
        assert server.counters()["active_clients"] == 1
        extra.close()
        first.close()
        await_counter(server, "disconnects", 1)
        for index in range(30):
            client = connect(server)
            client.sendall(handshake(request=index + 2))
            await_counter(server, "connections", index + 2)
            client.close()
            await_counter(server, "disconnects", index + 2)
        deadline = time.monotonic() + 2
        while server.counters()["active_clients"] and time.monotonic() < deadline:
            time.sleep(0.01)
        assert server.counters()["active_clients"] == 0
        assert len(server._handlers) == 0


def test_live_unix_clock_is_explicit_utc() -> None:
    utc_now = datetime(2023, 11, 14, 22, 13, 21)
    state = TelemetryState({UNIT: TR}, source_clock="utc")
    with NDTPServer(state, clock=lambda: utc_now) as server:
        client = connect(server)
        client.sendall(handshake() + nav())
        await_counter(server, "accepted", 1)
        observed = state.snapshot(TR, utc_now)
        assert observed["source_clock"] == "utc"
        assert observed["telemetry"]["event_time"] == "2023-11-14 22:13:21.000000"
        assert observed["telemetry"]["receive_time"] == "2023-11-14 22:13:21.000000"
        assert not observed["degraded"]
        client.close()
