# Position Accuracy Tests and Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove every object is drawn at its real position over the right place on Earth. Deterministic CI tests cover each pipeline step, a daily capture measures live accuracy against independent references, and a weekly review checks tolerances and opens a GitHub issue when something drifts.

**Architecture:**
- **Reference data.** A separate Python uv project in `tools/accuracy/` uses `skyfield` (an independent SGP4 and Earth-rotation implementation) to generate committed reference fixtures and to act as a stdin/stdout propagation helper.
- **Web side.** Web code gains a small tested geodesy module. Vitest tests compare the site's own pipeline (snapshot decode → satellite.js SGP4 → GMST rotation → scene mapping → globe texture) against the fixtures.
- **Audit.** Node scripts, run with `tsx`, do the live audit and the weekly evaluation. Their logic lives in pure, unit-tested modules.
- **Scheduling.** Two scheduled GitHub Actions workflows store daily results on an orphan `audit-log` branch and raise issues.

**Tech Stack:** TypeScript (Vitest, tsx, satellite.js 7, three 0.186, topojson-client); Python 3.12 with uv (skyfield ≥ 1.49, sgp4 ≥ 2.23, pytest); GitHub Actions and the `gh` CLI.

**Spec:** `docs/superpowers/specs/2026-09-24-position-accuracy-design.md`

## Global Constraints

- **Site-wide conventions:**
  - Scene frame: `scene = (x_ecef, z_ecef, −y_ecef) / 6371` (km → Earth radii). The Earth mesh is `THREE.SphereGeometry(1, 128, 96)`, not rotated. The texture is an equirectangular `CanvasTexture` with `flipY` true, so canvas row 0 (north) is at v = 1.
  - The site's pipeline is `recordToSatrec` → `propagate` → `gstime` → `eciToEcf` → `ecefToScene` (`web/src/lib/orbit.ts`). Tests must call these real functions, never copies.
- **Geodesy:**
  - WGS84 is `a = 6378.137 km`, `f = 1/298.257223563`.
  - Ground distances use a great circle on a 6371 km sphere.
- **Tolerances (a controller clarification of spec §3.2/§5, recorded in the ledger):** "math error" is measured as the **ground distance between the two subpoints** plus the **altitude difference**, not raw 3D km. At GEO radius, UT1−UTC alone rotates positions ~3 km in 3D, which is invisible on the globe.
  - **CI tests:**
    - Ground distance ≤ **1 km**, |Δalt| ≤ **1 km** and |Δlat|, |Δlon| ≤ **0.01°** for every sentinel.
    - 3D Earth-fixed distance ≤ **1 km** for LEO sentinels only.
    - SGP4 TEME ≤ **0.001 km**.
    - Globe UV vs latitude/longitude ≤ **0.2°** (triangle interpolation on a 128×96 sphere).
    - Land/ocean classes exact.
  - **Weekly review:**
    - Math-error ground distance, weekly max ≤ **1 km**.
    - ISS ground distance vs wheretheiss.at, weekly max ≤ **25 km**.
    - ISS |Δalt|, weekly max ≤ **10 km**.
    - Mean share of sampled objects with element age > **3 days** ≤ **5%**.
    - Daily captures present ≥ **4 of 7**.
- **The Python tooling lives only in `tools/accuracy/`** (its own `pyproject.toml` and `uv.lock`). Nothing is added to `api/` runtime dependencies.
- **Live endpoints:** `https://kessler.kudayyurter.dev/api/globe/snapshot?group=LEO|HIGH`, `.../api/globe/names?group=LEO|HIGH` (public, no secret), and `https://api.wheretheiss.at/v1/satellites/25544`.
- **CI tests never touch the network.** Only the audit script and workflows do.
- **Commits:** subject, blank line, then trailers, using two `-m` flags. Never push.
- **Checks before each commit, per area touched:**
  - `web/`: `npm run lint`, `npm run typecheck`, `npm test`.
  - `api/`: `uv run ruff check .`, `uv run pytest -q`.
  - `tools/accuracy/`: `uv run ruff check .`, `uv run pytest -q`.

## Review Focus

1. **The antimeridian and poles.** A subpoint near ±180° longitude or near the poles must not produce a 360° "error" or a NaN. *(Tests: Task 1 `greatCircleKm wraps across the antimeridian` and `ecefToGeodetic is finite at the poles`.)*
2. **wheretheiss.at is down or rate-limited.** The daily audit still records the math and age results, with `iss: null`, and exits 0. *(Test: Task 6 `buildDailyResult with no ISS reference sets iss null`.)*
3. **A day's file is missing or malformed on `audit-log`.** The weekly review counts it as missing rather than crashing. *(Test: Task 7 `evaluateWeek treats unparsable days as missing`.)*
4. **An issue is already open.** The weekly job comments on it instead of opening a duplicate. *(Test: Task 7 `planIssueAction comments when an accuracy issue is open`.)*
5. **An object fails to propagate** (decayed or bad elements). It is excluded from the math error and counted separately, never treated as an error of 0 or infinity. *(Test: Task 6 `measure skips objects that fail to propagate`.)*

---

## File Structure

```
tools/accuracy/                     NEW uv project (Python 3.12)
  pyproject.toml, uv.lock
  kessler_accuracy/__init__.py
  kessler_accuracy/snapshot.py      decode LEO1 (for picking sentinels from the live site)
  kessler_accuracy/reference.py     skyfield: omm_record -> ITRS km + geodetic
  make_golden.py                    writes web/tests/fixtures/accuracy/golden.json
  make_sgp4_vectors.py              writes web/tests/fixtures/accuracy/sgp4-vectors.json
  propagate.py                      stdin JSON -> stdout JSON (used by the live audit)
  tests/test_reference.py, tests/test_propagate_cli.py
web/src/lib/geo.ts                  NEW ecefToGeodetic, geodeticToEcef, sceneToEcef, greatCircleKm
web/src/lib/landMask.ts             NEW isLand(lon, lat, landFeatures) (even-odd point in polygon)
web/tests/unit/geo.test.ts, accuracy.test.ts, globeAlignment.test.ts   NEW
web/tests/fixtures/accuracy/{golden.json, sgp4-vectors.json, api-snapshot.bin.gz, api-snapshot.elements.json}  NEW
web/scripts/accuracy/tolerances.ts  NEW  single source of the weekly thresholds
web/scripts/accuracy/audit.ts       NEW  pure: sampleObjects, measure, buildDailyResult
web/scripts/accuracy/weekly.ts      NEW  pure: evaluateWeek, renderMarkdown, planIssueAction
web/scripts/audit-positions.ts      NEW  CLI (network + python helper)
web/scripts/audit-weekly.ts         NEW  CLI (reads a dir of daily JSON)
web/tests/unit/auditCore.test.ts, auditWeekly.test.ts   NEW
api/tests/test_snapshot_roundtrip.py   NEW
api/scripts/make_accuracy_snapshot.py  NEW  writes the web T2 fixture using app.ingest.snapshot.pack_snapshot
.github/workflows/accuracy-daily.yml, accuracy-weekly.yml   NEW
web/package.json                    MOD  + tsx devDependency, scripts audit:positions, audit:weekly
web/vitest.config.ts                MOD  include scripts/**/*.ts sources via alias only (tests stay in tests/unit)
README.md, web/README.md            MOD  "Accuracy" section
```

---

### Task 1: Geodesy helpers

**Files:**
- Create: `web/src/lib/geo.ts`, `web/tests/unit/geo.test.ts`

**Interfaces:**
- Produces:
  - `ecefToGeodetic(xKm, yKm, zKm): { latDeg: number; lonDeg: number; altKm: number }` (WGS84)
  - `geodeticToEcef(latDeg, lonDeg, altKm): [number, number, number]`
  - `sceneToEcef(sx, sy, sz): [number, number, number]` (inverse of `ecefToScene`, R = 6371)
  - `greatCircleKm(lat1, lon1, lat2, lon2): number` (sphere R = 6371)
  - `WGS84 = { a: 6378.137, f: 1 / 298.257223563 }`

- [ ] **Step 1: Write the failing tests** — `web/tests/unit/geo.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { EARTH_RADIUS_KM, ecefToScene } from "@/lib/orbit";
import { ecefToGeodetic, geodeticToEcef, greatCircleKm, sceneToEcef, WGS84 } from "@/lib/geo";

describe("geodesy", () => {
  it("puts the equator/prime-meridian surface point at (a, 0, 0)", () => {
    const g = ecefToGeodetic(WGS84.a, 0, 0);
    expect(g.latDeg).toBeCloseTo(0, 9);
    expect(g.lonDeg).toBeCloseTo(0, 9);
    expect(g.altKm).toBeCloseTo(0, 6);
  });

  it("round-trips geodetic -> ECEF -> geodetic at many points, including 400 km and GEO altitude", () => {
    for (const [lat, lon, alt] of [[30.04, 31.24, 0], [-33.87, 151.21, 420], [51.5, -0.13, 35786], [-89.9, 10, 800], [89.9, -170, 550], [0, 179.99, 400]]) {
      const [x, y, z] = geodeticToEcef(lat, lon, alt);
      const g = ecefToGeodetic(x, y, z);
      expect(g.latDeg).toBeCloseTo(lat, 7);
      expect(g.lonDeg).toBeCloseTo(lon, 7);
      expect(g.altKm).toBeCloseTo(alt, 5);
    }
  });

  it("ecefToGeodetic is finite at the poles", () => {
    const b = WGS84.a * (1 - WGS84.f);
    const n = ecefToGeodetic(0, 0, b + 400);
    expect(n.latDeg).toBeCloseTo(90, 9);
    expect(n.altKm).toBeCloseTo(400, 6);
    expect(Number.isFinite(n.lonDeg)).toBe(true);
    const s = ecefToGeodetic(0, 0, -b);
    expect(s.latDeg).toBeCloseTo(-90, 9);
    expect(s.altKm).toBeCloseTo(0, 6);
  });

  it("sceneToEcef inverts ecefToScene", () => {
    const out = new Float32Array(3);
    ecefToScene(1234.5, -4321.25, 5000, out, 0);
    const [x, y, z] = sceneToEcef(out[0], out[1], out[2]);
    expect(x).toBeCloseTo(1234.5, 2);
    expect(y).toBeCloseTo(-4321.25, 2);
    expect(z).toBeCloseTo(5000, 2);
    expect(EARTH_RADIUS_KM).toBe(6371);
  });

  it("greatCircleKm: a quarter meridian and a known city pair", () => {
    expect(greatCircleKm(0, 0, 90, 0)).toBeCloseTo((Math.PI / 2) * 6371, 6);
    expect(greatCircleKm(51.5074, -0.1278, 40.7128, -74.006)).toBeGreaterThan(5560);
    expect(greatCircleKm(51.5074, -0.1278, 40.7128, -74.006)).toBeLessThan(5580);
  });

  it("greatCircleKm wraps across the antimeridian", () => {
    expect(greatCircleKm(0, 179.9, 0, -179.9)).toBeCloseTo(0.2 * (Math.PI / 180) * 6371, 6);
  });
});
```

Run: `cd web && npx vitest run tests/unit/geo.test.ts`. It fails with "Cannot find module '@/lib/geo'".

- [ ] **Step 2: Implement** — `web/src/lib/geo.ts`

```ts
import { EARTH_RADIUS_KM } from "@/lib/orbit";

export const WGS84 = { a: 6378.137, f: 1 / 298.257223563 } as const;
const E2 = WGS84.f * (2 - WGS84.f);
const RAD = Math.PI / 180;

export function geodeticToEcef(latDeg: number, lonDeg: number, altKm: number): [number, number, number] {
  const lat = latDeg * RAD, lon = lonDeg * RAD;
  const s = Math.sin(lat), c = Math.cos(lat);
  const n = WGS84.a / Math.sqrt(1 - E2 * s * s);
  return [(n + altKm) * c * Math.cos(lon), (n + altKm) * c * Math.sin(lon), (n * (1 - E2) + altKm) * s];
}

/** ECEF km -> WGS84 geodetic (Bowring-style iteration, stable at the poles). */
export function ecefToGeodetic(x: number, y: number, z: number): { latDeg: number; lonDeg: number; altKm: number } {
  const lon = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - E2));
  let h = 0;
  for (let i = 0; i < 10; i++) {
    const s = Math.sin(lat), c = Math.cos(lat);
    const n = WGS84.a / Math.sqrt(1 - E2 * s * s);
    h = Math.abs(c) > 1e-9 ? p / c - n : Math.abs(z) - n * (1 - E2);
    lat = Math.atan2(z, p * (1 - (E2 * n) / (n + h)));
  }
  if (Math.abs(Math.cos(lat)) < 1e-6) {
    const n = WGS84.a / Math.sqrt(1 - E2);
    h = Math.abs(z) - n * (1 - E2);
  }
  return { latDeg: lat / RAD, lonDeg: lon / RAD, altKm: h };
}

/** Inverse of ecefToScene: scene (Earth radii, (x, z, -y)) -> ECEF km. */
export function sceneToEcef(sx: number, sy: number, sz: number): [number, number, number] {
  return [sx * EARTH_RADIUS_KM, -sz * EARTH_RADIUS_KM, sy * EARTH_RADIUS_KM];
}

export function greatCircleKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = lat1 * RAD, p2 = lat2 * RAD, dp = p2 - p1, dl = (lon2 - lon1) * RAD;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}
```

- [ ] **Step 3: Verify.** Run `cd web && npx vitest run tests/unit/geo.test.ts`, then `npm test`, `npm run lint`, `npm run typecheck`. All pass.

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/geo.ts web/tests/unit/geo.test.ts
git commit -m "feat(web): WGS84 geodesy helpers for position accuracy checks" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 2: Independent reference tooling (skyfield) and committed fixtures

**Files:**
- Create:
  - `tools/accuracy/pyproject.toml`, `tools/accuracy/uv.lock`
  - `tools/accuracy/kessler_accuracy/{__init__,snapshot,reference}.py`
  - `tools/accuracy/{make_golden,make_sgp4_vectors,propagate}.py`
  - `tools/accuracy/tests/{__init__,test_reference,test_propagate_cli}.py`
  - `web/tests/fixtures/accuracy/golden.json`, `web/tests/fixtures/accuracy/sgp4-vectors.json`

**Interfaces:**
- Produces:
  - **Record format.** An "OMM record" is the same shape as web `OrbitRecord`: `{noradId, owner, type, epochMs, meanMotion, eccentricity, inclination, raan, argPericenter, meanAnomaly, bstar, meanMotionDot, meanMotionDdot}`.
  - `reference.position(record: dict, time_ms: int) -> {"ecefKm": [x, y, z], "latDeg", "lonDeg", "altKm"}`. The position is ITRS via skyfield; the geodetic values are `wgs84.geographic_position_of`. Skyfield's built-in timescale is used (bundled UT1 data).
  - **`propagate.py` CLI.**
    - Stdin: `{"items": [{"record": {...}, "timeMs": int}, ...]}`.
    - Stdout: `{"results": [{"ok": true, "ecefKm": [...], "latDeg", "lonDeg", "altKm"} | {"ok": false, "error": str}, ...]}`, in the same order as the input.
  - **`golden.json`:** `{"generatedBy": "skyfield <ver>, sgp4 <ver>", "generatedAt": iso, "objects": [{"label": "ISS"|"FENGYUN-1C DEB"|"STARLINK"|"ROCKET BODY"|"GEO", "record": {...}, "samples": [{"timeMs", "ecefKm", "latDeg", "lonDeg", "altKm"}]}]}`
  - **`sgp4-vectors.json`:** `{"generatedBy", "cases": [{"satnum": str, "line1": str, "line2": str, "samples": [{"tsinceMin": number, "temeKm": [x, y, z]}]}]}`

- [ ] **Step 1: Scaffold the uv project**

```bash
mkdir -p tools/accuracy/kessler_accuracy tools/accuracy/tests && cd tools/accuracy
uv init -q --no-workspace --python 3.12 --bare .
uv add "skyfield>=1.49" "sgp4>=2.23" "numpy>=2"
uv add --dev "pytest>=8.3" "ruff>=0.6"
touch kessler_accuracy/__init__.py tests/__init__.py
```

Append the same `[tool.uv] package = false`, `[tool.pytest.ini_options] testpaths=["tests"] pythonpath=["."]` and `[tool.ruff]` sections that `infra/pyproject.toml` uses (line-length 100, target py312, select `E,F,I,B,UP`).

- [ ] **Step 2: Write the failing tests**

`tools/accuracy/tests/test_reference.py`:

```python
from kessler_accuracy.reference import position

ISS = {
    "noradId": 25544, "owner": "ISS", "type": "PAY", "epochMs": 1790058637496,
    "meanMotion": 15.49224498, "eccentricity": 0.00047657, "inclination": 51.6312,
    "raan": 179.6046, "argPericenter": 167.6102, "meanAnomaly": 192.5004,
    "bstar": 0.0001364276, "meanMotionDot": 0.00007132, "meanMotionDdot": 0.0,
}


def test_iss_position_is_physical():
    p = position(ISS, ISS["epochMs"])
    assert 410 < p["altKm"] < 440
    assert -51.7 <= p["latDeg"] <= 51.7
    assert -180 <= p["lonDeg"] <= 180
    r = sum(c * c for c in p["ecefKm"]) ** 0.5
    assert 6700 < r < 6850
```

`tools/accuracy/tests/test_propagate_cli.py`:

```python
import json
import subprocess
import sys
from pathlib import Path

from tests.test_reference import ISS

CLI = Path(__file__).resolve().parents[1] / "propagate.py"


def run(payload: dict) -> dict:
    out = subprocess.run([sys.executable, str(CLI)], input=json.dumps(payload), capture_output=True,
                         text=True, check=True)
    return json.loads(out.stdout)


def test_cli_preserves_order_and_reports_failures():
    broken = {**ISS, "noradId": 1, "eccentricity": 1.5}
    res = run({"items": [{"record": ISS, "timeMs": ISS["epochMs"]},
                         {"record": broken, "timeMs": ISS["epochMs"]}]})["results"]
    assert res[0]["ok"] is True and 410 < res[0]["altKm"] < 440
    assert res[1]["ok"] is False and res[1]["error"]
```

Run: `cd tools/accuracy && uv run pytest -q`. It fails with a ModuleNotFoundError or a missing file.

- [ ] **Step 3: Implement the reference module and CLI**

`tools/accuracy/kessler_accuracy/reference.py`:

```python
from datetime import UTC, datetime

from skyfield.api import EarthSatellite, load, wgs84
from skyfield.framelib import itrs

_TS = load.timescale(builtin=True)


def _omm(record: dict) -> dict:
    epoch = datetime.fromtimestamp(record["epochMs"] / 1000, tz=UTC)
    return {
        "OBJECT_NAME": str(record["noradId"]), "OBJECT_ID": str(record["noradId"]),
        "EPOCH": epoch.strftime("%Y-%m-%dT%H:%M:%S.%f"),
        "MEAN_MOTION": record["meanMotion"], "ECCENTRICITY": record["eccentricity"],
        "INCLINATION": record["inclination"], "RA_OF_ASC_NODE": record["raan"],
        "ARG_OF_PERICENTER": record["argPericenter"], "MEAN_ANOMALY": record["meanAnomaly"],
        "EPHEMERIS_TYPE": 0, "CLASSIFICATION_TYPE": "U", "NORAD_CAT_ID": record["noradId"],
        "ELEMENT_SET_NO": 999, "REV_AT_EPOCH": 0, "BSTAR": record["bstar"],
        "MEAN_MOTION_DOT": record["meanMotionDot"], "MEAN_MOTION_DDOT": record["meanMotionDdot"],
    }


def satellite(record: dict) -> EarthSatellite:
    return EarthSatellite.from_omm(_TS, _omm(record))


def position(record: dict, time_ms: int) -> dict:
    sat = satellite(record)
    t = _TS.from_datetime(datetime.fromtimestamp(time_ms / 1000, tz=UTC))
    geo = sat.at(t)
    if sat.model.error:
        raise ValueError(f"sgp4 error {sat.model.error}")
    ecef = geo.frame_xyz(itrs).km
    gp = wgs84.geographic_position_of(geo)
    return {"ecefKm": [float(v) for v in ecef], "latDeg": gp.latitude.degrees,
            "lonDeg": gp.longitude.degrees, "altKm": gp.elevation.km}
```

`tools/accuracy/propagate.py`:

```python
"""stdin: {"items":[{"record":{...},"timeMs":int}]} -> stdout: {"results":[...]} (same order)."""
import json
import math
import sys

from kessler_accuracy.reference import position


def main() -> None:
    items = json.load(sys.stdin)["items"]
    results = []
    for it in items:
        try:
            p = position(it["record"], int(it["timeMs"]))
            if not all(math.isfinite(v) for v in [*p["ecefKm"], p["latDeg"], p["lonDeg"], p["altKm"]]):
                raise ValueError("non-finite position")
            results.append({"ok": True, **p})
        except Exception as exc:  # one bad record must not sink the batch
            results.append({"ok": False, "error": str(exc) or type(exc).__name__})
    json.dump({"results": results}, sys.stdout)


if __name__ == "__main__":
    main()
```

For the CLI test to import `kessler_accuracy`, make `propagate.py` add its own directory to `sys.path` before importing, using `sys.path.insert(0, str(Path(__file__).resolve().parent))`.

`tools/accuracy/kessler_accuracy/snapshot.py`: a LEO1 decoder mirroring `api/app/ingest/snapshot.py` `unpack_snapshot`. It uses gzip, the magic `b"LEO1"`, a uint32 LE header length, the JSON header, and `struct.Struct("<IHBx10d")` records. It returns the header plus a list of OMM-record dicts with `epochMs = epoch_unix * 1000`.

- [ ] **Step 4: Fixture generators** (run once; commit their output)

`tools/accuracy/make_golden.py`:
- Fetch `https://kessler.kudayyurter.dev/api/globe/snapshot?group=LEO`, `group=HIGH` and `/api/globe/names?group=LEO` with `urllib.request`. Decode them with `kessler_accuracy.snapshot`.
- Pick the sentinels:
  - ISS = 25544;
  - the first `DEB` whose name contains `FENGYUN 1C DEB`;
  - the first `PAY` whose name starts with `STARLINK`;
  - the first `R/B`;
  - from HIGH, the first `PAY` with `abs(meanMotion − 1.0027) < 0.01` and `eccentricity < 0.01` (GEO).
- Build the sample times per the spec: epoch, epoch + 90 min, + 1 day, + 3 days, and 2026-01-15, 2026-06-15 and 2026-09-24 at 12:00 UTC.
- For each sentinel and time, write `position(record, t)` into `web/tests/fixtures/accuracy/golden.json`, using the schema in Interfaces. Include versions from `importlib.metadata`.

`tools/accuracy/make_sgp4_vectors.py`:
- Locate the Vallado verification set shipped with the `sgp4` package (`SGP4-VER.TLE`, via `importlib.resources.files("sgp4")`).
- Parse each two-line case and its listed start/stop/step minutes.
- Take the first 20 cases, with up to 12 time points each.
- Propagate with `sgp4.api.Satrec.twoline2rv(l1, l2)` (mode `'i'`, matching satellite.js) and write TEME km to `web/tests/fixtures/accuracy/sgp4-vectors.json`.
- If the package doesn't ship that file, stop and report NEEDS_CONTEXT. Do not invent TLEs.

Run both generators:

```bash
cd tools/accuracy && uv run python make_golden.py && uv run python make_sgp4_vectors.py
```

Confirm the JSON files exist and look sane: 5 objects × 7 samples, and ~20 cases.

- [ ] **Step 5: Verify and commit**

`cd tools/accuracy && uv run ruff check . && uv run pytest -q` → pass.

```bash
git add tools/accuracy web/tests/fixtures/accuracy/golden.json web/tests/fixtures/accuracy/sgp4-vectors.json
git commit -m "test: skyfield reference tooling and frozen accuracy fixtures" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 3: Data round-trip (API) and the decode fixture

**Files:**
- Create: `api/tests/test_snapshot_roundtrip.py`, `api/scripts/make_accuracy_snapshot.py`, `web/tests/fixtures/accuracy/api-snapshot.bin.gz`, `web/tests/fixtures/accuracy/api-snapshot.elements.json`

**Interfaces:**
- Consumes: `pack_snapshot(rows, generated_at)` and `unpack_snapshot(data)` from `api/app/ingest/snapshot.py`; `parse_gp_records` from `api/app/ingest/gp.py`.
- Produces: the web T2 fixture pair (binary snapshot plus the exact source elements, with `epochMs`).

- [ ] **Step 1: Write the failing test** — `api/tests/test_snapshot_roundtrip.py`

```python
import struct
from datetime import UTC, datetime, timedelta, timezone

from app.ingest.gp import parse_gp_records
from app.ingest.snapshot import pack_snapshot, unpack_snapshot

ROW = {
    "norad_id": 25544, "owner": "ISS", "object_type": "PAY",
    "epoch": datetime(2026, 9, 22, 6, 30, 37, 496000, tzinfo=UTC),
    "mean_motion": 15.49224498, "eccentricity": 0.00047657, "inclination": 51.6312,
    "raan": 179.6046, "arg_pericenter": 167.6102, "mean_anomaly": 192.5004,
    "bstar": 0.0001364276, "mean_motion_dot": 0.00007132, "mean_motion_ddot": 0.0,
}


def test_every_element_round_trips_bit_identically():
    header, records = unpack_snapshot(pack_snapshot([ROW], datetime(2026, 9, 22, tzinfo=UTC)))
    (rec,) = records
    assert rec[0] == 25544 and header["owners"][rec[1]] == "ISS" and header["types"][rec[2]] == "PAY"
    expected = [ROW["epoch"].timestamp(), *(ROW[k] for k in (
        "mean_motion", "eccentricity", "inclination", "raan", "arg_pericenter", "mean_anomaly",
        "bstar", "mean_motion_dot", "mean_motion_ddot"))]
    assert [struct.pack("<d", v) for v in rec[3:]] == [struct.pack("<d", v) for v in expected]


def test_epoch_is_utc_even_when_given_another_offset():
    shifted = {**ROW, "epoch": ROW["epoch"].astimezone(timezone(timedelta(hours=-5)))}
    _, (rec,) = unpack_snapshot(pack_snapshot([shifted], datetime(2026, 9, 22, tzinfo=UTC)))
    assert rec[3] == ROW["epoch"].timestamp()


def test_gp_epoch_without_zone_is_read_as_utc():
    (gp,) = parse_gp_records([{
        "NORAD_CAT_ID": "25544", "EPOCH": "2026-09-22T06:30:37.496000", "MEAN_MOTION": "15.49224498",
        "ECCENTRICITY": "0.00047657", "INCLINATION": "51.6312", "RA_OF_ASC_NODE": "179.6046",
        "ARG_OF_PERICENTER": "167.6102", "MEAN_ANOMALY": "192.5004", "BSTAR": "0.0001364276",
        "MEAN_MOTION_DOT": "0.00007132", "MEAN_MOTION_DDOT": "0",
    }])
    assert gp.epoch == ROW["epoch"]
```

Before writing the third test, read `parse_gp_records` and its `GpRecord` fields in `api/app/ingest/gp.py`. Use the real attribute name for the epoch, and the minimum set of keys the parser requires (copy them from `api/tests/fixtures/gp_spacetrack_sample.json`). If `parse_gp_records` needs more fields, add them with the values above.

Run: `cd api && uv run pytest tests/test_snapshot_roundtrip.py -q`. These tests may pass immediately, because they guard behaviour that already exists. Record in the report whether each one was RED or already GREEN. If any fails, that's a real bug: report it and fix it in the same task, following TDD.

- [ ] **Step 2: The web decode fixture** — `api/scripts/make_accuracy_snapshot.py`
- Build 3 rows: the ISS row above; a GEO row (mean_motion 1.00271, eccentricity 0.0002, inclination 0.05, and so on); and a decayed-looking row with bstar 0.01.
- Pack them with `pack_snapshot` and write `web/tests/fixtures/accuracy/api-snapshot.bin.gz`.
- Write `api-snapshot.elements.json` with the exact element values as web `OrbitRecord`s, with `epochMs = epoch.timestamp() * 1000`.
- Run it with `cd api && uv run python scripts/make_accuracy_snapshot.py`.

- [ ] **Step 3: Verify and commit**

`cd api && uv run ruff check . && uv run pytest -q` → all pass.

```bash
git add api/tests/test_snapshot_roundtrip.py api/scripts/make_accuracy_snapshot.py web/tests/fixtures/accuracy/api-snapshot.bin.gz web/tests/fixtures/accuracy/api-snapshot.elements.json
git commit -m "test(api): snapshot elements and epochs round-trip exactly (UTC)" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 4: Web pipeline accuracy tests (T2–T5)

**Files:**
- Create: `web/tests/unit/accuracy.test.ts`

**Interfaces:**
- Consumes:
  - `decodeSnapshot`, `gunzip` (`@/lib/snapshot`);
  - `recordToSatrec`, `ecefToScene`, `EARTH_RADIUS_KM` (`@/lib/orbit`);
  - `propagate`, `gstime`, `eciToEcf`, `twoline2satrec` (satellite.js);
  - `ecefToGeodetic`, `sceneToEcef`, `greatCircleKm` (Task 1);
  - the fixtures from Tasks 2–3.

- [ ] **Step 1: Write the tests**

```ts
import { readFileSync } from "node:fs";
import { eciToEcf, gstime, propagate, twoline2satrec } from "satellite.js";
import { describe, expect, it } from "vitest";
import { ecefToGeodetic, greatCircleKm, sceneToEcef } from "@/lib/geo";
import { ecefToScene, recordToSatrec } from "@/lib/orbit";
import { decodeSnapshot, gunzip, type OrbitRecord } from "@/lib/snapshot";

const fx = (n: string) => readFileSync(new URL(`../fixtures/accuracy/${n}`, import.meta.url));
type Sample = { timeMs: number; ecefKm: [number, number, number]; latDeg: number; lonDeg: number; altKm: number };
const golden = JSON.parse(fx("golden.json").toString()) as { objects: { label: string; record: OrbitRecord; samples: Sample[] }[] };
const vectors = JSON.parse(fx("sgp4-vectors.json").toString()) as { cases: { satnum: string; line1: string; line2: string; samples: { tsinceMin: number; temeKm: [number, number, number] }[] }[] };

/** The site's pipeline, end to end, for one record at one time: returns ECEF km via the scene frame. */
function sitePosition(rec: OrbitRecord, timeMs: number): [number, number, number] | null {
  const satrec = recordToSatrec(rec);
  if (!satrec) return null;
  const date = new Date(timeMs);
  const pv = propagate(satrec, date);
  if (!pv || !pv.position) return null;
  const ecf = eciToEcf(pv.position, gstime(date));
  const scene = new Float32Array(3);
  ecefToScene(ecf.x, ecf.y, ecf.z, scene, 0);
  return sceneToEcef(scene[0], scene[1], scene[2]);
}

describe("T2 snapshot decode", () => {
  it("decodes the API-packed snapshot to the exact source elements", async () => {
    const expected = JSON.parse(fx("api-snapshot.elements.json").toString()) as OrbitRecord[];
    const { records } = decodeSnapshot(await gunzip(new Uint8Array(fx("api-snapshot.bin.gz"))));
    expect(records).toEqual(expected);
  });
});

describe("T3/T4 site pipeline vs skyfield (independent)", () => {
  for (const obj of golden.objects) {
    for (const s of obj.samples) {
      it(`${obj.label} at ${new Date(s.timeMs).toISOString()}`, () => {
        const p = sitePosition(obj.record, s.timeMs);
        expect(p, "propagation failed").not.toBeNull();
        const g = ecefToGeodetic(...p!);
        const ground = greatCircleKm(g.latDeg, g.lonDeg, s.latDeg, s.lonDeg);
        expect(ground, "ground distance km").toBeLessThanOrEqual(1);
        expect(Math.abs(g.altKm - s.altKm), "altitude km").toBeLessThanOrEqual(1);
        expect(Math.abs(g.latDeg - s.latDeg), "latitude deg").toBeLessThanOrEqual(0.01);
        const dLon = ((g.lonDeg - s.lonDeg + 540) % 360) - 180;
        expect(Math.abs(dLon), "longitude deg").toBeLessThanOrEqual(0.01);
        if (obj.label !== "GEO") {
          const d3 = Math.hypot(p![0] - s.ecefKm[0], p![1] - s.ecefKm[1], p![2] - s.ecefKm[2]);
          expect(d3, "3D km (LEO)").toBeLessThanOrEqual(1);
        }
      });
    }
  }
});

describe("T5 official SGP4 verification vectors", () => {
  for (const c of vectors.cases) {
    it(`satnum ${c.satnum}`, () => {
      const rec = twoline2satrec(c.line1, c.line2);
      for (const s of c.samples) {
        const pv = sgp4(rec, s.tsinceMin); // minutes since the element epoch
        expect(pv && pv.position, `t=${s.tsinceMin}`).toBeTruthy();
        const p = pv!.position as { x: number; y: number; z: number };
        expect(Math.abs(p.x - s.temeKm[0])).toBeLessThanOrEqual(0.001);
        expect(Math.abs(p.y - s.temeKm[1])).toBeLessThanOrEqual(0.001);
        expect(Math.abs(p.z - s.temeKm[2])).toBeLessThanOrEqual(0.001);
      }
    });
  }
});
```

Add `sgp4` to the satellite.js import (`import { eciToEcf, gstime, propagate, sgp4, twoline2satrec } from "satellite.js";`).

- [ ] **Step 2: Run the tests**

Run: `cd web && npx vitest run tests/unit/accuracy.test.ts`.
- **If everything passes:** record that these guard existing correct behaviour.
- **If anything fails,** that's the point of these tests. Find the pipeline step at fault (data, SGP4, rotation or frame) from which assertion failed. Report NEEDS_CONTEXT with the numbers **before** changing product code, so the controller can decide whether it's a real bug or a tolerance or definition issue.

- [ ] **Step 3: Commit** (after `npm run lint`, `npm run typecheck` and `npm test` pass)

```bash
git add web/tests/unit/accuracy.test.ts
git commit -m "test(web): site orbit pipeline agrees with skyfield and SGP4 reference vectors" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 5: Globe alignment (T6)

**Files:**
- Create: `web/src/lib/landMask.ts`, `web/tests/unit/globeAlignment.test.ts`

**Interfaces:**
- Produces: `isLand(lonDeg: number, latDeg: number, land: FeatureCollection): boolean`. It uses even-odd point-in-polygon over every ring of every Polygon/MultiPolygon, which is the same fill rule `drawEarthTexture` uses. Ring coordinates are `[lon, lat]`.

- [ ] **Step 1: Write the failing test** — `web/tests/unit/globeAlignment.test.ts`

```ts
import { readFileSync } from "node:fs";
import type { FeatureCollection } from "geojson";
import * as THREE from "three";
import { feature } from "topojson-client";
import type { Topology } from "topojson-specification";
import { describe, expect, it } from "vitest";
import { lonLatToTexel } from "@/components/globe/earthTexture";
import { geodeticToEcef } from "@/lib/geo";
import { isLand } from "@/lib/landMask";
import { ecefToScene } from "@/lib/orbit";

const topo = JSON.parse(readFileSync(new URL("../../public/geo/land-50m.json", import.meta.url), "utf8")) as Topology;
const land = feature(topo, topo.objects.land) as unknown as FeatureCollection;

const LAND = { Cairo: [31.24, 30.04], Sahara: [13, 23], Denver: [-104.99, 39.74], "Buenos Aires": [-58.38, -34.6], Beijing: [116.4, 39.9], Sydney: [151.0, -33.8] };
const OCEAN = { "mid-Pacific": [-150, 0], "South Atlantic": [-15, -30], "Indian Ocean": [80, -20] };

/** Where on the actual Earth mesh (SphereGeometry(1,128,96), as in Earth.tsx) a lat/lon lands: ray from outside toward the centre, read the interpolated UV. */
function meshUv(lon: number, lat: number): THREE.Vector2 {
  const [x, y, z] = geodeticToEcef(lat, lon, 0);
  const s = new Float32Array(3);
  ecefToScene(x, y, z, s, 0);
  const dir = new THREE.Vector3(s[0], s[1], s[2]).normalize();
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 96), new THREE.MeshBasicMaterial());
  const ray = new THREE.Raycaster(dir.clone().multiplyScalar(3), dir.clone().negate());
  const hit = ray.intersectObject(mesh)[0];
  return hit.uv!;
}

describe("T6 globe alignment", () => {
  for (const [name, [lon, lat]] of Object.entries({ ...LAND, ...OCEAN })) {
    it(`${name}: the mesh point for its lat/lon samples the texture at that lat/lon`, () => {
      const uv = meshUv(lon, lat);
      const [tx, ty] = lonLatToTexel(lon, lat, 360, 180);
      const texLon = uv.x * 360 - 180;
      const texLat = uv.y * 180 - 90; // CanvasTexture flipY: canvas row 0 (north) is v = 1
      expect(Math.abs(((texLon - lon + 540) % 360) - 180)).toBeLessThanOrEqual(0.2);
      expect(Math.abs(texLat - lat)).toBeLessThanOrEqual(0.2);
      expect(Math.abs(tx - (lon + 180))).toBeLessThan(1e-9); // lonLatToTexel agrees with the same convention
      expect(Math.abs(ty - (90 - lat))).toBeLessThan(1e-9);
    });
  }
  for (const [name, [lon, lat]] of Object.entries(LAND)) {
    it(`${name} is land on the texture data`, () => expect(isLand(lon, lat, land)).toBe(true));
  }
  for (const [name, [lon, lat]] of Object.entries(OCEAN)) {
    it(`${name} is ocean on the texture data`, () => expect(isLand(lon, lat, land)).toBe(false));
  }
});
```

Use the same `topojson-client` import form as `Earth.tsx`. If the `topojson-specification` types aren't installed, import `Topology` the way `Earth.tsx` types it.

Run: `cd web && npx vitest run tests/unit/globeAlignment.test.ts`. It fails because `@/lib/landMask` is missing.

- [ ] **Step 2: Implement** — `web/src/lib/landMask.ts`

```ts
import type { FeatureCollection, MultiPolygon, Polygon } from "geojson";

function inRing(lon: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Even-odd over all rings — the same fill rule drawEarthTexture uses. */
export function isLand(lon: number, lat: number, land: FeatureCollection): boolean {
  let inside = false;
  for (const f of land.features) {
    const g = f.geometry as Polygon | MultiPolygon;
    const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
    for (const poly of polys) for (const ring of poly) if (inRing(lon, lat, ring)) inside = !inside;
  }
  return inside;
}
```

- [ ] **Step 3: Verify.** Run `npx vitest run tests/unit/globeAlignment.test.ts` → pass, then `npm test`, `npm run lint`, `npm run typecheck`.
  - If a mesh-UV assertion fails by roughly 180° or 90°, or mirrors the latitude, **that is a real globe misalignment**. Report NEEDS_CONTEXT with the numbers before changing product code.
  - If a land/ocean assertion fails for a point that is genuinely on a coast, move the landmark 0.5° inland or offshore and note it.

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/landMask.ts web/tests/unit/globeAlignment.test.ts
git commit -m "test(web): globe mesh, texture and land data line up with real lat/lon" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 6: Live audit (`npm run audit:positions`)

**Files:**
- Create:
  - `web/scripts/accuracy/tolerances.ts`
  - `web/scripts/accuracy/audit.ts` (pure)
  - `web/scripts/audit-positions.ts` (CLI)
  - `web/tests/unit/auditCore.test.ts`
- Modify:
  - `web/package.json` (devDependency `tsx`; scripts `"audit:positions": "tsx scripts/audit-positions.ts"` and `"audit:weekly": "tsx scripts/audit-weekly.ts"`)
  - `web/tsconfig.json` (include `scripts/**/*.ts` if it isn't included already)
  - `web/eslint.config.mjs` (only if lint must know about `scripts/`)

**Interfaces:**
- Produces:
  - `TOLERANCES = { mathGroundKm: 1, issGroundKm: 25, issAltKm: 10, staleDays: 3, staleShareMax: 0.05, minDaysPerWeek: 4 }`
  - `sampleObjects(records: OrbitRecord[], dateIso: string, n: number, sentinels: number[]): OrbitRecord[]`. It is deterministic for a given `dateIso`, stratified by `type` (PAY/DEB/R/B/UNK) in proportion to the population with at least 10 of each type present, and always includes the sentinel ids that exist.
  - `type Measurement = { noradId: number; name: string; type: ObjectType; regime: "LEO" | "HIGH"; ageDays: number; groundKm: number | null; altDiffKm: number | null; ok: boolean; error?: string }`
  - `measure(rec, regime, name, timeMs, ours: {latDeg, lonDeg, altKm} | null, ref: {ok, latDeg?, lonDeg?, altKm?, error?}): Measurement`. If either side fails, it returns `ok: false` with null errors.
  - `type DailyResult = { date: string; commit: string; generatedAt: string | null; timeMs: number; sampled: number; failed: number; byType: Record<string, { n: number; maxKm: number; p95Km: number }>; byRegime: Record<string, { n: number; maxKm: number; p95Km: number }>; age: { p50Days: number; p95Days: number; staleShare: number }; iss: { groundKm: number; altDiffKm: number; theirs: { latDeg: number; lonDeg: number; altKm: number; timestamp: number } } | null; worst: Measurement[] }`
  - `buildDailyResult(meta: {date, commit, generatedAt, timeMs}, ms: Measurement[], iss: DailyResult["iss"]): DailyResult`. Errors are the ground km; `worst` holds the top 10 by `groundKm`.

- [ ] **Step 1: Write the failing tests** — `web/tests/unit/auditCore.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { buildDailyResult, measure, sampleObjects } from "../../scripts/accuracy/audit";
import { TOLERANCES } from "../../scripts/accuracy/tolerances";
import type { OrbitRecord } from "@/lib/snapshot";

const rec = (id: number, type: OrbitRecord["type"], epochMs = Date.UTC(2026, 8, 24)): OrbitRecord => ({
  noradId: id, owner: "US", type, epochMs, meanMotion: 15, eccentricity: 0.001, inclination: 53, raan: 0,
  argPericenter: 0, meanAnomaly: 0, bstar: 0, meanMotionDot: 0, meanMotionDdot: 0,
});
const pop = [
  ...Array.from({ length: 600 }, (_, i) => rec(1000 + i, "PAY")),
  ...Array.from({ length: 300 }, (_, i) => rec(5000 + i, "DEB")),
  ...Array.from({ length: 60 }, (_, i) => rec(8000 + i, "R/B")),
  rec(25544, "PAY"),
];

describe("sampleObjects", () => {
  it("is deterministic per date, stratified, and always includes sentinels", () => {
    const a = sampleObjects(pop, "2026-09-24", 100, [25544, 999999]);
    const b = sampleObjects(pop, "2026-09-24", 100, [25544, 999999]);
    const c = sampleObjects(pop, "2026-09-25", 100, [25544, 999999]);
    expect(a.map((r) => r.noradId)).toEqual(b.map((r) => r.noradId));
    expect(a.map((r) => r.noradId)).not.toEqual(c.map((r) => r.noradId));
    expect(a.some((r) => r.noradId === 25544)).toBe(true);
    expect(a.length).toBe(100);
    const deb = a.filter((r) => r.type === "DEB").length, rb = a.filter((r) => r.type === "R/B").length;
    expect(deb).toBeGreaterThanOrEqual(25);
    expect(rb).toBeGreaterThanOrEqual(10);
  });
});

describe("measure", () => {
  it("measures ground and altitude difference", () => {
    const m = measure(rec(1, "PAY"), "LEO", "X", Date.UTC(2026, 8, 25), { latDeg: 10, lonDeg: 20, altKm: 500 }, { ok: true, latDeg: 10, lonDeg: 20.01, altKm: 500.4 });
    expect(m.ok).toBe(true);
    expect(m.groundKm!).toBeCloseTo(0.01 * (Math.PI / 180) * 6371 * Math.cos((10 * Math.PI) / 180), 3);
    expect(m.altDiffKm!).toBeCloseTo(0.4, 6);
    expect(m.ageDays).toBeCloseTo(1, 6);
  });
  it("measure skips objects that fail to propagate", () => {
    const m = measure(rec(1, "DEB"), "LEO", "X", 0, null, { ok: false, error: "sgp4 error 6" });
    expect(m.ok).toBe(false);
    expect(m.groundKm).toBeNull();
  });
});

describe("buildDailyResult", () => {
  const meta = { date: "2026-09-24", commit: "abc", generatedAt: "2026-09-24T06:00:00Z", timeMs: 0 };
  it("aggregates by type/regime, ages, and worst list; excludes failures from errors", () => {
    const ok = (id: number, type: OrbitRecord["type"], g: number, age: number) => ({ noradId: id, name: `N${id}`, type, regime: "LEO" as const, ageDays: age, groundKm: g, altDiffKm: 0.1, ok: true });
    const r = buildDailyResult(meta, [ok(1, "PAY", 0.2, 0.5), ok(2, "DEB", 0.9, 4), ok(3, "DEB", 0.1, 1), { noradId: 4, name: "N4", type: "R/B", regime: "LEO", ageDays: 1, groundKm: null, altDiffKm: null, ok: false, error: "x" }], null);
    expect(r.sampled).toBe(4);
    expect(r.failed).toBe(1);
    expect(r.byType.DEB.maxKm).toBeCloseTo(0.9);
    expect(r.worst[0].noradId).toBe(2);
    expect(r.age.staleShare).toBeCloseTo(1 / 3);
    expect(TOLERANCES.staleDays).toBe(3);
  });
  it("buildDailyResult with no ISS reference sets iss null", () => {
    expect(buildDailyResult(meta, [], null).iss).toBeNull();
  });
});
```

Run: `cd web && npx vitest run tests/unit/auditCore.test.ts`. It fails because the modules are missing. If `vitest.config.ts` only includes `tests/unit/**`, that's fine: the tests import from `../../scripts/...` by relative path.

- [ ] **Step 2: Implement the pure core** in `web/scripts/accuracy/audit.ts` and `tolerances.ts`, matching the Interfaces:
  - **Seeded sampling:** a PRNG such as mulberry32 seeded with a hash of `dateIso`.
    1. Put all sentinels that exist into the sample first.
    2. Allocate the remaining slots to each type in proportion to its population, with at least `min(10, typeCount)` per type.
    3. Pick within each type with a Fisher–Yates shuffle on the seeded PRNG.
    4. If rounding makes the total differ from `n`, trim or top up from the largest type.
  - **Errors:** `groundKm` comes from `greatCircleKm` (Task 1), and `ageDays = (timeMs − epochMs) / 86_400_000`.
  - **Percentiles:** p95 uses the nearest-rank method.

- [ ] **Step 3: The CLI** — `web/scripts/audit-positions.ts`
  1. Record `timeMs`. If `wheretheiss.at` answers within 10 s, set `timeMs = its timestamp × 1000`; otherwise use `Date.now()` and set `iss = null`.
  2. Fetch the LEO and HIGH snapshots and names from `https://kessler.kudayyurter.dev` (with a 30 s timeout and 2 retries). Decode them with `loadSnapshot`.
  3. Sample: `sampleObjects(allRecords, today, 500, [25544, <Fengyun, Starlink, R/B, GEO sentinel ids from web/tests/fixtures/accuracy/golden.json>])`.
  4. **Ours:** for each sampled record, compute the site pipeline position (the same function as `sitePosition` in Task 4: extract it to `web/scripts/accuracy/sitePosition.ts` and import it in both places), then `ecefToGeodetic`.
  5. **Theirs:** run the Python helper once for the whole batch: `spawnSync("uv", ["run", "--project", "<repo>/tools/accuracy", "python", "<repo>/tools/accuracy/propagate.py"], { input: JSON.stringify({ items }) })`.
  6. **ISS:** the ISS measurement against wheretheiss.at uses `ours` for 25544 at `timeMs` versus `theirs` from that API. Their `altitude` is in km.
  7. Build with `buildDailyResult`, using `commit` from `git rev-parse --short HEAD` (or `GITHUB_SHA`).
  8. Output:
     - Write `--out <file>` if given, otherwise stdout JSON.
     - Print a readable table to stderr: per type and regime n, max and p95; age p50/p95/stale share; ISS; worst 5.
  9. Exit code: non-zero only if the snapshot fetch or decode fails. Tolerance breaches are the weekly job's concern.

- [ ] **Step 4: Verify.**
  - Run `npx vitest run tests/unit/auditCore.test.ts` → pass; then `npm test`, `npm run lint`, `npm run typecheck`.
  - Run the real audit once:

```bash
cd web && npm run audit:positions -- --out /tmp/audit-today.json
```

  - Paste the printed table into the report.
  - Also move Task 4's `sitePosition` into `scripts/accuracy/sitePosition.ts` and import it from `accuracy.test.ts`, so there is one implementation.

- [ ] **Step 5: Commit**

```bash
git add web/scripts web/tests/unit/auditCore.test.ts web/tests/unit/accuracy.test.ts web/package.json web/package-lock.json web/tsconfig.json
git commit -m "feat: on-demand live position audit against skyfield and wheretheiss.at" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 7: Weekly evaluation (`npm run audit:weekly`)

**Files:**
- Create: `web/scripts/accuracy/weekly.ts` (pure), `web/scripts/audit-weekly.ts` (CLI), `web/tests/unit/auditWeekly.test.ts`

**Interfaces:**
- Consumes: `DailyResult` and `TOLERANCES` (Task 6).
- Produces:
  - `type Check = { name: string; value: number | null; limit: number; pass: boolean; detail: string }`
  - `evaluateWeek(days: { date: string; raw: string | null }[], tol = TOLERANCES): { weekOf: string; present: DailyResult[]; missing: string[]; checks: Check[]; pass: boolean; worst: Measurement[] }`
    - It checks the math max, the ISS ground max, the ISS altitude max, the mean stale share and the days present.
    - A day whose `raw` is null or fails to parse or validate counts as missing.
    - ISS checks ignore days with `iss: null`. With 0 ISS days, the ISS checks have `value: null` and `pass` is true only if at least 4 days are present overall.
  - `renderMarkdown(result, history: { weekOf: string; pass: boolean; mathMaxKm: number | null; issMaxKm: number | null }[]): string` returns the full `AUDIT.md` (this week's table plus a 12-week trend).
  - `planIssueAction(result, openIssueNumbers: number[]): { action: "none" } | { action: "open"; title: string; body: string } | { action: "comment"; issue: number; body: string }`. The title is `Position accuracy out of tolerance — week of YYYY-MM-DD`.

- [ ] **Step 1: Write the failing tests** — `web/tests/unit/auditWeekly.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { evaluateWeek, planIssueAction, renderMarkdown } from "../../scripts/accuracy/weekly";

const day = (date: string, over: Record<string, unknown> = {}) => JSON.stringify({
  date, commit: "abc", generatedAt: `${date}T06:00:00Z`, timeMs: Date.parse(`${date}T06:23:00Z`), sampled: 500, failed: 3,
  byType: { PAY: { n: 300, maxKm: 0.3, p95Km: 0.1 }, DEB: { n: 150, maxKm: 0.4, p95Km: 0.2 } },
  byRegime: { LEO: { n: 450, maxKm: 0.4, p95Km: 0.2 }, HIGH: { n: 50, maxKm: 0.2, p95Km: 0.1 } },
  age: { p50Days: 0.4, p95Days: 1.5, staleShare: 0.01 },
  iss: { groundKm: 4, altDiffKm: 1, theirs: { latDeg: 0, lonDeg: 0, altKm: 420, timestamp: 0 } },
  worst: [], ...over,
});
const week = (over: Record<string, Record<string, unknown>> = {}) =>
  ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27"].map((d) => ({ date: d, raw: day(d, over[d]) }));

describe("evaluateWeek", () => {
  it("passes a healthy week", () => {
    const r = evaluateWeek(week());
    expect(r.pass).toBe(true);
    expect(r.missing).toEqual([]);
  });
  it("fails when the math error exceeds 1 km on any day", () => {
    const r = evaluateWeek(week({ "2026-09-24": { byType: { DEB: { n: 150, maxKm: 1.7, p95Km: 0.3 } } } }));
    expect(r.pass).toBe(false);
    expect(r.checks.find((c) => c.name.startsWith("Math"))!.pass).toBe(false);
  });
  it("fails on ISS drift and on stale data", () => {
    expect(evaluateWeek(week({ "2026-09-22": { iss: { groundKm: 40, altDiffKm: 1, theirs: { latDeg: 0, lonDeg: 0, altKm: 420, timestamp: 0 } } } })).pass).toBe(false);
    expect(evaluateWeek(week(Object.fromEntries(["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24"].map((d) => [d, { age: { p50Days: 2, p95Days: 5, staleShare: 0.12 } }])))).pass).toBe(false);
  });
  it("evaluateWeek treats unparsable days as missing", () => {
    const days = week();
    days[0].raw = "{not json";
    days[1].raw = null;
    days[2].raw = JSON.stringify({ hello: "world" });
    const r = evaluateWeek(days);
    expect(r.missing).toEqual(["2026-09-21", "2026-09-22", "2026-09-23"]);
    expect(r.pass).toBe(true); // 4 of 7 present
    days[3].raw = null;
    expect(evaluateWeek(days).pass).toBe(false);
  });
  it("ignores ISS-less days for the ISS checks", () => {
    const r = evaluateWeek(week(Object.fromEntries(["2026-09-21", "2026-09-22"].map((d) => [d, { iss: null }]))));
    expect(r.pass).toBe(true);
  });
});

describe("planIssueAction / renderMarkdown", () => {
  const bad = evaluateWeek(week({ "2026-09-24": { byType: { DEB: { n: 150, maxKm: 1.7, p95Km: 0.3 } } } }));
  it("opens an issue when failing and none is open", () => {
    const a = planIssueAction(bad, []);
    expect(a.action).toBe("open");
    if (a.action === "open") expect(a.title).toBe(`Position accuracy out of tolerance — week of ${bad.weekOf}`);
  });
  it("planIssueAction comments when an accuracy issue is open", () => {
    const a = planIssueAction(bad, [42]);
    expect(a).toMatchObject({ action: "comment", issue: 42 });
  });
  it("does nothing on a passing week, and renders a table", () => {
    const good = evaluateWeek(week());
    expect(planIssueAction(good, [42])).toEqual({ action: "none" });
    const md = renderMarkdown(good, []);
    expect(md).toContain("| Check |");
    expect(md).toContain("PASS");
  });
});
```

Run: `cd web && npx vitest run tests/unit/auditWeekly.test.ts`. It fails because the module is missing.

- [ ] **Step 2: Implement** `web/scripts/accuracy/weekly.ts`, following the Interfaces:
  - `weekOf` is the first date in the input.
  - Validation checks that `raw` parses to an object with `date`, `byType`, `age` and `iss` keys.
  - The math check takes the max over all present days of every `byType[*].maxKm` and `byRegime[*].maxKm`.
  - The markdown has:
    - a header `# Position accuracy`;
    - a "Week of …" line with ✅ PASS or ❌ FAIL;
    - a checks table (`| Check | Value | Limit | Result |`), plus lists of missing days and the worst 10;
    - a 12-week trend table.

- [ ] **Step 3: The CLI** — `web/scripts/audit-weekly.ts --dir <audit/daily> --history <audit/history.json> --out-md <AUDIT.md> --out-plan <plan.json> --open-issues <comma list>`
  1. Read the last 7 calendar days, ending yesterday UTC, from `--dir`. A missing file counts as `raw: null`.
  2. Call `evaluateWeek`, append to or replace this week's entry in the history JSON, and write `AUDIT.md`.
  3. Write the `planIssueAction` result as JSON to `--out-plan`.
  4. Exit 0.

- [ ] **Step 4: Verify and commit** (`npm test`, `npm run lint`, `npm run typecheck`)

```bash
git add web/scripts web/tests/unit/auditWeekly.test.ts
git commit -m "feat: weekly accuracy evaluation with tolerances, report and issue plan" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 8: Scheduled workflows and docs

**Files:**
- Create: `.github/workflows/accuracy-daily.yml`, `.github/workflows/accuracy-weekly.yml`
- Modify: `README.md` and `web/README.md` (an "Accuracy" section: what's tested, how to run `npm run audit:positions`, where results live, the tolerances table)

**Interfaces:**
- Consumes: `npm run audit:positions -- --out <file>` (Task 6) and `npm run audit:weekly -- …` (Task 7).

- [ ] **Step 1: `accuracy-daily.yml`**

```yaml
name: accuracy-daily
on:
  schedule:
    - cron: "23 6 * * *"
  workflow_dispatch:
permissions:
  contents: write
concurrency:
  group: accuracy-log
  cancel-in-progress: false
jobs:
  capture:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: web/package-lock.json
      - uses: astral-sh/setup-uv@v5
        with:
          python-version: "3.12"
      - run: npm ci
        working-directory: web
      - run: uv sync --locked
        working-directory: tools/accuracy
      - name: Run audit
        working-directory: web
        run: npm run audit:positions -- --out "$RUNNER_TEMP/today.json"
      - name: Commit to audit-log
        run: |
          DAY=$(date -u +%F)
          git config user.name "kessler-audit[bot]"
          git config user.email "kessler-audit@users.noreply.github.com"
          if git ls-remote --exit-code origin audit-log >/dev/null; then
            git fetch origin audit-log
            git worktree add "$RUNNER_TEMP/log" audit-log
          else
            git worktree add --orphan -b audit-log "$RUNNER_TEMP/log"
          fi
          mkdir -p "$RUNNER_TEMP/log/audit/daily"
          cp "$RUNNER_TEMP/today.json" "$RUNNER_TEMP/log/audit/daily/$DAY.json"
          cd "$RUNNER_TEMP/log"
          git add audit
          git commit -m "audit: daily capture $DAY" || echo "nothing to commit"
          git push origin audit-log
```

- [ ] **Step 2: `accuracy-weekly.yml`**

```yaml
name: accuracy-weekly
on:
  schedule:
    - cron: "5 7 * * 1"
  workflow_dispatch:
permissions:
  contents: write
  issues: write
concurrency:
  group: accuracy-log
  cancel-in-progress: false
jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    env:
      GH_TOKEN: ${{ github.token }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: web/package-lock.json
      - run: npm ci
        working-directory: web
      - name: Check out audit-log
        run: |
          git fetch origin audit-log
          git worktree add "$RUNNER_TEMP/log" audit-log
      - name: Evaluate the week
        working-directory: web
        run: |
          gh label create accuracy --color B60205 --description "Position accuracy out of tolerance" --force
          OPEN=$(gh issue list --label accuracy --state open --json number --jq '[.[].number] | join(",")')
          npm run audit:weekly -- --dir "$RUNNER_TEMP/log/audit/daily" --history "$RUNNER_TEMP/log/audit/history.json" \
            --out-md "$RUNNER_TEMP/log/audit/AUDIT.md" --out-plan "$RUNNER_TEMP/plan.json" --open-issues "$OPEN"
      - name: Open or comment on an issue
        run: |
          ACTION=$(jq -r .action "$RUNNER_TEMP/plan.json")
          if [ "$ACTION" = open ]; then
            gh issue create --title "$(jq -r .title "$RUNNER_TEMP/plan.json")" --body "$(jq -r .body "$RUNNER_TEMP/plan.json")" --label accuracy
          elif [ "$ACTION" = comment ]; then
            gh issue comment "$(jq -r .issue "$RUNNER_TEMP/plan.json")" --body "$(jq -r .body "$RUNNER_TEMP/plan.json")"
          fi
      - name: Commit the report
        run: |
          cd "$RUNNER_TEMP/log"
          git config user.name "kessler-audit[bot]"
          git config user.email "kessler-audit@users.noreply.github.com"
          git add audit
          git commit -m "audit: weekly review $(date -u +%F)" || echo "nothing to commit"
          git push origin audit-log
```

- [ ] **Step 3: Docs.** Add an "Accuracy" section to `README.md` (brief, with a link to `web/README.md`). Add the details to `web/README.md`: the five pipeline steps and their tests, the tolerance table (from Global Constraints), `npm run audit:positions`, the `audit-log` branch (`audit/daily/*.json`, `audit/AUDIT.md`), and how to regenerate the fixtures (`cd tools/accuracy && uv run python make_golden.py && uv run python make_sgp4_vectors.py`).

- [ ] **Step 4: Verify.**
  - Run `uvx --from yamllint yamllint -d relaxed .github/workflows/accuracy-*.yml` (no errors).
  - Simulate the weekly CLI locally over a temp dir containing 3 copies of `/tmp/audit-today.json` (Task 6 output), renamed to recent dates. Confirm that `AUDIT.md` renders and that `plan.json` says `none` or `open` as expected. Paste the rendered `AUDIT.md` into the report.
  - Run all suites (web lint, typecheck and test; api pytest; tools/accuracy pytest).

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/accuracy-daily.yml .github/workflows/accuracy-weekly.yml README.md web/README.md
git commit -m "ci: daily position capture and weekly accuracy review" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```
