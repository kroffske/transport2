"""Send historical traffic through real NDTP sockets in receive-time order.

The dataset timestamps are naive wall-clock values. ``dataset_origin`` and
``epoch_origin`` define a reversible synthetic wire mapping, not a timezone.
The sender alone reads the CSV. The backend learns rows only as frames arrive.
An optional JSONL trace links each source packet and receive time to its NDTP
request ID and send monotonic clock for causality and quantization audits.
"""

from __future__ import annotations

import argparse
import json
import math
import socket
import struct
import time
from pathlib import Path
from urllib.request import Request, urlopen

import pandas as pd

NPL = struct.Struct("<HHHHBIH")
NPH = struct.Struct("<HHHI")
NAV = struct.Struct("<IIIBBHHHHHBB")
HANDSHAKE = struct.Struct("<HHHIII")
DEFAULT_DATASET_ORIGIN = "2026-01-06 00:00:00"
DEFAULT_EPOCH_ORIGIN = 1_700_000_000


def crc16_modbus(data: bytes) -> int:
    crc = 0xFFFF
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ (0xA001 if crc & 1 else 0)
    return crc


def frame(unit_id: int, request_id: int, service_id: int, kind: int, body: bytes) -> bytes:
    nph = NPH.pack(service_id, kind, 1, request_id) + body
    crc = crc16_modbus(nph)
    swapped_crc = ((crc & 0xFF) << 8) | (crc >> 8)
    return NPL.pack(0x7E7E, len(nph), 0, swapped_crc, 2, unit_id, 0) + nph


def handshake(unit_id: int, request_id: int = 1) -> bytes:
    return frame(unit_id, request_id, 0, 100,
                 HANDSHAKE.pack(6, 2, 0, unit_id, 65535, 0))


def wire_epoch(event_time: pd.Timestamp, dataset_origin: pd.Timestamp,
               epoch_origin: int) -> int:
    seconds = (event_time - dataset_origin).total_seconds()
    result = epoch_origin + math.floor(seconds)
    if not 0 <= result <= 0xFFFFFFFF:
        raise ValueError("event timestamp is outside NDTP u32 range")
    return result


def navigation(row: pd.Series, request_id: int, dataset_origin: pd.Timestamp,
               epoch_origin: int) -> tuple[bytes, dict]:
    valid = (str(row.location_valid).lower() in {"true", "1"}
             and pd.notna(row.lon) and pd.notna(row.lat)
             and -180 <= float(row.lon) <= 180 and -90 <= float(row.lat) <= 90)
    lon = float(row.lon) if valid else 0.0
    lat = float(row.lat) if valid else 0.0
    speed = float(row.speed) if valid and pd.notna(row.speed) else 0.0
    heading = float(row.heading) if valid and pd.notna(row.heading) else 0.0
    if not math.isfinite(speed) or not math.isfinite(heading):
        raise ValueError("nonfinite speed or heading")
    epoch = wire_epoch(row.event_time, dataset_origin, epoch_origin)
    speed_wire = max(0, min(65535, round(speed)))
    course_wire = max(0, min(360, round(heading)))
    flags = (0x20 if lat >= 0 else 0) | (0x40 if lon >= 0 else 0) | (0x80 if valid else 0)
    nav = NAV.pack(epoch, round(abs(lon) * 1e7), round(abs(lat) * 1e7),
                   flags, 0, speed_wire, speed_wire, course_wire, 0, 0, 0, 0)
    wire = frame(int(row.unit_id), request_id, 1, 101, b"\x00\x00" + nav)
    quantization = {"event_time_delta_s": epoch - epoch_origin -
                    (row.event_time - dataset_origin).total_seconds(),
                    "speed_delta_kmh": speed_wire - speed,
                    "lon_delta_deg": round(abs(lon) * 1e7) / 1e7 - abs(lon),
                    "lat_delta_deg": round(abs(lat) * 1e7) / 1e7 - abs(lat)}
    return wire, quantization


def load_rows(path: Path, start: str | None, end: str | None,
              units: set[int] | None, limit: int | None) -> pd.DataFrame:
    columns = ["packet_id", "tr_id", "unit_id", "event_time", "receive_time",
               "location_valid", "lon", "lat", "speed", "heading"]
    rows = pd.read_csv(path, usecols=columns,
                       dtype={"packet_id": str, "tr_id": str, "unit_id": int})
    for column in ("event_time", "receive_time"):
        rows[column] = pd.to_datetime(rows[column], format="mixed", errors="raise")
        if rows[column].isna().any() or rows[column].dt.tz is not None:
            raise ValueError(f"{column} must be complete naive dataset-wall time")
    if start:
        rows = rows.loc[rows.receive_time >= pd.Timestamp(start)]
    if end:
        rows = rows.loc[rows.receive_time <= pd.Timestamp(end)]
    if units:
        rows = rows.loc[rows.unit_id.isin(units)]
    conflicts = rows.groupby("unit_id").tr_id.nunique()
    if (conflicts > 1).any():
        raise ValueError(f"unit_id has conflicting tr_id: {conflicts[conflicts > 1].to_dict()}")
    rows = rows.sort_values(["receive_time", "packet_id"], kind="stable")
    if limit is not None:
        rows = rows.head(limit)
    if rows.empty:
        raise ValueError("No replay rows selected")
    return rows.reset_index(drop=True)


def controller_call(base_url: str, method: str, path: str,
                    payload: dict | None, timeout: float) -> dict:
    body = json.dumps(payload).encode() if payload is not None else None
    request = Request(base_url.rstrip("/") + path, data=body, method=method,
                      headers={"Content-Type": "application/json"})
    with urlopen(request, timeout=timeout) as response:
        return json.load(response)


def wait_for_ack(base_url: str, prior_revision: int, unit_id: int,
                 request_id: int, timeout: float) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        readback = controller_call(base_url, "GET",
                                   f"/v1/ingest?since_revision={prior_revision}", None, timeout)
        if readback["outcome_gap"]:
            raise RuntimeError(f"NDTP outcome journal gap after revision {prior_revision}")
        for outcome in readback["outcomes"]:
            if (int(outcome["unit_id"]) == unit_id
                    and int(outcome["request_id"]) == request_id):
                if outcome["outcome"] not in {"accepted", "duplicate"}:
                    raise RuntimeError(f"NDTP frame {unit_id}/{request_id} outcome={outcome['outcome']}")
                return outcome
        time.sleep(0.01)
    raise TimeoutError(f"No ingest ack for NDTP frame {unit_id}/{request_id}")


def replay(args: argparse.Namespace) -> dict:
    rows = load_rows(args.traffic, args.start, args.end,
                     set(args.units) if args.units else None, args.limit)
    dataset_origin = pd.Timestamp(args.dataset_origin)
    if dataset_origin.tz is not None:
        raise ValueError("dataset_origin must be a naive wall-clock value")
    if args.speedup <= 0:
        raise ValueError("speedup must be positive")
    sockets: dict[int, socket.socket] = {}
    request_ids: dict[int, int] = {}
    first_receive = rows.receive_time.iloc[0]
    start_monotonic = time.monotonic()
    max_lateness = 0.0
    sent = 0
    duplicate = 0
    trace = args.trace.open("w", encoding="utf-8") if args.trace else None
    try:
        for row in rows.itertuples(index=False):
            target_elapsed = (row.receive_time - first_receive).total_seconds() / args.speedup
            target_send = start_monotonic + target_elapsed
            wait = target_send - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            unit_id = int(row.unit_id)
            if unit_id not in sockets:
                sock = socket.create_connection((args.host, args.port), timeout=args.timeout)
                sock.settimeout(args.timeout)
                sock.sendall(handshake(unit_id))
                sockets[unit_id] = sock
                request_ids[unit_id] = 1
            request_ids[unit_id] = (request_ids[unit_id] + 1) & 0xFFFFFFFF
            if request_ids[unit_id] == 0:
                request_ids[unit_id] = 1
            prior_revision = None
            if args.backend_url:
                advance = controller_call(args.backend_url, "POST", "/v1/replay/clock",
                                          {"receive_time": row.receive_time.isoformat(),
                                           "unit_id": unit_id,
                                           "request_id": request_ids[unit_id]}, args.timeout)
                prior_revision = int(advance["processed_revision"])
            packet, quantization = navigation(pd.Series(row._asdict()), request_ids[unit_id],
                                              dataset_origin, args.epoch_origin)
            send_unix_ns = time.time_ns()
            send_monotonic_ns = time.monotonic_ns()
            max_lateness = max(max_lateness, max(0.0, send_monotonic_ns / 1e9 - target_send))
            sockets[unit_id].sendall(packet)
            acknowledged = (wait_for_ack(args.backend_url, prior_revision, unit_id,
                                         request_ids[unit_id], args.timeout)
                            if args.backend_url else None)
            ack_monotonic_ns = time.monotonic_ns() if acknowledged else None
            ack_unix_ns = time.time_ns() if acknowledged else None
            if acknowledged and acknowledged["outcome"] == "duplicate":
                duplicate += 1
            sent += 1
            if trace:
                trace.write(json.dumps({"source_packet_id": row.packet_id,
                                        "tr_id": row.tr_id, "unit_id": unit_id,
                                        "event_time": row.event_time.isoformat(),
                                        "source_receive_time": row.receive_time.isoformat(),
                                        "ndtp_request_id": request_ids[unit_id],
                                        "send_monotonic_ns": send_monotonic_ns,
                                        "ack_monotonic_ns": ack_monotonic_ns,
                                        "send_unix_ns": send_unix_ns,
                                        "ack_unix_ns": ack_unix_ns,
                                        "ack": acknowledged,
                                        "quantization": quantization},
                                       ensure_ascii=False, allow_nan=False) + "\n")
    finally:
        for sock in sockets.values():
            sock.close()
        if trace:
            trace.close()
    return {"sent": sent, "duplicate": duplicate, "units": len(sockets),
            "first_receive": first_receive.isoformat(),
            "last_receive": rows.receive_time.iloc[-1].isoformat(),
            "elapsed_wall_s": time.monotonic() - start_monotonic,
            "max_send_lateness_wall_s": max_lateness,
            "dataset_origin": dataset_origin.isoformat(), "epoch_origin": args.epoch_origin,
            "speedup": args.speedup}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--traffic", type=Path, required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9201)
    parser.add_argument("--start", help="inclusive source receive_time, naive dataset clock")
    parser.add_argument("--end", help="inclusive source receive_time, naive dataset clock")
    parser.add_argument("--units", type=int, nargs="*")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--speedup", type=float, default=120.0)
    parser.add_argument("--dataset-origin", default=DEFAULT_DATASET_ORIGIN)
    parser.add_argument("--epoch-origin", type=int, default=DEFAULT_EPOCH_ORIGIN)
    parser.add_argument("--timeout", type=float, default=5.0)
    parser.add_argument("--backend-url", default="http://127.0.0.1:8001",
                        help="Backend replay-clock control and per-frame ingest ack")
    parser.add_argument("--trace", type=Path)
    return parser.parse_args()


if __name__ == "__main__":
    print(json.dumps(replay(parse_args()), ensure_ascii=False))
