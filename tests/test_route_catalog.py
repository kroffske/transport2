"""Route identity derived from the plan: the data has no route ID, only assignments."""

from __future__ import annotations

from pathlib import Path

from transport_backend.route_catalog import catalog_view, read_addresses, route_catalog, street
from transport_ml.data import read_plan


def _plan(path: Path, rows: list[tuple[str, str, str, str, str]]) -> Path:
    lines = ["tt_action_item_id,tr_id,time_begin,geom,building_address"]
    lines += [f'{stop},{tr},2026-01-06 {time},"POINT ({point})","{address}"' for stop, tr, time, point, address in rows]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def test_assignments_with_one_stop_set_share_a_route_labelled_by_its_ends(tmp_path):
    path = _plan(tmp_path / "plan.csv", [
        ("a1", "A", "06:00:00", "37.50 55.70", "Каширское ш., д.40, к.2"),
        ("a2", "A", "06:05:00", "37.52 55.70", ""),
        ("a3", "A", "06:10:00", "37.56 55.70", "Борисовский пр., д.5"),
        # B serves the same stops in the opposite direction: the same route.
        ("b1", "B", "06:00:00", "37.56 55.70", "Борисовский пр., д.5"),
        ("b2", "B", "06:05:00", "37.52 55.70", ""),
        ("b3", "B", "06:10:00", "37.50 55.70", "Каширское ш., д.40, к.2"),
        # C has one more stop: another route; its far end has no address nearby.
        ("c1", "C", "06:00:00", "37.50 55.70", "Каширское ш., д.40, к.2"),
        ("c2", "C", "06:10:00", "37.90 55.90", ""),
    ])
    routes = route_catalog(read_plan(path), read_addresses(path))
    assert routes["A"] == routes["B"] and routes["A"].key.startswith("R-") and len(routes["A"].key) == 8
    assert routes["C"].key != routes["A"].key
    assert routes["A"].label == "Каширское ш. — Борисовский пр."
    assert routes["C"].label == "Каширское ш."
    assert catalog_view(routes) == [
        {"route_key": routes["C"].key, "route_label": "Каширское ш.", "tr_ids": ["C"]},
        {"route_key": routes["A"].key, "route_label": "Каширское ш. — Борисовский пр.", "tr_ids": ["A", "B"]},
    ]


def test_plan_without_addresses_still_gets_keys():
    plan = read_plan(Path(__file__).resolve().parents[1] / "data" / "validate" / "schedule_plan.csv")
    routes = route_catalog(plan)
    assert set(routes) == set(plan["tr_id"]) and all(info.label == "—" for info in routes.values())


def test_street_drops_the_house_part():
    assert street("ул. Мичуринский Проспект, Олимпийская Деревня, д.3, к.1") == "ул. Мичуринский Проспект, Олимпийская Деревня"
    assert street("Старый Петровско-Разумовский пр.") == "Старый Петровско-Разумовский пр."
