import json
from pathlib import Path
import subprocess
import sys

import pytest

from transport_backend.route_shapes import (DEFAULT_PATH, SegmentShape, line_through,
                                            load_route_shapes, parse_route_shapes, shape_sha)

ROOT = Path(__file__).resolve().parents[1]
PLAN = ROOT / "data" / "validate" / "schedule_plan.csv"
TRAFFIC = ROOT / "data" / "train" / "traffic.csv"


def _raw():
    segments = [{"from_stop": "a", "to_stop": "b", "coords": [[37.0, 55.0], [37.001, 55.0005], [37.002, 55.0]],
                 "source": "gps", "n": 3},
                {"from_stop": "b", "to_stop": "c", "coords": [[37.002, 55.0], [37.003, 55.001]],
                 "source": "straight", "n": 0}]
    return {"1": {"segments": segments, "built_from": ["2026-01-06"], "sha": shape_sha(segments)}}


def test_parse_keys_segments_by_stop_pair():
    shapes = parse_route_shapes(_raw())
    seg = shapes["1"][("a", "b")]
    assert seg == SegmentShape("a", "b", ((37.0, 55.0), (37.001, 55.0005), (37.002, 55.0)), "gps", 3)
    assert shapes["1"][("b", "c")].source == "straight"


def test_parse_rejects_unknown_source_and_short_coords():
    raw = _raw()
    raw["1"]["segments"][0]["source"] = "osrm"
    with pytest.raises(ValueError):
        parse_route_shapes(raw)
    raw = _raw()
    raw["1"]["segments"][1]["coords"] = [[37.0, 55.0]]
    with pytest.raises(ValueError):
        parse_route_shapes(raw)


def test_line_through_keeps_stop_anchors_and_falls_back_to_straight():
    shapes = parse_route_shapes(_raw())["1"]
    stops = [("a", 37.0, 55.0), ("b", 37.002, 55.0), ("c", 37.003, 55.001), ("x", 37.01, 55.01)]
    line = line_through(shapes, stops)
    assert line == [(37.0, 55.0), (37.001, 55.0005), (37.002, 55.0), (37.003, 55.001), (37.01, 55.01)]
    assert line_through({}, stops) == [(lon, lat) for _, lon, lat in stops]


def test_missing_file_means_no_shapes(tmp_path):
    assert load_route_shapes(tmp_path / "absent.json") == {}


def test_committed_file_is_small_consistent_and_hashed():
    assert DEFAULT_PATH.exists()
    assert DEFAULT_PATH.stat().st_size < 2_000_000
    raw = json.loads(DEFAULT_PATH.read_text())
    shapes = parse_route_shapes(raw)
    assert shapes
    for tr_id, entry in raw.items():
        assert entry["sha"] == shape_sha(entry["segments"])
        assert entry["built_from"]
        segs = entry["segments"]
        for prev, nxt in zip(segs, segs[1:]):
            assert prev["to_stop"] == nxt["from_stop"]
            assert prev["coords"][-1] == nxt["coords"][0]
        for seg in segs:
            assert (seg["n"] > 0) == (seg["source"] == "gps")


@pytest.mark.skipif(not PLAN.exists(), reason="official plan is not in the repository")
def test_anchors_equal_planned_stop_coordinates():
    from transport_ml.data import read_plan
    plan = read_plan(PLAN).dropna(subset=["stop_lon", "stop_lat"])
    shapes = load_route_shapes()
    assert set(shapes) == set(plan["tr_id"])
    for tr_id, stops in plan.groupby("tr_id"):
        rows = list(stops.itertuples(index=False))
        segs = shapes[tr_id]
        assert len(segs) == len(rows) - 1
        for a, b in zip(rows, rows[1:]):
            seg = segs[(a.tt_action_item_id, b.tt_action_item_id)]
            assert seg.coords[0] == (a.stop_lon, a.stop_lat)
            assert seg.coords[-1] == (b.stop_lon, b.stop_lat)


@pytest.mark.skipif(not (PLAN.exists() and TRAFFIC.exists()), reason="official data is not in the repository")
def test_rebuild_is_deterministic(tmp_path):
    out = tmp_path / "shapes.json"
    subprocess.run([sys.executable, str(ROOT / "scripts" / "build_route_shapes.py"), "--out", str(out)],
                   check=True, capture_output=True, cwd=ROOT)
    rebuilt, committed = json.loads(out.read_text()), json.loads(DEFAULT_PATH.read_text())
    assert {k: v["sha"] for k, v in rebuilt.items()} == {k: v["sha"] for k, v in committed.items()}
    assert out.read_bytes() == DEFAULT_PATH.read_bytes()
