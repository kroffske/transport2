"""Configure the official local emulator with a known scheduled Moscow stop.

Run only with SOURCE_CLOCK=simulation. POST replaces all emulator units; the
emulator assigns Nav00 UTC timestamps. Coordinates are static stop observations,
not a claimed route shape or an observed real-world vehicle.
"""

import json
from urllib.request import Request, urlopen

BACKEND = "http://localhost:8001"
EMULATOR = "http://localhost:18080"


def get(url):
    with urlopen(url, timeout=10) as response:
        return json.load(response)


def main():
    ready = get(BACKEND + "/ready")
    if ready["source_clock"] != "simulation":
        raise SystemExit("backend must run with SOURCE_CLOCK=simulation")
    config = {
        "targetHost": "backend", "targetPort": 9201,
        "units": [{"unitId": 894032, "intervalMs": 2000, "autoGenerate": False,
                   "cells": [{"type": "G6CellNav00", "fields": {
                       "longitude": 376939676, "latitude": 556847482,
                       "extraDopBit5": True, "extraDopBit6": True,
                       "extraDopBit7": True, "speedAvg": 0, "speedMax": 0,
                       "nsat": 8}}]}],
    }
    request = Request(EMULATOR + "/api/config", data=json.dumps(config).encode(),
                      headers={"Content-Type": "application/json"}, method="POST")
    with urlopen(request, timeout=10) as response:
        actual = json.load(response)
    fields = actual["units"][0]["cells"][0]["fields"]
    if fields.get("longitude") != 376939676 or fields.get("latitude") != 556847482:
        raise RuntimeError("emulator did not retain stop coordinates")
    print(json.dumps({"backend": ready, "emulator": get(EMULATOR + "/api/config")},
                     ensure_ascii=False))


if __name__ == "__main__":
    main()
