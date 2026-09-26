"""Packed NDTP framing and the fixed-length emulator cell subset.

An unknown cell has no safe skip offset: its entire frame is rejected.
``max_frame_size`` bounds both an advertised frame and the stream buffer.
"""

from __future__ import annotations

from dataclasses import dataclass
import struct


NPL = struct.Struct("<HHHHBIH")
NPH = struct.Struct("<HHHI")
NAV = struct.Struct("<IIIBBHHHHHBB")
CELL_LENGTHS = {0: 26, 2: 26, 8: 6, 10: 37, 15: 50, 16: 8}
SIGNATURE = b"\x7e\x7e"


class NDTPError(ValueError):
    """Malformed or unsupported NDTP frame."""


@dataclass(frozen=True)
class Navigation:
    timestamp: int
    lon: float
    lat: float
    location_valid: bool
    speed: int
    heading: int
    alt: int


@dataclass(frozen=True)
class Frame:
    unit_id: int
    service_id: int
    message_type: int
    request_id: int
    navigation: Navigation | None
    handshake_unit_id: int | None
    raw: bytes


def crc16_modbus(data: bytes) -> int:
    crc = 0xFFFF
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ (0xA001 if crc & 1 else 0)
    return crc


def swapped_crc(data: bytes) -> int:
    crc = crc16_modbus(data)
    return (crc >> 8) | ((crc & 0xFF) << 8)


def encode_frame(unit_id: int, service_id: int, message_type: int,
                 request_id: int, body: bytes) -> bytes:
    """Encode the emulator-compatible NPL/NPH envelope (also used by replay)."""
    payload = NPH.pack(service_id, message_type, 1, request_id) + body
    if len(payload) > 65535:
        raise NDTPError("NPL dataSize exceeds u16")
    return NPL.pack(0x7E7E, len(payload), 0, swapped_crc(payload), 2,
                    unit_id, 0) + payload


def parse_frame(raw: bytes) -> Frame:
    if len(raw) < NPL.size + NPH.size:
        raise NDTPError("short frame")
    signature, size, flags, crc, kind, unit_id, _ = NPL.unpack_from(raw)
    if signature != 0x7E7E or kind != 2 or flags != 0:
        raise NDTPError("unsupported NPL signature, type, or flags")
    if size != len(raw) - NPL.size:
        raise NDTPError("NPL dataSize mismatch")
    payload = raw[NPL.size:]
    if swapped_crc(payload) != crc:
        raise NDTPError("bad CRC16 Modbus")
    service, message_type, nph_flags, request_id = NPH.unpack_from(payload)
    if nph_flags != 1:
        raise NDTPError("unsupported NPH flags")
    body = payload[NPH.size:]
    if (service, message_type) == (0, 100):
        if len(body) != 18:
            raise NDTPError("handshake body must be 18 bytes")
        major, minor, handshake_flags, handshake_unit, max_size, reserved = struct.unpack("<HHHIII", body)
        if (major, minor) != (6, 2) or handshake_flags or reserved or max_size < NPH.size:
            raise NDTPError("unsupported handshake contract")
        if handshake_unit != unit_id:
            raise NDTPError("handshake unit differs from NPL peerAddress")
        return Frame(unit_id, service, message_type, request_id, None,
                     handshake_unit, raw)
    if (service, message_type) != (1, 101):
        raise NDTPError(f"unsupported NPH service/type {service}/{message_type}")
    offset = 0
    nav = None
    while offset < len(body):
        if len(body) - offset < 2:
            raise NDTPError("truncated cell header")
        cell_type, number = body[offset], body[offset + 1]
        offset += 2
        length = CELL_LENGTHS.get(cell_type)
        if length is None:
            raise NDTPError(f"unknown cell type {cell_type}; no known length")
        if len(body) - offset < length:
            raise NDTPError(f"truncated cell type {cell_type}: need {length} bytes")
        cell = body[offset:offset + length]
        offset += length
        if cell_type == 0:
            if nav is not None or number != 0 or offset != 2 + length:
                raise NDTPError("Nav00 must occur once and first with number 0")
            timestamp, longitude, latitude, bits, _, speed, _, course, _, altitude, _, _ = NAV.unpack(cell)
            lon = longitude / 1e7 * (1 if bits & 0x40 else -1)
            lat = latitude / 1e7 * (1 if bits & 0x20 else -1)
            if longitude > 1800000000 or latitude > 900000000 or course > 360:
                raise NDTPError("Nav00 coordinate or heading out of range")
            nav = Navigation(timestamp, lon, lat, bool(bits & 0x80), speed,
                             course, altitude)
    if nav is None:
        raise NDTPError("realtime frame has no Nav00")
    return Frame(unit_id, service, message_type, request_id, nav, None, raw)


class FrameStream:
    """Incremental stream framer; feed returns complete frames and framing errors."""

    def __init__(self, max_frame_size: int = 65550):
        if not NPL.size + NPH.size <= max_frame_size <= 65535 + NPL.size:
            raise ValueError("invalid max_frame_size")
        self.max_frame_size = max_frame_size
        self.buffer = bytearray()

    def feed(self, chunk: bytes) -> tuple[list[bytes], int]:
        frames: list[bytes] = []
        errors = 0
        offset = 0
        while offset < len(chunk):
            capacity = self.max_frame_size - len(self.buffer)
            if capacity == 0:
                # Only possible after malformed input; valid full frames are
                # removed by the loop below.
                del self.buffer[0]
                errors += 1
                capacity = 1
            take = min(capacity, len(chunk) - offset)
            self.buffer.extend(chunk[offset:offset + take])
            offset += take
            while len(self.buffer) >= 2:
                if self.buffer[:2] != SIGNATURE:
                    del self.buffer[0]
                    errors += 1
                    continue
                if len(self.buffer) < NPL.size:
                    break
                size = struct.unpack_from("<H", self.buffer, 2)[0]
                total = NPL.size + size
                if total < NPL.size + NPH.size or total > self.max_frame_size:
                    del self.buffer[0]
                    errors += 1
                    continue
                if len(self.buffer) < total:
                    break
                frames.append(bytes(self.buffer[:total]))
                del self.buffer[:total]
        return frames, errors
