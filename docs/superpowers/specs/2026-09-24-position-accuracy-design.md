# Kessler: Position Accuracy Tests and Audit — Design

**Date:** 2026-09-24 · **Author:** Kuday Yurter (with Claude) · **Status:** design approved in conversation; written spec pending review

## 1. Goal

Prove that every object is drawn where it really is, over the right place on the Earth at the right time. Keep proving it over time:
- **Deterministic tests** in CI fail if any step of the position pipeline breaks.
- **A daily capture** measures how far off we are against independent references.
- **A weekly review** compares the numbers to tolerances and raises an alert when something drifts.

Success looks like:
- A regression in any pipeline step (data, orbit math, Earth rotation, globe mapping) fails a named CI test.
- One day's accuracy numbers are recorded every day.
- Every week the owner gets either a passing summary or a GitHub issue that shows what drifted and by how much.

## 2. The pipeline under test

A position passes through five steps:

1. **Space-Track GP data → database → snapshot.**
   - `api/app/ingest/gp.py` and `api/app/ingest/snapshot.py` store the orbital elements.
   - The snapshot is LEO1: gzip, then 88-byte `<IHBx10d` records, with the epoch in unix seconds.
2. **Snapshot → decode.** `web/src/lib/snapshot.ts` turns the bytes back into `OrbitRecord`s.
3. **SGP4 orbit model → TEME position.**
   - `web/src/lib/orbit.ts` calls `recordToSatrec` and `propagateAll`, using satellite.js.
   - TEME is the coordinate frame SGP4 produces.
4. **TEME → Earth-fixed.** `gstime` (Greenwich sidereal time) plus `eciToEcf` rotate the position to match the Earth at that moment, then `ecefToScene` maps it to scene coordinates as `(x, z, −y) / 6371`.
5. **Scene → globe.**
   - The Earth mesh is a `THREE.SphereGeometry` with an equirectangular texture (`web/src/components/globe/earthTexture.ts`, `lonLatToTexel`).
   - The mesh is not rotated.

## 3. Deterministic tests (CI)

### 3.1 Reference data (golden file)

- **Generator:** `tools/accuracy/make_golden.py` is run by hand and its output is committed.
  - It uses Python `skyfield`, an independent SGP4 and Earth-rotation implementation, to write `web/tests/fixtures/accuracy/golden.json`.
  - `skyfield` goes in a new uv project at `tools/accuracy/`, never in `api/`.
- **Objects:** five sentinels with real elements from the current catalog, frozen into the fixture.

| Sentinel | NORAD id |
|---|---|
| ISS | 25544 |
| A Fengyun-1C fragment | from the catalog |
| A Starlink | from the catalog |
| A rocket body (`R/B`) | from the catalog |
| A GEO satellite (geostationary orbit) | from the catalog |

- **Times:**
  - the element epoch;
  - epoch + 90 min;
  - epoch + 1 day;
  - epoch + 3 days;
  - three fixed dates across a year (2026-01-15, 2026-06-15, 2026-09-24 12:00 UTC), to catch date and time-scale errors.
- **Values:** for each object and time, the golden file stores:
  - the Earth-fixed position in km (ITRS, polar motion ignored);
  - the geodetic latitude and longitude on WGS84, in degrees;
  - the altitude in km.

### 3.2 Tests

All tests below are Vitest in `web/tests/unit/accuracy.test.ts`, except the API one.

- **T1 Data round-trip (API, pytest).**
  - Take GP rows with known values.
  - Run them through `write_snapshots` and `unpack_snapshot`.
  - Every element must be bit-identical.
  - The epoch must round-trip as UTC. A timezone-shift case is included: an epoch string with no zone equals UTC.
- **T2 Decode.** The web `decodeSnapshot` reads a snapshot built by the API test fixture and returns the same element values, with `epochMs` exact.
- **T3 Orbit math vs skyfield.**
  - Run `recordToSatrec` and `propagate` for each golden object and time, converting to Earth-fixed with the site's own `gstime` and `eciToEcf`.
  - It must agree with the golden Earth-fixed position within **1 km**.
- **T4 Geodetic.**
  - Invert `ecefToScene`, then convert to geodetic latitude and longitude with a small, tested `ecefToGeodetic` helper (WGS84) added to `web/src/lib/geo.ts`.
  - It must match the golden latitude and longitude within **0.01°** and the altitude within **1 km**.
- **T5 Official SGP4 vectors.** The standard SGP4 verification set, generated with the Python `sgp4` package and committed, matches satellite.js within **1e-3 km** in TEME at the listed times.
- **T6 Globe alignment.** For each landmark, this checks both where the landmark lands on the 3D sphere and what the map shows there:
  - Take the scene direction for its latitude and longitude, as `ecefToScene` of the geodetic point.
  - Find the `THREE.SphereGeometry` vertex nearest that direction, and read its UV (the texture coordinate).
  - The UV must equal `lonLatToTexel(lon, lat)`, normalised, within half a texel at 2048×1024.
  - Then the texture's land mask at that texel must match the expected class:
    - **land:** Cairo, Sahara (23N 13E), Denver, Buenos Aires, Beijing, Sydney;
    - **ocean:** mid-Pacific (0, −150), South Atlantic (−30, −15), Indian Ocean (−20, 80).
  - The land mask is rasterised from `public/geo/land-50m.json` with the same code the texture uses.

## 4. Live audit (on demand)

`npm run audit:positions` runs `web/scripts/audit-positions.ts`, a Node script run with `tsx`.

- **Inputs:**
  - `GET https://kessler.kudayyurter.dev/api/globe/snapshot?group=LEO` and `?group=HIGH`, plus `/api/globe/names`, all through the public proxy with no secret;
  - `GET https://api.wheretheiss.at/v1/satellites/25544`, whose `timestamp` is the comparison time.
- **Sample:** 500 objects, stratified by type (PAY, DEB, R/B) and regime, drawn with a seed made from the date so a given day's run is reproducible. The five sentinels are always included.
- **Measurements:**
  - **Math error:** our position at time *t* vs skyfield's position at *t* from the same elements. Skyfield is called through a tiny Python helper (`tools/accuracy/propagate.py`) that reads JSON on stdin and writes JSON to stdout. This is the implementation-error check.
  - **Element age:** *t* − epoch, per object.
  - **ISS vs reality:** our latitude, longitude and altitude for the ISS at wheretheiss.at's `timestamp`, against theirs. Reported as the great-circle ground distance in km plus the altitude difference.
- **Output:** a JSON result:
  - `date`, `commit`, `snapshot.generated_at`;
  - per-type and per-regime `max` and `p95` math error (km);
  - element-age percentiles and the share older than 3 days;
  - the ISS ground and altitude error;
  - the worst 10 objects, with ids and names.

  The same numbers print as a readable table.

## 5. Daily capture and weekly review (GitHub Actions)

- **`.github/workflows/accuracy-daily.yml`:**
  - runs on a cron at 06:23 UTC daily, and on `workflow_dispatch`;
  - sets up Node 22 and uv, then runs the audit;
  - commits `audit/daily/YYYY-MM-DD.json` to the orphan branch `audit-log`;
  - needs `contents: write`;
  - no AWS access and no secrets.
- **`.github/workflows/accuracy-weekly.yml`:**
  - runs Mondays at 07:05 UTC, and on `workflow_dispatch`;
  - reads the last 7 daily files from `audit-log`, runs `web/scripts/audit-weekly.ts` and checks the tolerances below;
  - rewrites `audit/AUDIT.md` on `audit-log`, holding the latest week's table and a rolling 12-week trend;
  - if any check fails, opens one GitHub issue titled `Position accuracy out of tolerance — week of YYYY-MM-DD`, labelled `accuracy`, with the failing checks, their numbers and the worst objects;
  - needs `issues: write`;
  - does not open a new issue while an open one with that label already exists; it comments on the open one instead.
- **Missing days** (a failed daily run) are listed in the summary. Four or more missing days in a week is itself a failure.

### Tolerances (single source: `web/scripts/accuracy-tolerances.ts`)

| Check | Tolerance |
|---|---|
| Math error vs skyfield (same elements), any object, weekly max | ≤ 1 km |
| ISS ground distance vs wheretheiss.at, weekly max | ≤ 25 km |
| ISS altitude difference, weekly max | ≤ 10 km |
| Share of sampled objects with element age > 3 days, weekly mean | ≤ 5% |
| Daily captures present | ≥ 4 of 7 |

The deterministic CI tests (§3) carry their own fixed tolerances. Globe alignment is exact (land and ocean classes).

## 6. Out of scope

- Correcting positions automatically.
- Comparing against radar or optical observations.
- Polar motion and UT1−UTC corrections: they are sub-100 m, far below what can be seen on the globe.

## 7. Risks

- **wheretheiss.at downtime or rate limits:** the ISS check is skipped for that day, marked `"iss": null`, and not counted as a failure unless it's missing 4 or more days in the week.
- **The public site is down:** the daily run fails and records nothing, which the missing-days rule covers.
- **CI flakiness:** §3 uses only committed fixtures and makes no network calls.
