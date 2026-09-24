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

## Deploying (Vercel)

The Vercel project `kessler` builds this folder: **Root Directory** `web`, framework **Next.js**. It needs two environment variables (Production and Preview):

- `API_ORIGIN_URL`: the `kessler-api` Lambda Function URL, without a trailing slash (CloudFormation output `KesslerApp.ApiFunctionUrl`).
- `ORIGIN_SECRET`: the same value as SSM `/kessler/ORIGIN_SECRET`.

`vercel.json` pins functions to `cle1` (next to AWS us-east-2) and skips builds when nothing under `web/` changed since the last deployment.
