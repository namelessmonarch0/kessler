"""Fetch live LEO/HIGH snapshots, pick five sentinel objects, and write the frozen
golden fixture used by the web accuracy tests. Run once by hand; commit the output.
"""
import importlib.metadata
import json
import sys
import urllib.request
from datetime import UTC, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from kessler_accuracy.reference import position
from kessler_accuracy.snapshot import unpack_snapshot

BASE = "https://kessler.kudayyurter.dev/api/globe"
WEB_ROOT = Path(__file__).resolve().parents[2] / "web"
OUT = WEB_ROOT / "tests" / "fixtures" / "accuracy" / "golden.json"


def _fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "kessler-accuracy/0.1"})
    with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310
        return resp.read()


def _fetch_json(url: str) -> dict:
    return json.loads(_fetch(url))


def _snapshot(group: str) -> tuple[dict, list[dict]]:
    return unpack_snapshot(_fetch(f"{BASE}/snapshot?group={group}"))


def _names(group: str) -> dict[str, str]:
    return _fetch_json(f"{BASE}/names?group={group}")["names"]


def pick_sentinels() -> list[tuple[str, dict]]:
    _, leo_records = _snapshot("LEO")
    _, high_records = _snapshot("HIGH")
    leo_names = _names("LEO")
    high_names = _names("HIGH")

    by_id = {r["noradId"]: r for r in leo_records}
    iss = by_id[25544]

    def first(records: list[dict], names: dict[str, str], predicate) -> dict:
        for r in records:
            name = names.get(str(r["noradId"]), "")
            if predicate(r, name):
                return r
        raise LookupError("no matching sentinel found")

    fengyun = first(
        leo_records, leo_names, lambda r, n: r["type"] == "DEB" and "FENGYUN 1C DEB" in n
    )
    starlink = first(
        leo_records, leo_names, lambda r, n: r["type"] == "PAY" and n.startswith("STARLINK")
    )
    rocket_body = first(leo_records, leo_names, lambda r, n: r["type"] == "R/B")
    geo = first(
        high_records,
        high_names,
        lambda r, n: r["type"] == "PAY"
        and abs(r["meanMotion"] - 1.0027) < 0.01
        and r["eccentricity"] < 0.01,
    )

    return [
        ("ISS", iss),
        ("FENGYUN-1C DEB", fengyun),
        ("STARLINK", starlink),
        ("ROCKET BODY", rocket_body),
        ("GEO", geo),
    ]


def sample_times(epoch_ms: int) -> list[int]:
    epoch = datetime.fromtimestamp(epoch_ms / 1000, tz=UTC)
    fixed = [
        datetime(2026, 1, 15, 12, 0, 0, tzinfo=UTC),
        datetime(2026, 6, 15, 12, 0, 0, tzinfo=UTC),
        datetime(2026, 9, 24, 12, 0, 0, tzinfo=UTC),
    ]
    times = [
        epoch,
        epoch + timedelta(minutes=90),
        epoch + timedelta(days=1),
        epoch + timedelta(days=3),
    ]
    times.extend(fixed)
    return [int(t.timestamp() * 1000) for t in times]


def main() -> None:
    sentinels = pick_sentinels()
    versions = {
        "skyfield": importlib.metadata.version("skyfield"),
        "sgp4": importlib.metadata.version("sgp4"),
    }
    objects = []
    for label, record in sentinels:
        samples = []
        for time_ms in sample_times(record["epochMs"]):
            p = position(record, time_ms)
            samples.append(
                {
                    "timeMs": time_ms,
                    "ecefKm": p["ecefKm"],
                    "latDeg": p["latDeg"],
                    "lonDeg": p["lonDeg"],
                    "altKm": p["altKm"],
                }
            )
        objects.append({"label": label, "record": record, "samples": samples})

    golden = {
        "generatedBy": f"skyfield {versions['skyfield']}, sgp4 {versions['sgp4']}",
        "generatedAt": datetime.now(tz=UTC).isoformat(),
        "objects": objects,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(golden, indent=2) + "\n")
    print(f"wrote {OUT} ({len(objects)} objects x {len(objects[0]['samples'])} samples)")


if __name__ == "__main__":
    main()
