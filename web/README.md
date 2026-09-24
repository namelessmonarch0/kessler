# Kessler: web

Next.js explorer for kessler.kudayyurter.dev. Design: `../docs/superpowers/specs/2026-09-22-leo-debris-design.md` §6.

## Local development

```bash
# 1. Start the data API with data (see ../api/README.md)
cd ../api && docker compose up -d db && uv run python -m app.jobs all
uv run uvicorn app.api.main:create_app --factory --port 8000
# 2. In another terminal
cd web && cp .env.example .env.local && npm install && npm run dev
```

Open http://localhost:3000. The browser only calls `/api/*` on the same origin; `src/app/api/[...path]/route.ts` forwards to `API_ORIGIN_URL`.

## Layout

The page is a fixed, full-screen 3D globe (`GlobeScene`) with floating panels on top — not a
scrolling page. Panels: **Overview**, **Search**, **History**, **Owners**, **Filters**, **Ask AI**
(`lib/panels.ts`). `overview`, `search`, `history` and `owners` are shown by default; `filters`
and `chat` start hidden. Each panel can be hidden; the dock (`PanelDock`, desktop/tablet) or the
tab strip (`MobileSheet`, phone) toggles them and shows which are open. Visibility persists in
`localStorage` under `kessler.panels.v1` (`lib/panels.ts`); every read/write is wrapped in
try/catch, so private-mode or quota errors just fall back to the defaults. Panel chrome:
`rgba(14,14,14,0.86)` background, `backdrop-filter: blur(6px)`, a 2 px `#262626` border, 16 px
radius (`.panel` in `globals.css`).

Breakpoints: phone < 640 px, tablet 640–1023 px, desktop ≥ 1024 px. Below 640 px, panels collapse
into a single bottom sheet (`MobileSheet`) with a tab strip instead of separate floating cards; the
globe camera applies a view offset while the sheet is open so the Earth stays centred in the space
above it, rather than behind it.

**Colours** are defined once in `lib/types.ts` and mirrored as CSS tokens in `globals.css`, in two
steps:
- `GLOBE_COLORS` — objects on the globe, their labels, and headline counts (bright, readable over
  the blue/green Earth): PAY `#fff4d6`, DEB `#ff6a3d`, R/B `#c4a8ff`, UNK `#bdbdbd`.
- `CHART_COLORS` — chart lines/bars, legends and filter swatches (deeper, validated on `#0e0e0e`):
  PAY `#b58f3c`, DEB `#d64a3f`, R/B `#957be0`, UNK `#8f8e88`.

The Earth keeps its own unrelated palette (ocean `#2f6fd6`, land `#7fd06b`, coastline ink
`#0d1b2e`) and a real-Sun terminator with a Bayer-dithered twilight band; the ordered-dither +
grain effect is scoped to the Earth shader only, not a full-screen post-process.

**Name labels** (`lib/labels.ts`, `components/globe/LabelDriver.tsx`) show the object's name near
its marker when zoomed in: Departure Mono 12 px, in the object's `GLOBE_COLORS` colour, on a
`rgba(0,0,0,0.55)` pill (`.globe-label` in `globals.css`), offset 8 px up-right from the marker.
They appear once the camera is closer than 2.2 Earth radii and disappear again past 2.4 (hysteresis
so they don't flicker at the boundary), capped at 12 on screen at once, recomputed at most every
250 ms. Names come from `GET /api/globe/names?group=LEO|HIGH`
(`{"generated_at": str | null, "names": {"<norad_id>": "<name>"}}`, cached client-side per group in
`lib/names.ts`), proxied like the rest of `/api/*`.

## Tests

| Command | What |
|---|---|
| `npm test` | Unit tests (Vitest): proxy, API client, snapshot decoder, SGP4 + Sun maths, store, chart helpers |
| `npm run e2e` | Playwright against `next dev` with a mocked API |
| `npm run lint && npm run typecheck` | ESLint + TypeScript |

Data: USSPACECOM via Space-Track.org; CelesTrak.

## Accuracy

Full design: `../docs/superpowers/specs/2026-09-24-position-accuracy-design.md`.

A position on the globe passes through five steps, each covered by a deterministic test that
fails if that step regresses:

| Step | Code | Test |
|---|---|---|
| 1. Space-Track GP data → database → snapshot | `api/app/ingest/gp.py`, `api/app/ingest/snapshot.py` | T1 data round-trip (`api`, pytest) |
| 2. Snapshot → decode | `web/src/lib/snapshot.ts` | T2 decode (`web/tests/unit/accuracy.test.ts`) |
| 3. SGP4 orbit model → TEME position | `web/src/lib/orbit.ts` (satellite.js) | T3 orbit math vs skyfield; T5 official SGP4 vectors |
| 4. TEME → Earth-fixed (`gstime`, `eciToEcf`, `ecefToScene`) | `web/src/lib/orbit.ts` | T3, T4 geodetic round-trip |
| 5. Scene → globe (sphere mesh + equirectangular texture) | `web/src/components/globe/earthTexture.ts` | T6 globe alignment |

The Earth mesh is a sphere and objects sit along their geocentric direction, while the land data is
geodetic (WGS84). `lonLatToTexel` therefore draws each point at its geocentric latitude
ψ = atan((1 − e²)·tan φ); at geodetic latitude the continents would sit up to ~0.19° (~20 km)
poleward of the objects at mid-latitudes. T6 pins this at 0.02°.

Web-side tests T2–T5 live in `web/tests/unit/accuracy.test.ts`; T6 (globe alignment) lives in
`web/tests/unit/globeAlignment.test.ts`. All of them run against reference data
frozen into `web/tests/fixtures/accuracy/` (see "Regenerating fixtures" below). None of these
tests touch the network — only the audit script and the scheduled workflows do.

### Tolerances

"Math error" is the ground distance between two subpoints plus the altitude difference, not raw
3D km — at GEO radius, UT1−UTC alone rotates positions ~3 km in 3D, which is invisible on the
globe.

| Check | Limit |
|---|---|
| Ground distance (CI, every sentinel) | ≤ 1 km |
| \|Δalt\| (CI, every sentinel) | ≤ 1 km |
| \|Δlat\|, \|Δlon\| (CI, every sentinel) | ≤ 0.01° |
| 3D Earth-fixed distance (CI, LEO sentinels only) | ≤ 1 km |
| SGP4 TEME vs the official vector set (CI) | ≤ 0.001 km |
| Globe UV vs geocentric latitude/longitude (CI) | ≤ 0.02° of arc |
| Land/ocean class (CI) | exact |
| Math error ground distance, weekly max | ≤ 1 km |
| ISS ground distance vs wheretheiss.at, weekly max | ≤ 25 km |
| ISS \|Δalt\| vs wheretheiss.at, weekly max | ≤ 10 km |
| Mean share of sampled objects with element age > 3 days | ≤ 5% |
| Daily captures present per week | ≥ 4 of 7 |

### Daily capture and weekly review

`npm run audit:positions -- --out <file>` fetches the live site's `/api/globe/snapshot` and
`/api/globe/names` for `LEO` and `HIGH`, samples ~500 objects (plus the sentinels) at the current
time, propagates each with the site's own pipeline and independently with `tools/accuracy` (a
Python `skyfield`/`sgp4` helper via `uv run`), and compares the two. It also compares the site's
ISS position against `https://api.wheretheiss.at/v1/satellites/25544`. It writes one `DailyResult`
JSON to `<file>` (nothing is committed by the script itself).

`npm run audit:weekly -- --dir <audit/daily> --history <audit/history.json> --out-md <AUDIT.md> --out-plan <plan.json> --open-issues <comma list>`
reads the last 7 days of daily results, checks them against the tolerances above, renders
`AUDIT.md` (this week's table, worst offenders, a 12-week trend) and updates `history.json`, and
writes `plan.json` describing what to do next: `{"action":"none"}` when the week passes,
`{"action":"open",...}` to open a new GitHub issue, or `{"action":"comment",...}` to comment on an
existing open one.

Two scheduled GitHub Actions workflows run these:

- **`.github/workflows/accuracy-daily.yml`** — every day at 06:23 UTC, runs `audit:positions` and
  commits the result to `audit/daily/<date>.json` on an orphan `audit-log` branch (kept separate
  from `main` so history accumulates without bloating the app's history).
- **`.github/workflows/accuracy-weekly.yml`** — every Monday at 07:05 UTC, runs `audit:weekly`
  over that branch, commits the updated `audit/AUDIT.md` and `audit/history.json`, and opens or
  comments on a GitHub issue labeled `accuracy` when the week fails.

Both are also `workflow_dispatch`-able. The current report lives at
[`audit/AUDIT.md` on the `audit-log` branch](https://github.com/namelessmonarch0/kessler/tree/audit-log/audit).

### Regenerating fixtures

The golden and SGP4 fixtures are generated by hand and committed:

```bash
cd tools/accuracy
uv run python make_golden.py
uv run python make_sgp4_vectors.py
```

## Deploying (Vercel)

The Vercel project `kessler` builds this folder: **Root Directory** `web`, framework **Next.js**. It needs two environment variables (Production and Preview):

- `API_ORIGIN_URL`: the `kessler-api` Lambda Function URL, without a trailing slash (CloudFormation output `KesslerApp.ApiFunctionUrl`).
- `ORIGIN_SECRET`: the same value as SSM `/kessler/ORIGIN_SECRET`.

`vercel.json` pins functions to `cle1` (next to AWS us-east-2) and skips builds when nothing under `web/` changed since the last deployment.
