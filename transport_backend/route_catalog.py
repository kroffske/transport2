"""Route identity derived from the plan.

The data has no route ID: only assignments (``tr_id``) with their planned stops.
Assignments that serve exactly the same set of stop points are one route. The key
is stable for a plan (a hash of the sorted stop ``geom`` strings), the label names
the two stops farthest apart (the route's ends) by street.
"""

from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha1
from pathlib import Path
import math
import re

import numpy as np
import pandas as pd

from .schedule import M_PER_DEG_LAT, M_PER_DEG_LON_EQUATOR

ADDRESS_RADIUS_M = 300.0  # a stop without an address borrows the nearest one within this distance
_HOUSE = re.compile(r",\s*(д\.|вл\.|стр\.|к\.).*$")


@dataclass(frozen=True)
class RouteInfo:
    key: str
    label: str


def read_addresses(path: Path) -> dict[str, str]:
    """``tt_action_item_id -> building_address`` of the plan file; empty without the column."""
    frame = pd.read_csv(path, usecols=lambda c: c in {"tt_action_item_id", "building_address"},
                        dtype={"tt_action_item_id": str})
    if "building_address" not in frame:
        return {}
    frame = frame.dropna(subset=["building_address"])
    return dict(zip(frame["tt_action_item_id"], frame["building_address"].astype(str)))


def street(address: str) -> str:
    """The address without the house part: «Каширское ш., д.40, к.2» -> «Каширское ш.»."""
    return _HOUSE.sub("", address).strip()


def route_catalog(plan: pd.DataFrame, addresses: dict[str, str] | None = None) -> dict[str, RouteInfo]:
    """``tr_id -> RouteInfo`` for every assignment of a prepared plan (``transport_ml.data.prepare_plan``)."""
    addresses = addresses or {}
    routes: dict[str, RouteInfo] = {}
    labels: dict[str, str] = {}
    for tr_id, group in plan.groupby("tr_id", sort=False):
        geoms = sorted({str(g) for g in group["geom"].dropna()})
        key = "R-" + sha1("\n".join(geoms).encode()).hexdigest()[:6]
        if key not in labels:
            labels[key] = _label(group, addresses)
        routes[str(tr_id)] = RouteInfo(key, labels[key])
    return routes


def _label(group: pd.DataFrame, addresses: dict[str, str]) -> str:
    stops = group.drop_duplicates("geom")
    stops = stops[stops["stop_lon"].notna() & stops["stop_lat"].notna()]
    if len(stops) < 2:
        return "—"
    cos_lat = math.cos(math.radians(float(stops["stop_lat"].mean())))
    xy = stops[["stop_lon", "stop_lat"]].to_numpy() * [M_PER_DEG_LON_EQUATOR * cos_lat, M_PER_DEG_LAT]
    distance = np.sqrt(((xy[:, None, :] - xy[None, :, :]) ** 2).sum(axis=2))
    first, second = np.unravel_index(int(distance.argmax()), distance.shape)
    named = np.array([bool(addresses.get(str(stop))) for stop in stops["tt_action_item_id"]])
    ids = stops["tt_action_item_id"].astype(str).to_numpy()

    def name(index: int) -> str | None:
        if not named.any():
            return None
        near = np.where(named, distance[index], np.inf)
        best = int(near.argmin())
        return street(addresses[ids[best]]) if near[best] <= ADDRESS_RADIUS_M else None

    ends = list(dict.fromkeys(end for end in (name(int(first)), name(int(second))) if end))
    return " — ".join(ends) or "—"


def catalog_view(routes: dict[str, RouteInfo]) -> list[dict]:
    """All routes of the plan with their assignments, sorted by label: the dispatcher's choice list."""
    grouped: dict[str, dict] = {}
    for tr_id, info in routes.items():
        grouped.setdefault(info.key, {"route_key": info.key, "route_label": info.label, "tr_ids": []})["tr_ids"].append(tr_id)
    return sorted(grouped.values(), key=lambda route: (route["route_label"], route["route_key"]))
