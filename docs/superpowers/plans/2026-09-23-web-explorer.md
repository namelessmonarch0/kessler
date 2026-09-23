# LEO Debris: Web Explorer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the public website in `web/`. It has a live cartoon 3D globe of every tracked object in orbit, animated charts from the real catalog, object search with a detail card, and an About page. It consumes the finished data API, and runs and is tested locally.

**Architecture:** A Next.js 16 App Router app. Its only server code is a same-origin `/api/*` proxy route that forwards to the Python API and adds the origin secret. Everything else is client-side:
- A packed snapshot of orbital elements is decoded and propagated with SGP4 in a Web Worker.
- The positions feed three instanced meshes in a React Three Fiber scene: a flat two-colour Earth shader with a real-sun dithered terminator, plus a subtle dither post-process.
- The charts are hand-built SVG (d3-scale/d3-shape) animated with anime.js.
- UI state lives in one Zustand store.

AI chat (plan 3) and AWS/Vercel deployment (plan 4) are out of scope. The chat panel ships in its "coming soon" state.

**Tech Stack:** Node 22+, npm, Next.js 16.3.x, React 19, TypeScript 5.9, Tailwind CSS v4, three 0.186, @react-three/fiber 9, @react-three/drei 10, @react-three/postprocessing 3 + postprocessing 6, satellite.js 7, animejs 4, zustand 5, topojson-client 3 + world-atlas 2, d3-scale 4 / d3-shape 3, Vitest 5, Playwright 1.63.

**Spec:** `docs/superpowers/specs/2026-09-22-leo-debris-design.md` (read §2, §4, §6 incl. §6.2 decisions). Backend contract: `api/app/api/routes.py` and `api/app/ingest/snapshot.py` in this repo.

## Global Constraints

- All web code lives in `web/`. Use npm (`npm ci` in CI). Path alias `@/*` → `web/src/*`.
- **This is Next.js 16: APIs differ from older versions.** Before writing any Next-specific code (route handlers, fonts, layout, metadata), read the relevant guide in `web/node_modules/next/dist/docs/`. Route handler dynamic `params` is a Promise.
- The browser only ever calls same-origin `/api/...`. The proxy forwards to `API_ORIGIN_URL`, and sends `X-Origin-Auth: $ORIGIN_SECRET` when that variable is set.
- Entity colours, fixed everywhere: payload `#3987e5`, debris `#d95926`, rocket body `#199e70`. The unknown type uses ink-3 `#8f8e88`.
- Globe palette: ocean `#2f6fd6`, land `#7fd06b`, coastline ink `#0d1b2e`. Page background `#000`.
- Dither: Earth-shader twilight band ±9° (sin 9° = 0.1564) with a 4×4 Bayer ordered dither. Subtle post-process: cell 2 CSS px × device pixel ratio, 7 levels, grain 0.09.
- Type: **Departure Mono** (self-hosted, OFL) for labels, numbers and headings; **Inter Tight** for body text. Minimum text size 12px. Text contrast ≥ 4.5:1 on its background.
- Cards: `#0e0e0e` background, 2px `#262626` border, 18px radius, `box-shadow: 5px 5px 0 #1c1c1c`.
- Object shape size in world units: `0.0042 * cameraDistance^0.55` (grows on screen as you zoom in).
- The snapshot format is binding (`api/app/ingest/snapshot.py`): gzip(`"LEO1"` + uint32-LE header length + UTF-8 JSON header + records). Each record is 88 bytes little-endian `<IHBx10d`: norad_id, owner_index, type_index, pad, then float64 epoch_unix_s, mean_motion (rev/day), eccentricity, inclination, raan, arg_pericenter, mean_anomaly (deg), bstar, mean_motion_dot, mean_motion_ddot.
- Scene frame: Earth radius = 1 unit. The Earth mesh is **not rotated**. Mapping from Earth-fixed (ECEF) km: `scene = (x, z, −y) / 6371`. With it, lon 0° → +X, lon 90°E → −Z and the north pole → +Y, which matches the equirectangular texture on `THREE.SphereGeometry`.
- Respect `prefers-reduced-motion`: intro, counters and fly-tos jump straight to their end state.
- Attribution shown on every page: `Data: USSPACECOM via Space-Track.org; CelesTrak.`
- Every commit message: subject, blank line, then the trailer lines `Co-Authored-By: <model> <noreply@anthropic.com>`. Use two `-m` flags. Never push.
- `npm run lint`, `npm run typecheck` and `npm test` must pass before each commit.

## Review Focus

1. **The API is down or returns errors.** Each panel shows a short "Data unavailable" message, the Earth still renders, and there are no uncaught exceptions. *(Tests: Task 2 `proxy returns 502 JSON when upstream is unreachable`; Task 14 e2e `survives API failure`.)*
2. **No globe snapshot yet** (the API returns 404 before the first GP ingest). The globe shows the Earth plus the note "Orbit data not available yet". *(Test: Task 14 e2e `shows note when snapshot is missing`.)*
3. **Elements SGP4 cannot propagate** (decayed or garbage elements, SGP4 error codes). The object is skipped (NaN position) and never drawn at the Earth's centre. *(Tests: Task 5 `returns NaN for elements that fail to propagate`; Task 9 `instance transform hides NaN positions`.)*
4. **No WebGL** (old device, blocked GPU). Charts, search and cards still work, and the globe area explains why it is empty. *(Test: Task 8 `hasWebGL returns false when no context is available`.)*
5. **Phone-width screens** (390px). Panels stack and there is no horizontal page scroll. *(Test: Task 14 e2e `no horizontal overflow at 390px`.)*

---

## File Structure

```
web/
  package.json, package-lock.json, tsconfig.json, next.config.ts, postcss.config.mjs,
  eslint.config.mjs, vitest.config.ts, playwright.config.ts, .env.example, README.md
  public/geo/land-50m.json                 # copied from world-atlas (Natural Earth, public domain)
  src/
    app/
      layout.tsx                           # fonts, metadata, <body>
      globals.css                          # Tailwind v4 + design tokens + .card
      page.tsx                             # explorer page (client shell)
      about/page.tsx                       # story, team, method, sources
      api/[...path]/route.ts               # same-origin proxy → lib/proxy.ts
      fonts/DepartureMono-Regular.woff2, fonts/DepartureMono-LICENSE.txt
    lib/
      types.ts        # API response types + ObjectType/Regime constants
      proxy.ts        # upstreamUrl(), proxyToApi()
      api.ts          # buildQuery(), ApiRequestError, api.* fetchers
      snapshot.ts     # decodeSnapshot(), gunzip()
      orbit.ts        # recordToSatrec(), ecefToScene(), propagateAll()
      sun.ts          # subsolarPoint(), sunDirectionScene()
      clock.ts        # simClock
      store.ts        # useExplorer (zustand)
      chartData.ts    # visibleTypeSeries(), crossoverYear(), chartTitle(), ANNOTATIONS, ownerLabel()
      format.ts       # fmtInt(), fmtDate(), fmtKm()
      motion.ts       # prefersReducedMotion(), countUp()
    workers/propagate.worker.ts
    components/
      ui/PixelIcon.tsx, ui/Card.tsx, ui/Unavailable.tsx
      globe/GlobeSection.tsx   # WebGL check + <Canvas> host + overlays
      globe/GlobeScene.tsx     # camera, controls, light, Earth, Objects, effects
      globe/Earth.tsx, globe/earthMaterial.ts, globe/earthTexture.ts
      globe/Objects.tsx, globe/objectGeometries.ts, globe/instances.ts
      globe/DitherEffect.ts, globe/usePropagation.ts, globe/webgl.ts, globe/flyTo.ts
      panels/Header.tsx, panels/Intro.tsx, panels/StatTiles.tsx, panels/Filters.tsx,
      panels/SearchBox.tsx, panels/ObjectCard.tsx, panels/ChatPanel.tsx, panels/Footer.tsx
      charts/LineChart.tsx, charts/BarChart.tsx
  tests/
    unit/*.test.ts
    fixtures/snapshot-leo.bin.gz (generated in Task 4), fixtures/api/*.json (Task 14)
  e2e/explorer.spec.ts
.github/workflows/web.yml
```

---

### Task 1: Scaffold the Next.js app, design tokens, fonts and test runner

**Files:**
- Create: `web/package.json` (via npm), `web/tsconfig.json`, `web/next.config.ts`, `web/postcss.config.mjs`, `web/eslint.config.mjs`, `web/vitest.config.ts`, `web/.env.example`, `web/src/app/layout.tsx`, `web/src/app/globals.css`, `web/src/app/page.tsx` (placeholder), `web/src/app/fonts/DepartureMono-Regular.woff2`, `web/src/app/fonts/DepartureMono-LICENSE.txt`, `web/src/lib/format.ts`, `web/tests/unit/format.test.ts`
- Modify: root `.gitignore`

**Interfaces:**
- Produces: `fmtInt(n: number): string` ("28,625"); `fmtKm(n: number | null): string` ("422 km", or "—" for null); `fmtDate(iso: string | null): string` ("20 Nov 1998", or "—"). CSS custom properties and Tailwind theme colours named `bg, card, line, ink, ink-2, ink-3, pay, deb, rb, ocean, land`. Font CSS variables `--font-departure`, `--font-inter`. A `.card` class. Scripts `dev, build, lint, typecheck, test, e2e`.

- [ ] **Step 1: Create the package and install exact dependency ranges**

```bash
mkdir -p web && cd web
npm init -y
npm pkg set name=leo-web private=true version=0.1.0
npm pkg delete main keywords author license description scripts.test
npm pkg set scripts.dev="next dev" scripts.build="next build" scripts.start="next start" \
  scripts.lint="eslint" scripts.typecheck="tsc --noEmit" scripts.test="vitest run" scripts.e2e="playwright test"
npm install next@16.3.6 react@19.3.0 react-dom@19.3.0 three@0.186.0 @react-three/fiber@^9.8.0 \
  @react-three/drei@^10.7.8 @react-three/postprocessing@^3.1.2 postprocessing@^6.39.5 \
  satellite.js@^7.1.0 animejs@^4.5.0 zustand@^5.0.15 topojson-client@^3.1.0 d3-scale@^4.0.2 d3-shape@^3.2.0
npm install -D typescript@~5.9 @types/node@^22 @types/react@^19 @types/react-dom@^19 @types/three@0.186.0 \
  @types/topojson-client@^3.1.5 @types/d3-scale@^4.0.9 @types/d3-shape@^3.2.0 @types/geojson \
  eslint@^9 eslint-config-next@16.3.6 tailwindcss@^4.3.3 @tailwindcss/postcss@^4.3.3 \
  vitest@^5.0.1 @playwright/test@^1.63.0 world-atlas@^2.0.2
```

- [ ] **Step 2: Write the config files**

`web/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "react-jsx",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts", ".next/dev/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

`web/next.config.ts`:
```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
```

`web/postcss.config.mjs`:
```js
const config = { plugins: { "@tailwindcss/postcss": {} } };
export default config;
```

`web/eslint.config.mjs`:
```js
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "playwright-report/**", "test-results/**"]),
]);
```

`web/vitest.config.ts`:
```ts
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { include: ["tests/unit/**/*.test.ts"], environment: "node" },
});
```

`web/.env.example`:
```bash
# Where the FastAPI data API runs (see ../api/README.md). The browser never calls it directly.
API_ORIGIN_URL=http://localhost:8000
# Must match the API's ORIGIN_SECRET in production; leave empty locally.
ORIGIN_SECRET=
```

Append to the repo root `.gitignore`:
```
web/node_modules/
web/.next/
web/.env
web/.env.local
web/playwright-report/
web/test-results/
web/next-env.d.ts
web/*.tsbuildinfo
!web/.env.example
```

- [ ] **Step 3: Add the fonts**

```bash
mkdir -p src/app/fonts
curl -sSfL -o src/app/fonts/DepartureMono-Regular.woff2 \
  https://cdn.jsdelivr.net/gh/rektdeckard/departure-mono@main/public/assets/DepartureMono-Regular.woff2
curl -sSfL -o src/app/fonts/DepartureMono-LICENSE.txt \
  https://cdn.jsdelivr.net/gh/rektdeckard/departure-mono@main/LICENSE
```
Check that the woff2 file is larger than 10 KB and starts with `wOF2` (`head -c4`).

- [ ] **Step 4: Write the failing test for the formatters**

`web/tests/unit/format.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { fmtDate, fmtInt, fmtKm } from "@/lib/format";

describe("format", () => {
  it("formats integers with thousands separators", () => {
    expect(fmtInt(28625)).toBe("28,625");
    expect(fmtInt(0)).toBe("0");
  });
  it("formats kilometres and missing values", () => {
    expect(fmtKm(422.4)).toBe("422 km");
    expect(fmtKm(null)).toBe("—");
  });
  it("formats ISO dates in UTC", () => {
    expect(fmtDate("1998-11-20")).toBe("20 Nov 1998");
    expect(fmtDate(null)).toBe("—");
  });
});
```

Run: `npm test`
Expected: FAIL, `Cannot find module '@/lib/format'` (or similar resolve error).

- [ ] **Step 5: Implement the formatters, tokens, layout and placeholder page**

`web/src/lib/format.ts`:
```ts
const INT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export function fmtInt(n: number): string {
  return INT.format(n);
}

export function fmtKm(n: number | null): string {
  return n === null ? "—" : `${INT.format(n)} km`;
}

export function fmtDate(iso: string | null): string {
  return iso ? DATE.format(new Date(`${iso.slice(0, 10)}T00:00:00Z`)) : "—";
}
```

`web/src/app/globals.css`:
```css
@import "tailwindcss";

@theme {
  --color-bg: #000000;
  --color-card: #0e0e0e;
  --color-line: #262626;
  --color-ink: #f4f4f2;
  --color-ink-2: #a3a29c;
  --color-ink-3: #8f8e88;
  --color-pay: #3987e5;
  --color-deb: #d95926;
  --color-rb: #199e70;
  --color-ocean: #2f6fd6;
  --color-land: #7fd06b;
  --font-sans: var(--font-inter), system-ui, sans-serif;
  --font-mono: var(--font-departure), ui-monospace, monospace;
}

html, body { background: var(--color-bg); color: var(--color-ink); }
body { font-family: var(--font-sans); -webkit-font-smoothing: antialiased; }

.card {
  background: var(--color-card);
  border: 2px solid var(--color-line);
  border-radius: 18px;
  box-shadow: 5px 5px 0 #1c1c1c;
}

.label { font-family: var(--font-mono); font-size: 12px; letter-spacing: 0.02em; color: var(--color-ink-2); }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; }
}
```

`web/src/app/layout.tsx`:
```tsx
import type { Metadata } from "next";
import { Inter_Tight } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";

const inter = Inter_Tight({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const departure = localFont({
  src: "./fonts/DepartureMono-Regular.woff2",
  variable: "--font-departure",
  display: "swap",
});

export const metadata: Metadata = {
  title: "LEO Debris",
  description: "A live map of every tracked object in low Earth orbit, with the history of how it got crowded.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${departure.variable}`}>
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
```

`web/src/app/page.tsx` (placeholder, replaced in Task 12):
```tsx
export default function Home() {
  return <main className="p-6 font-mono">LEO / DEBRIS</main>;
}
```

- [ ] **Step 6: Verify**

Run: `npm test && npm run lint && npm run typecheck && npm run build`
Expected: 3 tests pass; lint and typecheck clean; `next build` succeeds. If Next generates an `AGENTS.md`/`CLAUDE.md` in `web/`, keep and commit them.

- [ ] **Step 7: Commit**

```bash
cd .. && git add .gitignore web
git commit -m "feat(web): scaffold Next.js app with design tokens, fonts and vitest" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 2: Same-origin API proxy

**Files:**
- Create: `web/src/lib/proxy.ts`, `web/src/app/api/[...path]/route.ts`, `web/tests/unit/proxy.test.ts`

**Interfaces:**
- Produces: `upstreamUrl(requestUrl: string, origin: string): string`; `proxyToApi(req: Request, env?: ProxyEnv, fetchImpl?: typeof fetch): Promise<Response>`, where `ProxyEnv = { API_ORIGIN_URL?: string; ORIGIN_SECRET?: string }`. Route `GET|POST /api/*` in Next.

- [ ] **Step 1: Write the failing tests**

`web/tests/unit/proxy.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { proxyToApi, upstreamUrl } from "@/lib/proxy";

const ENV = { API_ORIGIN_URL: "http://api.local:8000/", ORIGIN_SECRET: "s3cret" };

describe("upstreamUrl", () => {
  it("keeps path and query and trims the origin's trailing slash", () => {
    expect(upstreamUrl("http://site/api/stats/timeseries?from=2006&to=2011", ENV.API_ORIGIN_URL))
      .toBe("http://api.local:8000/api/stats/timeseries?from=2006&to=2011");
  });
});

describe("proxyToApi", () => {
  it("forwards GET with the origin secret and filters headers both ways", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("{\"ok\":true}", {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "public, s-maxage=3600", "set-cookie": "x=1" },
      }),
    );
    const req = new Request("http://site/api/meta", { headers: { accept: "application/json", cookie: "a=b" } });
    const res = await proxyToApi(req, ENV, fetchImpl as unknown as typeof fetch);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const sent = new Headers(init.headers);
    expect(url).toBe("http://api.local:8000/api/meta");
    expect(sent.get("x-origin-auth")).toBe("s3cret");
    expect(sent.get("cookie")).toBeNull();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=3600");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.json()).toEqual({ ok: true });
  });

  it("passes through upstream errors and 304s unchanged", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 304, headers: { etag: "\"abc\"" } }));
    const req = new Request("http://site/api/globe/snapshot?group=LEO", { headers: { "if-none-match": "\"abc\"" } });
    const res = await proxyToApi(req, ENV, fetchImpl as unknown as typeof fetch);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get("if-none-match")).toBe("\"abc\"");
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe("\"abc\"");
  });

  it("omits the secret header when no secret is configured", async () => {
    const fetchImpl = vi.fn(async () => new Response("[]", { status: 200 }));
    await proxyToApi(new Request("http://site/api/events"), { API_ORIGIN_URL: "http://a" }, fetchImpl as unknown as typeof fetch);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get("x-origin-auth")).toBeNull();
  });

  it("proxy returns 502 JSON when upstream is unreachable", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("fetch failed"); });
    const res = await proxyToApi(new Request("http://site/api/meta"), ENV, fetchImpl as unknown as typeof fetch);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: { code: "unavailable", message: "the data API is unreachable" } });
  });

  it("returns 500 JSON when API_ORIGIN_URL is missing", async () => {
    const res = await proxyToApi(new Request("http://site/api/meta"), {}, vi.fn() as unknown as typeof fetch);
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("misconfigured");
  });

  it("forwards POST bodies", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok"));
    const req = new Request("http://site/api/chat", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{\"q\":1}",
    });
    await proxyToApi(req, ENV, fetchImpl as unknown as typeof fetch);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe("{\"q\":1}");
  });
});
```

Run: `npm test -- proxy`
Expected: FAIL, module `@/lib/proxy` not found.

- [ ] **Step 2: Implement**

`web/src/lib/proxy.ts`:
```ts
export type ProxyEnv = { API_ORIGIN_URL?: string; ORIGIN_SECRET?: string };

const REQUEST_HEADERS = ["accept", "content-type", "if-none-match"];
const RESPONSE_HEADERS = ["content-type", "cache-control", "etag"];

function errorJson(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

export function upstreamUrl(requestUrl: string, origin: string): string {
  const url = new URL(requestUrl);
  return origin.replace(/\/+$/, "") + url.pathname + url.search;
}

/** Forwards a same-origin /api/* request to the Python API. Only an allow-list of headers
 * crosses in either direction (no cookies), and the origin secret is added server-side. */
export async function proxyToApi(
  req: Request,
  env: ProxyEnv = process.env as ProxyEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const origin = env.API_ORIGIN_URL;
  if (!origin) return errorJson(500, "misconfigured", "API_ORIGIN_URL is not set");

  const headers = new Headers();
  for (const name of REQUEST_HEADERS) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (env.ORIGIN_SECRET) headers.set("x-origin-auth", env.ORIGIN_SECRET);

  let upstream: Response;
  try {
    upstream = await fetchImpl(upstreamUrl(req.url, origin), {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
      cache: "no-store",
      redirect: "manual",
    });
  } catch {
    return errorJson(502, "unavailable", "the data API is unreachable");
  }

  const out = new Headers();
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
```

`web/src/app/api/[...path]/route.ts`:
```ts
import type { NextRequest } from "next/server";
import { proxyToApi } from "@/lib/proxy";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return proxyToApi(req);
}

export async function POST(req: NextRequest) {
  return proxyToApi(req);
}
```

- [ ] **Step 3: Verify, including against the real API**

Run: `npm test -- proxy` (7 passed), then `npm run lint && npm run typecheck`.
Manual check: start the API (`cd ../api && docker compose up -d db && uv run uvicorn app.api.main:create_app --factory --port 8000`), create `web/.env.local` from `.env.example`, run `npm run dev`, and `curl -s localhost:3000/api/meta | head -c 200` returns the meta JSON. Stop both servers afterwards.

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/proxy.ts web/src/app/api web/tests/unit/proxy.test.ts
git commit -m "feat(web): same-origin API proxy with origin secret and header allow-list" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 3: API types and typed client

**Files:**
- Create: `web/src/lib/types.ts`, `web/src/lib/api.ts`, `web/tests/unit/api.test.ts`

**Interfaces:**
- Produces, in `types.ts`:
  - `type ObjectType = "PAY" | "R/B" | "DEB" | "UNK"`; `type Regime = "LEO" | "MEO" | "GEO" | "HEO" | "OTHER"`; `type Metric = "in_orbit" | "added" | "reentered"`; `type GroupBy = "none" | "type" | "owner" | "regime"`
  - constants `OBJECT_TYPES`, `TYPE_COLORS: Record<ObjectType, string>`, `TYPE_LABELS: Record<ObjectType, string>`
  - interfaces `Meta`, `OwnerSummary`, `TimeseriesResponse`, `BreakdownResponse`, `BreakdownRow`, `BreakupEvent`, `SearchResult`, `ObjectDetail`, `OrbitElements`, `ApiErrorBody`
- Produces, in `api.ts`:
  - `buildQuery(q: Record<string, string | number | readonly string[] | undefined>): string`
  - `class ApiRequestError extends Error { status: number; code: string }`
  - `api.meta()`, `api.timeseries(q: TimeseriesQuery)`, `api.breakdown(q: BreakdownQuery)`, `api.events()`, `api.object(id: number)`, `api.search(q: string)`, and `api.snapshot(group: "LEO" | "HIGH"): Promise<Uint8Array | null>` (null on 404)

- [ ] **Step 1: Write the failing tests**

`web/tests/unit/api.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, api, buildQuery } from "@/lib/api";

afterEach(() => vi.unstubAllGlobals());

function stubFetch(response: Response) {
  const fn = vi.fn(async () => response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("buildQuery", () => {
  it("joins arrays with commas and skips undefined and empty arrays", () => {
    expect(buildQuery({ owners: ["US", "PRC"], types: [], from: 2006, to: undefined })).toBe("?owners=US%2CPRC&from=2006");
    expect(buildQuery({})).toBe("");
  });
});

describe("api", () => {
  it("requests same-origin paths", async () => {
    const fn = stubFetch(Response.json({ metric: "in_orbit", group_by: "type", years: [], series: [] }));
    await api.timeseries({ group_by: "type", regimes: ["LEO"], from: 2006, to: 2011 });
    expect(fn.mock.calls[0][0]).toBe("/api/stats/timeseries?group_by=type&regimes=LEO&from=2006&to=2011");
  });

  it("throws ApiRequestError with the API's code and message", async () => {
    stubFetch(Response.json({ error: { code: "invalid_filter", message: "unknown owner code 'XX'" } }, { status: 422 }));
    await expect(api.meta()).rejects.toMatchObject({ status: 422, code: "invalid_filter", message: "unknown owner code 'XX'" });
  });

  it("falls back to a generic error when the body is not JSON", async () => {
    stubFetch(new Response("Bad Gateway", { status: 502 }));
    const err = await api.events().catch((e) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err.code).toBe("http_error");
  });

  it("returns null for a missing snapshot and bytes otherwise", async () => {
    stubFetch(Response.json({ error: { code: "not_found", message: "no globe snapshot" } }, { status: 404 }));
    expect(await api.snapshot("LEO")).toBeNull();
    stubFetch(new Response(new Uint8Array([1, 2, 3])));
    expect(Array.from((await api.snapshot("HIGH"))!)).toEqual([1, 2, 3]);
  });

  it("encodes search text", async () => {
    const fn = stubFetch(Response.json([]));
    await api.search("50%_ off");
    expect(fn.mock.calls[0][0]).toBe("/api/objects/search?q=50%25_+off");
  });
});
```

Run: `npm test -- api`. Expected: FAIL (module not found).

- [ ] **Step 2: Implement the types**

`web/src/lib/types.ts`:
```ts
export type ObjectType = "PAY" | "R/B" | "DEB" | "UNK";
export type Regime = "LEO" | "MEO" | "GEO" | "HEO" | "OTHER";
export type Metric = "in_orbit" | "added" | "reentered";
export type GroupBy = "none" | "type" | "owner" | "regime";

export const OBJECT_TYPES: readonly ObjectType[] = ["PAY", "R/B", "DEB", "UNK"];
export const TYPE_COLORS: Record<ObjectType, string> = {
  PAY: "#3987e5",
  "R/B": "#199e70",
  DEB: "#d95926",
  UNK: "#8f8e88",
};
export const TYPE_LABELS: Record<ObjectType, string> = {
  PAY: "Payloads",
  "R/B": "Rocket bodies",
  DEB: "Debris",
  UNK: "Unknown",
};

export interface OwnerSummary { code: string; name: string; flag_emoji: string | null; in_orbit: number; total: number }

export interface Meta {
  data_as_of: { satcat: string | null; gp: string | null; stats: string | null };
  in_orbit: Partial<Record<ObjectType, Partial<Record<Regime, number>>>>;
  owners: OwnerSummary[];
  types: Record<ObjectType, string>;
  regimes: Record<Regime, string>;
  ops_status: Record<string, string>;
  attribution: string;
}

export interface TimeseriesResponse {
  metric: Metric;
  group_by: GroupBy;
  years: number[];
  series: { key: string; values: number[] }[];
}

export interface BreakdownRow { key: string; counts: Partial<Record<ObjectType, number>>; total: number }
export interface BreakdownResponse { at: number; by: "owner" | "type" | "regime"; rows: BreakdownRow[] }

export interface BreakupEvent {
  id: string;
  parent_cospar: string;
  name: string;
  event_date: string;
  kind: "ASAT" | "COLLISION" | "EXPLOSION" | "UNKNOWN";
  description: string;
  source_url: string;
  pieces_total: number;
  pieces_in_orbit: number;
}

export interface SearchResult {
  norad_id: number;
  name: string;
  cospar_id: string | null;
  object_type: ObjectType;
  owner: string;
  regime: Regime;
  decayed: boolean;
}

export interface OrbitElements {
  epoch: string;
  mean_motion: number;
  eccentricity: number;
  inclination: number;
  raan: number;
  arg_pericenter: number;
  mean_anomaly: number;
  bstar: number;
  mean_motion_dot: number;
  mean_motion_ddot: number;
  source: string;
}

export interface ObjectDetail {
  norad_id: number;
  cospar_id: string | null;
  name: string;
  object_type: ObjectType;
  ops_status: string | null;
  ops_status_label: string | null;
  owner: string;
  owner_name: string;
  flag_emoji: string | null;
  launch_date: string | null;
  launch_site: string | null;
  launch_site_name: string | null;
  decay_date: string | null;
  period: number | null;
  inclination: number | null;
  apogee: number | null;
  perigee: number | null;
  rcs_size: "SMALL" | "MEDIUM" | "LARGE" | null;
  regime: Regime;
  parent_cospar: string | null;
  first_seen_year: number;
  event: { id: string; name: string; event_date: string } | null;
  elements: OrbitElements | null;
}

export interface ApiErrorBody { error: { code: string; message: string } }
```

- [ ] **Step 3: Implement the client**

`web/src/lib/api.ts`:
```ts
import type {
  ApiErrorBody, BreakdownResponse, BreakupEvent, GroupBy, Meta, Metric, ObjectDetail, ObjectType,
  Regime, SearchResult, TimeseriesResponse,
} from "@/lib/types";

export class ApiRequestError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = "ApiRequestError";
  }
}

type QueryValue = string | number | readonly string[] | undefined;

export function buildQuery(q: Record<string, QueryValue>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(q)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length) params.set(key, value.join(","));
    } else {
      params.set(key, String(value));
    }
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

async function toError(res: Response): Promise<ApiRequestError> {
  try {
    const body = (await res.json()) as ApiErrorBody;
    return new ApiRequestError(res.status, body.error.code, body.error.message);
  } catch {
    return new ApiRequestError(res.status, "http_error", `HTTP ${res.status}`);
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`);
  if (!res.ok) throw await toError(res);
  return (await res.json()) as T;
}

export interface TimeseriesQuery {
  metric?: Metric;
  group_by?: GroupBy;
  owners?: readonly string[];
  types?: readonly ObjectType[];
  regimes?: readonly Regime[];
  from?: number;
  to?: number;
  top?: number;
}

export interface BreakdownQuery {
  by?: "owner" | "type" | "regime";
  at?: number;
  owners?: readonly string[];
  types?: readonly ObjectType[];
  regimes?: readonly Regime[];
  top?: number;
}

export const api = {
  meta: () => getJson<Meta>("/meta"),
  timeseries: (q: TimeseriesQuery) => getJson<TimeseriesResponse>(`/stats/timeseries${buildQuery({ ...q })}`),
  breakdown: (q: BreakdownQuery) => getJson<BreakdownResponse>(`/stats/breakdown${buildQuery({ ...q })}`),
  events: () => getJson<BreakupEvent[]>("/events"),
  object: (id: number) => getJson<ObjectDetail>(`/objects/${id}`),
  search: (q: string) => getJson<SearchResult[]>(`/objects/search${buildQuery({ q })}`),
  async snapshot(group: "LEO" | "HIGH"): Promise<Uint8Array | null> {
    const res = await fetch(`/api/globe/snapshot?group=${group}`);
    if (res.status === 404) return null;
    if (!res.ok) throw await toError(res);
    return new Uint8Array(await res.arrayBuffer());
  },
};
```

- [ ] **Step 4: Verify and commit**

Run: `npm test -- api` (6 passed), `npm run lint && npm run typecheck`.
```bash
git add web/src/lib/types.ts web/src/lib/api.ts web/tests/unit/api.test.ts
git commit -m "feat(web): typed API client mirroring the data API contract" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 4: Snapshot decoder (LEO1 binary format)

**Files:**
- Create: `web/src/lib/snapshot.ts`, `web/tests/unit/snapshot.test.ts`, `web/tests/fixtures/snapshot-leo.bin.gz`

**Interfaces:**
- Consumes: `ObjectType` (Task 3).
- Produces: `interface SnapshotHeader { version: number; generated_at: string; count: number; owners: string[]; types: ObjectType[]; record_size: number; fields: string[] }`; `interface OrbitRecord { noradId: number; owner: string; type: ObjectType; epochMs: number; meanMotion: number; eccentricity: number; inclination: number; raan: number; argPericenter: number; meanAnomaly: number; bstar: number; meanMotionDot: number; meanMotionDdot: number }`; `gunzip(bytes: Uint8Array): Promise<Uint8Array>`; `decodeSnapshot(raw: Uint8Array): { header: SnapshotHeader; records: OrbitRecord[] }` (takes **uncompressed** bytes); `loadSnapshot(gz: Uint8Array): Promise<{ header; records }>`.

- [ ] **Step 1: Generate the fixture with the real backend packer**

From the repo root:
```bash
cd api && uv run python - <<'PY'
from datetime import UTC, datetime
from pathlib import Path
from app.ingest.snapshot import pack_snapshot
rows = [
    dict(norad_id=25544, owner="ISS", object_type="PAY", epoch=datetime(2026, 9, 22, 6, 30, 37, 496448, tzinfo=UTC),
         mean_motion=15.49224498, eccentricity=0.00047657, inclination=51.6312, raan=179.6046,
         arg_pericenter=167.6102, mean_anomaly=192.5004, bstar=0.0001364276, mean_motion_dot=0.00007132,
         mean_motion_ddot=0.0),
    dict(norad_id=29733, owner="PRC", object_type="DEB", epoch=datetime(2026, 9, 21, 18, 2, 11, tzinfo=UTC),
         mean_motion=12.9692, eccentricity=0.058, inclination=99.21, raan=210.1, arg_pericenter=120.5,
         mean_anomaly=240.2, bstar=0.000021, mean_motion_dot=0.0000003, mean_motion_ddot=0.0),
]
out = Path("../web/tests/fixtures/snapshot-leo.bin.gz")
out.parent.mkdir(parents=True, exist_ok=True)
out.write_bytes(pack_snapshot(rows, datetime(2026, 9, 23, 12, 0, tzinfo=UTC)))
print(out.stat().st_size, "bytes")
PY
cd ../web
```

- [ ] **Step 2: Write the failing tests**

`web/tests/unit/snapshot.test.ts`:
```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeSnapshot, gunzip, loadSnapshot } from "@/lib/snapshot";

const GZ = new Uint8Array(readFileSync(new URL("../fixtures/snapshot-leo.bin.gz", import.meta.url)));

describe("snapshot", () => {
  it("decodes the header and records written by the Python packer", async () => {
    const { header, records } = await loadSnapshot(GZ);
    expect(header.version).toBe(1);
    expect(header.count).toBe(2);
    expect(header.record_size).toBe(88);
    expect(header.owners).toEqual(["ISS", "PRC"]);
    expect(records[0]).toMatchObject({ noradId: 25544, owner: "ISS", type: "PAY" });
    expect(records[0].meanMotion).toBeCloseTo(15.49224498, 8);
    expect(records[0].epochMs).toBe(Date.UTC(2026, 8, 22, 6, 30, 37, 496) + 0.448);
    expect(records[1]).toMatchObject({ noradId: 29733, owner: "PRC", type: "DEB" });
    expect(records[1].inclination).toBeCloseTo(99.21, 10);
  });

  it("rejects data without the LEO1 magic", async () => {
    const raw = await gunzip(GZ);
    const broken = raw.slice();
    broken[0] = 0x58;
    expect(() => decodeSnapshot(broken)).toThrow(/LEO1/);
  });

  it("rejects truncated data", async () => {
    const raw = await gunzip(GZ);
    expect(() => decodeSnapshot(raw.slice(0, raw.length - 10))).toThrow(/truncated/);
  });
});
```

Run: `npm test -- snapshot`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`web/src/lib/snapshot.ts`:
```ts
import type { ObjectType } from "@/lib/types";

export interface SnapshotHeader {
  version: number;
  generated_at: string;
  count: number;
  owners: string[];
  types: ObjectType[];
  record_size: number;
  fields: string[];
}

export interface OrbitRecord {
  noradId: number;
  owner: string;
  type: ObjectType;
  epochMs: number;
  meanMotion: number;
  eccentricity: number;
  inclination: number;
  raan: number;
  argPericenter: number;
  meanAnomaly: number;
  bstar: number;
  meanMotionDot: number;
  meanMotionDdot: number;
}

const MAGIC = "LEO1";
const RECORD_SIZE = 88;

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Decodes uncompressed LEO1 bytes (see api/app/ingest/snapshot.py). Records are not 8-byte
 * aligned after the JSON header, so they are read with a DataView, not typed-array views. */
export function decodeSnapshot(raw: Uint8Array): { header: SnapshotHeader; records: OrbitRecord[] } {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (raw.byteLength < 8 || new TextDecoder().decode(raw.subarray(0, 4)) !== MAGIC) {
    throw new Error("not a LEO1 snapshot");
  }
  const headerLen = view.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(raw.subarray(8, 8 + headerLen))) as SnapshotHeader;
  if (header.record_size !== RECORD_SIZE) throw new Error(`unsupported record size ${header.record_size}`);
  const start = 8 + headerLen;
  if (raw.byteLength < start + header.count * RECORD_SIZE) throw new Error("snapshot is truncated");

  const records: OrbitRecord[] = new Array(header.count);
  for (let i = 0; i < header.count; i++) {
    const o = start + i * RECORD_SIZE;
    const f = (k: number) => view.getFloat64(o + 8 + k * 8, true);
    records[i] = {
      noradId: view.getUint32(o, true),
      owner: header.owners[view.getUint16(o + 4, true)],
      type: header.types[view.getUint8(o + 6)],
      epochMs: f(0) * 1000,
      meanMotion: f(1),
      eccentricity: f(2),
      inclination: f(3),
      raan: f(4),
      argPericenter: f(5),
      meanAnomaly: f(6),
      bstar: f(7),
      meanMotionDot: f(8),
      meanMotionDdot: f(9),
    };
  }
  return { header, records };
}

export async function loadSnapshot(gz: Uint8Array) {
  return decodeSnapshot(await gunzip(gz));
}
```

Note: `epoch_unix` is stored as float64 seconds, so the exact millisecond value carries sub-millisecond precision. The test's `+ 0.448` checks that. If float rounding makes `toBe` fail by less than 1e-3, change that single assertion to `toBeCloseTo(..., 2)` and mention it in the report.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- snapshot` (3 passed), `npm run lint && npm run typecheck`.
```bash
git add web/src/lib/snapshot.ts web/tests/unit/snapshot.test.ts web/tests/fixtures/snapshot-leo.bin.gz
git commit -m "feat(web): decode LEO1 globe snapshots" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 5: Orbit propagation core and the real Sun

**Files:**
- Create: `web/src/lib/orbit.ts`, `web/src/lib/sun.ts`, `web/src/lib/clock.ts`, `web/tests/unit/orbit.test.ts`, `web/tests/unit/sun.test.ts`

**Interfaces:**
- Consumes: `OrbitRecord` (Task 4).
- Produces:
  - `recordToSatrec(r: OrbitRecord): SatRec | null` (null if satellite.js rejects the elements or they fail to propagate at their own epoch)
  - `EARTH_RADIUS_KM = 6371`
  - `ecefToScene(x: number, y: number, z: number, out: Float32Array, offset: number): void` (writes 3 floats)
  - `propagateAll(satrecs: (SatRec | null)[], date: Date, out: Float32Array): number` (writes 3 floats per object; NaN when propagation fails; returns the count that succeeded)
  - `subsolarPoint(date: Date): { latDeg: number; lonDeg: number }`
  - `sunDirectionScene(date: Date): [number, number, number]` (unit vector)
  - `simClock` with `.now(): number` (ms), `.scale: number`, `.tick(realDtMs: number)`, `.setScale(scale: number)`, `.reset()`

- [ ] **Step 1: Write the failing tests**

`web/tests/unit/orbit.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { EARTH_RADIUS_KM, ecefToScene, propagateAll, recordToSatrec } from "@/lib/orbit";
import type { OrbitRecord } from "@/lib/snapshot";

const ISS: OrbitRecord = {
  noradId: 25544, owner: "ISS", type: "PAY", epochMs: Date.parse("2026-09-22T06:30:37.496Z"),
  meanMotion: 15.49224498, eccentricity: 0.00047657, inclination: 51.6312, raan: 179.6046,
  argPericenter: 167.6102, meanAnomaly: 192.5004, bstar: 0.0001364276, meanMotionDot: 0.00007132, meanMotionDdot: 0,
};

describe("ecefToScene", () => {
  it("maps lon 0 to +X, lon 90E to -Z and the north pole to +Y, in Earth radii", () => {
    const out = new Float32Array(9);
    ecefToScene(EARTH_RADIUS_KM, 0, 0, out, 0);
    ecefToScene(0, EARTH_RADIUS_KM, 0, out, 3);
    ecefToScene(0, 0, EARTH_RADIUS_KM, out, 6);
    expect(Array.from(out)).toEqual([1, 0, -0, 0, 0, -1, 0, 1, -0]);
  });
});

describe("propagateAll", () => {
  it("propagates the ISS to a ~420-440 km altitude at its epoch", () => {
    const out = new Float32Array(3);
    const ok = propagateAll([recordToSatrec(ISS)], new Date(ISS.epochMs), out);
    expect(ok).toBe(1);
    const altitudeKm = Math.hypot(out[0], out[1], out[2]) * EARTH_RADIUS_KM - EARTH_RADIUS_KM;
    expect(altitudeKm).toBeGreaterThan(420);
    expect(altitudeKm).toBeLessThan(440);
  });

  it("returns NaN for elements that fail to propagate", () => {
    const broken = recordToSatrec({ ...ISS, noradId: 1, eccentricity: 1.5 });
    const out = new Float32Array(6);
    const ok = propagateAll([broken, null], new Date(ISS.epochMs), out);
    expect(ok).toBe(0);
    expect(Array.from(out).every(Number.isNaN)).toBe(true);
  });
});
```

`web/tests/unit/sun.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { subsolarPoint, sunDirectionScene } from "@/lib/sun";
import { simClock } from "@/lib/clock";

describe("subsolarPoint", () => {
  it("is near the equator and prime meridian at the September 2026 equinox noon", () => {
    const p = subsolarPoint(new Date("2026-09-22T12:00:00Z"));
    expect(p.latDeg).toBeCloseTo(0.2, 1);
    expect(p.lonDeg).toBeCloseTo(-1.83, 1);
  });
  it("is at the Tropic of Cancer at the June solstice", () => {
    expect(subsolarPoint(new Date("2026-06-21T12:00:00Z")).latDeg).toBeCloseTo(23.44, 1);
  });
});

describe("sunDirectionScene", () => {
  it("is a unit vector pointing at lon ~0 (+X) at equinox noon", () => {
    const [x, y, z] = sunDirectionScene(new Date("2026-09-22T12:00:00Z"));
    expect(Math.hypot(x, y, z)).toBeCloseTo(1, 6);
    expect(x).toBeGreaterThan(0.99);
  });
});

describe("simClock", () => {
  it("advances by real time times the scale", () => {
    simClock.reset(Date.UTC(2026, 0, 1));
    simClock.setScale(10);
    simClock.tick(1000);
    expect(simClock.now()).toBe(Date.UTC(2026, 0, 1) + 10_000);
  });
});
```

Run: `npm test -- orbit sun`. Expected: FAIL (modules not found).

- [ ] **Step 2: Implement**

`web/src/lib/orbit.ts`:
```ts
import { eciToEcf, gstime, json2satrec, propagate, type SatRec } from "satellite.js";
import type { OrbitRecord } from "@/lib/snapshot";

export const EARTH_RADIUS_KM = 6371;

export function recordToSatrec(r: OrbitRecord): SatRec | null {
  try {
    const rec = json2satrec({
      OBJECT_NAME: String(r.noradId),
      OBJECT_ID: String(r.noradId),
      EPOCH: new Date(r.epochMs).toISOString().replace("Z", ""),
      MEAN_MOTION: r.meanMotion,
      ECCENTRICITY: r.eccentricity,
      INCLINATION: r.inclination,
      RA_OF_ASC_NODE: r.raan,
      ARG_OF_PERICENTER: r.argPericenter,
      MEAN_ANOMALY: r.meanAnomaly,
      NORAD_CAT_ID: r.noradId,
      ELEMENT_SET_NO: 999,
      BSTAR: r.bstar,
      MEAN_MOTION_DOT: r.meanMotionDot,
      MEAN_MOTION_DDOT: r.meanMotionDdot,
    });
    if (rec.error) return null;
    // Some invalid elements (e.g. eccentricity >= 1) only fail when propagated: reject them up front.
    const trial = propagate(rec, new Date(r.epochMs));
    return trial && typeof trial.position === "object" ? rec : null;
  } catch {
    return null;
  }
}

/** Earth-fixed km → scene units (Earth radius 1): scene = (x, z, -y) / R. */
export function ecefToScene(x: number, y: number, z: number, out: Float32Array, offset: number): void {
  out[offset] = x / EARTH_RADIUS_KM;
  out[offset + 1] = z / EARTH_RADIUS_KM;
  out[offset + 2] = -y / EARTH_RADIUS_KM;
}

export function propagateAll(satrecs: (SatRec | null)[], date: Date, out: Float32Array): number {
  const gmst = gstime(date);
  let ok = 0;
  for (let i = 0; i < satrecs.length; i++) {
    const rec = satrecs[i];
    const pv = rec ? propagate(rec, date) : null;
    const pos = pv && typeof pv.position === "object" ? pv.position : null;
    if (!pos || !Number.isFinite(pos.x)) {
      out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = Number.NaN;
      continue;
    }
    const ecf = eciToEcf(pos, gmst);
    ecefToScene(ecf.x, ecf.y, ecf.z, out, i * 3);
    ok++;
  }
  return ok;
}
```

If the installed satellite.js typings make `pv.position` a union that the `typeof` guard does not narrow, keep the runtime behaviour and adjust only the type guard. Say so in the report.

`web/src/lib/sun.ts`:
```ts
const RAD = Math.PI / 180;

/** Subsolar point from UTC time (NOAA low-precision formulas, ~0.01° accuracy). */
export function subsolarPoint(date: Date): { latDeg: number; lonDeg: number } {
  const d = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * d) * RAD;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (280.46061837 + 360.98564736629 * d) * RAD;
  let lon = ra - gmst;
  lon = Math.atan2(Math.sin(lon), Math.cos(lon));
  return { latDeg: dec / RAD, lonDeg: lon / RAD };
}

/** Unit vector towards the Sun in scene coordinates (see ecefToScene). */
export function sunDirectionScene(date: Date): [number, number, number] {
  const { latDeg, lonDeg } = subsolarPoint(date);
  const lat = latDeg * RAD;
  const lon = lonDeg * RAD;
  const x = Math.cos(lat) * Math.cos(lon);
  const y = Math.cos(lat) * Math.sin(lon);
  const z = Math.sin(lat);
  return [x, z, -y];
}
```

`web/src/lib/clock.ts`:
```ts
/** Simulation clock shared by the globe (sun + propagation). Real time × scale. */
export const simClock = {
  t: Date.now(),
  scale: 1,
  now(): number {
    return this.t;
  },
  tick(realDtMs: number): void {
    this.t += realDtMs * this.scale;
  },
  setScale(scale: number): void {
    this.scale = scale;
  },
  reset(to: number = Date.now()): void {
    this.t = to;
  },
};
```

- [ ] **Step 3: Verify and commit**

Run: `npm test -- orbit sun` (all pass), `npm run lint && npm run typecheck`.
```bash
git add web/src/lib/orbit.ts web/src/lib/sun.ts web/src/lib/clock.ts web/tests/unit/orbit.test.ts web/tests/unit/sun.test.ts
git commit -m "feat(web): SGP4 propagation to scene frame, real subsolar point and sim clock" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 6: Propagation Web Worker and hook

**Files:**
- Create: `web/src/workers/propagate.worker.ts`, `web/src/components/globe/usePropagation.ts`, `web/tests/unit/workerProtocol.test.ts`

**Interfaces:**
- Consumes: `recordToSatrec`, `propagateAll` (Task 5); `OrbitRecord` (Task 4); `simClock` (Task 5).
- Produces:
  - The worker protocol, exported from the worker module as types plus a pure handler: `type WorkerIn = { kind: "load"; records: OrbitRecord[] } | { kind: "tick"; timeMs: number; id: number }`; `type WorkerOut = { kind: "loaded"; count: number; valid: number } | { kind: "positions"; id: number; timeMs: number; positions: Float32Array }`; `createHandler(post: (msg: WorkerOut, transfer?: Transferable[]) => void): (msg: WorkerIn) => void`
  - The hook `usePropagation(records: OrbitRecord[] | null): PropagationFrames`, where `PropagationFrames = { current: { prev: Float32Array | null; next: Float32Array | null; prevTime: number; nextTime: number } }` (a React ref object updated about 10 times per second; it requests positions for `simClock.now() + 100 * simClock.scale`)

- [ ] **Step 1: Write the failing test for the pure handler**

`web/tests/unit/workerProtocol.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createHandler, type WorkerOut } from "@/workers/propagate.worker";
import type { OrbitRecord } from "@/lib/snapshot";

const ISS: OrbitRecord = {
  noradId: 25544, owner: "ISS", type: "PAY", epochMs: Date.parse("2026-09-22T06:30:37.496Z"),
  meanMotion: 15.49224498, eccentricity: 0.00047657, inclination: 51.6312, raan: 179.6046,
  argPericenter: 167.6102, meanAnomaly: 192.5004, bstar: 0.0001364276, meanMotionDot: 0.00007132, meanMotionDdot: 0,
};

describe("propagate worker handler", () => {
  it("loads records, then answers ticks with transferable positions", () => {
    const sent: { msg: WorkerOut; transfer?: Transferable[] }[] = [];
    const handle = createHandler((msg, transfer) => sent.push({ msg, transfer }));
    handle({ kind: "load", records: [ISS, { ...ISS, noradId: 2, eccentricity: 2 }] });
    expect(sent[0].msg).toEqual({ kind: "loaded", count: 2, valid: 1 });

    handle({ kind: "tick", timeMs: ISS.epochMs, id: 7 });
    const out = sent[1].msg;
    expect(out.kind).toBe("positions");
    if (out.kind !== "positions") throw new Error("unreachable");
    expect(out.id).toBe(7);
    expect(out.positions.length).toBe(6);
    expect(Number.isFinite(out.positions[0])).toBe(true);
    expect(Number.isNaN(out.positions[3])).toBe(true);
    expect(sent[1].transfer?.[0]).toBe(out.positions.buffer);
  });

  it("ignores ticks before any load", () => {
    const sent: WorkerOut[] = [];
    createHandler((m) => sent.push(m))({ kind: "tick", timeMs: 0, id: 1 });
    expect(sent).toEqual([]);
  });
});
```

Run: `npm test -- workerProtocol`. Expected: FAIL (module not found).

- [ ] **Step 2: Implement the worker and hook**

`web/src/workers/propagate.worker.ts`:
```ts
import type { SatRec } from "satellite.js";
import { propagateAll, recordToSatrec } from "@/lib/orbit";
import type { OrbitRecord } from "@/lib/snapshot";

export type WorkerIn = { kind: "load"; records: OrbitRecord[] } | { kind: "tick"; timeMs: number; id: number };
export type WorkerOut =
  | { kind: "loaded"; count: number; valid: number }
  | { kind: "positions"; id: number; timeMs: number; positions: Float32Array };

export function createHandler(post: (msg: WorkerOut, transfer?: Transferable[]) => void) {
  let satrecs: (SatRec | null)[] | null = null;
  return (msg: WorkerIn) => {
    if (msg.kind === "load") {
      satrecs = msg.records.map(recordToSatrec);
      post({ kind: "loaded", count: satrecs.length, valid: satrecs.filter(Boolean).length });
      return;
    }
    if (!satrecs) return;
    const positions = new Float32Array(satrecs.length * 3);
    propagateAll(satrecs, new Date(msg.timeMs), positions);
    post({ kind: "positions", id: msg.id, timeMs: msg.timeMs, positions }, [positions.buffer]);
  };
}

// Only wire up the message loop when running inside a worker (not when imported by tests).
// The minimal cast avoids pulling the "webworker" lib, whose globals clash with "dom".
type WorkerScope = {
  postMessage(msg: WorkerOut, transfer: Transferable[]): void;
  onmessage: ((e: MessageEvent<WorkerIn>) => void) | null;
};
declare const WorkerGlobalScope: (new () => unknown) | undefined;
if (typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope) {
  const scope = self as unknown as WorkerScope;
  const handle = createHandler((msg, transfer) => scope.postMessage(msg, transfer ?? []));
  scope.onmessage = (e) => handle(e.data);
}
```

`web/src/components/globe/usePropagation.ts`:
```ts
"use client";

import { useEffect, useRef } from "react";
import { simClock } from "@/lib/clock";
import type { OrbitRecord } from "@/lib/snapshot";
import type { WorkerIn, WorkerOut } from "@/workers/propagate.worker";

export type PropagationFrames = {
  current: { prev: Float32Array | null; next: Float32Array | null; prevTime: number; nextTime: number };
};

const TICK_MS = 100;

/** Keeps the latest two position frames from the worker. Renderers interpolate between them
 * at simClock.now(). */
export function usePropagation(records: OrbitRecord[] | null): PropagationFrames {
  const frames = useRef({ prev: null as Float32Array | null, next: null as Float32Array | null, prevTime: 0, nextTime: 0 });

  useEffect(() => {
    if (!records || records.length === 0) return;
    const worker = new Worker(new URL("../../workers/propagate.worker.ts", import.meta.url), { type: "module" });
    let id = 0;
    let waiting = false;
    const request = () => {
      if (waiting) return;
      waiting = true;
      const msg: WorkerIn = { kind: "tick", timeMs: simClock.now() + TICK_MS * simClock.scale, id: ++id };
      worker.postMessage(msg);
    };
    worker.onmessage = (e: MessageEvent<WorkerOut>) => {
      const msg = e.data;
      if (msg.kind === "loaded") {
        request();
        return;
      }
      const f = frames.current;
      f.prev = f.next ?? msg.positions;
      f.prevTime = f.next ? f.nextTime : msg.timeMs;
      f.next = msg.positions;
      f.nextTime = msg.timeMs;
      waiting = false;
    };
    const load: WorkerIn = { kind: "load", records };
    worker.postMessage(load);
    const timer = window.setInterval(request, TICK_MS);
    return () => {
      window.clearInterval(timer);
      worker.terminate();
      frames.current = { prev: null, next: null, prevTime: 0, nextTime: 0 };
    };
  }, [records]);

  return frames;
}
```

- [ ] **Step 3: Verify and commit**

Run: `npm test -- workerProtocol` (2 passed), `npm run lint && npm run typecheck && npm run build` (the build proves Next bundles the worker URL).
```bash
git add web/src/workers web/src/components/globe/usePropagation.ts web/tests/unit/workerProtocol.test.ts
git commit -m "feat(web): SGP4 propagation web worker with transferable frames" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 7: Explorer store, chart data helpers and motion utilities

**Files:**
- Create: `web/src/lib/store.ts`, `web/src/lib/chartData.ts`, `web/src/lib/motion.ts`, `web/tests/unit/store.test.ts`, `web/tests/unit/chartData.test.ts`

**Interfaces:**
- Consumes: types from Task 3.
- Produces:
  - `useExplorer` (a zustand hook) with state `{ types: ObjectType[]; owners: string[]; orbits: { leo: boolean; high: boolean }; selectedId: number | null; timeScale: 1 | 4320 }` and actions `toggleType(t)`, `setOwners(codes)`, `toggleOrbit(k: "leo" | "high")`, `select(id | null)`, `setTimeScale(s)`, `reset()`
  - `regimesFor(orbits: { leo: boolean; high: boolean }): Regime[] | undefined` (both → undefined, meaning all regimes)
  - `isVisible(record: { type: ObjectType; owner: string }, group: "LEO" | "HIGH", s: { types; owners; orbits }): boolean`
  - In `chartData.ts`: `ANNOTATIONS: { year: number; label: string; row: 0 | 1 }[]`; `visibleTypeSeries(ts: TimeseriesResponse): { key: ObjectType; values: number[] }[]` (only PAY, DEB, R/B, in that order); `crossoverYear(ts: TimeseriesResponse): number | null` (first year PAY > DEB after DEB led); `chartTitle(ts: TimeseriesResponse): string`; `ownerLabel(key: string, owners: OwnerSummary[]): string` ("_other" → "Other")
  - In `motion.ts`: `prefersReducedMotion(): boolean`; `countUp(el: HTMLElement, to: number, delayMs?: number): void` (anime.js; sets the text directly when reduced motion is on)

- [ ] **Step 1: Write the failing tests**

`web/tests/unit/store.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest";
import { isVisible, regimesFor, useExplorer } from "@/lib/store";

beforeEach(() => useExplorer.getState().reset());

describe("explorer store", () => {
  it("starts with all types, all owners and LEO only", () => {
    const s = useExplorer.getState();
    expect(s.types).toEqual(["PAY", "R/B", "DEB", "UNK"]);
    expect(s.owners).toEqual([]);
    expect(s.orbits).toEqual({ leo: true, high: false });
    expect(s.timeScale).toBe(1);
  });

  it("toggles types but never allows zero types", () => {
    const { toggleType } = useExplorer.getState();
    toggleType("DEB");
    expect(useExplorer.getState().types).toEqual(["PAY", "R/B", "UNK"]);
    toggleType("PAY"); toggleType("R/B"); toggleType("UNK");
    expect(useExplorer.getState().types).toEqual(["UNK"]);
  });

  it("never allows both orbit groups off", () => {
    useExplorer.getState().toggleOrbit("leo");
    expect(useExplorer.getState().orbits).toEqual({ leo: true, high: false });
    useExplorer.getState().toggleOrbit("high");
    useExplorer.getState().toggleOrbit("leo");
    expect(useExplorer.getState().orbits).toEqual({ leo: false, high: true });
  });
});

describe("regimesFor / isVisible", () => {
  it("maps orbit toggles to API regimes", () => {
    expect(regimesFor({ leo: true, high: false })).toEqual(["LEO"]);
    expect(regimesFor({ leo: false, high: true })).toEqual(["MEO", "GEO", "HEO"]);
    expect(regimesFor({ leo: true, high: true })).toBeUndefined();
  });

  it("filters by type, owner and orbit group", () => {
    const s = { types: ["PAY", "DEB"] as const, owners: ["US"], orbits: { leo: true, high: false } };
    expect(isVisible({ type: "PAY", owner: "US" }, "LEO", { ...s, types: [...s.types] })).toBe(true);
    expect(isVisible({ type: "R/B", owner: "US" }, "LEO", { ...s, types: [...s.types] })).toBe(false);
    expect(isVisible({ type: "PAY", owner: "PRC" }, "LEO", { ...s, types: [...s.types] })).toBe(false);
    expect(isVisible({ type: "PAY", owner: "US" }, "HIGH", { ...s, types: [...s.types] })).toBe(false);
  });
});
```

`web/tests/unit/chartData.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { chartTitle, crossoverYear, ownerLabel, visibleTypeSeries } from "@/lib/chartData";
import type { TimeseriesResponse } from "@/lib/types";

const TS: TimeseriesResponse = {
  metric: "in_orbit", group_by: "type", years: [2022, 2023, 2024, 2025],
  series: [
    { key: "DEB", values: [11375, 10692, 10533, 9994] },
    { key: "PAY", values: [8039, 10204, 11895, 15229] },
    { key: "UNK", values: [40, 45, 50, 52] },
    { key: "R/B", values: [981, 970, 975, 978] },
  ],
};

describe("chartData", () => {
  it("keeps PAY, DEB, R/B in a fixed order", () => {
    expect(visibleTypeSeries(TS).map((s) => s.key)).toEqual(["PAY", "DEB", "R/B"]);
  });
  it("finds the year payloads overtook debris", () => {
    expect(crossoverYear(TS)).toBe(2024);
    expect(chartTitle(TS)).toBe("Payloads overtook debris in 2024");
  });
  it("falls back to a neutral title without a crossover", () => {
    const flat: TimeseriesResponse = { ...TS, series: [{ key: "DEB", values: [5, 5, 5, 5] }, { key: "PAY", values: [1, 1, 1, 1] }] };
    expect(crossoverYear(flat)).toBeNull();
    expect(chartTitle(flat)).toBe("Objects in orbit by type");
  });
  it("labels owners", () => {
    const owners = [{ code: "US", name: "United States", flag_emoji: null, in_orbit: 1, total: 1 }];
    expect(ownerLabel("US", owners)).toBe("United States");
    expect(ownerLabel("_other", owners)).toBe("Other");
    expect(ownerLabel("POR", owners)).toBe("POR");
  });
});
```

Run: `npm test -- store chartData`. Expected: FAIL (modules not found).

- [ ] **Step 2: Implement**

`web/src/lib/store.ts`:
```ts
import { create } from "zustand";
import { OBJECT_TYPES, type ObjectType, type Regime } from "@/lib/types";

type Orbits = { leo: boolean; high: boolean };
type Filters = { types: ObjectType[]; owners: string[]; orbits: Orbits };

interface ExplorerState extends Filters {
  selectedId: number | null;
  timeScale: 1 | 4320;
  toggleType: (t: ObjectType) => void;
  setOwners: (codes: string[]) => void;
  toggleOrbit: (k: keyof Orbits) => void;
  select: (id: number | null) => void;
  setTimeScale: (s: 1 | 4320) => void;
  reset: () => void;
}

const initial = (): Filters & Pick<ExplorerState, "selectedId" | "timeScale"> => ({
  types: [...OBJECT_TYPES],
  owners: [],
  orbits: { leo: true, high: false },
  selectedId: null,
  timeScale: 1,
});

export const useExplorer = create<ExplorerState>((set) => ({
  ...initial(),
  toggleType: (t) =>
    set((s) => {
      const has = s.types.includes(t);
      if (has && s.types.length === 1) return s;
      return { types: has ? s.types.filter((x) => x !== t) : OBJECT_TYPES.filter((x) => x === t || s.types.includes(x)) };
    }),
  setOwners: (codes) => set({ owners: codes }),
  toggleOrbit: (k) =>
    set((s) => {
      const next = { ...s.orbits, [k]: !s.orbits[k] };
      return next.leo || next.high ? { orbits: next } : s;
    }),
  select: (id) => set({ selectedId: id }),
  setTimeScale: (timeScale) => set({ timeScale }),
  reset: () => set(initial()),
}));

export function regimesFor(orbits: Orbits): Regime[] | undefined {
  if (orbits.leo && orbits.high) return undefined;
  return orbits.leo ? ["LEO"] : ["MEO", "GEO", "HEO"];
}

export function isVisible(
  record: { type: ObjectType; owner: string },
  group: "LEO" | "HIGH",
  s: Filters,
): boolean {
  if (group === "LEO" ? !s.orbits.leo : !s.orbits.high) return false;
  if (!s.types.includes(record.type)) return false;
  return s.owners.length === 0 || s.owners.includes(record.owner);
}
```

`web/src/lib/chartData.ts`:
```ts
import type { ObjectType, OwnerSummary, TimeseriesResponse } from "@/lib/types";

export const ANNOTATIONS: { year: number; label: string; row: 0 | 1 }[] = [
  { year: 2007, label: "Fengyun-1C ASAT test", row: 0 },
  { year: 2009, label: "Iridium–Cosmos collision", row: 1 },
  { year: 2019, label: "Starlink launches begin", row: 0 },
  { year: 2021, label: "Kosmos 1408 ASAT test", row: 1 },
];

const SHOWN: ObjectType[] = ["PAY", "DEB", "R/B"];

export function visibleTypeSeries(ts: TimeseriesResponse): { key: ObjectType; values: number[] }[] {
  return SHOWN.flatMap((key) => {
    const s = ts.series.find((x) => x.key === key);
    return s ? [{ key, values: s.values }] : [];
  });
}

export function crossoverYear(ts: TimeseriesResponse): number | null {
  const pay = ts.series.find((s) => s.key === "PAY")?.values;
  const deb = ts.series.find((s) => s.key === "DEB")?.values;
  if (!pay || !deb) return null;
  let debrisLed = false;
  for (let i = 0; i < ts.years.length; i++) {
    if (deb[i] > pay[i]) debrisLed = true;
    else if (debrisLed && pay[i] > deb[i]) return ts.years[i];
  }
  return null;
}

export function chartTitle(ts: TimeseriesResponse): string {
  const year = crossoverYear(ts);
  return year ? `Payloads overtook debris in ${year}` : "Objects in orbit by type";
}

export function ownerLabel(key: string, owners: OwnerSummary[]): string {
  if (key === "_other") return "Other";
  return owners.find((o) => o.code === key)?.name ?? key;
}
```

`web/src/lib/motion.ts`:
```ts
import { animate } from "animejs";
import { fmtInt } from "@/lib/format";

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function countUp(el: HTMLElement, to: number, delayMs = 0): void {
  if (prefersReducedMotion()) {
    el.textContent = fmtInt(to);
    return;
  }
  const o = { v: 0 };
  animate(o, {
    v: to,
    duration: 1600,
    delay: delayMs,
    ease: "outExpo",
    onUpdate: () => {
      el.textContent = fmtInt(Math.round(o.v));
    },
  });
}
```

- [ ] **Step 3: Verify and commit**

Run: `npm test -- store chartData` (all pass), `npm run lint && npm run typecheck`.
```bash
git add web/src/lib/store.ts web/src/lib/chartData.ts web/src/lib/motion.ts web/tests/unit/store.test.ts web/tests/unit/chartData.test.ts
git commit -m "feat(web): explorer store, chart data helpers and motion utilities" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 8: Earth: texture, terminator shader and WebGL detection

**Files:**
- Create: `web/public/geo/land-50m.json` (copied), `web/src/components/globe/earthTexture.ts`, `web/src/components/globe/earthMaterial.ts`, `web/src/components/globe/Earth.tsx`, `web/src/components/globe/webgl.ts`, `web/tests/unit/earth.test.ts`

**Interfaces:**
- Consumes: `sunDirectionScene` (Task 5), `simClock` (Task 5).
- Produces:
  - `hasWebGL(doc?: Pick<Document, "createElement">): boolean`
  - `lonLatToTexel(lon: number, lat: number, w: number, h: number): [number, number]`
  - `ringSegments(ring: [number, number][], w: number, h: number): [number, number][][]` (splits at the antimeridian)
  - `drawEarthTexture(ctx: CanvasRenderingContext2D, land: FeatureCollection | null, w: number, h: number): void`
  - `PALETTE = { ocean: "#2f6fd6", land: "#7fd06b", coast: "#0d1b2e" }`
  - `createEarthMaterial(map: THREE.Texture): THREE.ShaderMaterial` (uniform `sunDir: Vector3`)
  - `<Earth />` (a React component, self-updating the sun direction every frame)

- [ ] **Step 1: Copy the land data**

```bash
mkdir -p public/geo && cp node_modules/world-atlas/land-50m.json public/geo/land-50m.json
```
(Natural Earth data via world-atlas: public domain; ISC-licensed packaging.)

- [ ] **Step 2: Write the failing tests**

`web/tests/unit/earth.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { lonLatToTexel, ringSegments } from "@/components/globe/earthTexture";
import { hasWebGL } from "@/components/globe/webgl";

describe("lonLatToTexel", () => {
  it("maps the equirectangular corners and centre", () => {
    expect(lonLatToTexel(-180, 90, 400, 200)).toEqual([0, 0]);
    expect(lonLatToTexel(0, 0, 400, 200)).toEqual([200, 100]);
    expect(lonLatToTexel(180, -90, 400, 200)).toEqual([400, 200]);
  });
});

describe("ringSegments", () => {
  it("splits rings that jump across the antimeridian", () => {
    const segs = ringSegments([[170, 0], [179, 1], [-179, 1], [-170, 0]], 360, 180);
    expect(segs.length).toBe(2);
    expect(segs[0].length).toBe(2);
    expect(segs[1].length).toBe(2);
  });
  it("keeps a normal ring as one segment", () => {
    expect(ringSegments([[0, 0], [10, 0], [10, 10]], 360, 180).length).toBe(1);
  });
});

describe("hasWebGL", () => {
  it("hasWebGL returns false when no context is available", () => {
    const doc = { createElement: () => ({ getContext: () => null }) } as unknown as Pick<Document, "createElement">;
    expect(hasWebGL(doc)).toBe(false);
  });
  it("returns false when canvas creation throws, true when a context exists", () => {
    const throwing = { createElement: () => { throw new Error("no canvas"); } } as unknown as Pick<Document, "createElement">;
    expect(hasWebGL(throwing)).toBe(false);
    const ok = { createElement: () => ({ getContext: (k: string) => (k === "webgl2" ? {} : null) }) } as unknown as Pick<Document, "createElement">;
    expect(hasWebGL(ok)).toBe(true);
  });
});
```

Run: `npm test -- earth`. Expected: FAIL (modules not found).

- [ ] **Step 3: Implement the pure helpers**

`web/src/components/globe/webgl.ts`:
```ts
export function hasWebGL(doc: Pick<Document, "createElement"> = document): boolean {
  try {
    const canvas = doc.createElement("canvas") as HTMLCanvasElement;
    return Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
}
```

`web/src/components/globe/earthTexture.ts`:
```ts
import type { FeatureCollection, MultiPolygon, Polygon } from "geojson";

export const PALETTE = { ocean: "#2f6fd6", land: "#7fd06b", coast: "#0d1b2e" } as const;

export function lonLatToTexel(lon: number, lat: number, w: number, h: number): [number, number] {
  return [((lon + 180) / 360) * w, ((90 - lat) / 180) * h];
}

/** Converts a lon/lat ring to texel segments, starting a new segment when consecutive points
 * jump more than half the texture width (the ring crosses the antimeridian). */
export function ringSegments(ring: [number, number][], w: number, h: number): [number, number][][] {
  const segments: [number, number][][] = [];
  let current: [number, number][] = [];
  let prevX: number | null = null;
  for (const [lon, lat] of ring) {
    const p = lonLatToTexel(lon, lat, w, h);
    if (prevX !== null && Math.abs(p[0] - prevX) > w / 2) {
      segments.push(current);
      current = [];
    }
    current.push(p);
    prevX = p[0];
  }
  if (current.length) segments.push(current);
  return segments;
}

export function drawEarthTexture(
  ctx: CanvasRenderingContext2D,
  land: FeatureCollection | null,
  w: number,
  h: number,
): void {
  ctx.fillStyle = PALETTE.ocean;
  ctx.fillRect(0, 0, w, h);
  if (!land) return;
  ctx.beginPath();
  for (const feature of land.features) {
    const g = feature.geometry as Polygon | MultiPolygon;
    const polygons = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
    for (const polygon of polygons) {
      for (const ring of polygon) {
        for (const seg of ringSegments(ring as [number, number][], w, h)) {
          seg.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
          ctx.closePath();
        }
      }
    }
  }
  ctx.fillStyle = PALETTE.land;
  ctx.fill("evenodd");
  ctx.lineWidth = Math.max(1.5, w / 1400);
  ctx.lineJoin = "round";
  ctx.strokeStyle = PALETTE.coast;
  ctx.stroke();
}
```

- [ ] **Step 4: Implement the shader material and component**

`web/src/components/globe/earthMaterial.ts`:
```ts
import * as THREE from "three";

// ±9° twilight band: sin(9°) ≈ 0.1564. Inside the band a 4×4 Bayer ordered dither thickens
// towards night while a soft tint builds underneath (spec §6.2).
const vertexShader = /* glsl */ `
varying vec3 vNormalW;
varying vec2 vUv;
void main() {
  vUv = uv;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const fragmentShader = /* glsl */ `
uniform sampler2D map;
uniform vec3 sunDir;
uniform float band;
uniform float cellSize;
varying vec3 vNormalW;
varying vec2 vUv;

float bayer4(vec2 p) {
  int x = int(mod(p.x, 4.0));
  int y = int(mod(p.y, 4.0));
  int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return (float(m[x + y * 4]) + 0.5) / 16.0;
}

void main() {
  vec3 base = texture2D(map, vUv).rgb;
  float d = dot(normalize(vNormalW), normalize(sunDir));
  float t = smoothstep(band, -band, d);                 // 0 = day, 1 = night
  float dithered = step(bayer4(floor(gl_FragCoord.xy / cellSize)), t);
  vec3 night = base * 0.16 + vec3(0.004, 0.008, 0.02);
  gl_FragColor = vec4(mix(base, night, clamp(0.5 * t + 0.5 * dithered, 0.0, 1.0)), 1.0);
  #include <colorspace_fragment>
}`;

export function createEarthMaterial(map: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      map: { value: map },
      sunDir: { value: new THREE.Vector3(1, 0, 0) },
      band: { value: 0.1564 },
      cellSize: { value: 2 * (typeof window === "undefined" ? 1 : Math.min(window.devicePixelRatio, 2)) },
    },
    vertexShader,
    fragmentShader,
  });
}
```

`web/src/components/globe/Earth.tsx`:
```tsx
"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { feature } from "topojson-client";
import type { FeatureCollection } from "geojson";
import type { Topology } from "topojson-specification";
import { simClock } from "@/lib/clock";
import { sunDirectionScene } from "@/lib/sun";
import { drawEarthTexture } from "@/components/globe/earthTexture";
import { createEarthMaterial } from "@/components/globe/earthMaterial";

export function Earth() {
  const { canvas, texture, material } = useMemo(() => {
    const small = typeof window !== "undefined" && window.innerWidth < 700;
    const canvas = document.createElement("canvas");
    canvas.width = small ? 2048 : 4096;
    canvas.height = canvas.width / 2;
    drawEarthTexture(canvas.getContext("2d")!, null, canvas.width, canvas.height);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    return { canvas, texture, material: createEarthMaterial(texture) };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/geo/land-50m.json")
      .then((r) => r.json())
      .then((topo: Topology) => {
        if (cancelled) return;
        const land = feature(topo, topo.objects.land) as unknown as FeatureCollection;
        drawEarthTexture(canvas.getContext("2d")!, land, canvas.width, canvas.height);
        texture.needsUpdate = true;
      })
      .catch(() => undefined); // ocean-only Earth is an acceptable fallback
    return () => {
      cancelled = true;
      texture.dispose();
      material.dispose();
    };
  }, [canvas, texture, material]);

  useFrame(() => {
    const [x, y, z] = sunDirectionScene(new Date(simClock.now()));
    (material.uniforms.sunDir.value as THREE.Vector3).set(x, y, z);
  });

  return (
    <group>
      <mesh material={material}>
        <sphereGeometry args={[1, 128, 96]} />
      </mesh>
      {/* ink outline (inverted hull) */}
      <mesh>
        <sphereGeometry args={[1.012, 96, 64]} />
        <meshBasicMaterial color="#0a0f1a" side={THREE.BackSide} />
      </mesh>
      {/* soft cartoon atmosphere rim */}
      <mesh>
        <sphereGeometry args={[1.045, 96, 64]} />
        <meshBasicMaterial color="#7fb6ff" transparent opacity={0.08} side={THREE.BackSide} depthWrite={false} />
      </mesh>
    </group>
  );
}
```
If `topojson-specification` types are not already installed as a dependency of `@types/topojson-client`, run `npm install -D @types/topojson-specification`.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- earth` (5 passed), `npm run lint && npm run typecheck`.
```bash
git add web/public/geo web/src/components/globe/earthTexture.ts web/src/components/globe/earthMaterial.ts web/src/components/globe/Earth.tsx web/src/components/globe/webgl.ts web/tests/unit/earth.test.ts web/package.json web/package-lock.json
git commit -m "feat(web): flat two-colour Earth with real-sun dithered terminator" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 9: Orbiting objects: shapes, instancing, size-by-zoom and picking

**Files:**
- Create: `web/src/components/globe/objectGeometries.ts`, `web/src/components/globe/instances.ts`, `web/src/components/globe/Objects.tsx`, `web/tests/unit/instances.test.ts`

**Interfaces:**
- Consumes: `OrbitRecord` (Task 4), `PropagationFrames` + `usePropagation` (Task 6), `useExplorer` + `isVisible` (Task 7), `simClock` (Task 5), `TYPE_COLORS` (Task 3).
- Produces:
  - `objectSize(cameraDistance: number): number` (= `0.0042 * d^0.55`)
  - `interpolate(frames: { prev; next; prevTime; nextTime }, timeMs: number, i: number, out: THREE.Vector3): boolean` (false when the position is NaN or missing)
  - `writeInstance(matrix: THREE.Matrix4, pos: THREE.Vector3 | null, vel: THREE.Vector3, size: number, spin: number, dummy: THREE.Object3D): void` (a null position gives a zero-scale matrix)
  - `createSatelliteGeometry(), createRocketBodyGeometry(), createDebrisGeometry(): THREE.BufferGeometry`
  - `<Objects records={OrbitRecord[]} group="LEO" | "HIGH" onReady?: (positionsOf: (noradId: number) => THREE.Vector3 | null) => void />`

- [ ] **Step 1: Write the failing tests**

`web/tests/unit/instances.test.ts`:
```ts
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { interpolate, objectSize, writeInstance } from "@/components/globe/instances";

describe("objectSize", () => {
  it("shrinks slower than distance so shapes grow on screen when zooming in", () => {
    expect(objectSize(1)).toBeCloseTo(0.0042, 6);
    const near = objectSize(1.3) / 0.3;
    const far = objectSize(4) / 3;
    expect(near).toBeGreaterThan(far * 5);
  });
});

describe("interpolate", () => {
  const frames = {
    prev: new Float32Array([1, 0, 0, NaN, NaN, NaN]),
    next: new Float32Array([0, 1, 0, 1, 1, 1]),
    prevTime: 1000,
    nextTime: 2000,
  };
  it("interpolates linearly between frames", () => {
    const v = new THREE.Vector3();
    expect(interpolate(frames, 1500, 0, v)).toBe(true);
    expect(v.toArray()).toEqual([0.5, 0.5, 0]);
  });
  it("reports NaN positions as not drawable", () => {
    expect(interpolate(frames, 1500, 1, new THREE.Vector3())).toBe(false);
  });
  it("is not drawable before any frame exists", () => {
    expect(interpolate({ prev: null, next: null, prevTime: 0, nextTime: 0 }, 0, 0, new THREE.Vector3())).toBe(false);
  });
});

describe("writeInstance", () => {
  it("instance transform hides NaN positions", () => {
    const m = new THREE.Matrix4();
    writeInstance(m, null, new THREE.Vector3(1, 0, 0), 0.01, 0, new THREE.Object3D());
    const s = new THREE.Vector3();
    m.decompose(new THREE.Vector3(), new THREE.Quaternion(), s);
    expect(s.length()).toBe(0);
  });
  it("places visible objects at their position with the requested size", () => {
    const m = new THREE.Matrix4();
    writeInstance(m, new THREE.Vector3(0, 1.1, 0), new THREE.Vector3(1, 0, 0), 0.02, 0, new THREE.Object3D());
    const p = new THREE.Vector3(); const s = new THREE.Vector3();
    m.decompose(p, new THREE.Quaternion(), s);
    expect(p.y).toBeCloseTo(1.1, 6);
    expect(s.x).toBeCloseTo(0.02, 6);
  });
});
```

Run: `npm test -- instances`. Expected: FAIL (module not found).

- [ ] **Step 2: Implement the helpers and geometries**

`web/src/components/globe/instances.ts`:
```ts
import * as THREE from "three";

type Frames = { prev: Float32Array | null; next: Float32Array | null; prevTime: number; nextTime: number };

export function objectSize(cameraDistance: number): number {
  return 0.0042 * Math.pow(cameraDistance, 0.55);
}

export function interpolate(frames: Frames, timeMs: number, i: number, out: THREE.Vector3): boolean {
  const { prev, next, prevTime, nextTime } = frames;
  if (!prev || !next) return false;
  const a = nextTime > prevTime ? Math.min(Math.max((timeMs - prevTime) / (nextTime - prevTime), 0), 1.5) : 1;
  const k = i * 3;
  const x = prev[k] + (next[k] - prev[k]) * a;
  const y = prev[k + 1] + (next[k + 1] - prev[k + 1]) * a;
  const z = prev[k + 2] + (next[k + 2] - prev[k + 2]) * a;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
  out.set(x, y, z);
  return true;
}

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

export function writeInstance(
  matrix: THREE.Matrix4,
  pos: THREE.Vector3 | null,
  vel: THREE.Vector3,
  size: number,
  spin: number,
  dummy: THREE.Object3D,
): void {
  if (!pos) {
    matrix.copy(ZERO);
    return;
  }
  dummy.position.copy(pos);
  dummy.up.copy(pos).normalize();
  dummy.lookAt(pos.x + vel.x, pos.y + vel.y, pos.z + vel.z);
  if (spin) {
    dummy.rotateX(spin);
    dummy.rotateY(spin * 1.3);
  }
  dummy.scale.setScalar(size);
  dummy.updateMatrix();
  matrix.copy(dummy.matrix);
}
```

`web/src/components/globe/objectGeometries.ts`:
```ts
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

function tint(g: THREE.BufferGeometry, hex: string): THREE.BufferGeometry {
  const geo = g.toNonIndexed();
  const c = new THREE.Color(hex);
  const colors = new Float32Array(geo.attributes.position.count * 3);
  for (let i = 0; i < colors.length; i += 3) colors.set([c.r, c.g, c.b], i);
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geo;
}

/** Satellite: cream body, blue panels (payload colour), small dish. Uses vertex colours. */
export function createSatelliteGeometry(): THREE.BufferGeometry {
  const body = new THREE.BoxGeometry(0.6, 0.6, 0.9);
  const p1 = new THREE.BoxGeometry(1.5, 0.05, 0.6).translate(-1.1, 0, 0);
  const p2 = new THREE.BoxGeometry(1.5, 0.05, 0.6).translate(1.1, 0, 0);
  const dish = new THREE.ConeGeometry(0.28, 0.25, 12).rotateX(Math.PI / 2).translate(0, 0, 0.55);
  return mergeGeometries([tint(body, "#f2efe6"), tint(p1, "#3987e5"), tint(p2, "#3987e5"), tint(dish, "#d8d4c8")])!;
}

/** Rocket body: cylinder + nose cone + nozzle, pointing along +Z. */
export function createRocketBodyGeometry(): THREE.BufferGeometry {
  const cyl = new THREE.CylinderGeometry(0.32, 0.32, 1.5, 14).toNonIndexed();
  const nose = new THREE.ConeGeometry(0.32, 0.55, 14).translate(0, 1.02, 0).toNonIndexed();
  const nozzle = new THREE.CylinderGeometry(0.18, 0.3, 0.25, 12).translate(0, -0.87, 0).toNonIndexed();
  return mergeGeometries([cyl, nose, nozzle])!.rotateX(Math.PI / 2);
}

/** Debris: a jagged, flattened shard. */
export function createDebrisGeometry(): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(0.55, 0).toNonIndexed();
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const s = 0.55 + Math.abs(Math.sin(i * 12.9898) * 0.9);
    p.setXYZ(i, p.getX(i) * s, p.getY(i) * s * 0.6, p.getZ(i) * s);
  }
  g.computeVertexNormals();
  return g;
}
```

- [ ] **Step 3: Implement the Objects component**

`web/src/components/globe/Objects.tsx`:
```tsx
"use client";

import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { simClock } from "@/lib/clock";
import type { OrbitRecord } from "@/lib/snapshot";
import { isVisible, useExplorer } from "@/lib/store";
import { TYPE_COLORS, type ObjectType } from "@/lib/types";
import { usePropagation } from "@/components/globe/usePropagation";
import { interpolate, objectSize, writeInstance } from "@/components/globe/instances";
import { createDebrisGeometry, createRocketBodyGeometry, createSatelliteGeometry } from "@/components/globe/objectGeometries";

type Kind = "sat" | "rb" | "deb";
const kindOf = (t: ObjectType): Kind => (t === "PAY" ? "sat" : t === "R/B" ? "rb" : "deb");
const SIZE_FACTOR: Record<Kind, number> = { sat: 1, rb: 1.15, deb: 0.8 };

export function Objects({
  records,
  group,
  onReady,
}: {
  records: OrbitRecord[];
  group: "LEO" | "HIGH";
  onReady?: (positionOf: (noradId: number) => THREE.Vector3 | null) => void;
}) {
  const frames = usePropagation(records);
  const camera = useThree((s) => s.camera);
  const types = useExplorer((s) => s.types);
  const owners = useExplorer((s) => s.owners);
  const orbits = useExplorer((s) => s.orbits);
  const selectedId = useExplorer((s) => s.selectedId);
  const select = useExplorer((s) => s.select);

  const buckets = useMemo(() => {
    const idx: Record<Kind, number[]> = { sat: [], rb: [], deb: [] };
    records.forEach((r, i) => idx[kindOf(r.type)].push(i));
    return idx;
  }, [records]);

  const visible = useMemo(
    () => records.map((r) => isVisible(r, group, { types, owners, orbits })),
    [records, group, types, owners, orbits],
  );

  const geometries = useMemo(
    () => ({ sat: createSatelliteGeometry(), rb: createRocketBodyGeometry(), deb: createDebrisGeometry() }),
    [],
  );
  const materials = useMemo(() => {
    const ramp = new THREE.DataTexture(new Uint8Array([90, 90, 90, 255, 175, 175, 175, 255, 255, 255, 255, 255]), 3, 1);
    ramp.minFilter = ramp.magFilter = THREE.NearestFilter;
    ramp.needsUpdate = true;
    return {
      sat: new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: ramp, emissive: "#222222" }),
      rb: new THREE.MeshToonMaterial({ color: TYPE_COLORS["R/B"], gradientMap: ramp, emissive: "#062a1e" }),
      deb: new THREE.MeshToonMaterial({ color: TYPE_COLORS.DEB, gradientMap: ramp, emissive: "#3a1006" }),
    };
  }, []);
  useEffect(
    () => () => {
      Object.values(geometries).forEach((g) => g.dispose());
      Object.values(materials).forEach((m) => m.dispose());
    },
    [geometries, materials],
  );

  const meshes = { sat: useRef<THREE.InstancedMesh>(null), rb: useRef<THREE.InstancedMesh>(null), deb: useRef<THREE.InstancedMesh>(null) };
  const scratch = useMemo(
    () => ({ pos: new THREE.Vector3(), ahead: new THREE.Vector3(), vel: new THREE.Vector3(), m: new THREE.Matrix4(), dummy: new THREE.Object3D() }),
    [],
  );

  const indexById = useMemo(() => new Map(records.map((r, i) => [r.noradId, i])), [records]);
  useEffect(() => {
    onReady?.((noradId) => {
      const i = indexById.get(noradId);
      const v = new THREE.Vector3();
      return i !== undefined && interpolate(frames.current, simClock.now(), i, v) ? v : null;
    });
  }, [indexById, frames, onReady]);

  useFrame(() => {
    const now = simClock.now();
    const size = objectSize(camera.position.length());
    const { pos, ahead, vel, m, dummy } = scratch;
    (Object.keys(buckets) as Kind[]).forEach((kind) => {
      const mesh = meshes[kind].current;
      if (!mesh) return;
      buckets[kind].forEach((recordIndex, instance) => {
        const drawable = visible[recordIndex] && interpolate(frames.current, now, recordIndex, pos);
        if (drawable) {
          if (interpolate(frames.current, now + 1000 * simClock.scale, recordIndex, ahead)) vel.subVectors(ahead, pos);
          else vel.set(1, 0, 0);
        }
        const selectedBoost = records[recordIndex].noradId === selectedId ? 2.2 : 1;
        const spin = kind === "deb" ? (recordIndex % 97) * 0.13 + now * 0.0004 : 0;
        writeInstance(m, drawable ? pos : null, vel, size * SIZE_FACTOR[kind] * selectedBoost, spin, dummy);
        mesh.setMatrixAt(instance, m);
      });
      mesh.instanceMatrix.needsUpdate = true;
    });
  });

  const onClick = (kind: Kind) => (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (e.instanceId === undefined) return;
    select(records[buckets[kind][e.instanceId]].noradId);
  };

  return (
    <>
      {(Object.keys(buckets) as Kind[]).map((kind) =>
        buckets[kind].length ? (
          <instancedMesh
            key={kind}
            ref={meshes[kind]}
            args={[geometries[kind], materials[kind], buckets[kind].length]}
            frustumCulled={false}
            onClick={onClick(kind)}
            onPointerOver={() => (document.body.style.cursor = "pointer")}
            onPointerOut={() => (document.body.style.cursor = "")}
          />
        ) : null,
      )}
    </>
  );
}
```

- [ ] **Step 4: Verify and commit**

Run: `npm test -- instances` (6 passed), `npm run lint && npm run typecheck`.
```bash
git add web/src/components/globe/objectGeometries.ts web/src/components/globe/instances.ts web/src/components/globe/Objects.tsx web/tests/unit/instances.test.ts
git commit -m "feat(web): instanced satellite, rocket-body and debris shapes with zoom sizing and picking" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 10: Globe scene: camera, controls, sun light, dither post-process, fly-to and globe section

**Files:**
- Create: `web/src/components/globe/DitherEffect.ts`, `web/src/components/globe/flyTo.ts`, `web/src/components/globe/GlobeScene.tsx`, `web/src/components/globe/GlobeSection.tsx`, `web/tests/unit/flyTo.test.ts`

**Interfaces:**
- Consumes: `Earth` (Task 8), `Objects` (Task 9), `hasWebGL` (Task 8), `api.snapshot` (Task 3), `loadSnapshot` (Task 4), `simClock`/`sunDirectionScene` (Task 5), `useExplorer` (Task 7), `prefersReducedMotion` (Task 7).
- Produces:
  - `DitherEffectImpl` (a postprocessing `Effect`: uniforms `cell`, `levels`, `grain`) and `<Dither cell levels grain />`
  - `shortestAngle(from: number, to: number): number` (radians, result in (−π, π])
  - `flyTo(camera: THREE.PerspectiveCamera, target: THREE.Vector3, distance: number, onDone?: () => void): { cancel(): void }`
  - `<GlobeSection />`: the whole globe card. It includes the WebGL fallback, the snapshot-loading, "Orbit data not available yet" and "Data unavailable" overlays, the UTC and subsolar readout, and the time-speed toggle (Live / 1 day per 20 s).

- [ ] **Step 1: Write the failing test for the camera maths**

`web/tests/unit/flyTo.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { shortestAngle } from "@/components/globe/flyTo";

describe("shortestAngle", () => {
  it("goes the short way round the globe", () => {
    expect(shortestAngle(0.1, 0.3)).toBeCloseTo(0.2, 10);
    expect(shortestAngle(3.0, -3.0)).toBeCloseTo(2 * Math.PI - 6, 10);
    expect(shortestAngle(-3.0, 3.0)).toBeCloseTo(-(2 * Math.PI - 6), 10);
  });
});
```

Run: `npm test -- flyTo`. Expected: FAIL (module not found).

- [ ] **Step 2: Implement fly-to and the dither effect**

`web/src/components/globe/flyTo.ts`:
```ts
import { animate } from "animejs";
import * as THREE from "three";
import { prefersReducedMotion } from "@/lib/motion";

export function shortestAngle(from: number, to: number): number {
  const d = to - from;
  return Math.atan2(Math.sin(d), Math.cos(d));
}

/** Arcs the camera around the globe (never through it) to look at `target` from `distance`. */
export function flyTo(
  camera: THREE.PerspectiveCamera,
  target: THREE.Vector3,
  distance: number,
  onDone?: () => void,
): { cancel(): void } {
  const from = new THREE.Spherical().setFromVector3(camera.position);
  const to = new THREE.Spherical().setFromVector3(target.clone().normalize().multiplyScalar(distance));
  const apply = (r: number, phi: number, theta: number) => {
    camera.position.setFromSpherical(new THREE.Spherical(r, phi, theta));
    camera.lookAt(0, 0, 0);
  };
  if (prefersReducedMotion()) {
    apply(to.radius, to.phi, to.theta);
    onDone?.();
    return { cancel() {} };
  }
  const s = { r: from.radius, phi: from.phi, theta: from.theta };
  const anim = animate(s, {
    r: [from.radius, Math.max(from.radius, to.radius) + 0.6, to.radius],
    phi: to.phi,
    theta: from.theta + shortestAngle(from.theta, to.theta),
    duration: 2000,
    ease: "inOutQuart",
    onUpdate: () => apply(s.r, s.phi, s.theta),
    onComplete: () => onDone?.(),
  });
  return { cancel: () => anim.pause() };
}
```

`web/src/components/globe/DitherEffect.ts`:
```ts
import { Effect, EffectAttribute } from "postprocessing";
import { Uniform } from "three";

// Subtle ordered dither + grain (spec §6.2: cell 2 px, 7 levels, grain 0.09). Quantisation
// happens in display (sRGB-like) space; grain is multiplicative so black space stays black.
const fragmentShader = /* glsl */ `
uniform float cell;
uniform float levels;
uniform float grain;

float bayer4(vec2 p) {
  int x = int(mod(p.x, 4.0));
  int y = int(mod(p.y, 4.0));
  int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return (float(m[x + y * 4]) + 0.5) / 16.0;
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec2 frag = uv * resolution;
  vec2 cellId = floor(frag / cell);
  vec3 c = texture2D(inputBuffer, (cellId * cell + cell * 0.5) / resolution).rgb;
  vec3 display = pow(max(c, 0.0), vec3(1.0 / 2.2));
  float L = levels - 1.0;
  vec3 q = floor(display * L + bayer4(cellId)) / L;
  float g = vnoise(frag * 0.9) * 0.55 + hash(frag) * 0.45;
  q *= 1.0 + (g - 0.5) * grain * 2.0;
  outputColor = vec4(pow(clamp(q, 0.0, 1.0), vec3(2.2)), inputColor.a);
}`;

export class DitherEffectImpl extends Effect {
  constructor({ cell = 2, levels = 7, grain = 0.09 } = {}) {
    super("DitherEffect", fragmentShader, {
      // Samples the input at the cell centre (not just the current pixel).
      attributes: EffectAttribute.CONVOLUTION,
      uniforms: new Map<string, Uniform>([
        ["cell", new Uniform(cell)],
        ["levels", new Uniform(levels)],
        ["grain", new Uniform(grain)],
      ]),
    });
  }
}
```

- [ ] **Step 3: Implement the scene and section**

`web/src/components/globe/GlobeScene.tsx`:
```tsx
"use client";

import { OrbitControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { EffectComposer } from "@react-three/postprocessing";
import { useCallback, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { simClock } from "@/lib/clock";
import type { OrbitRecord } from "@/lib/snapshot";
import { useExplorer } from "@/lib/store";
import { sunDirectionScene } from "@/lib/sun";
import { DitherEffectImpl } from "@/components/globe/DitherEffect";
import { Earth } from "@/components/globe/Earth";
import { flyTo } from "@/components/globe/flyTo";
import { Objects } from "@/components/globe/Objects";

export function GlobeScene({ leo, high }: { leo: OrbitRecord[] | null; high: OrbitRecord[] | null }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const sun = useRef<THREE.DirectionalLight>(null);
  const timeScale = useExplorer((s) => s.timeScale);
  const selectedId = useExplorer((s) => s.selectedId);
  const locators = useRef<((id: number) => THREE.Vector3 | null)[]>([]);
  const dither = useMemo(
    () => new DitherEffectImpl({ cell: 2 * Math.min(window.devicePixelRatio, 2), levels: 7, grain: 0.09 }),
    [],
  );

  useEffect(() => simClock.setScale(timeScale), [timeScale]);

  useEffect(() => {
    if (selectedId === null) return;
    for (const find of locators.current) {
      const p = find(selectedId);
      if (p) {
        const fly = flyTo(camera, p, Math.max(1.35, p.length() + 0.45));
        return () => fly.cancel();
      }
    }
  }, [selectedId, camera]);

  const onReadyLeo = useCallback((f: (id: number) => THREE.Vector3 | null) => (locators.current[0] = f), []);
  const onReadyHigh = useCallback((f: (id: number) => THREE.Vector3 | null) => (locators.current[1] = f), []);

  useFrame((_, dt) => {
    simClock.tick(Math.min(dt, 0.1) * 1000);
    const [x, y, z] = sunDirectionScene(new Date(simClock.now()));
    sun.current?.position.set(x * 10, y * 10, z * 10);
  });

  return (
    <>
      <ambientLight intensity={0.35} />
      <directionalLight ref={sun} intensity={2.2} />
      <Earth />
      {leo && <Objects records={leo} group="LEO" onReady={onReadyLeo} />}
      {high && <Objects records={high} group="HIGH" onReady={onReadyHigh} />}
      <OrbitControls enableDamping enablePan={false} minDistance={1.12} maxDistance={9} zoomSpeed={0.8} />
      <EffectComposer multisampling={0}>
        <primitive object={dither} dispose={null} />
      </EffectComposer>
    </>
  );
}
```

`web/src/components/globe/GlobeSection.tsx`:
```tsx
"use client";

import { Canvas } from "@react-three/fiber";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { simClock } from "@/lib/clock";
import { loadSnapshot, type OrbitRecord } from "@/lib/snapshot";
import { useExplorer } from "@/lib/store";
import { subsolarPoint } from "@/lib/sun";
import { GlobeScene } from "@/components/globe/GlobeScene";
import { hasWebGL } from "@/components/globe/webgl";

type Status = "loading" | "ready" | "missing" | "error";

async function fetchGroup(group: "LEO" | "HIGH"): Promise<OrbitRecord[] | null> {
  const gz = await api.snapshot(group);
  return gz ? (await loadSnapshot(gz)).records : null;
}

function Readout() {
  const [text, setText] = useState("");
  useEffect(() => {
    const id = window.setInterval(() => {
      const d = new Date(simClock.now());
      const s = subsolarPoint(d);
      const lat = `${Math.abs(s.latDeg).toFixed(1)}°${s.latDeg >= 0 ? "N" : "S"}`;
      const lon = `${Math.abs(s.lonDeg).toFixed(1)}°${s.lonDeg >= 0 ? "E" : "W"}`;
      setText(`${d.toISOString().slice(0, 16).replace("T", " ")} UTC · SUN OVER ${lat} ${lon}`);
    }, 1000);
    return () => window.clearInterval(id);
  }, []);
  return <p className="label" aria-live="off">{text}</p>;
}

export function GlobeSection() {
  const [webgl, setWebgl] = useState<boolean | null>(null);
  const [leo, setLeo] = useState<OrbitRecord[] | null>(null);
  const [high, setHigh] = useState<OrbitRecord[] | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const wantHigh = useExplorer((s) => s.orbits.high);
  const timeScale = useExplorer((s) => s.timeScale);
  const setTimeScale = useExplorer((s) => s.setTimeScale);

  useEffect(() => setWebgl(hasWebGL()), []);

  useEffect(() => {
    let cancelled = false;
    fetchGroup("LEO")
      .then((records) => {
        if (cancelled) return;
        setLeo(records);
        setStatus(records ? "ready" : "missing");
      })
      .catch(() => !cancelled && setStatus("error"));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!wantHigh || high) return;
    fetchGroup("HIGH").then(setHigh).catch(() => undefined);
  }, [wantHigh, high]);

  return (
    <section className="card relative h-[420px] overflow-hidden sm:h-[560px]" aria-label="Live globe of tracked objects">
      {webgl && (
        <Canvas
          style={{ position: "absolute", inset: 0 }}
          camera={{ position: [0.6, 0.9, 3.6], fov: 40, near: 0.005, far: 100 }}
          dpr={[1, 2]}
          gl={{ antialias: true }}
        >
          <color attach="background" args={["#000000"]} />
          <GlobeScene leo={leo} high={high} />
        </Canvas>
      )}
      <div className="pointer-events-none absolute left-4 top-3 right-4 flex flex-col gap-1">
        <Readout />
        {webgl === false && <p className="text-sm text-ink-2">This device can&apos;t show the 3D globe (WebGL is unavailable). Charts and search still work.</p>}
        {webgl && status === "loading" && <p className="label">Loading orbits…</p>}
        {webgl && status === "missing" && <p className="text-sm text-ink-2">Orbit data not available yet.</p>}
        {webgl && status === "error" && <p className="text-sm text-ink-2">Data unavailable. The Earth is shown without objects.</p>}
      </div>
      <div className="absolute bottom-3 left-4 flex gap-2">
        {([1, 4320] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => {
              if (s === 1) simClock.reset();
              setTimeScale(s);
            }}
            aria-pressed={timeScale === s}
            className={`rounded-full border-2 px-3 py-2 text-sm ${timeScale === s ? "border-ink text-ink" : "border-line text-ink-2"} bg-[#121212]`}
          >
            {s === 1 ? "Live" : "Fast · 1 day / 20 s"}
          </button>
        ))}
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Verify (unit tests, types and a visual check) and commit**

Run: `npm test -- flyTo` (1 passed), `npm run lint && npm run typecheck && npm run build`.
Visual check: temporarily render `<GlobeSection />` in `src/app/page.tsx`, run the API with data plus `npm run dev`, and open http://localhost:3000. Confirm:
- the Earth shows blue ocean, green land and ink coastlines;
- the day/night boundary sits where the readout says the Sun is, with a gradual dithered twilight;
- a fine grain/dither texture is visible;
- satellites, rocket bodies and debris have distinct shapes that get clearly bigger when you zoom in close;
- clicking an object sets the selection (its shape enlarges);
- "Fast" makes the terminator sweep.

Take a screenshot (for example with Playwright's `page.screenshot`) and attach its path in the report. Revert the temporary page change (Task 12 builds the real page).
```bash
git add web/src/components/globe web/tests/unit/flyTo.test.ts
git commit -m "feat(web): globe scene with real-sun light, subtle dither pass, fly-to and fallbacks" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 11: Charts: line chart with annotations, and stacked owner bars

**Files:**
- Create: `web/src/components/charts/LineChart.tsx`, `web/src/components/charts/BarChart.tsx`, `web/tests/unit/chartScales.test.ts`, `web/src/components/charts/scales.ts`

**Interfaces:**
- Consumes: `TimeseriesResponse`, `BreakdownResponse`, `OwnerSummary`, `TYPE_COLORS`, `TYPE_LABELS` (Task 3); `visibleTypeSeries`, `ANNOTATIONS`, `ownerLabel` (Task 7); `prefersReducedMotion` (Task 7); `fmtInt` (Task 1).
- Produces: `niceMax(max: number): number` (next of 1/2/2.5/5 × 10ⁿ at or above max); `yTicks(max: number): number[]` (5 ticks from 0); `<LineChart data={TimeseriesResponse} />` (SVG, 330px tall, responsive width via ResizeObserver, crosshair plus tooltip, direct end labels plus legend, annotation lines, draw-in on first view with anime.js `createDrawable`); `<BarChart data={BreakdownResponse} owners={OwnerSummary[]} />` (stacked horizontal PAY/DEB/R/B with a 2px gap, hover tooltip, grow-in on first view).

- [ ] **Step 1: Write the failing tests**

`web/tests/unit/chartScales.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { niceMax, yTicks } from "@/components/charts/scales";

describe("chart scales", () => {
  it("rounds the axis max up to a clean number", () => {
    expect(niceMax(15229)).toBe(20000);
    expect(niceMax(9994)).toBe(10000);
    expect(niceMax(2300)).toBe(2500);
    expect(niceMax(0)).toBe(1);
  });
  it("makes five evenly spaced ticks from zero", () => {
    expect(yTicks(20000)).toEqual([0, 5000, 10000, 15000, 20000]);
  });
});
```

Run: `npm test -- chartScales`. Expected: FAIL (module not found).

- [ ] **Step 2: Implement the scales**

`web/src/components/charts/scales.ts`:
```ts
export function niceMax(max: number): number {
  if (max <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(max)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * exp >= max) return m * exp;
  return 10 * exp;
}

export function yTicks(max: number): number[] {
  return [0, 1, 2, 3, 4].map((i) => (max / 4) * i);
}
```

- [ ] **Step 3: Implement the charts**

`web/src/components/charts/LineChart.tsx`:
```tsx
"use client";

import { animate, createDrawable, stagger } from "animejs";
import { scaleLinear } from "d3-scale";
import { curveMonotoneX, line } from "d3-shape";
import { useEffect, useRef, useState } from "react";
import { ANNOTATIONS, visibleTypeSeries } from "@/lib/chartData";
import { fmtInt } from "@/lib/format";
import { prefersReducedMotion } from "@/lib/motion";
import { TYPE_COLORS, TYPE_LABELS, type TimeseriesResponse } from "@/lib/types";
import { niceMax, yTicks } from "@/components/charts/scales";

const H = 330;
const M = { t: 30, r: 118, b: 28, l: 52 };

export function LineChart({ data }: { data: TimeseriesResponse }) {
  const wrap = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(320, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const series = visibleTypeSeries(data);
  const years = data.years;
  const x = scaleLinear().domain([years[0], years[years.length - 1]]).range([M.l, width - M.r]);
  const yMax = niceMax(Math.max(1, ...series.flatMap((s) => s.values)));
  const y = scaleLinear().domain([0, yMax]).range([H - M.b, M.t]);
  const path = line<number>().x((_, i) => x(years[i])).y((v) => y(v)).curve(curveMonotoneX);
  const narrow = width < 520;

  useEffect(() => {
    const el = svg.current;
    if (!el || prefersReducedMotion()) return;
    const paths = el.querySelectorAll<SVGPathElement>("path[data-series]");
    paths.forEach((p) => (p.style.opacity = "0"));
    const io = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      io.disconnect();
      paths.forEach((p) => (p.style.opacity = "1"));
      animate(createDrawable(Array.from(paths)), { draw: ["0 0", "0 1"], duration: 1800, delay: stagger(200), ease: "inOutQuad" });
    }, { threshold: 0.3 });
    io.observe(el);
    return () => io.disconnect();
  }, [data]);

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const year = Math.round(x.invert(e.clientX - rect.left + M.l));
    const i = years.indexOf(year);
    if (i >= 0) setHover({ i, x: e.clientX, y: e.clientY });
  };

  return (
    <div ref={wrap} className="relative">
      <div className="mb-2 flex flex-wrap gap-4 text-[13px] text-ink-2">
        {series.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-2">
            <i className="inline-block h-2.5 w-2.5 rounded-[3px]" style={{ background: TYPE_COLORS[s.key] }} />
            {TYPE_LABELS[s.key]}
          </span>
        ))}
      </div>
      <svg ref={svg} width={width} height={H} role="img" aria-label="Objects in orbit per year by type" className="block max-w-full">
        {yTicks(yMax).map((t) => (
          <g key={t}>
            <line x1={M.l} x2={width - M.r} y1={y(t)} y2={y(t)} stroke="#1e1e1e" />
            <text x={M.l - 8} y={y(t) + 4} textAnchor="end" className="fill-ink-3 font-mono text-[12px]">{fmtInt(t)}</text>
          </g>
        ))}
        {[years[0], ...years.filter((yr) => yr % 20 === 0), years[years.length - 1]]
          .filter((v, i, a) => a.indexOf(v) === i)
          .map((yr) => (
            <text key={yr} x={x(yr)} y={H - 6} textAnchor="middle" className="fill-ink-3 font-mono text-[12px]">{yr}</text>
          ))}
        {!narrow && ANNOTATIONS.filter((a) => a.year >= years[0] && a.year <= years[years.length - 1]).map((a) => (
          <g key={a.year}>
            <line x1={x(a.year)} x2={x(a.year)} y1={M.t + a.row * 14} y2={H - M.b} stroke="#3a3a3a" strokeDasharray="3 4" />
            <text x={x(a.year) - 4} y={M.t - 8 + a.row * 14} textAnchor="end" className="fill-ink-2 font-mono text-[12px]">{a.label}</text>
          </g>
        ))}
        {series.map((s) => (
          <path key={s.key} data-series={s.key} d={path(s.values) ?? ""} fill="none" stroke={TYPE_COLORS[s.key]} strokeWidth={2.5} strokeLinecap="round" />
        ))}
        {series.map((s) => {
          const v = s.values[s.values.length - 1];
          return (
            <g key={s.key}>
              <circle cx={x(years[years.length - 1])} cy={y(v)} r={4.5} fill={TYPE_COLORS[s.key]} stroke="#0e0e0e" strokeWidth={2} />
              <text x={x(years[years.length - 1]) + 10} y={y(v) + 4} className="fill-ink font-mono text-[12px]">{fmtInt(v)}</text>
            </g>
          );
        })}
        {hover && <line x1={x(years[hover.i])} x2={x(years[hover.i])} y1={M.t} y2={H - M.b} stroke="#555" />}
        <rect x={M.l} y={M.t} width={width - M.l - M.r} height={H - M.t - M.b} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
      </svg>
      {hover && (
        <div className="pointer-events-none fixed z-10 min-w-40 rounded-[10px] border-2 border-[#333] bg-[#161616] px-3 py-2.5 text-[12px] shadow-[3px_3px_0_#0a0a0a]" style={{ left: hover.x + 14, top: hover.y + 14 }}>
          <div className="font-mono text-ink">{years[hover.i]}</div>
          {series.map((s) => (
            <div key={s.key} className="mt-1 flex justify-between gap-4 text-ink-2">
              <span>{TYPE_LABELS[s.key]}</span>
              <b className="font-medium text-ink">{fmtInt(s.values[hover.i])}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

`web/src/components/charts/BarChart.tsx`:
```tsx
"use client";

import { animate, stagger } from "animejs";
import { scaleBand, scaleLinear } from "d3-scale";
import { useEffect, useRef, useState } from "react";
import { ownerLabel } from "@/lib/chartData";
import { fmtInt } from "@/lib/format";
import { prefersReducedMotion } from "@/lib/motion";
import { TYPE_COLORS, TYPE_LABELS, type BreakdownResponse, type ObjectType, type OwnerSummary } from "@/lib/types";

const KEYS: ObjectType[] = ["PAY", "DEB", "R/B"];
const M = { t: 8, r: 60, b: 8, l: 110 };

export function BarChart({ data, owners }: { data: BreakdownResponse; owners: OwnerSummary[] }) {
  const wrap = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(360);
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rows = data.rows.slice(0, 6);
  const H = Math.max(160, rows.length * 48 + M.t + M.b);
  const x = scaleLinear().domain([0, Math.max(1, ...rows.map((r) => r.total))]).range([M.l, width - M.r]);
  const y = scaleBand().domain(rows.map((r) => r.key)).range([M.t, H - M.b]).padding(0.38);

  useEffect(() => {
    const el = svg.current;
    if (!el || prefersReducedMotion()) return;
    const segs = el.querySelectorAll<SVGRectElement>("rect[data-seg]");
    segs.forEach((s) => (s.style.transform = "scaleX(0)"));
    const io = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      io.disconnect();
      animate(Array.from(segs), { scaleX: [0, 1], delay: stagger(60), duration: 800, ease: "outBack(1.4)" });
    }, { threshold: 0.3 });
    io.observe(el);
    return () => io.disconnect();
  }, [data]);

  return (
    <div ref={wrap} className="relative">
      <svg ref={svg} width={width} height={H} role="img" aria-label="Objects in orbit by owner and type" className="block max-w-full">
        {rows.map((row) => {
          let acc = 0;
          const label = ownerLabel(row.key, owners);
          return (
            <g key={row.key}>
              <text x={M.l - 10} y={(y(row.key) ?? 0) + y.bandwidth() / 2 + 4} textAnchor="end" className="fill-ink font-mono text-[12px]">
                {label.length > 14 ? `${label.slice(0, 13)}…` : label}
              </text>
              {KEYS.map((k) => {
                const v = row.counts[k] ?? 0;
                if (!v) return null;
                const x0 = x(acc) + (acc ? 1 : 0);
                acc += v;
                const w = Math.max(0, x(acc) - x0 - 1);
                return (
                  <rect
                    key={k}
                    data-seg
                    x={x0}
                    y={y(row.key)}
                    width={w}
                    height={y.bandwidth()}
                    rx={4}
                    fill={TYPE_COLORS[k]}
                    style={{ transformOrigin: `${M.l}px 0px` }}
                    onPointerMove={(e) => setTip({ text: `${label} · ${TYPE_LABELS[k]}: ${fmtInt(v)}`, x: e.clientX, y: e.clientY })}
                    onPointerLeave={() => setTip(null)}
                  />
                );
              })}
              <text x={x(row.total) + 8} y={(y(row.key) ?? 0) + y.bandwidth() / 2 + 4} className="fill-ink-2 font-mono text-[12px]">{fmtInt(row.total)}</text>
            </g>
          );
        })}
      </svg>
      {tip && (
        <div className="pointer-events-none fixed z-10 rounded-[10px] border-2 border-[#333] bg-[#161616] px-3 py-2.5 text-[12px] text-ink shadow-[3px_3px_0_#0a0a0a]" style={{ left: tip.x + 14, top: tip.y + 14 }}>
          {tip.text}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Verify and commit**

Run: `npm test -- chartScales` (2 passed), `npm run lint && npm run typecheck`.
```bash
git add web/src/components/charts web/tests/unit/chartScales.test.ts
git commit -m "feat(web): animated line and stacked bar charts" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 12: Explorer page: header, intro, stat tiles, filters, search, object card, chat placeholder, footer

**Files:**
- Create: `web/src/components/ui/PixelIcon.tsx`, `web/src/components/ui/Card.tsx`, `web/src/components/ui/Unavailable.tsx`, `web/src/components/panels/{Header,Intro,StatTiles,Filters,SearchBox,ObjectCard,ChatPanel,Footer}.tsx`
- Modify: `web/src/app/page.tsx` (replace placeholder)

**Interfaces:**
- Consumes: everything above: `api`, `useExplorer`, `regimesFor`, `GlobeSection`, `LineChart`, `BarChart`, `chartTitle`, `countUp`, `fmt*`, `TYPE_*`.
- Produces: `<PixelIcon name="sat" | "deb" | "rb" | "chat" size?: number color?: string />`; `<Card as? className? children />`; `<Unavailable what: string />` (renders "Data unavailable: {what}."); the explorer page at `/`.

- [ ] **Step 1: Implement the UI primitives**

`web/src/components/ui/PixelIcon.tsx`:
```tsx
const ICONS = {
  sat: ["........", "##....##", "##.##.##", "###..###", "##.##.##", "##....##", "...##...", "..####.."],
  deb: ["........", "..#.....", "......#.", "...##...", "#..##...", ".......#", ".#...#..", "........"],
  rb: ["...##...", "..####..", "..####..", "..####..", "..####..", ".######.", ".#.##.#.", "...##..."],
  chat: ["########", "#......#", "#.#.#..#", "#......#", "########", "..#.....", ".#......", "........"],
} as const;

export type PixelIconName = keyof typeof ICONS;

export function PixelIcon({ name, size = 12, color = "currentColor" }: { name: PixelIconName; size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 8 8" shapeRendering="crispEdges" aria-hidden="true">
      {ICONS[name].flatMap((row, y) =>
        [...row].map((c, x) => (c === "#" ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={color} /> : null)),
      )}
    </svg>
  );
}
```

`web/src/components/ui/Card.tsx`:
```tsx
export function Card({ className = "", children, ...rest }: React.HTMLAttributes<HTMLElement>) {
  return (
    <section className={`card p-5 ${className}`} {...rest}>
      {children}
    </section>
  );
}
```

`web/src/components/ui/Unavailable.tsx`:
```tsx
export function Unavailable({ what }: { what: string }) {
  return <p className="text-sm text-ink-2" role="status">Data unavailable: {what}.</p>;
}
```

- [ ] **Step 2: Implement the panels**

`web/src/components/panels/Header.tsx`:
```tsx
import Link from "next/link";
import { PixelIcon } from "@/components/ui/PixelIcon";

export function Header() {
  return (
    <header className="flex items-center justify-between py-5">
      <Link href="/" className="flex items-center gap-2.5 font-mono text-[15px] text-ink">
        <PixelIcon name="sat" size={18} color="#3987e5" /> LEO / DEBRIS
      </Link>
      <nav className="flex gap-5 text-sm text-ink-2">
        <Link href="/#explore" className="hover:text-ink">Explore</Link>
        <Link href="/about" className="hover:text-ink">About</Link>
        <a href="https://kudayyurter.dev" className="hover:text-ink">kudayyurter.dev ↗</a>
      </nav>
    </header>
  );
}
```

`web/src/components/panels/Intro.tsx`:
```tsx
import { Card } from "@/components/ui/Card";

export function Intro() {
  return (
    <Card>
      <h1 className="font-mono text-[28px] leading-tight text-ink sm:text-[34px]">Low Earth orbit is getting crowded.</h1>
      <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
        Every tracked satellite, rocket body and fragment within 2,000 km of Earth, moving live. Click an object to
        see what it is, or scroll down to see how we got here.
      </p>
    </Card>
  );
}
```

`web/src/components/panels/StatTiles.tsx`:
```tsx
"use client";

import { useEffect, useRef } from "react";
import { countUp } from "@/lib/motion";
import type { Meta, ObjectType } from "@/lib/types";
import { PixelIcon, type PixelIconName } from "@/components/ui/PixelIcon";
import { Unavailable } from "@/components/ui/Unavailable";

const TILES: { type: ObjectType; label: string; sub: string; icon: PixelIconName; color: string }[] = [
  { type: "PAY", label: "Payloads", sub: "active and dead satellites", icon: "sat", color: "#3987e5" },
  { type: "DEB", label: "Debris", sub: "tracked fragments ≥10 cm", icon: "deb", color: "#d95926" },
  { type: "R/B", label: "Rocket bodies", sub: "spent upper stages", icon: "rb", color: "#199e70" },
];

function Tile({ value, index, ...t }: (typeof TILES)[number] & { value: number; index: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) countUp(ref.current, value, 300 + index * 120);
  }, [value, index]);
  return (
    <div className="card p-4" data-testid={`tile-${t.type}`}>
      <div className="flex items-center gap-2 text-[13px] text-ink-2"><PixelIcon name={t.icon} color={t.color} />{t.label}</div>
      <div ref={ref} className="mt-2 font-mono text-[28px] text-ink">0</div>
      <div className="mt-1 text-[12px] text-ink-3">{t.sub}</div>
    </div>
  );
}

export function StatTiles({ meta, error }: { meta: Meta | null; error: boolean }) {
  if (error) return <div className="card p-4"><Unavailable what="object counts" /></div>;
  return (
    <div className="grid grid-cols-3 gap-3">
      {TILES.map((t, i) => (
        <Tile key={t.type} {...t} index={i} value={meta?.in_orbit[t.type]?.LEO ?? 0} />
      ))}
    </div>
  );
}
```

`web/src/components/panels/Filters.tsx`:
```tsx
"use client";

import { useExplorer } from "@/lib/store";
import { TYPE_COLORS, TYPE_LABELS, type Meta, type ObjectType } from "@/lib/types";
import { Card } from "@/components/ui/Card";

const TYPES: ObjectType[] = ["PAY", "DEB", "R/B"];

export function Filters({ meta }: { meta: Meta | null }) {
  const { types, owners, orbits, toggleType, setOwners, toggleOrbit } = useExplorer();
  const topOwners = (meta?.owners ?? []).slice(0, 8);
  const chip = (on: boolean) =>
    `rounded-full border-2 px-3 py-1.5 text-[13px] ${on ? "border-ink text-ink" : "border-line text-ink-2"} bg-[#121212]`;

  return (
    <Card aria-label="Filters">
      <p className="label">Object types</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {TYPES.map((t) => (
          <button key={t} type="button" aria-pressed={types.includes(t)} className={chip(types.includes(t))} onClick={() => toggleType(t)}>
            <span className="mr-1.5 inline-block h-2 w-2 rounded-[2px]" style={{ background: TYPE_COLORS[t] }} />
            {TYPE_LABELS[t]}
          </button>
        ))}
      </div>
      <p className="label mt-4">Orbits</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" aria-pressed={orbits.leo} className={chip(orbits.leo)} onClick={() => toggleOrbit("leo")}>Low Earth orbit</button>
        <button type="button" aria-pressed={orbits.high} className={chip(orbits.high)} onClick={() => toggleOrbit("high")}>Higher orbits</button>
      </div>
      <label className="label mt-4 block" htmlFor="owner">Owner</label>
      <select
        id="owner"
        className="mt-2 w-full rounded-[10px] border-2 border-line bg-[#121212] px-3 py-2 text-sm text-ink"
        value={owners[0] ?? ""}
        onChange={(e) => setOwners(e.target.value ? [e.target.value] : [])}
      >
        <option value="">All owners</option>
        {topOwners.map((o) => (
          <option key={o.code} value={o.code}>{`${o.flag_emoji ?? ""} ${o.name}`.trim()}</option>
        ))}
      </select>
    </Card>
  );
}
```

`web/src/components/panels/SearchBox.tsx`:
```tsx
"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useExplorer } from "@/lib/store";
import { TYPE_LABELS, type SearchResult } from "@/lib/types";

export function SearchBox() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const select = useExplorer((s) => s.select);

  useEffect(() => {
    const text = q.trim();
    if (text.length < 2 && !/^\d+$/.test(text)) {
      setResults([]);
      setError(null);
      return;
    }
    const id = window.setTimeout(() => {
      api.search(text)
        .then((r) => { setResults(r); setError(null); })
        .catch((e: Error) => { setResults([]); setError(e.message); });
    }, 250);
    return () => window.clearTimeout(id);
  }, [q]);

  return (
    <div>
      <label className="label" htmlFor="search">Find an object</label>
      <input
        id="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="ISS, STARLINK-1007, 25544, 1999-025…"
        maxLength={100}
        className="mt-2 w-full rounded-[10px] border-2 border-line bg-[#121212] px-3 py-2 text-sm text-ink placeholder:text-ink-3"
      />
      {error && <p className="mt-2 text-[13px] text-ink-2">{error}</p>}
      {results.length > 0 && (
        <ul className="mt-2 max-h-56 overflow-auto rounded-[10px] border-2 border-line">
          {results.map((r) => (
            <li key={r.norad_id}>
              <button type="button" onClick={() => { select(r.norad_id); setQ(""); }} className="flex w-full justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-[#161616]">
                <span className="text-ink">{r.name}</span>
                <span className="font-mono text-[12px] text-ink-3">{TYPE_LABELS[r.object_type]} · {r.decayed ? "re-entered" : r.regime}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

`web/src/components/panels/ObjectCard.tsx`:
```tsx
"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { fmtDate, fmtKm } from "@/lib/format";
import { useExplorer } from "@/lib/store";
import { TYPE_LABELS, type ObjectDetail } from "@/lib/types";
import { Card } from "@/components/ui/Card";
import { Unavailable } from "@/components/ui/Unavailable";

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-4 border-t border-[#1c1c1c] py-1.5 text-[13px]">
      <dt className="text-ink-2">{k}</dt>
      <dd className="text-right font-mono text-ink">{v}</dd>
    </div>
  );
}

export function ObjectCard() {
  const selectedId = useExplorer((s) => s.selectedId);
  const select = useExplorer((s) => s.select);
  const [obj, setObj] = useState<ObjectDetail | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (selectedId === null) return;
    let cancelled = false;
    setObj(null);
    setError(false);
    api.object(selectedId).then((o) => !cancelled && setObj(o)).catch(() => !cancelled && setError(true));
    return () => { cancelled = true; };
  }, [selectedId]);

  if (selectedId === null) return null;
  return (
    <Card aria-label="Selected object" data-testid="object-card">
      <div className="flex items-start justify-between gap-3">
        <h2 className="font-mono text-[18px] text-ink">{obj?.name ?? `NORAD ${selectedId}`}</h2>
        <button type="button" onClick={() => select(null)} className="text-sm text-ink-2 hover:text-ink" aria-label="Close">✕</button>
      </div>
      {error && <Unavailable what="object details" />}
      {obj && (
        <dl className="mt-3">
          <Row k="Type" v={TYPE_LABELS[obj.object_type]} />
          <Row k="Owner" v={`${obj.flag_emoji ?? ""} ${obj.owner_name}`.trim()} />
          <Row k="Status" v={obj.ops_status_label ?? "Unknown"} />
          <Row k="Launched" v={`${fmtDate(obj.launch_date)}${obj.launch_site_name ? ` · ${obj.launch_site_name}` : ""}`} />
          <Row k="Orbit" v={`${fmtKm(obj.perigee)} × ${fmtKm(obj.apogee)}`} />
          <Row k="Inclination" v={obj.inclination === null ? "—" : `${obj.inclination.toFixed(1)}°`} />
          <Row k="Catalog no." v={`${obj.norad_id} · ${obj.cospar_id ?? "—"}`} />
          {obj.event && <Row k="Created by" v={`${obj.event.name} (${obj.event.event_date.slice(0, 4)})`} />}
          {obj.decay_date && <Row k="Re-entered" v={fmtDate(obj.decay_date)} />}
        </dl>
      )}
    </Card>
  );
}
```

`web/src/components/panels/ChatPanel.tsx`:
```tsx
import { Card } from "@/components/ui/Card";
import { PixelIcon } from "@/components/ui/PixelIcon";

const EXAMPLES = ["Show me the Fengyun-1C debris cloud", "How much Chinese debris from 2007 is still up?", "What is the Kessler syndrome?"];

export function ChatPanel() {
  return (
    <Card aria-label="AI analyst">
      <div className="label flex items-center gap-2"><PixelIcon name="chat" /> ANALYST</div>
      <p className="mt-2 text-sm text-ink-2">An AI analyst that answers from the real catalog and moves the globe is coming soon.</p>
      <ul className="mt-3 flex flex-col gap-2">
        {EXAMPLES.map((e) => (
          <li key={e} className="rounded-[10px] border-2 border-dashed border-line px-3 py-2 text-[13px] text-ink-3">{e}</li>
        ))}
      </ul>
    </Card>
  );
}
```

`web/src/components/panels/Footer.tsx`:
```tsx
import { fmtDate } from "@/lib/format";
import type { Meta } from "@/lib/types";

export const ATTRIBUTION = "Data: USSPACECOM via Space-Track.org; CelesTrak.";

export function Footer({ meta }: { meta?: Meta | null }) {
  const asOf = meta?.data_as_of.gp ?? meta?.data_as_of.satcat ?? null;
  return (
    <footer className="mt-10 border-t border-line py-6 text-[12px] text-ink-3">
      <p className="font-mono">{ATTRIBUTION}{asOf ? ` Updated ${fmtDate(asOf)}.` : ""}</p>
      <p className="mt-1">Built by Kuday Yurter from a 1st-place MATLAB project. Only objects ≥ 10 cm are tracked.</p>
    </footer>
  );
}
```

- [ ] **Step 3: Implement the explorer page**

`web/src/app/page.tsx`:
```tsx
"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { chartTitle } from "@/lib/chartData";
import { regimesFor, useExplorer } from "@/lib/store";
import type { BreakdownResponse, Meta, TimeseriesResponse } from "@/lib/types";
import { BarChart } from "@/components/charts/BarChart";
import { LineChart } from "@/components/charts/LineChart";
import { GlobeSection } from "@/components/globe/GlobeSection";
import { ChatPanel } from "@/components/panels/ChatPanel";
import { Filters } from "@/components/panels/Filters";
import { Footer } from "@/components/panels/Footer";
import { Header } from "@/components/panels/Header";
import { Intro } from "@/components/panels/Intro";
import { ObjectCard } from "@/components/panels/ObjectCard";
import { SearchBox } from "@/components/panels/SearchBox";
import { StatTiles } from "@/components/panels/StatTiles";
import { Card } from "@/components/ui/Card";
import { Unavailable } from "@/components/ui/Unavailable";

type Load<T> = { data: T | null; error: boolean };

export default function Explorer() {
  const [meta, setMeta] = useState<Load<Meta>>({ data: null, error: false });
  const [ts, setTs] = useState<Load<TimeseriesResponse>>({ data: null, error: false });
  const [bars, setBars] = useState<Load<BreakdownResponse>>({ data: null, error: false });
  const owners = useExplorer((s) => s.owners);
  const types = useExplorer((s) => s.types);
  const orbits = useExplorer((s) => s.orbits);

  useEffect(() => {
    api.meta().then((d) => setMeta({ data: d, error: false })).catch(() => setMeta({ data: null, error: true }));
  }, []);

  useEffect(() => {
    const regimes = regimesFor(orbits);
    api.timeseries({ group_by: "type", owners, types, regimes, from: 1960 })
      .then((d) => setTs({ data: d, error: false }))
      .catch(() => setTs({ data: null, error: true }));
    api.breakdown({ by: "owner", types, regimes, top: 5 })
      .then((d) => setBars({ data: d, error: false }))
      .catch(() => setBars({ data: null, error: true }));
  }, [owners, types, orbits]);

  return (
    <main className="mx-auto max-w-[1280px] px-4 pb-10 sm:px-7">
      <Header />
      <div id="explore" className="grid gap-5 lg:grid-cols-[1.15fr_0.85fr]">
        <GlobeSection />
        <div className="flex min-w-0 flex-col gap-5">
          <Intro />
          <StatTiles meta={meta.data} error={meta.error} />
          <ObjectCard />
          <Card><SearchBox /></Card>
        </div>
      </div>
      <div className="mt-5 grid gap-5 lg:grid-cols-[1.35fr_0.65fr]">
        <Card aria-label="History chart" className="min-w-0">
          <h2 className="font-mono text-[18px] text-ink">{ts.data ? chartTitle(ts.data) : "Objects in orbit by type"}</h2>
          <p className="mt-1 text-[13px] leading-snug text-ink-2">
            Objects in orbit at the end of each year. Collisions and anti-satellite tests caused the debris jumps;
            Starlink-era launches drive the payload surge.
          </p>
          <div className="mt-3">{ts.error ? <Unavailable what="yearly history" /> : ts.data && <LineChart data={ts.data} />}</div>
        </Card>
        <div className="flex min-w-0 flex-col gap-5">
          <Card aria-label="Owners chart">
            <h2 className="font-mono text-[18px] text-ink">Who owns what&apos;s up there</h2>
            <p className="mt-1 text-[13px] text-ink-2">Objects in orbit today, by owner and type.</p>
            <div className="mt-3">{bars.error ? <Unavailable what="owners" /> : bars.data && <BarChart data={bars.data} owners={meta.data?.owners ?? []} />}</div>
          </Card>
          <Filters meta={meta.data} />
          <ChatPanel />
        </div>
      </div>
      <Footer meta={meta.data} />
    </main>
  );
}
```

Add a page-level intro stagger: in `Explorer`, add this `useEffect` (import `animate`, `stagger` from `animejs` and `prefersReducedMotion` from `@/lib/motion`):
```tsx
useEffect(() => {
  if (prefersReducedMotion()) return;
  animate(".card", { opacity: [0, 1], translateY: [18, 0], delay: stagger(70), duration: 700, ease: "outExpo" });
}, []);
```

- [ ] **Step 4: Verify**

Run: `npm run lint && npm run typecheck && npm test && npm run build`.
Manual check with the real API (`python -m app.jobs all` already run, API on :8000, `npm run dev`):
- the tiles count up;
- the line chart draws in when you scroll to it, and its title reads "Payloads overtook debris in 2024";
- the bars grow in;
- toggling Debris off updates both charts and hides the debris shapes;
- searching "ISS" and clicking a result opens the card and flies the globe to it;
- "Higher orbits" loads the high snapshot;
- at 390px width everything stacks.

Stop the API and reload: the panels show "Data unavailable" and the Earth still renders.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/ui web/src/components/panels web/src/app/page.tsx
git commit -m "feat(web): explorer page with tiles, filters, search, object card, chat placeholder and charts" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 13: About page

**Files:**
- Create: `web/src/app/about/page.tsx`

**Interfaces:**
- Consumes: `Header`, `Footer`, `Card`, `PixelIcon` (Task 12).
- Produces: route `/about` with the story of the original project, team credits, the award, the method notes and sources.

- [ ] **Step 1: Implement**

`web/src/app/about/page.tsx`:
```tsx
import type { Metadata } from "next";
import { Footer } from "@/components/panels/Footer";
import { Header } from "@/components/panels/Header";
import { Card } from "@/components/ui/Card";

export const metadata: Metadata = {
  title: "About · LEO Debris",
  description: "How this site was built, where the data comes from, and the MATLAB project it started as.",
};

const TEAM = ["Brian Alino", "Meena Al Hasani", "Gregory Maddox", "Vedant Patel", "Jessica Semaan", "Kuday Yurter"];

export default function About() {
  return (
    <main className="mx-auto max-w-[860px] px-4 pb-10 sm:px-7">
      <Header />
      <div className="flex flex-col gap-5">
        <Card>
          <h1 className="font-mono text-[28px] text-ink">From a MATLAB app to a live map</h1>
          <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
            This site started as <em>Space Debris and Objects in LEO</em>, a MATLAB App Designer project that won
            1st place. It charted debris, rocket bodies and payloads from China, Russia and the US between 1997
            and 2022, with a globe of randomly placed dots. This version covers every tracked object and owner
            from 1957 to today, places each object at its real position, and refreshes several times a day.
          </p>
          <p className="label mt-4">Original team</p>
          <p className="mt-1 text-[15px] text-ink">{TEAM.join(", ")}</p>
          <p className="mt-3 text-[13px] text-ink-2">
            Original code: <a className="underline hover:text-ink" href="https://github.com/namelessmonarch0/DebrisInLEO">github.com/namelessmonarch0/DebrisInLEO</a>
          </p>
        </Card>
        <Card>
          <h2 className="font-mono text-[18px] text-ink">How the numbers are counted</h2>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-[15px] leading-relaxed text-ink-2">
            <li>The catalog lists every object tracked since Sputnik in 1957, including about 35,000 that have already re-entered.</li>
            <li>An object counts as “in orbit” in a year if it was first seen by then and had not re-entered by the end of that year.</li>
            <li>Debris is dated by when it appeared, not by its parent&apos;s launch. Fragments from known breakups (Fengyun-1C in 2007, Iridium–Cosmos in 2009, Kosmos 1408 in 2021, and others) are dated to the event.</li>
            <li>Low Earth orbit here means an apogee below 2,000 km.</li>
            <li>Positions are computed in your browser from published orbital elements with the SGP4 model; the day/night line follows the real Sun.</li>
            <li>Only objects about 10 cm and larger are tracked. Estimates put the number of 1–10 cm pieces near a million.</li>
          </ul>
        </Card>
        <Card>
          <h2 className="font-mono text-[18px] text-ink">Sources</h2>
          <ul className="mt-3 space-y-2 text-[15px] text-ink-2">
            <li>Orbital elements and catalog: USSPACECOM via <a className="underline hover:text-ink" href="https://www.space-track.org">Space-Track.org</a> and <a className="underline hover:text-ink" href="https://celestrak.org">CelesTrak</a>.</li>
            <li>Coastlines: <a className="underline hover:text-ink" href="https://www.naturalearthdata.com">Natural Earth</a> via world-atlas.</li>
            <li>Typeface: Departure Mono by Helena Zhang (SIL Open Font License) and Inter Tight.</li>
          </ul>
        </Card>
      </div>
      <Footer />
    </main>
  );
}
```

- [ ] **Step 2: Verify and commit**

Run: `npm run lint && npm run typecheck && npm run build`; open `/about` in dev and check it reads well at 390px and desktop.
```bash
git add web/src/app/about
git commit -m "feat(web): about page with project story, method and sources" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 14: End-to-end tests with a mocked API

**Files:**
- Create: `web/playwright.config.ts`, `web/e2e/explorer.spec.ts`, `web/tests/fixtures/api/{meta,timeseries,breakdown,events,search,object}.json`

**Interfaces:**
- Consumes: the finished pages; `web/tests/fixtures/snapshot-leo.bin.gz` (Task 4).
- Produces: `npm run e2e`, which starts `next dev` on port 3100 and intercepts every browser `/api/**` call with fixtures (no Python API needed).

- [ ] **Step 1: Write the fixtures**

`web/tests/fixtures/api/meta.json`:
```json
{"data_as_of":{"satcat":"2026-09-23T10:00:00Z","gp":"2026-09-23T12:00:00Z","stats":"2026-09-23T10:01:00Z"},
 "in_orbit":{"PAY":{"LEO":17750,"GEO":1670},"DEB":{"LEO":9830},"R/B":{"LEO":993}},
 "owners":[{"code":"US","name":"United States","flag_emoji":"🇺🇸","in_orbit":16052,"total":29205},
           {"code":"PRC","name":"China","flag_emoji":"🇨🇳","in_orbit":5564,"total":9378}],
 "types":{"PAY":"Payload","R/B":"Rocket body","DEB":"Debris","UNK":"Unknown"},
 "regimes":{"LEO":"Low Earth orbit","MEO":"Medium Earth orbit","GEO":"Geostationary orbit","HEO":"Highly elliptical orbit","OTHER":"Other"},
 "ops_status":{"+":"Operational"},"attribution":"Data: USSPACECOM via Space-Track.org; CelesTrak."}
```

`web/tests/fixtures/api/timeseries.json`:
```json
{"metric":"in_orbit","group_by":"type","years":[2005,2006,2007,2008,2009,2021,2022,2023,2024,2025],
 "series":[{"key":"PAY","values":[1700,1762,1806,1848,1905,6043,8039,10204,11895,15229]},
           {"key":"DEB","values":[4000,4180,7733,7800,10240,11807,11375,10692,10533,9994]},
           {"key":"R/B","values":[850,861,874,877,878,957,981,970,975,978]}]}
```

`web/tests/fixtures/api/breakdown.json`:
```json
{"at":2026,"by":"owner","rows":[{"key":"US","counts":{"PAY":13005,"DEB":2821,"R/B":226},"total":16052},
 {"key":"PRC","counts":{"PAY":1404,"DEB":3976,"R/B":184},"total":5564},
 {"key":"_other","counts":{"PAY":2121,"DEB":111,"R/B":70},"total":2302}]}
```

`web/tests/fixtures/api/events.json`: `[]`

`web/tests/fixtures/api/search.json`:
```json
[{"norad_id":25544,"name":"ISS (ZARYA)","cospar_id":"1998-067A","object_type":"PAY","owner":"ISS","regime":"LEO","decayed":false}]
```

`web/tests/fixtures/api/object.json`:
```json
{"norad_id":25544,"cospar_id":"1998-067A","name":"ISS (ZARYA)","object_type":"PAY","ops_status":"+","ops_status_label":"Operational",
 "owner":"ISS","owner_name":"International Space Station partners","flag_emoji":null,"launch_date":"1998-11-20","launch_site":"TYMSC",
 "launch_site_name":"Baikonur (Tyuratam)","decay_date":null,"period":92.95,"inclination":51.63,"apogee":422,"perigee":416,"rcs_size":"LARGE",
 "regime":"LEO","parent_cospar":"1998-067","first_seen_year":1998,"event":null,"elements":null}
```

- [ ] **Step 2: Write the config and tests**

`web/playwright.config.ts`:
```ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  use: { baseURL: "http://localhost:3100", ...devices["Desktop Chrome"] },
  webServer: {
    command: "npx next dev --port 3100",
    url: "http://localhost:3100/about",
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    env: { API_ORIGIN_URL: "http://127.0.0.1:9" },
  },
});
```

`web/e2e/explorer.spec.ts`:
```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

// Playwright compiles specs as CommonJS here (package.json has no "type": "module"), so use __dirname.
const fx = (name: string) => readFileSync(path.join(__dirname, "../tests/fixtures", name));

async function mockApi(page: Page, overrides: Record<string, { status: number; body?: Buffer | string }> = {}) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api/, "");
    const o = Object.entries(overrides).find(([prefix]) => path.startsWith(prefix));
    if (o) return route.fulfill({ status: o[1].status, body: o[1].body ?? JSON.stringify({ error: { code: "x", message: "x" } }), contentType: "application/json" });
    const map: Record<string, string> = {
      "/meta": "api/meta.json", "/stats/timeseries": "api/timeseries.json", "/stats/breakdown": "api/breakdown.json",
      "/events": "api/events.json", "/objects/search": "api/search.json", "/objects/25544": "api/object.json",
    };
    if (path === "/globe/snapshot") {
      return url.searchParams.get("group") === "LEO"
        ? route.fulfill({ status: 200, body: fx("snapshot-leo.bin.gz"), contentType: "application/octet-stream" })
        : route.fulfill({ status: 404, body: JSON.stringify({ error: { code: "not_found", message: "none" } }), contentType: "application/json" });
    }
    const file = map[path];
    return file
      ? route.fulfill({ status: 200, body: fx(file), contentType: "application/json" })
      : route.fulfill({ status: 404, body: "{}", contentType: "application/json" });
  });
}

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

test("explorer renders tiles, charts, globe and attribution", async ({ page }) => {
  const errors = trackErrors(page);
  await mockApi(page);
  await page.goto("/");
  await expect(page.getByTestId("tile-PAY")).toContainText("17,750", { timeout: 10_000 });
  await expect(page.getByRole("heading", { name: "Payloads overtook debris in 2024" })).toBeVisible();
  await expect(page.locator("canvas")).toHaveCount(1);
  await page.getByRole("img", { name: "Objects in orbit per year by type" }).scrollIntoViewIfNeeded();
  await expect(page.locator("path[data-series]")).toHaveCount(3);
  await expect(page.getByText("Data: USSPACECOM via Space-Track.org; CelesTrak.")).toBeVisible();
  expect(errors).toEqual([]);
});

test("search opens the object card", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await page.getByLabel("Find an object").fill("ISS");
  await page.getByRole("button", { name: /ISS \(ZARYA\)/ }).click();
  await expect(page.getByTestId("object-card")).toContainText("International Space Station partners");
});

test("survives API failure", async ({ page }) => {
  const errors = trackErrors(page);
  await mockApi(page, { "/": { status: 500 } });
  await page.goto("/");
  await expect(page.getByText(/Data unavailable/).first()).toBeVisible({ timeout: 10_000 });
  expect(errors).toEqual([]);
});

test("shows note when snapshot is missing", async ({ page }) => {
  await mockApi(page, { "/globe/snapshot": { status: 404 } });
  await page.goto("/");
  await expect(page.getByText("Orbit data not available yet.")).toBeVisible({ timeout: 10_000 });
});

test("no horizontal overflow at 390px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApi(page);
  await page.goto("/");
  await expect(page.getByTestId("tile-PAY")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("about page credits the team", async ({ page }) => {
  await page.goto("/about");
  await expect(page.getByText(/Jessica Semaan/)).toBeVisible();
});
```

- [ ] **Step 3: Run**

```bash
npx playwright install chromium
npm run e2e
```
Expected: 6 passed. If a test fails, fix the **app** code (not the expectation) unless the expectation contradicts this plan; explain any expectation change in the report. Headless Chromium provides WebGL through SwiftShader; if `canvas` has count 0 because WebGL is unavailable in the environment, run with `--headed` or report it.

- [ ] **Step 4: Commit**

```bash
git add web/playwright.config.ts web/e2e web/tests/fixtures/api
git commit -m "test(web): end-to-end explorer tests against a mocked API" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 15: Web CI and README

**Files:**
- Create: `.github/workflows/web.yml`, `web/README.md`

- [ ] **Step 1: Write the workflow and README**

`.github/workflows/web.yml`:
```yaml
name: web
on:
  push:
    branches: [main]
    paths: ["web/**", ".github/workflows/web.yml"]
  pull_request:
    paths: ["web/**", ".github/workflows/web.yml"]
jobs:
  test:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: web
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: web/package-lock.json
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test
      - run: npx playwright install --with-deps chromium
      - run: npm run e2e
        env:
          CI: "1"
```

`web/README.md`:
````markdown
# LEO Debris: web

Next.js explorer for leo.kudayyurter.dev. Design: `../docs/superpowers/specs/2026-09-22-leo-debris-design.md` §6.

## Local development

```bash
# 1. Start the data API with data (see ../api/README.md)
cd ../api && docker compose up -d db && uv run python -m app.jobs all
uv run uvicorn app.api.main:create_app --factory --port 8000
# 2. In another terminal
cd web && cp .env.example .env.local && npm install && npm run dev
```

Open http://localhost:3000. The browser only calls `/api/*` on the same origin; `src/app/api/[...path]/route.ts` forwards to `API_ORIGIN_URL`.

## Tests

| Command | What |
|---|---|
| `npm test` | Unit tests (Vitest): proxy, API client, snapshot decoder, SGP4 + Sun maths, store, chart helpers |
| `npm run e2e` | Playwright against `next dev` with a mocked API |
| `npm run lint && npm run typecheck` | ESLint + TypeScript |

Data: USSPACECOM via Space-Track.org; CelesTrak.
````

- [ ] **Step 2: Validate locally and commit**

Run from `web/`: `npm ci && npm run lint && npm run typecheck && npm test && npm run e2e` (all green).
```bash
git add .github/workflows/web.yml web/README.md
git commit -m "ci(web): lint, typecheck, unit and e2e tests" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

## Spec coverage (self-review)

| Spec requirement | Task |
|---|---|
| §2 Next.js + R3F + anime.js; `/api/*` proxy adds origin secret, streams | 1, 2 |
| §3.7 snapshot contract | 4 |
| §6.1 pages `/` and `/about`, link back to kudayyurter.dev | 12, 13 |
| §6.1 black, cartoonish, pixel icons, cards, Departure Mono and Inter Tight | 1, 12 |
| §6.1/6.2 flat Earth, Classic palette, ink coastlines, real-Sun terminator, smooth dithered twilight, subtle dither pass | 8, 10 |
| §6.1 object shapes by type, size grows with zoom, picking, object card | 9, 12 |
| §6.1 entity colours fixed everywhere | 3, 9, 11, 12 |
| §6.1 charts titled with the takeaway, direct labels + legend, annotations, crosshair, draw-in | 7, 11 |
| §6.1 anime.js for intro, counters, draw-in, fly-tos | 7, 10, 11, 12 |
| §6.1 Zustand single store | 7 |
| §6.1 SGP4 in a worker, Float32Array transfer ~10 Hz | 6 |
| §6.1 WebGL fallback: charts-only | 8, 10 |
| §7 web error states: boundary/skeletons, offline chat | 10, 12, 14 |
| §8 web tests: Vitest + Playwright | all; 14 |
| §8 CI | 15 |
| §5 chat (streaming agent), §9 Vercel project and domain | **AI plan / deploy plan** |
