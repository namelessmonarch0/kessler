# Kessler Mission-Control Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Kessler home page as "mission control":
- a full-screen globe in open space, with hideable floating panels around it;
- crisp (non-dithered) objects in a new colour set;
- object name labels near the centre of view when zoomed in.

**Architecture:**
- **Stage and panels.** The R3F canvas becomes a fixed full-viewport stage. Panels are fixed overlays arranged in two side columns, and a dock of chips toggles them. Visibility lives in the zustand store and persists to localStorage. Below 640 px the columns are replaced by a tabbed bottom sheet.
- **Rendering.** The post-process dither pass is removed; a subtle Bayer texture moves into the Earth shader, and objects use a new two-step (globe/chart) colour set.
- **Labels.** A throttled driver inside the scene projects visible objects to screen space, picks up to 12 near the centre with pure, unit-tested logic, and writes them into an HTML overlay. Names come from a new cached API endpoint.

**Tech Stack:** Next.js 16.3.6, React 19, three 0.186, @react-three/fiber 9, @react-three/drei 10, zustand 5, Tailwind v4, Vitest, Playwright; FastAPI + psycopg (api).

**Spec:** `docs/superpowers/specs/2026-09-24-kessler-mission-control-design.md` (amends §6 of `docs/superpowers/specs/2026-09-22-leo-debris-design.md`).

## Global Constraints

- **Next.js 16.** APIs differ from older versions. Before writing Next-specific code, read the relevant guide in `web/node_modules/next/dist/docs/`.
- **Globe colours** (objects, labels, counts): PAY `#fff4d6`, DEB `#ff6a3d`, R/B `#c4a8ff`, UNK `#bdbdbd`.
- **Chart colours** (lines, bars, legends, filter swatches): PAY `#b58f3c`, DEB `#d64a3f`, R/B `#957be0`, UNK `#8f8e88`.
- **Retired colours.** The old hexes `#3987e5`, `#d95926` and `#199e70` must not appear anywhere under `web/src`.
- **Earth palette is unchanged:** ocean `#2f6fd6`, land `#7fd06b`, coast `#0d1b2e`. The Earth shader keeps its ±9° (0.1564) Bayer twilight band.
- **No full-frame post-processing.** `@react-three/postprocessing` and `postprocessing` are removed.
- **Panel ids and defaults:** `overview` shown, `search` shown, `history` shown, `owners` shown, `filters` hidden, `chat` hidden.
  - Visibility persists in localStorage key `kessler.panels.v1`.
  - Every storage access is wrapped in try/catch; on failure the defaults apply.
- **Panel style:** `rgba(14,14,14,0.86)` background, `backdrop-filter: blur(6px)`, 2 px `#262626` border, 16 px radius.
- **Labels:**
  - At most **12** per update, recomputed at most every **250 ms**.
  - Shown when camera distance < **2.2** Earth radii, hidden again when > **2.4**.
  - Departure Mono 12 px, in the object's globe colour, on a `rgba(0,0,0,0.55)` pill, offset 8 px up-right.
- **Names endpoint:** `GET /api/globe/names?group=LEO|HIGH` returns `{"generated_at": str|null, "names": {"<norad_id>": "<name>"}}`.
  - Headers: `Cache-Control: public, max-age=300, s-maxage=21600` and an ETag (304 on If-None-Match).
- **Breakpoints:** phone < 640 px (bottom sheet), tablet 640–1023 px, desktop ≥ 1024 px.
- **Accessibility:** minimum text size 12 px. Respect `prefers-reduced-motion`.
- **Attribution** `Data: USSPACECOM via Space-Track.org; CelesTrak.` stays visible on the home page (in the overview panel).
- **Commits:** every commit message is a subject, a blank line, then the trailer lines. Use two `-m` flags. Never push.
- **Before each commit:**
  - `web/`: `npm run lint`, `npm run typecheck` and `npm test` pass. Tasks touching layout or e2e also run `npm run build` and `npm run e2e`, with no server left on port 3100.
  - `api/`: `uv run ruff check .` and `uv run pytest -q` pass.

## Review Focus

1. **localStorage is blocked or corrupt** (private mode, quota, bad JSON). The page must load with default panels and toggling must still work in-session. *(Tests: Task 3 `falls back to defaults when storage throws` and `ignores corrupt JSON`.)*
2. **The names request fails** (404 before the backend is deployed, 500, offline). Labels must simply not appear, with no uncaught error; a later zoom-in may retry after 60 s. *(Test: Task 6 `returns null on failure and retries after the cooldown`.)*
3. **The user hides every panel.** The globe stays usable and the dock remains to bring panels back, including after a reload. *(Test: Task 4 e2e `hiding all panels leaves the dock to restore them`.)*
4. **Short desktop windows** (1280×720). Corner panels must not overlap each other; a column scrolls instead. *(Test: Task 4 e2e `panels do not overlap at 1280x720`.)*
5. **The selected object is behind the Earth or off-screen.** It must not get a floating label pointing at nothing. *(Test: Task 7 `never labels occluded or off-screen objects, even when selected`.)*

---

## File Structure

```
api/app/services/globe.py            NEW  globe_names(conn, group) -> dict[str, str]
api/app/api/routes.py                MOD  GET /api/globe/names
api/tests/test_globe_names.py        NEW
web/src/lib/types.ts                 MOD  GLOBE_COLORS, CHART_COLORS (TYPE_COLORS removed)
web/src/app/globals.css              MOD  colour tokens, .panel class
web/src/lib/panels.ts                NEW  panel ids, defaults, load/save visibility
web/src/lib/store.ts                 MOD  panels state + actions
web/src/lib/useIsMobile.ts           NEW  matchMedia hook (< 640 px)
web/src/lib/camera.ts                NEW  initialDistance(aspect, fovDeg)
web/src/lib/names.ts                 NEW  lazy cached name lookup per group
web/src/lib/labels.ts                NEW  labelsActive, isOccluded, pickLabels
web/src/lib/api.ts                   MOD  api.names(group)
web/src/components/layout/Panel.tsx      NEW
web/src/components/layout/PanelDock.tsx  NEW
web/src/components/layout/MobileSheet.tsx NEW
web/src/components/panels/panelContent.tsx NEW  title + body per PanelId
web/src/components/panels/Overview.tsx   NEW  replaces Intro + StatTiles + Footer on home
web/src/components/panels/{Filters,ChatPanel,ObjectCard}.tsx  MOD  no Card wrapper
web/src/components/panels/{Intro,StatTiles}.tsx  DELETE
web/src/components/globe/GlobeSection.tsx  MOD  fixed full-screen stage, labels overlay container
web/src/components/globe/GlobeScene.tsx    MOD  no EffectComposer, LabelDriver
web/src/components/globe/LabelDriver.tsx   NEW  useFrame-throttled projection + DOM writes
web/src/components/globe/Objects.tsx       MOD  new colours, registers a label source
web/src/components/globe/objectGeometries.ts MOD neutral vertex colours
web/src/components/globe/earthMaterial.ts  MOD  surface grain
web/src/components/globe/DitherEffect.ts   DELETE
web/src/app/page.tsx                 MOD  mission-control composition
web/src/components/panels/Header.tsx MOD  (used on /about only)
web/tests/unit/{colors,panels,camera,names,labels,earthMaterial}.test.ts NEW; store.test.ts MOD
web/tests/fixtures/api/names-leo.json  NEW
web/e2e/explorer.spec.ts             MOD
```

---

### Task 1: API — `GET /api/globe/names`

**Files:**
- Create: `api/app/services/globe.py`, `api/tests/test_globe_names.py`
- Modify: `api/app/api/routes.py`

**Interfaces:**
- Consumes:
  - `SNAPSHOT_GROUPS` (`api/app/ingest/snapshot.py`).
  - `last_success(conn, "ingest_gp") -> datetime | None` (`api/app/ingest/runlog.py`).
  - Test fixtures `world`, `client`, `migrated`, `store` (`api/tests/test_api.py` / `conftest.py`).
- Produces: `app.services.globe.globe_names(conn, group: str) -> dict[str, str]` and the HTTP endpoint used by Task 6.

- [ ] **Step 1: Write the failing tests** — `api/tests/test_globe_names.py`

```python
from datetime import UTC, datetime

from app.services.globe import globe_names
from tests.test_api import client, make_client, store, world  # noqa: F401  (fixtures)

GP_SQL = (
    "INSERT INTO gp_elements (norad_id, epoch, mean_motion, eccentricity, inclination, raan, "
    "arg_pericenter, mean_anomaly, bstar, mean_motion_dot, mean_motion_ddot, source) "
    "VALUES (%s, %s, 15.5, 0.001, 53, 10, 20, 30, 0.0001, 0, 0, 'spacetrack')"
)


def add_gp(conn, *ids):
    for i in ids:
        conn.execute(GP_SQL, (i, datetime(2026, 9, 22, tzinfo=UTC)))


def test_names_follow_snapshot_groups(world):
    add_gp(world, 1, 2, 3, 4)  # 2 and 3 are decayed in seed_stats_world
    assert globe_names(world, "LEO") == {"1": "ALPHA SAT"}
    assert globe_names(world, "HIGH") == {"4": "GAMMA GEO"}


def test_names_endpoint_shape_and_cache_headers(client, world):
    add_gp(world, 1, 4)
    r = client.get("/api/globe/names?group=LEO")
    assert r.status_code == 200
    body = r.json()
    assert body["names"] == {"1": "ALPHA SAT"}
    assert "generated_at" in body
    assert r.headers["cache-control"] == "public, max-age=300, s-maxage=21600"
    etag = r.headers["etag"]
    again = client.get("/api/globe/names?group=LEO", headers={"If-None-Match": etag})
    assert again.status_code == 304


def test_names_endpoint_rejects_unknown_group(client):
    r = client.get("/api/globe/names?group=MARS")
    assert r.status_code == 422
    assert r.json()["error"]["code"]
```

Importing fixtures from `tests.test_api` is fine because pytest discovers fixtures by name. If ruff flags the unused-import pattern despite `noqa`, move `world`, `store`, `make_client` and `client` into `api/tests/conftest.py` unchanged, and import nothing.

- [ ] **Step 2: Run the tests and see them fail**

Run: `cd api && uv run pytest tests/test_globe_names.py -q`
Expected: `ModuleNotFoundError: No module named 'app.services.globe'`.

- [ ] **Step 3: Implement** — `api/app/services/globe.py`

```python
import psycopg

from app.ingest.snapshot import SNAPSHOT_GROUPS


def globe_names(conn: psycopg.Connection, group: str) -> dict[str, str]:
    """NORAD id -> name for the objects in a group's globe snapshot (same filter as
    write_snapshots: on orbit, has GP elements, regime in the group)."""
    rows = conn.execute(
        """
        SELECT o.norad_id, o.name
        FROM gp_elements g JOIN objects o USING (norad_id)
        WHERE o.decay_date IS NULL AND o.regime = ANY(%s)
        ORDER BY o.norad_id
        """,
        (list(SNAPSHOT_GROUPS[group]),),
    ).fetchall()
    return {str(r["norad_id"]): r["name"] for r in rows}
```

Add this to `api/app/api/routes.py`, below `globe_snapshot`. Add the imports `import json` and `from app.services.globe import globe_names`.

```python
@router.get("/globe/names")
def globe_names_route(
    request: Request,
    group: Literal["LEO", "HIGH"] = "LEO",
    conn: psycopg.Connection = Depends(get_conn),
) -> Response:
    generated = last_success(conn, "ingest_gp")
    body = json.dumps(
        {"generated_at": generated.isoformat() if generated else None,
         "names": globe_names(conn, group)},
        separators=(",", ":"),
    ).encode()
    etag = '"' + hashlib.sha1(body).hexdigest() + '"'
    headers = {"ETag": etag, "Cache-Control": "public, max-age=300, s-maxage=21600"}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    return Response(content=body, media_type="application/json", headers=headers)
```

- [ ] **Step 4: Run the tests**

Run: `cd api && uv run ruff check . && uv run pytest -q` → all pass (3 new).

- [ ] **Step 5: Commit**

```bash
git add api/app/services/globe.py api/app/api/routes.py api/tests/test_globe_names.py
git commit -m "feat(api): /api/globe/names for globe labels" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 2: New colour set and crisp objects (no post-process dither)

**Files:**
- Modify:
  - `web/src/lib/types.ts`, `web/src/app/globals.css`
  - `web/src/components/charts/LineChart.tsx`, `web/src/components/charts/BarChart.tsx`
  - `web/src/components/panels/Filters.tsx`, `web/src/components/panels/StatTiles.tsx`, `web/src/components/panels/Header.tsx`
  - `web/src/components/globe/Objects.tsx`, `web/src/components/globe/objectGeometries.ts`, `web/src/components/globe/GlobeScene.tsx`, `web/src/components/globe/earthMaterial.ts`
  - `web/src/components/globe/GlobeErrorBoundary.tsx` (comment only)
  - `web/src/app/page.tsx` (comment only)
  - `web/package.json`, `web/package-lock.json`
- Delete: `web/src/components/globe/DitherEffect.ts`
- Test: `web/tests/unit/colors.test.ts`, `web/tests/unit/earthMaterial.test.ts`

**Interfaces:**
- Produces: `GLOBE_COLORS: Record<ObjectType, string>` and `CHART_COLORS: Record<ObjectType, string>` from `@/lib/types`, replacing `TYPE_COLORS`. The Earth shader gains uniform `grain` (0.04).

- [ ] **Step 1: Write the failing tests**

`web/tests/unit/colors.test.ts`:

```ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CHART_COLORS, GLOBE_COLORS } from "@/lib/types";

const SRC = fileURLToPath(new URL("../../src", import.meta.url));
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

describe("colour set", () => {
  it("uses the approved globe and chart colours", () => {
    expect(GLOBE_COLORS).toEqual({ PAY: "#fff4d6", DEB: "#ff6a3d", "R/B": "#c4a8ff", UNK: "#bdbdbd" });
    expect(CHART_COLORS).toEqual({ PAY: "#b58f3c", DEB: "#d64a3f", "R/B": "#957be0", UNK: "#8f8e88" });
  });

  it("no source file uses the retired colours", () => {
    const offenders = walk(SRC).filter((f) => /#3987e5|#d95926|#199e70/i.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("nothing imports full-frame postprocessing", () => {
    const offenders = walk(SRC).filter((f) => /from "(@react-three\/)?postprocessing"/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
```

`web/tests/unit/earthMaterial.test.ts`:

```ts
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { createEarthMaterial } from "@/components/globe/earthMaterial";

describe("earth material", () => {
  it("keeps the twilight band and adds a subtle surface grain", () => {
    const m = createEarthMaterial(new THREE.Texture());
    expect(m.uniforms.band.value).toBeCloseTo(0.1564, 4);
    expect(m.uniforms.grain.value).toBeCloseTo(0.04, 5);
    expect(m.fragmentShader).toContain("grain");
  });
});
```

Run: `cd web && npx vitest run tests/unit/colors.test.ts tests/unit/earthMaterial.test.ts`
Expected: FAIL. `CHART_COLORS` and `GLOBE_COLORS` are not exported, the retired hexes are found in several files, and `uniforms.grain` is undefined.

- [ ] **Step 2: Colour constants and tokens**

In `web/src/lib/types.ts`, replace `TYPE_COLORS` with:

```ts
/** Bright step: objects on the globe, labels and headline counts (must read over the blue/green Earth). */
export const GLOBE_COLORS: Record<ObjectType, string> = {
  PAY: "#fff4d6",
  "R/B": "#c4a8ff",
  DEB: "#ff6a3d",
  UNK: "#bdbdbd",
};
/** Deeper step: chart marks and legends on #0e0e0e (validated: dark mode, all pairs). */
export const CHART_COLORS: Record<ObjectType, string> = {
  PAY: "#b58f3c",
  "R/B": "#957be0",
  DEB: "#d64a3f",
  UNK: "#8f8e88",
};
```

In `web/src/app/globals.css`, replace the three `--color-pay/deb/rb` lines with:

```css
  --color-pay-globe: #fff4d6;
  --color-deb-globe: #ff6a3d;
  --color-rb-globe: #c4a8ff;
  --color-pay-chart: #b58f3c;
  --color-deb-chart: #d64a3f;
  --color-rb-chart: #957be0;
```

- [ ] **Step 3: Update the consumers**
  - **Charts and filters:** `LineChart.tsx`, `BarChart.tsx` and `Filters.tsx` import `CHART_COLORS` instead of `TYPE_COLORS`; it's the same indexing, just the renamed constant.
  - **Stat tiles:** in `StatTiles.tsx`, replace each tile's `color` literal with `GLOBE_COLORS.PAY`, `GLOBE_COLORS.DEB` and `GLOBE_COLORS["R/B"]` (this file is deleted in Task 4; keep it compiling until then).
  - **Header:** in `Header.tsx`, the `PixelIcon` colour becomes `GLOBE_COLORS.PAY`.
  - **`objectGeometries.ts`:** in `createSatelliteGeometry`, use neutral tints so the material colour sets the hue. Update the doc comment to "Satellite: neutral body/panels; the material colour (payload globe colour) tints it."

```ts
  return mergeGeometries([tint(body, "#ffffff"), tint(p1, "#cfd3da"), tint(p2, "#cfd3da"), tint(dish, "#e6e6e6")])!;
```

  - **`Objects.tsx` materials:**

```ts
      sat: new THREE.MeshToonMaterial({ vertexColors: true, color: GLOBE_COLORS.PAY, gradientMap: ramp, emissive: "#2a2620" }),
      rb: new THREE.MeshToonMaterial({ color: GLOBE_COLORS["R/B"], gradientMap: ramp, emissive: "#231a3a" }),
      deb: new THREE.MeshToonMaterial({ color: GLOBE_COLORS.DEB, gradientMap: ramp, emissive: "#3a1206" }),
```

- [ ] **Step 4: Remove the post-process dither and move a subtle grain into the Earth shader**
  - **`GlobeScene.tsx`:** delete the `EffectComposer` import, the `DitherEffectImpl` import, the `dither` `useMemo`, and the `<EffectComposer>…</EffectComposer>` element. Remove `useMemo` from the React import if it's now unused.
  - **Delete** `web/src/components/globe/DitherEffect.ts`.
  - **Dependencies:** `cd web && npm uninstall @react-three/postprocessing postprocessing`.
  - **Comments:** update the comments in `page.tsx` and `GlobeErrorBoundary.tsx` that mention postprocessing, so they no longer claim it's in use.
  - **`earthMaterial.ts`:** add `uniform float grain;` to the fragment shader, and inside `main()` replace the first line, `vec3 base = texture2D(map, vUv).rgb;`, with:

```glsl
  vec3 base = texture2D(map, vUv).rgb;
  // Subtle ordered-dither texture on the Earth only (objects stay crisp): ±grain brightness.
  base *= 1.0 + grain * 2.0 * (bayer4(floor(gl_FragCoord.xy / cellSize)) - 0.5);
```

and add `grain: { value: 0.04 },` to `uniforms`. Update the top comment to mention the surface grain.

- [ ] **Step 5: Verify**

Run: `cd web && npm run lint && npm run typecheck && npm test && npm run build`. Everything passes, and the build output has no postprocessing chunk.
Run `npm run e2e`. The existing e2e suite still passes, since only colours and the effect changed.

Visual check: run `npm run dev` against the local API (`api/README.md`). Screenshot the globe at 1440×900 to `.superpowers/sdd/<workspace>/shots/task-2-globe.png`, and confirm that objects are crisp and in the new colours while the Earth still shows its twilight dither.

- [ ] **Step 6: Commit**

```bash
git add -A web
git commit -m "feat(web): new object colours, crisp objects, Earth-only dither" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 3: Panel visibility state

**Files:**
- Create: `web/src/lib/panels.ts`, `web/tests/unit/panels.test.ts`
- Modify: `web/src/lib/store.ts`, `web/tests/unit/store.test.ts`

**Interfaces:**
- Produces:
  - `type PanelId = "overview" | "search" | "history" | "owners" | "filters" | "chat"`
  - `PANELS: readonly { id: PanelId; title: string }[]`
  - `DEFAULT_VISIBILITY: Record<PanelId, boolean>`
  - `STORAGE_KEY = "kessler.panels.v1"`
  - `loadVisibility(storage: Pick<Storage, "getItem"> | null): Record<PanelId, boolean>`
  - `saveVisibility(storage: Pick<Storage, "setItem"> | null, v: Record<PanelId, boolean>): void`
  - `browserStorage(): Storage | null`
  - Store additions: `panels: Record<PanelId, boolean>`, `setPanel(id, shown)`, `togglePanel(id)`, `hydratePanels()`. `select(id)` with a non-null id also shows `search`.

- [ ] **Step 1: Write the failing tests** — `web/tests/unit/panels.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_VISIBILITY, loadVisibility, PANELS, saveVisibility, STORAGE_KEY } from "@/lib/panels";

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};

describe("panels", () => {
  it("lists six panels in dock order with the spec defaults", () => {
    expect(PANELS.map((p) => p.id)).toEqual(["overview", "search", "history", "owners", "filters", "chat"]);
    expect(DEFAULT_VISIBILITY).toEqual({ overview: true, search: true, history: true, owners: true, filters: false, chat: false });
  });

  it("round-trips through storage", () => {
    const s = mem();
    saveVisibility(s, { ...DEFAULT_VISIBILITY, history: false, filters: true });
    expect(JSON.parse(s.m.get(STORAGE_KEY)!)).toMatchObject({ history: false, filters: true });
    expect(loadVisibility(s)).toEqual({ ...DEFAULT_VISIBILITY, history: false, filters: true });
  });

  it("falls back to defaults when storage throws", () => {
    const boom = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("QuotaExceeded"); } };
    expect(loadVisibility(boom)).toEqual(DEFAULT_VISIBILITY);
    expect(() => saveVisibility(boom, DEFAULT_VISIBILITY)).not.toThrow();
    expect(loadVisibility(null)).toEqual(DEFAULT_VISIBILITY);
  });

  it("ignores corrupt JSON and unknown or non-boolean keys", () => {
    const s = mem();
    s.m.set(STORAGE_KEY, "{not json");
    expect(loadVisibility(s)).toEqual(DEFAULT_VISIBILITY);
    s.m.set(STORAGE_KEY, JSON.stringify({ owners: false, bogus: true, search: "yes" }));
    expect(loadVisibility(s)).toEqual({ ...DEFAULT_VISIBILITY, owners: false });
  });
});
```

Append to `web/tests/unit/store.test.ts`:

```ts
describe("panel visibility in the store", () => {
  it("starts from the defaults and toggles", () => {
    const s = useExplorer.getState();
    expect(s.panels.filters).toBe(false);
    s.togglePanel("filters");
    expect(useExplorer.getState().panels.filters).toBe(true);
    useExplorer.getState().setPanel("history", false);
    expect(useExplorer.getState().panels.history).toBe(false);
  });

  it("selecting an object reveals the search panel", () => {
    useExplorer.getState().setPanel("search", false);
    useExplorer.getState().select(25544);
    expect(useExplorer.getState().panels.search).toBe(true);
  });
});
```

Run: `cd web && npx vitest run tests/unit/panels.test.ts tests/unit/store.test.ts`. It fails with "Cannot find module '@/lib/panels'" and `panels` undefined.

- [ ] **Step 2: Implement** — `web/src/lib/panels.ts`

```ts
export type PanelId = "overview" | "search" | "history" | "owners" | "filters" | "chat";

export const PANELS: readonly { id: PanelId; title: string }[] = [
  { id: "overview", title: "Overview" },
  { id: "search", title: "Search" },
  { id: "history", title: "History" },
  { id: "owners", title: "Owners" },
  { id: "filters", title: "Filters" },
  { id: "chat", title: "Ask AI" },
];

export const DEFAULT_VISIBILITY: Record<PanelId, boolean> = {
  overview: true, search: true, history: true, owners: true, filters: false, chat: false,
};

export const STORAGE_KEY = "kessler.panels.v1";

export function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function loadVisibility(storage: Pick<Storage, "getItem"> | null): Record<PanelId, boolean> {
  const out = { ...DEFAULT_VISIBILITY };
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return out;
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      for (const p of PANELS) {
        const v = (parsed as Record<string, unknown>)[p.id];
        if (typeof v === "boolean") out[p.id] = v;
      }
    }
  } catch {
    return { ...DEFAULT_VISIBILITY };
  }
  return out;
}

export function saveVisibility(storage: Pick<Storage, "setItem"> | null, v: Record<PanelId, boolean>): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(v));
  } catch {
    // Private mode / quota: keep the in-memory state only.
  }
}
```

In `web/src/lib/store.ts`:
- Import `{ browserStorage, DEFAULT_VISIBILITY, loadVisibility, saveVisibility, type PanelId }`.
- Add the field and actions to `ExplorerState`:

```ts
  panels: Record<PanelId, boolean>;
  setPanel: (id: PanelId, shown: boolean) => void;
  togglePanel: (id: PanelId) => void;
  hydratePanels: () => void;
```

- Add `panels: { ...DEFAULT_VISIBILITY }` to `initial()`.
- Add the implementations:

```ts
  setPanel: (id, shown) =>
    set((s) => {
      const panels = { ...s.panels, [id]: shown };
      saveVisibility(browserStorage(), panels);
      return { panels };
    }),
  togglePanel: (id) =>
    set((s) => {
      const panels = { ...s.panels, [id]: !s.panels[id] };
      saveVisibility(browserStorage(), panels);
      return { panels };
    }),
  hydratePanels: () => set({ panels: loadVisibility(browserStorage()) }),
```

- Change `select` so selecting reveals the search panel. Do not persist that reveal:

```ts
  select: (id) => set((s) => (id === null ? { selectedId: null } : { selectedId: id, panels: { ...s.panels, search: true } })),
```

In the Vitest node environment `window` is undefined, so `browserStorage()` returns null and the store tests stay pure.

- [ ] **Step 3: Run the tests**

`cd web && npx vitest run tests/unit/panels.test.ts tests/unit/store.test.ts` → pass; `npm test`, `npm run lint`, `npm run typecheck` → pass.

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/panels.ts web/src/lib/store.ts web/tests/unit/panels.test.ts web/tests/unit/store.test.ts
git commit -m "feat(web): panel visibility state with safe persistence" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 4: Mission-control layout (desktop and tablet)

**Files:**
- Create:
  - `web/src/lib/camera.ts`, `web/tests/unit/camera.test.ts`
  - `web/src/components/layout/Panel.tsx`, `web/src/components/layout/PanelDock.tsx`
  - `web/src/components/panels/panelContent.tsx`, `web/src/components/panels/Overview.tsx`
- Modify:
  - `web/src/app/page.tsx`, `web/src/app/globals.css`
  - `web/src/components/globe/GlobeSection.tsx`, `web/src/components/globe/GlobeScene.tsx`
  - `web/src/components/panels/{Filters,ChatPanel,ObjectCard}.tsx`
  - `web/src/app/about/page.tsx` (it imports Footer; keep it)
  - `web/e2e/explorer.spec.ts`
- Delete: `web/src/components/panels/Intro.tsx`, `web/src/components/panels/StatTiles.tsx`

**Interfaces:**
- Consumes: the store `panels`, `setPanel`, `togglePanel` and `hydratePanels`, plus `PANELS` and `PanelId` (Task 3); `GLOBE_COLORS` and `CHART_COLORS` (Task 2).
- Produces:
  - `initialDistance(aspect: number, fovDeg?: number): number`
  - `<Panel id title>`, `<PanelDock />`
  - `PANEL_CONTENT: Record<PanelId, (ctx: PanelCtx) => React.ReactNode>`, where `PanelCtx = { meta; ts; bars }` (the page's `Load<T>` states)
  - `GlobeSection` renders as a fixed full-viewport stage and contains an empty `div[data-testid="globe-labels"]` overlay container that Task 7 fills.

- [ ] **Step 1: Camera framing, tested first** — `web/tests/unit/camera.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { initialDistance } from "@/lib/camera";

describe("initialDistance", () => {
  it("frames the Earth at ~60% of the vertical field on landscape screens", () => {
    // vfov 40° -> target 24° -> d = 1 / sin(12°)
    expect(initialDistance(16 / 9)).toBeCloseTo(1 / Math.sin((12 * Math.PI) / 180), 3);
  });
  it("uses the narrower horizontal field on portrait phones", () => {
    const hfov = 2 * Math.atan(Math.tan((20 * Math.PI) / 180) * 0.46);
    expect(initialDistance(0.46)).toBeCloseTo(1 / Math.sin((0.6 * hfov) / 2), 3);
  });
});
```

Implement `web/src/lib/camera.ts`:

```ts
/** Camera distance (Earth radii) at which the Earth spans ~60% of the smaller field of view. */
export function initialDistance(aspect: number, fovDeg = 40): number {
  const v = (fovDeg * Math.PI) / 180;
  const h = 2 * Math.atan(Math.tan(v / 2) * aspect);
  return 1 / Math.sin((0.6 * Math.min(v, h)) / 2);
}
```

In `GlobeScene.tsx`:
- Add a mount effect that places the camera. Keep the existing view direction, and use `size` from `useThree((s) => s.size)`:

```ts
  const size = useThree((s) => s.size);
  useEffect(() => {
    const dir = new THREE.Vector3(0.6, 0.9, 3.6).normalize();
    camera.position.copy(dir.multiplyScalar(initialDistance(size.width / Math.max(size.height, 1))));
    camera.lookAt(0, 0, 0);
    // Once, at mount: later resizes keep whatever zoom the user chose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera]);
```

- Raise OrbitControls' `maxDistance` from `9` to `12`, since portrait phones start around 10.2.

- [ ] **Step 2: Panel chrome** — add to `globals.css`:

```css
.panel {
  pointer-events: auto;
  background: rgba(14, 14, 14, 0.86);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  border: 2px solid var(--color-line);
  border-radius: 16px;
  padding: 14px;
}
```

`web/src/components/layout/Panel.tsx`:

```tsx
"use client";

import type { PanelId } from "@/lib/panels";
import { useExplorer } from "@/lib/store";

export function Panel({ id, title, children, className = "" }: { id: PanelId; title: string; children: React.ReactNode; className?: string }) {
  const shown = useExplorer((s) => s.panels[id]);
  const setPanel = useExplorer((s) => s.setPanel);
  if (!shown) return null;
  return (
    <section className={`panel ${className}`} aria-label={title} data-panel={id}>
      <header className="mb-2 flex items-center justify-between gap-3">
        <h2 className="font-mono text-[14px] text-ink">{title}</h2>
        <button type="button" onClick={() => setPanel(id, false)} aria-label={`Hide ${title}`} className="px-1 text-[16px] leading-none text-ink-2 hover:text-ink">×</button>
      </header>
      {children}
    </section>
  );
}
```

`web/src/components/layout/PanelDock.tsx`:

```tsx
"use client";

import { PANELS } from "@/lib/panels";
import { useExplorer } from "@/lib/store";

export function PanelDock() {
  const panels = useExplorer((s) => s.panels);
  const togglePanel = useExplorer((s) => s.togglePanel);
  return (
    <nav aria-label="Panels" data-testid="panel-dock" className="pointer-events-auto flex max-w-full flex-wrap justify-center gap-1.5">
      {PANELS.map((p) => (
        <button
          key={p.id}
          type="button"
          aria-pressed={panels[p.id]}
          onClick={() => togglePanel(p.id)}
          className={`rounded-full border px-3 py-1 text-[13px] backdrop-blur ${panels[p.id] ? "border-ink/70 bg-[#141414]/90 text-ink" : "border-line bg-[#0b0b0b]/80 text-ink-3"}`}
        >
          {p.title}
        </button>
      ))}
    </nav>
  );
}
```

- [ ] **Step 3: Panel contents**
  - Strip the `Card` wrappers from `Filters.tsx`, `ChatPanel.tsx` and `ObjectCard.tsx`. Each returns its inner content in a plain `<div>` and keeps its existing `aria-label` and `data-testid` on that div: ObjectCard keeps `data-testid="object-card"`, and its heading stays inside.
  - **Delete** `Intro.tsx` and `StatTiles.tsx`.

`web/src/components/panels/Overview.tsx` (it keeps the `tile-<TYPE>` test ids so the counts stay testable):

```tsx
"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { fmtDate } from "@/lib/format";
import { countUp } from "@/lib/motion";
import { GLOBE_COLORS, TYPE_LABELS, type Meta, type ObjectType } from "@/lib/types";
import { ATTRIBUTION } from "@/components/panels/Footer";
import { Unavailable } from "@/components/ui/Unavailable";

const TYPES: ObjectType[] = ["PAY", "DEB", "R/B"];

function Count({ type, value, index }: { type: ObjectType; value: number | null; index: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!ref.current || value === null) return;
    const anim = countUp(ref.current, value, 300 + index * 120);
    return () => {
      anim?.cancel();
    };
  }, [value, index]);
  return (
    <div data-testid={`tile-${type}`} className="flex items-baseline justify-between gap-3">
      <span className="text-[13px] text-ink-2">{TYPE_LABELS[type]}</span>
      <span ref={ref} className="font-mono text-[20px] tabular-nums" style={{ color: GLOBE_COLORS[type] }}>{value === null ? "—" : "0"}</span>
    </div>
  );
}

export function Overview({ meta, error }: { meta: Meta | null; error: boolean }) {
  const asOf = meta?.data_as_of.gp ?? meta?.data_as_of.satcat ?? null;
  return (
    <div>
      <p className="font-mono text-[22px] leading-tight text-ink">KESSLER</p>
      <p className="mt-1 text-[13px] leading-snug text-ink-2">Every tracked object in Earth orbit, 1957 to now.</p>
      <p className="label mt-3">In low Earth orbit now</p>
      {error ? <Unavailable what="object counts" /> : (
        <div className="mt-1 flex flex-col gap-1">{TYPES.map((t, i) => <Count key={t} type={t} index={i} value={meta?.in_orbit[t]?.LEO ?? null} />)}</div>
      )}
      <p className="mt-3 font-mono text-[12px] text-ink-3">{ATTRIBUTION}{asOf ? ` Updated ${fmtDate(asOf)}.` : ""}</p>
      <p className="mt-2 flex gap-4 text-[13px] text-ink-2">
        <Link href="/about" className="hover:text-ink">About</Link>
        <a href="https://kudayyurter.dev" className="hover:text-ink">kudayyurter.dev ↗</a>
      </p>
    </div>
  );
}
```

`web/src/components/panels/panelContent.tsx`:

```tsx
"use client";

import { chartTitle } from "@/lib/chartData";
import type { PanelId } from "@/lib/panels";
import type { BreakdownResponse, Meta, TimeseriesResponse } from "@/lib/types";
import { BarChart } from "@/components/charts/BarChart";
import { LineChart } from "@/components/charts/LineChart";
import { ChatPanel } from "@/components/panels/ChatPanel";
import { Filters } from "@/components/panels/Filters";
import { ObjectCard } from "@/components/panels/ObjectCard";
import { Overview } from "@/components/panels/Overview";
import { SearchBox } from "@/components/panels/SearchBox";
import { Unavailable } from "@/components/ui/Unavailable";

export type Load<T> = { data: T | null; error: boolean };
export type PanelCtx = { meta: Load<Meta>; ts: Load<TimeseriesResponse>; bars: Load<BreakdownResponse> };

export const PANEL_CONTENT: Record<PanelId, (c: PanelCtx) => React.ReactNode> = {
  overview: (c) => <Overview meta={c.meta.data} error={c.meta.error} />,
  search: () => (
    <div className="flex flex-col gap-3">
      <SearchBox />
      <ObjectCard />
    </div>
  ),
  history: (c) => (
    <div aria-label="History chart">
      <h3 className="font-mono text-[15px] text-ink">{c.ts.data ? chartTitle(c.ts.data) : "Objects in orbit by type"}</h3>
      <p className="mt-1 text-[12px] leading-snug text-ink-2">Objects in orbit at the end of each year.</p>
      <div className="mt-2">{c.ts.error ? <Unavailable what="yearly history" /> : c.ts.data && <LineChart data={c.ts.data} />}</div>
    </div>
  ),
  owners: (c) => (
    <div aria-label="Owners chart">
      <h3 className="font-mono text-[15px] text-ink">Who owns what&apos;s up there</h3>
      <div className="mt-2">{c.bars.error ? <Unavailable what="owners" /> : c.bars.data && <BarChart data={c.bars.data} owners={c.meta.data?.owners ?? []} />}</div>
    </div>
  ),
  filters: (c) => <Filters meta={c.meta.data} />,
  chat: () => <ChatPanel />,
};
```

The panel `title` (from `PANELS`) is the small header label, and the chart keeps its own h3 heading (for example "Payloads overtook debris in 2024"), so the existing e2e heading assertion still holds with `getByRole("heading", …)`.

- [ ] **Step 4: The stage and page composition**

`GlobeSection.tsx`:
- Change the outer `<section>` to `className="fixed inset-0"` (drop `card`, `relative`, the fixed heights and `overflow-hidden`), and keep its `aria-label`.
- Change the Canvas `camera` prop to `{ position: [0.6, 0.9, 3.6], fov: 40, near: 0.005, far: 100 }`; GlobeScene reframes it on mount.
- Move the status messages and the no-WebGL message into a centred block: `pointer-events-none absolute inset-x-0 top-1/2 flex -translate-y-1/2 flex-col items-center gap-1 text-center`.
- Move the Readout and the Live/Fast buttons to a bottom-centre stack: `absolute bottom-4 left-1/2 flex -translate-x-1/2 flex-col items-center gap-2`.
- Add an empty overlay for Task 7, as the last child of the section:

```tsx
      <div ref={labelsRef} data-testid="globe-labels" aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden" />
```

  Here `labelsRef` is `useRef<HTMLDivElement>(null)`. Pass it to `<GlobeScene … labelsRef={labelsRef} />` and add `labelsRef?: React.RefObject<HTMLDivElement | null>` to GlobeScene's props; it stays unused until Task 7.

`web/src/app/page.tsx`:
- Keep the three data effects (meta, the ts/bars fetch with its `cancelled` guard) and the dynamic `GlobeSection` import. Change the loading placeholder to `<section className="fixed inset-0" aria-label="Live globe of tracked objects" />`.
- Remove the stagger-in animation and the `Header`, `Footer`, `Intro`, `StatTiles`, `Card` and `chartTitle` imports; the charts now render through `PANEL_CONTENT`.
- Call `hydratePanels` once on mount:

```tsx
  const hydratePanels = useExplorer((s) => s.hydratePanels);
  useEffect(() => hydratePanels(), [hydratePanels]);
```

- Render:

```tsx
  const ctx: PanelCtx = { meta, ts, bars };
  const panel = (id: PanelId, extra = "") => (
    <Panel id={id} title={PANELS.find((p) => p.id === id)!.title} className={extra}>{PANEL_CONTENT[id](ctx)}</Panel>
  );
  return (
    <main className="h-dvh overflow-hidden">
      <GlobeSection />
      <div className="pointer-events-none fixed inset-x-0 top-3 z-20 flex justify-center px-[calc(theme(spacing.4)+var(--col))]" style={{ ["--col" as string]: "clamp(320px, 28vw, 380px)" }}>
        <PanelDock />
      </div>
      <div className="pointer-events-none fixed bottom-4 left-4 top-14 z-10 flex w-[clamp(320px,28vw,380px)] flex-col justify-between gap-3 overflow-y-auto">
        <div className="flex flex-col gap-3">{panel("overview")}{panel("filters")}</div>
        {panel("history")}
      </div>
      <div className="pointer-events-none fixed bottom-4 right-4 top-14 z-10 flex w-[clamp(320px,26vw,360px)] flex-col justify-between gap-3 overflow-y-auto">
        <div className="flex flex-col gap-3">{panel("search")}{panel("chat")}</div>
        {panel("owners")}
      </div>
    </main>
  );
```

  The columns are pointer-transparent (`pointer-events-none`), and panels re-enable pointer events through the `.panel` class, so the globe can be dragged in the gaps between them. At 640–1023 px the clamps give 320 px columns, and the dock wraps within the middle gap. Task 5 replaces the columns below 640 px. If Tailwind v4 rejects the `theme(spacing.4)` expression inside the arbitrary value, use `px-[calc(16px+var(--col))]`, and note it in the report.

`web/src/app/about/page.tsx` keeps using `Header` and `Footer`, unchanged.

- [ ] **Step 5: e2e updates and new layout tests** — `web/e2e/explorer.spec.ts`
  - **"explorer renders…":** keep it as is. It checks `tile-PAY` containing "17,750", the history heading, one canvas, 3 series, and the attribution text, which is now in the overview panel.
  - **"ignores a stale timeseries response…":** before `getByRole("button", { name: "Debris" }).click()`, open the filters panel with `await page.getByTestId("panel-dock").getByRole("button", { name: "Filters" }).click();`.
  - **"a broken globe render…":** keep it. Its tile and chart assertions still hold.
  - **"no horizontal overflow at 390px":** moves to Task 5. Wrap it in `test.skip(true, "re-enabled in Task 5 (mobile sheet)")` for now.
  - **Add these new tests:**

```ts
test("globe fills the viewport with no card frame", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockApi(page);
  await page.goto("/");
  const box = await page.locator("canvas").boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(1440 - 1);
  expect(box?.height).toBeGreaterThanOrEqual(900 - 1);
  await expect(page.locator("section.card")).toHaveCount(0);
});

test("a panel hides with × and comes back from the dock, across reloads", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Hide History" }).click();
  await expect(page.locator('[data-panel="history"]')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('[data-panel="history"]')).toHaveCount(0);
  await page.getByTestId("panel-dock").getByRole("button", { name: "History" }).click();
  await expect(page.locator('[data-panel="history"]')).toBeVisible();
});

test("hiding all panels leaves the dock to restore them", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  for (const name of ["Overview", "Search", "History", "Owners"]) {
    await page.getByRole("button", { name: `Hide ${name}` }).click();
  }
  await expect(page.locator("[data-panel]")).toHaveCount(0);
  await expect(page.locator("canvas")).toBeVisible();
  await page.getByTestId("panel-dock").getByRole("button", { name: "Overview" }).click();
  await expect(page.getByTestId("tile-PAY")).toBeVisible();
});

test("panels do not overlap at 1280x720", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await mockApi(page);
  await page.goto("/");
  await expect(page.locator("path[data-series]")).toHaveCount(3, { timeout: 10_000 });
  const boxes = await page.locator("[data-panel]").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()));
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const overlap = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      expect(overlap, `panels ${i} and ${j} overlap`).toBe(false);
    }
});
```

  Playwright gives each test a fresh browser context, so localStorage never leaks from one test into another.

- [ ] **Step 6: Verify and commit**

Run: `cd web && npm run lint && npm run typecheck && npm test && npm run build && npm run e2e`. All pass, with the 390 px test skipped.

Visual check: take screenshots at 1440×900 and 1024×768 with the local API into the workspace `shots/` folder. Confirm that the globe is centred in open space, the panels sit in the side columns, the dock is at the top, and the Live/Fast controls are at the bottom.

```bash
git add -A web
git commit -m "feat(web): mission-control layout with hideable floating panels" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 5: Phone layout — bottom sheet

**Files:**
- Create: `web/src/lib/useIsMobile.ts`, `web/src/components/layout/MobileSheet.tsx`
- Modify: `web/src/app/page.tsx`, `web/e2e/explorer.spec.ts`

**Interfaces:**
- Consumes: `PANEL_CONTENT` and `PanelCtx`, plus `PANELS` (Task 4).
- Produces:
  - `useIsMobile(): boolean`: true below 640 px; false on the server and in the first client render.
  - `<MobileSheet ctx={PanelCtx} />`

- [ ] **Step 1: e2e first** — replace the skipped 390 px test with:

```ts
test("phone: bottom sheet with tabs, no horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApi(page);
  await page.goto("/");
  await expect(page.locator("canvas")).toBeVisible();
  const sheet = page.getByTestId("mobile-sheet");
  await expect(sheet).toBeVisible();
  await expect(page.getByTestId("panel-dock")).toHaveCount(0);
  await sheet.getByRole("tab", { name: "History" }).click();
  await expect(page.locator("path[data-series]")).toHaveCount(3, { timeout: 10_000 });
  await sheet.getByRole("tab", { name: "Overview" }).click();
  await expect(page.getByTestId("tile-PAY")).toContainText("17,750");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
```

Run: `cd web && npx playwright test -g "phone"`. It fails because there is no `mobile-sheet`.

- [ ] **Step 2: Implement**

`web/src/lib/useIsMobile.ts`:

```ts
"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(max-width: 639px)";

function subscribe(cb: () => void) {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(QUERY).matches, () => false);
}
```

`web/src/components/layout/MobileSheet.tsx`:

```tsx
"use client";

import { useState } from "react";
import { PANELS, type PanelId } from "@/lib/panels";
import { PANEL_CONTENT, type PanelCtx } from "@/components/panels/panelContent";

export function MobileSheet({ ctx }: { ctx: PanelCtx }) {
  const [active, setActive] = useState<PanelId>("overview");
  const [open, setOpen] = useState(true);
  return (
    <div data-testid="mobile-sheet" className="panel fixed inset-x-2 bottom-2 z-20 max-h-[60dvh] !p-0">
      <div role="tablist" aria-label="Panels" className="flex gap-1 overflow-x-auto border-b-2 border-line px-2 py-2">
        {PANELS.map((p) => (
          <button
            key={p.id}
            role="tab"
            type="button"
            aria-selected={active === p.id}
            onClick={() => {
              setActive(p.id);
              setOpen(true);
            }}
            className={`shrink-0 rounded-full px-3 py-1 text-[13px] ${active === p.id ? "bg-[#1c1c1c] text-ink" : "text-ink-2"}`}
          >
            {p.title}
          </button>
        ))}
        <button type="button" onClick={() => setOpen((o) => !o)} aria-label={open ? "Collapse panel" : "Expand panel"} className="ml-auto shrink-0 px-2 text-ink-2">
          {open ? "▾" : "▴"}
        </button>
      </div>
      {open && <div role="tabpanel" aria-label={PANELS.find((p) => p.id === active)!.title} className="max-h-[calc(60dvh-52px)] overflow-y-auto p-3">{PANEL_CONTENT[active](ctx)}</div>}
    </div>
  );
}
```

In `page.tsx`, add `const isMobile = useIsMobile();`. When `isMobile` is true, render `<GlobeSection />` and `<MobileSheet ctx={ctx} />` only, with no dock or columns. Otherwise render the Task 4 layout.

Selecting an object on the phone should jump the sheet to Search. In MobileSheet, subscribe with `const selectedId = useExplorer((s) => s.selectedId);` and add:

```tsx
  useEffect(() => {
    if (selectedId !== null) {
      setActive("search");
      setOpen(true);
    }
  }, [selectedId]);
```

If `react-hooks/set-state-in-effect` flags it, add the same justified single-line disable that ObjectCard uses (a reaction to an external selection event).

- [ ] **Step 3: Verify and commit**

Run: `cd web && npm run lint && npm run typecheck && npm test && npm run build && npm run e2e`. Everything passes, including "phone:".

Visual check: take a 390×844 screenshot to `shots/task-5-phone.png`.

```bash
git add -A web
git commit -m "feat(web): phone bottom sheet with panel tabs" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 6: Name lookup client

**Files:**
- Create: `web/src/lib/names.ts`, `web/tests/unit/names.test.ts`, `web/tests/fixtures/api/names-leo.json`
- Modify: `web/src/lib/api.ts`, `web/tests/unit/api.test.ts`, `web/e2e/explorer.spec.ts` (mock route only)

**Interfaces:**
- Consumes: the `GET /api/globe/names` endpoint (Task 1).
- Produces:
  - `api.names(group: "LEO" | "HIGH"): Promise<Record<string, string>>`, which throws `ApiRequestError` on non-2xx.
  - `createNameCache(fetcher, now = Date.now, cooldownMs = 60_000)` returns `{ get(group): Promise<Map<number, string> | null>; peek(group): Map<number, string> | null }`.
  - `nameCache`, the app singleton built on `api.names`.

- [ ] **Step 1: Write the failing tests** — `web/tests/unit/names.test.ts`

```ts
import { describe, expect, it, vi } from "vitest";
import { createNameCache } from "@/lib/names";

describe("name cache", () => {
  it("fetches a group once and serves it from memory", async () => {
    const fetcher = vi.fn(async () => ({ "25544": "ISS (ZARYA)" }));
    const c = createNameCache(fetcher);
    const [a, b] = await Promise.all([c.get("LEO"), c.get("LEO")]);
    expect(a?.get(25544)).toBe("ISS (ZARYA)");
    expect(b).toBe(a);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(c.peek("LEO")?.get(25544)).toBe("ISS (ZARYA)");
    expect(c.peek("HIGH")).toBeNull();
  });

  it("returns null on failure and retries after the cooldown", async () => {
    let t = 0;
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("404")).mockResolvedValue({ "1": "A" });
    const c = createNameCache(fetcher, () => t, 60_000);
    expect(await c.get("LEO")).toBeNull();
    t = 30_000;
    expect(await c.get("LEO")).toBeNull(); // still cooling down, no refetch
    expect(fetcher).toHaveBeenCalledTimes(1);
    t = 61_000;
    expect((await c.get("LEO"))?.get(1)).toBe("A");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
```

Add to `web/tests/unit/api.test.ts`, following that file's existing fetch-stub pattern (look at how `api.snapshot` is tested there):
- `api.names("LEO")` requests `/api/globe/names?group=LEO` and returns `body.names`.
- On a 500 it throws `ApiRequestError`.

Run: `cd web && npx vitest run tests/unit/names.test.ts tests/unit/api.test.ts` → FAIL (module/function missing).

- [ ] **Step 2: Implement**

In `api.ts`, add to the `api` object:

```ts
  names: async (group: "LEO" | "HIGH") =>
    (await getJson<{ generated_at: string | null; names: Record<string, string> }>(`/globe/names?group=${group}`)).names,
```

`web/src/lib/names.ts`:

```ts
import { api } from "@/lib/api";

type Group = "LEO" | "HIGH";
type Entry = { map: Map<number, string> | null; pending: Promise<Map<number, string> | null> | null; failedAt: number | null };

export function createNameCache(fetcher: (g: Group) => Promise<Record<string, string>>, now: () => number = Date.now, cooldownMs = 60_000) {
  const entries: Record<Group, Entry> = {
    LEO: { map: null, pending: null, failedAt: null },
    HIGH: { map: null, pending: null, failedAt: null },
  };
  return {
    peek: (g: Group) => entries[g].map,
    get(g: Group): Promise<Map<number, string> | null> {
      const e = entries[g];
      if (e.map) return Promise.resolve(e.map);
      if (e.pending) return e.pending;
      if (e.failedAt !== null && now() - e.failedAt < cooldownMs) return Promise.resolve(null);
      e.pending = fetcher(g)
        .then((names) => {
          e.map = new Map(Object.entries(names).map(([k, v]) => [Number(k), v]));
          e.failedAt = null;
          return e.map;
        })
        .catch(() => {
          e.failedAt = now();
          return null;
        })
        .finally(() => {
          e.pending = null;
        });
      return e.pending;
    },
  };
}

export const nameCache = createNameCache((g) => api.names(g));
```

Create the fixture `web/tests/fixtures/api/names-leo.json`, mapping every NORAD id in `tests/fixtures/snapshot-leo.bin.gz` to a readable name.
- Generate it once with a throwaway node script that uses `loadSnapshot` from `src/lib/snapshot.ts` (for example via `npx tsx`). Don't commit the script.
- Shape: `{"generated_at": "2026-09-23T10:00:00Z", "names": {"<id>": "<name>"}}`.
- Use `"ISS (ZARYA)"` for 25544 if present; otherwise `OBJECT <id>`.

In the e2e `mockApi` map, route `/globe/names` to that fixture. It's a query-string path like `/globe/snapshot`, so handle it next to the snapshot branch: serve the fixture when `group=LEO`, and a 404 JSON otherwise.

- [ ] **Step 3: Verify and commit**

`cd web && npm run lint && npm run typecheck && npm test` → pass.

```bash
git add web/src/lib/names.ts web/src/lib/api.ts web/tests/unit/names.test.ts web/tests/unit/api.test.ts web/tests/fixtures/api/names-leo.json web/e2e/explorer.spec.ts
git commit -m "feat(web): lazy cached object-name lookup for globe labels" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 7: Label selection logic (pure)

**Files:**
- Create: `web/src/lib/labels.ts`, `web/tests/unit/labels.test.ts`

**Interfaces:**
- Produces:
  - Constants: `LABEL_MAX = 12`, `SHOW_BELOW = 2.2`, `HIDE_ABOVE = 2.4`, `LABEL_INTERVAL_MS = 250`.
  - `labelsActive(wasActive: boolean, cameraDistance: number): boolean`
  - `isOccluded(cam: [number, number, number], p: [number, number, number], radius?: number): boolean`
  - `type Candidate = { id: number; x: number; y: number; name: string; color: string; occluded: boolean }`, where x/y are CSS pixels from the top-left.
  - `type Placed = Candidate & { left: number; top: number }`, where `left`/`top` is the pill's top-left.
  - `pickLabels(cands: Candidate[], opts: { width: number; height: number; selectedId: number | null; max?: number; charW?: number; lineH?: number }): Placed[]`
- Rule: the selected object is placed first when it is on-screen and not occluded, and counts toward the max. Otherwise candidates are placed nearest-to-centre first. A pill (width `name.length * charW + 12`, height `lineH + 4`, at `x + 8`, `y - 8 - lineH - 4`) that overlaps an already placed pill is skipped. Placement stops at `max`.

- [ ] **Step 1: Write the failing tests** — `web/tests/unit/labels.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { HIDE_ABOVE, isOccluded, LABEL_MAX, labelsActive, pickLabels, SHOW_BELOW, type Candidate } from "@/lib/labels";

const W = 1000, H = 800;
const c = (id: number, x: number, y: number, extra: Partial<Candidate> = {}): Candidate => ({ id, x, y, name: `SAT ${id}`, color: "#fff", occluded: false, ...extra });

describe("labelsActive (hysteresis)", () => {
  it("turns on below 2.2 and off only above 2.4", () => {
    expect(SHOW_BELOW).toBe(2.2);
    expect(HIDE_ABOVE).toBe(2.4);
    expect(labelsActive(false, 2.3)).toBe(false);
    expect(labelsActive(false, 2.1)).toBe(true);
    expect(labelsActive(true, 2.3)).toBe(true);
    expect(labelsActive(true, 2.5)).toBe(false);
  });
});

describe("isOccluded", () => {
  it("is true when the Earth sits between camera and point", () => {
    expect(isOccluded([0, 0, 3], [0, 0, -1.1])).toBe(true);
  });
  it("is false for a point on the near side or off to the side", () => {
    expect(isOccluded([0, 0, 3], [0, 0, 1.1])).toBe(false);
    expect(isOccluded([0, 0, 3], [1.5, 0, -1])).toBe(false);
  });
});

describe("pickLabels", () => {
  it("ranks by distance to the screen centre and caps at 12", () => {
    const cands = Array.from({ length: 30 }, (_, i) => c(i, 500 + (i % 6) * 120 - 300, 400 + Math.floor(i / 6) * 60 - 120));
    const out = pickLabels(cands, { width: W, height: H, selectedId: null, charW: 1, lineH: 1 });
    expect(LABEL_MAX).toBe(12);
    expect(out.length).toBe(12);
    const d = (p: Candidate) => Math.hypot(p.x - W / 2, p.y - H / 2);
    expect(Math.max(...out.map(d))).toBeLessThanOrEqual(Math.min(...cands.filter((x) => !out.some((o) => o.id === x.id)).map(d)));
  });

  it("drops a label that would overlap a closer one", () => {
    const out = pickLabels([c(1, 500, 400), c(2, 505, 402)], { width: W, height: H, selectedId: null });
    expect(out.map((o) => o.id)).toEqual([1]);
  });

  it("always places the selected object first when visible", () => {
    const out = pickLabels([c(1, 500, 400), c(2, 900, 100)], { width: W, height: H, selectedId: 2, max: 1 });
    expect(out.map((o) => o.id)).toEqual([2]);
  });

  it("never labels occluded or off-screen objects, even when selected", () => {
    const out = pickLabels(
      [c(1, 500, 400, { occluded: true }), c(2, -20, 400), c(3, 500, 900), c(4, 520, 300)],
      { width: W, height: H, selectedId: 1 },
    );
    expect(out.map((o) => o.id)).toEqual([4]);
  });
});
```

Run: `cd web && npx vitest run tests/unit/labels.test.ts` → FAIL (module missing).

- [ ] **Step 2: Implement** — `web/src/lib/labels.ts`

```ts
export const LABEL_MAX = 12;
export const SHOW_BELOW = 2.2;
export const HIDE_ABOVE = 2.4;
export const LABEL_INTERVAL_MS = 250;

export function labelsActive(wasActive: boolean, cameraDistance: number): boolean {
  return wasActive ? cameraDistance <= HIDE_ABOVE : cameraDistance < SHOW_BELOW;
}

type V3 = [number, number, number];

/** True if the segment camera→point passes through the sphere (Earth) before reaching the point. */
export function isOccluded(cam: V3, p: V3, radius = 1): boolean {
  const d: V3 = [p[0] - cam[0], p[1] - cam[1], p[2] - cam[2]];
  const a = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  const b = 2 * (cam[0] * d[0] + cam[1] * d[1] + cam[2] * d[2]);
  const cc = cam[0] * cam[0] + cam[1] * cam[1] + cam[2] * cam[2] - radius * radius;
  const disc = b * b - 4 * a * cc;
  if (disc < 0) return false;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t > 0 && t < 1 - 1e-6;
}

export type Candidate = { id: number; x: number; y: number; name: string; color: string; occluded: boolean };
export type Placed = Candidate & { left: number; top: number };

export function pickLabels(
  cands: Candidate[],
  opts: { width: number; height: number; selectedId: number | null; max?: number; charW?: number; lineH?: number },
): Placed[] {
  const { width, height, selectedId, max = LABEL_MAX, charW = 7.64, lineH = 14 } = opts;
  const onScreen = cands.filter((c) => !c.occluded && c.x >= 0 && c.x <= width && c.y >= 0 && c.y <= height);
  const cx = width / 2, cy = height / 2;
  const ranked = onScreen
    .map((c) => ({ c, d: Math.hypot(c.x - cx, c.y - cy) }))
    .sort((a, b) => a.d - b.d)
    .map((r) => r.c);
  const sel = ranked.findIndex((c) => c.id === selectedId);
  if (sel > 0) ranked.unshift(ranked.splice(sel, 1)[0]);
  const placed: Placed[] = [];
  const boxes: { l: number; t: number; r: number; b: number }[] = [];
  for (const c of ranked) {
    if (placed.length >= max) break;
    const w = c.name.length * charW + 12, h = lineH + 4;
    const left = c.x + 8, top = c.y - 8 - h;
    const box = { l: left, t: top, r: left + w, b: top + h };
    if (boxes.some((o) => box.l < o.r && o.l < box.r && box.t < o.b && o.t < box.b)) continue;
    boxes.push(box);
    placed.push({ ...c, left, top });
  }
  return placed;
}
```

- [ ] **Step 3: Verify and commit**

`cd web && npx vitest run tests/unit/labels.test.ts` → pass; `npm test`, `npm run lint`, `npm run typecheck` → pass.

```bash
git add web/src/lib/labels.ts web/tests/unit/labels.test.ts
git commit -m "feat(web): pure label selection (centre ranking, occlusion, overlap, hysteresis)" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 8: Label overlay on the globe

**Files:**
- Create: `web/src/components/globe/LabelDriver.tsx`
- Modify:
  - `web/src/components/globe/Objects.tsx`, `web/src/components/globe/GlobeScene.tsx`, `web/src/components/globe/GlobeSection.tsx`
  - `web/src/app/globals.css`
  - `web/e2e/explorer.spec.ts`

**Interfaces:**
- Consumes:
  - `pickLabels`, `labelsActive`, `isOccluded`, `LABEL_INTERVAL_MS` (Task 7).
  - `nameCache` (Task 6).
  - `GLOBE_COLORS` (Task 2).
  - The `labelsRef` overlay div (Task 4).
  - `interpolate(frames, timeMs, i, out)` from `components/globe/instances.ts`.
- Produces:
  - `type LabelSource = { group: "LEO" | "HIGH"; records: OrbitRecord[]; visible: boolean[]; frames: PropagationFrames }`
  - Objects gains a prop `onLabelSource?: (s: LabelSource | null) => void`.
  - `<LabelDriver sources={RefObject<(LabelSource | undefined)[]>} container={RefObject<HTMLDivElement | null>} />`

- [ ] **Step 1: e2e first** — add:

```ts
test("zooming in shows name labels near the centre; clicking one opens its card", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  const canvas = page.locator("canvas");
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 40; i++) await page.mouse.wheel(0, -400);
  const labels = page.getByTestId("globe-labels").locator("button");
  await expect(labels.first()).toBeVisible({ timeout: 15_000 });
  expect(await labels.count()).toBeLessThanOrEqual(12);
  await labels.first().click();
  await expect(page.getByTestId("object-card")).toBeVisible();
});
```

Run: `cd web && npx playwright test -g "name labels"` → FAIL (no label buttons).

- [ ] **Step 2: Expose label sources from Objects** — in `Objects.tsx`, add the prop and export the type:

```ts
export type LabelSource = { group: "LEO" | "HIGH"; records: OrbitRecord[]; visible: boolean[]; frames: PropagationFrames };
```

(import `type PropagationFrames` from `./usePropagation`), then:

```ts
  useEffect(() => {
    onLabelSource?.({ group, records, visible, frames });
    return () => onLabelSource?.(null);
  }, [group, records, visible, frames, onLabelSource]);
```

- [ ] **Step 3: LabelDriver** — `web/src/components/globe/LabelDriver.tsx`

```tsx
"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useRef } from "react";
import * as THREE from "three";
import { simClock } from "@/lib/clock";
import { isOccluded, LABEL_INTERVAL_MS, labelsActive, pickLabels, type Candidate } from "@/lib/labels";
import { nameCache } from "@/lib/names";
import { useExplorer } from "@/lib/store";
import { GLOBE_COLORS } from "@/lib/types";
import { interpolate } from "@/components/globe/instances";
import type { LabelSource } from "@/components/globe/Objects";

export function LabelDriver({ sources, container }: { sources: React.RefObject<(LabelSource | undefined)[]>; container: React.RefObject<HTMLDivElement | null> }) {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const last = useRef(0);
  const active = useRef(false);
  const shownKey = useRef("");
  const scratch = useRef(new THREE.Vector3());

  useFrame(() => {
    const now = performance.now();
    if (now - last.current < LABEL_INTERVAL_MS) return;
    last.current = now;
    const el = container.current;
    if (!el) return;
    active.current = labelsActive(active.current, camera.position.length());
    el.dataset.active = active.current ? "1" : "0";
    if (!active.current) {
      // Zoomed back out: drop the (now invisible) labels so none stay clickable.
      if (shownKey.current) {
        el.replaceChildren();
        shownKey.current = "";
      }
      return;
    }

    const cam: [number, number, number] = [camera.position.x, camera.position.y, camera.position.z];
    const t = simClock.now();
    const cands: Candidate[] = [];
    for (const src of sources.current ?? []) {
      if (!src) continue;
      const names = nameCache.peek(src.group);
      if (!names) {
        void nameCache.get(src.group);
        continue;
      }
      src.records.forEach((r, i) => {
        if (!src.visible[i]) return;
        const name = names.get(r.noradId);
        if (!name) return;
        const p = scratch.current;
        if (!interpolate(src.frames.current, t, i, p)) return;
        const occluded = isOccluded(cam, [p.x, p.y, p.z]);
        p.project(camera);
        if (p.z > 1) return;
        cands.push({
          id: r.noradId, name, color: GLOBE_COLORS[r.type], occluded,
          x: ((p.x + 1) / 2) * size.width, y: ((1 - p.y) / 2) * size.height,
        });
      });
    }
    const placed = pickLabels(cands, { width: size.width, height: size.height, selectedId: useExplorer.getState().selectedId });
    const key = placed.map((p) => `${p.id}:${Math.round(p.left)}:${Math.round(p.top)}`).join("|");
    if (key === shownKey.current) return;
    shownKey.current = key;
    el.replaceChildren(
      ...placed.map((p) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "globe-label";
        b.textContent = p.name;
        b.style.left = `${p.left}px`;
        b.style.top = `${p.top}px`;
        b.style.color = p.color;
        b.tabIndex = -1;
        b.onclick = () => useExplorer.getState().select(p.id);
        return b;
      }),
    );
  });
  return null;
}
```

- [ ] **Step 4: Wire it up**
  - **`GlobeScene.tsx`:**
    - Add `const labelSources = useRef<(LabelSource | undefined)[]>([]);`.
    - Add two callbacks: `const onLeoLabels = useCallback((s: LabelSource | null) => (labelSources.current[0] = s ?? undefined), []);`, and `onHighLabels` for index 1.
    - Pass `onLabelSource={onLeoLabels}` and `onLabelSource={onHighLabels}` to the two `Objects`.
    - Render `{labelsRef && <LabelDriver sources={labelSources} container={labelsRef} />}`.
  - **`globals.css`:**

```css
.globe-label {
  position: absolute;
  pointer-events: auto;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 14px;
  padding: 2px 6px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.55);
  white-space: nowrap;
  cursor: pointer;
}
.globe-label::before {
  content: "";
  position: absolute;
  left: -8px;
  bottom: -8px;
  width: 9px;
  height: 1px;
  background: currentColor;
  transform: rotate(-45deg);
  transform-origin: right;
}
[data-testid="globe-labels"] { opacity: 0; transition: opacity 200ms; }
[data-testid="globe-labels"][data-active="1"] { opacity: 1; }
```

  The existing reduced-motion rule already shortens the fade. The overlay container keeps `pointer-events-none` and each label re-enables pointer events for itself, so drags on empty space still reach the canvas.

- [ ] **Step 5: Verify and commit**

Run: `cd web && npm run lint && npm run typecheck && npm test && npm run build && npm run e2e`. Everything passes, including "name labels".

**Performance check:** in `npm run dev` against the local API with the full LEO snapshot (about 30k objects), zoom in and record one Chrome performance sample of about 5 s in the report. The LabelDriver tick should stay under about 8 ms. If it doesn't, pre-filter records whose position is behind the camera plane (skip when `(p - cam) · camForward < 0`) before projecting, and report the before and after numbers.

**Visual check:** take a zoomed-in screenshot at 1440×900 to `shots/task-8-labels.png`, and confirm the labels sit near the centre, don't overlap, and are in the object colours.

```bash
git add -A web
git commit -m "feat(web): name labels for objects near the centre when zoomed in" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 9: Docs and final visual pass

**Files:**
- Modify: `web/README.md`, `README.md` (the "What's in the repo" web line), `docs/superpowers/specs/2026-09-22-leo-debris-design.md` (add a one-line pointer in §6 to the mission-control spec)

- [ ] **Step 1:** In `web/README.md`, add a "Layout" section:
  - the stage and panels;
  - the localStorage key `kessler.panels.v1`;
  - the colour steps and where they live (`lib/types.ts`, `globals.css`);
  - the labels (thresholds, `/api/globe/names`).
- [ ] **Step 2:** Add to spec §6, under "6.2 Decided": "Superseded in part by `2026-09-24-kessler-mission-control-design.md` (layout, colours, dither scope, labels)."
- [ ] **Step 3: Final visual pass.** Run the full stack locally: the API with the local database, then `npm run dev`. Take screenshots into `shots/final-*.png`:
  - 1440×900 default;
  - 1440×900 zoomed in with labels;
  - 1024×768;
  - 390×844 with the History tab open.

  Describe each in the report: globe centred in open space, no dithered objects, colours as specified, no overlaps.
- [ ] **Step 4:** `cd web && npm run lint && npm run typecheck && npm test && npm run build && npm run e2e`; `cd ../api && uv run pytest -q`. Commit:

```bash
git add web/README.md README.md docs/superpowers/specs/2026-09-22-leo-debris-design.md
git commit -m "docs: mission-control layout, colours and labels" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```
