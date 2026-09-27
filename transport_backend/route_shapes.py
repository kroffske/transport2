"""Road-following shapes between consecutive planned stops.

Built offline by ``scripts/build_route_shapes.py`` into
``data/routes/route_shapes.json``::

    {"<tr_id>": {"segments": [{"from_stop": "<tt_action_item_id>",
                               "to_stop": "<tt_action_item_id>",
                               "coords": [[lon, lat], ...],  # first/last == stop coords
                               "source": "gps" | "straight",
                               "n": <GPS passes averaged, 0 for straight>}, ...],
                 "built_from": ["YYYY-MM-DD", ...],
                 "sha": "<sha256 of the segments>"}}

Segments follow the plan order of ``transport_ml.data.read_plan`` (time_begin,
then tt_action_item_id) over stops with coordinates. A shape is only a drawing
aid between planned stops; it is not a map-matched road geometry.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
from typing import Iterable, Mapping

DEFAULT_PATH = Path(__file__).resolve().parents[1] / "data" / "routes" / "route_shapes.json"
SOURCES = frozenset({"gps", "straight"})

Point = tuple[float, float]


@dataclass(frozen=True)
class SegmentShape:
    from_stop: str
    to_stop: str
    coords: tuple[Point, ...]
    source: str
    n: int


RouteShapes = dict[str, dict[tuple[str, str], SegmentShape]]


def shape_sha(segments: list[dict]) -> str:
    """Stable content hash of one vehicle's segment list."""
    blob = json.dumps(segments, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(blob.encode()).hexdigest()


def parse_route_shapes(raw: Mapping[str, Mapping]) -> RouteShapes:
    """``{tr_id: {(from_stop, to_stop): SegmentShape}}``; malformed input raises ``ValueError``."""
    out: RouteShapes = {}
    for tr_id, entry in raw.items():
        pairs: dict[tuple[str, str], SegmentShape] = {}
        for seg in entry["segments"]:
            coords = tuple((float(lon), float(lat)) for lon, lat in seg["coords"])
            if len(coords) < 2 or seg["source"] not in SOURCES:
                raise ValueError(f"bad segment {tr_id}:{seg.get('from_stop')}")
            shape = SegmentShape(str(seg["from_stop"]), str(seg["to_stop"]), coords,
                                 str(seg["source"]), int(seg["n"]))
            pairs[(shape.from_stop, shape.to_stop)] = shape
        out[str(tr_id)] = pairs
    return out


def load_route_shapes(path: Path = DEFAULT_PATH) -> RouteShapes:
    """Shapes from disk; an absent file means no shapes (callers draw straight lines)."""
    if not path.exists():
        return {}
    return parse_route_shapes(json.loads(path.read_text()))


def line_through(shapes: Mapping[tuple[str, str], SegmentShape],
                 stops: Iterable[tuple[str, float, float]]) -> list[Point]:
    """Polyline through ``(stop_id, lon, lat)`` stops in order, using a shape per
    consecutive pair when one exists and the straight segment otherwise.

    Every stop coordinate appears in the result exactly as given (anchors).
    """
    line: list[Point] = []
    previous: tuple[str, float, float] | None = None
    for stop in stops:
        stop_id, lon, lat = str(stop[0]), float(stop[1]), float(stop[2])
        if previous is None:
            line.append((lon, lat))
        else:
            shape = shapes.get((previous[0], stop_id))
            if shape is not None:
                line.extend(shape.coords[1:-1])
            line.append((lon, lat))
        previous = (stop_id, lon, lat)
    return line
