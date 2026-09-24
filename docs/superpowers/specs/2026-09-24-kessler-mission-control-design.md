# Kessler: Mission-Control Page Design

**Date:** 2026-09-24 · **Author:** Kuday Yurter (with Claude) · **Status:** approved in conversation, pending written review

Amends the frontend sections (§6) of `2026-09-22-leo-debris-design.md`. Everything not mentioned here (data, API contract, snapshot format, proxy, deploy) is unchanged.

## 1. Goals

The owner's requests (2026-09-24):
1. The globe is centred and **not in a box**. It sits in open space, and the dashboards are arranged around it.
2. **Each dashboard can be hidden.**
3. The dither must **not** affect the orbital objects.
4. Object colours must not blend into the Earth's blue ocean and green land.
5. When zoomed in, the **names** of a bunch of objects near the centre of view appear as text.

Success means:
- At 1280×800 and larger, the globe fills the viewport and every panel can be hidden and brought back.
- At 390 px wide there is no horizontal scroll, and the globe stays usable.
- Objects render crisp (no dither) in the new colours.
- Zooming in shows up to 12 labels near screen centre.
- All existing tests are updated and green, and the new behaviour is tested.

## 2. Layout: "mission control"

- **Globe stage:** the R3F canvas is `position: fixed; inset: 0`, behind everything, on the black page background. There is no Card, border or rounded frame. OrbitControls work anywhere the pointer isn't over a panel. The globe is centred. The initial camera distance frames the Earth at roughly 60% of the smaller viewport dimension.
- **Panels** float over the stage (`position: fixed`, 16 px from the edges, desktop ≥ 1024 px). They keep the card language (`#0e0e0e` at 86% opacity with a light backdrop blur, 2 px `#262626` border, 14–18 px radius):

| Panel id | Position | Contents | Default |
|---|---|---|---|
| `overview` | top-left, 280 px | KESSLER wordmark, tagline "Every tracked object in Earth orbit, 1957 to now.", in-orbit counts per type in the new colours, data-as-of line, attribution | shown |
| `search` | top-right, 300 px | Search box; the selected object's detail card renders inside this panel below the search | shown |
| `history` | bottom-left, 380×260 | Line chart (in orbit by type, annotations) | shown |
| `owners` | bottom-right, 360×260 | Owners bar chart | shown |
| `filters` | left edge, under overview | Type / owner / orbit filters | hidden |
| `chat` | right edge, under search | "Ask AI" coming-soon panel (plan 3 fills it) | hidden |

- **Hiding:** each panel header has a `×` button (`aria-label="Hide <panel>"`).
- **Panel dock:** a row of chips, top-centre, lists all six panels. Clicking a chip toggles its panel, and hidden panels show as dimmed chips. Each chip is a `button` with `aria-pressed`.
- **Persistence:** visibility is stored per browser in `localStorage` key `kessler.panels.v1`. Every read and write is wrapped in try/catch, so a missing or blocked store falls back to the defaults.
- **Time controls:** Live / Fast stay bottom-centre. The date/sun readout sits just above them.
- **Tablet (640–1023 px):** the same floating layout, but panels shrink (history and owners 320×220). If two corner panels would overlap, the charts stack in a bottom row.
- **Phone (< 640 px):** the globe fills the screen. Panels become a bottom sheet with a tab per panel, showing one panel at a time; the sheet can collapse to just the tab row. The dock is replaced by the tabs.
- **Removed:** the old hero layout (GlobeSection card, Intro card, StatTiles row, charts grid below the fold). The About page and Header stay as normal pages. On the home page the Header's links (Explore / About / kudayyurter.dev) move into the overview panel footer.
- **Loading:** globe load, WebGL fallback and error boundary behave as today. The "no WebGL" fallback shows its message centred on the stage, and the panels still work.

## 3. Colours

- **Entity colours** now have two steps, a bright "globe" step and a deeper "chart" step:

| Type | Globe (objects, labels, counts) | Chart (lines, bars, legends) |
|---|---|---|
| PAY payloads | `#fff4d6` starlight | `#b58f3c` wheat |
| DEB debris | `#ff6a3d` ember | `#d64a3f` |
| R/B rocket bodies | `#c4a8ff` lavender | `#957be0` |
| UNK unknown | `#bdbdbd` | `#8f8e88` |

- **Validation:** the chart set passes the dataviz validator in dark mode on `#0e0e0e` with `--pairs all`. The worst pair is wheat↔ember, ΔE 6.4 deutan, which is legal because the line chart direct-labels each line end and the bar chart has a legend.
- **Where the colours live:** `TYPE_COLORS` becomes `TYPE_COLORS.globe` / `TYPE_COLORS.chart`, and the CSS tokens `--color-pay/deb/rb` are replaced by `--color-pay-globe`, `--color-pay-chart`, and so on. No component may hard-code the old hexes `#3987e5`, `#d95926` or `#199e70`.
- **Satellite geometry:** its vertex colours become neutral (white body, light-grey panels), so the per-instance colour decides the hue. The old blue panels are removed.
- **Earth:** unchanged (ocean `#2f6fd6`, land `#7fd06b`, coast `#0d1b2e`).

## 4. Dither

- **Removed:** the full-frame `DitherEffect` post-process pass and its `EffectComposer`. This is what dithered the objects, and removing it also saves a full-screen pass per frame.
- **Kept:** the Earth shader's 4×4 Bayer twilight band (±9°).
- **Added:** a subtle surface texture to the Earth shader only. A 4×4 Bayer threshold at cell `2 × devicePixelRatio` (max 2) modulates ocean/land brightness by ±4%, so the Earth keeps the textured look while objects, labels and the atmosphere stay crisp.
- The `DitherEffect.tsx` file and its unit test are deleted, and `@react-three/postprocessing` / `postprocessing` are removed from dependencies if nothing else uses them.

## 5. Name labels

- **New API endpoint** `GET /api/globe/names?group=LEO|HIGH` returns `{"generated_at": iso, "names": {"<norad_id>": "<name>", ...}}`.
  - It covers the objects in that group's current snapshot (the same regime mapping as `SNAPSHOT_GROUPS`).
  - Headers: `Cache-Control: public, max-age=300, s-maxage=21600`, plus an ETag like the snapshot.
  - It is served from the database (`objects.name` joined to `gp_elements`), goes through the existing proxy and origin-auth, and an unknown group returns 422 like other invalid parameters.
- **Loading:** the web fetches a group's names lazily, the first time labels would show for that group, and keeps them in memory. If the fetch fails, labels are simply not shown, and nothing else is affected.
- **When:** labels show when the camera distance to the Earth's centre is below **2.2 Earth radii**. They fade in over 200 ms and fade out beyond **2.4** (hysteresis). Under `prefers-reduced-motion` they appear with no fade.
- **Which** (recomputed at most every 250 ms while the camera or time moves):
  - Candidates are visible objects (after filters) whose position is in front of the Earth (not occluded; the same test as picking), inside the viewport, and whose name is known.
  - They are ranked by screen distance to the viewport centre.
  - The nearest **12** are labelled. The selected object is always labelled.
- **Rendering:** HTML overlay labels (absolutely positioned elements in a single container; no per-label React re-render per frame):
  - Departure Mono 12 px, in the object's globe colour, on a `rgba(0,0,0,.55)` pill, offset 8 px up-right of the object with a 1 px leader.
  - Labels that would overlap an earlier (closer-to-centre) label are dropped.
  - Clicking a label selects that object: the search panel shows its card, and the panel becomes visible if hidden.
- **Screen readers:** the label container is `aria-hidden` (decorative); selection stays accessible through search.

## 6. Components (web)

- **New:**
  - `components/layout/Stage.tsx`: the full-screen globe host; replaces GlobeSection's card.
  - `components/layout/Panel.tsx`: the floating panel with title and hide button.
  - `components/layout/PanelDock.tsx`: the chip row.
  - `components/layout/MobileSheet.tsx`
  - `lib/panels.ts`: panel ids, defaults and localStorage persistence (pure, unit-tested); visibility state lives in the zustand store.
  - `components/globe/Labels.tsx`: the overlay container, with its selection logic in pure `lib/labels.ts` (ranking, occlusion flag, overlap culling; unit-tested).
  - `lib/names.ts`: the fetch and cache.
- **Changed:**
  - `app/page.tsx`: the new composition.
  - `GlobeScene.tsx`: no EffectComposer; exposes camera and positions for the labels.
  - `earthMaterial.ts`: the surface texture.
  - `objectGeometries.ts`: neutral vertex colours.
  - `lib/types.ts` and `globals.css`: the colour steps.
  - Charts, StatTiles/overview and the object card: the new colour tokens.
  - `Header.tsx`: About page only.
- **API:** a new route in `api/app/api/routes.py` plus a service function and tests.

## 7. Testing

- **Unit tests:**
  - `lib/panels.ts`: defaults, toggle, persistence, and the blocked-storage fallback.
  - `lib/labels.ts`: ranking by centre distance, the cap of 12, the selected object always included, occluded or off-screen objects excluded, overlap culling, and the 2.2/2.4 hysteresis.
  - Colour constants: no old hex values anywhere under `src/` (a grep-style test).
  - `lib/names.ts`: cache and failure handling.
- **API tests:** the names endpoint returns the snapshot group's names, rejects a bad group (422), and sets the cache headers.
- **E2E tests:**
  - The globe canvas fills the viewport with no card frame around it.
  - Each panel hides via × and comes back via its dock chip, and the state survives a reload.
  - The 390 px check: no horizontal overflow, and the bottom sheet switches tabs.
  - Zooming in shows at least one label using the fixture names, and clicking a label opens the object card.
  - The existing API-failure and no-snapshot cases still pass.
- **Visual check:** screenshots at 1440×900 and 390×844 (objects crisp, colours as in §3), attached to the plan's final task report.

## 8. Out of scope

AI chat behaviour (plan 3), new charts, new data, and changes to the Earth palette.
