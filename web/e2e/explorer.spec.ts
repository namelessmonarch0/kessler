import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

// web/package.json has "type": "module", so Playwright loads this spec as ESM and __dirname is
// not defined; build the fixtures path from import.meta.url instead (Node >= 20.11 also exposes
// import.meta.dirname directly, which is what this resolves to).
const dirname = path.dirname(fileURLToPath(import.meta.url));
const fx = (name: string) => readFileSync(path.join(dirname, "../tests/fixtures", name));

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
    if (path === "/globe/names") {
      return url.searchParams.get("group") === "LEO"
        ? route.fulfill({ status: 200, body: fx("api/names-leo.json"), contentType: "application/json" })
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

test("zooming in on a searched object shows name labels near the centre; clicking one opens its card", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  const canvas = page.locator("canvas");
  await expect(canvas).toBeVisible();
  // Fly to ISS via search rather than wheel-zooming at the canvas centre: the snapshot fixture
  // has only 2 objects, so a blind zoom can leave both off-screen depending on where the globe
  // happens to be facing (flaky). flyTo brings the camera to ~1.5 Earth radii, below the 2.2
  // SHOW_BELOW threshold, looking straight at ISS.
  await page.getByLabel("Find an object").fill("ISS");
  await page.getByRole("button", { name: /ISS \(ZARYA\)/ }).click();
  const labelsContainer = page.getByTestId("globe-labels");
  const labels = labelsContainer.locator("button");
  const issLabel = labels.filter({ hasText: "ISS (ZARYA)" });
  await expect(issLabel.first()).toBeVisible({ timeout: 15_000 });
  expect(await labels.count()).toBeLessThanOrEqual(12);
  await issLabel.first().click();
  await expect(page.getByTestId("object-card")).toBeVisible();
  // Zoom back out with the mouse wheel over the canvas until labels deactivate and clear. Hover
  // a corner rather than dead centre: the ISS label sits right over the canvas centre (the
  // camera looks straight at it after flyTo) and, being pointer-events:auto, would otherwise
  // swallow the wheel events meant for OrbitControls.
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 40);
  for (let i = 0; i < 80; i++) await page.mouse.wheel(0, 400);
  await expect(labelsContainer).toHaveAttribute("data-active", "0", { timeout: 15_000 });
  expect(await labels.count()).toBe(0);
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

test("phone: bottom sheet with tabs, no horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApi(page);
  await page.goto("/");
  await expect(page.locator("canvas")).toBeVisible();
  const sheet = page.getByTestId("mobile-sheet");
  await expect(sheet).toBeVisible();
  await expect(page.getByTestId("panel-dock")).toHaveCount(0);
  // The Live/Fast controls moved to a top bar on phone (see GlobeSection) so the open sheet,
  // which covers roughly the lower half of the screen, never covers them.
  const live = page.getByRole("button", { name: "Live" });
  await expect(live).toBeVisible();
  const liveBox = await live.boundingBox();
  const sheetBox = await sheet.boundingBox();
  if (!liveBox || !sheetBox) throw new Error("missing bounding box for Live button or sheet");
  const overlap = liveBox.x < sheetBox.x + sheetBox.width && sheetBox.x < liveBox.x + liveBox.width
    && liveBox.y < sheetBox.y + sheetBox.height && sheetBox.y < liveBox.y + liveBox.height;
  expect(overlap, "Live button must not overlap the sheet").toBe(false);
  expect(liveBox.y + liveBox.height, "Live button should sit in the top 20% of the screen").toBeLessThanOrEqual(844 * 0.2);
  // The date/sun readout lives in the same top bar, on one line, without overlapping the Earth.
  const readout = page.getByTestId("globe-readout");
  await expect(readout).toBeVisible();
  await expect(readout).toContainText("UTC");
  // The Earth's projected centre (data-earth-cy, written by GlobeScene outside production) must sit
  // within +/-5% of screen height of the midpoint between the top bar's bottom and the sheet's top
  // — on the short Overview tab AND the tall History tab (a taller sheet moves the Earth up; it
  // never magnifies it).
  const globeSection = page.getByLabel("Live globe of tracked objects");
  const topBar = page.getByTestId("globe-topbar");
  const expectCentred = async (tab: string) => {
    await expect.poll(async () => {
      const tb = await topBar.boundingBox();
      const sb = await sheet.boundingBox();
      const cy = Number(await globeSection.getAttribute("data-earth-cy"));
      if (!tb || !sb || !Number.isFinite(cy)) return Infinity;
      return Math.abs(cy - (tb.y + tb.height + sb.y) / 2);
    }, { timeout: 5_000, message: `${tab}: Earth centre should be within 5% of the top-bar/sheet midpoint` }).toBeLessThanOrEqual(844 * 0.05);
  };
  await expect.poll(async () => globeSection.getAttribute("data-earth-cy"), { timeout: 5_000 }).not.toBeNull();
  await expectCentred("Overview");
  await sheet.getByRole("tab", { name: "History" }).click();
  await expect(page.locator("path[data-series]")).toHaveCount(3, { timeout: 10_000 });
  await expectCentred("History");
  // ...and on the tallest tab the whole Earth clears the top bar.
  await expect.poll(async () => {
    const tb = await topBar.boundingBox();
    return Number(await globeSection.getAttribute("data-earth-top")) - (tb!.y + tb!.height);
  }, { timeout: 5_000, message: "History: Earth's top edge must be below the top bar" }).toBeGreaterThanOrEqual(0);
  await sheet.getByRole("tab", { name: "Overview" }).click();
  await expect(page.getByTestId("tile-PAY")).toContainText("17,750");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("about page credits the team", async ({ page }) => {
  await page.goto("/about");
  await expect(page.getByText(/Jessica Semaan/)).toBeVisible();
});

test("a broken globe render falls back without breaking the rest of the page", async ({ page }) => {
  const errors = trackErrors(page);
  // Test-only hook read by GlobeScene (see web/src/components/globe/GlobeScene.tsx), gated to
  // development/test builds — forces the R3F render tree to throw so GlobeErrorBoundary's
  // fallback path can be exercised end-to-end, the way a real WebGL/shader/driver failure would.
  await page.addInitScript(() => {
    (window as unknown as { __LEO_FORCE_GLOBE_ERROR__?: boolean }).__LEO_FORCE_GLOBE_ERROR__ = true;
  });
  await mockApi(page);
  await page.goto("/");
  await expect(page.getByText(/This device can.t show the 3D globe \(WebGL is unavailable\)/)).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("canvas")).toHaveCount(0);
  // The rest of the page must still work: tiles and charts render, nothing else crashed.
  await expect(page.getByTestId("tile-PAY")).toContainText("17,750");
  await page.getByRole("img", { name: "Objects in orbit per year by type" }).scrollIntoViewIfNeeded();
  await expect(page.locator("path[data-series]")).toHaveCount(3);
  // React's development-mode error-boundary machinery (invokeGuardedCallback) deliberately
  // re-surfaces a caught render error to the browser console/devtools for stack-trace fidelity —
  // https://github.com/facebook/react/issues/10474 — which Playwright's `pageerror` listener also
  // observes, even though GlobeErrorBoundary genuinely caught it (already proven by the fallback
  // text, the missing canvas, and the rest of the page rendering above). This is development-only
  // noise (next dev is what this whole e2e suite runs against), not a real escape past the
  // boundary; assert it is *exactly* the one forced error and nothing else broke.
  expect(errors).toEqual(["Forced globe error (test-only, via window.__LEO_FORCE_GLOBE_ERROR__)"]);
});

test("ignores a stale timeseries response when filters change before it arrives", async ({ page }) => {
  const errors = trackErrors(page);
  const full = JSON.parse(fx("api/timeseries.json").toString()) as { series: { key: string }[] };
  let calls = 0;
  await mockApi(page);
  // Registered *after* mockApi's catch-all so it takes priority (Playwright tries the
  // most-recently-registered matching route first). The first request (the page's initial,
  // unfiltered load) resolves slowly; a request made after toggling a filter resolves fast.
  // Without the `cancelled` guard in page.tsx, the slow first response arriving later would
  // overwrite the correctly-filtered fast one.
  await page.route("**/api/stats/timeseries**", async (route) => {
    calls += 1;
    const isFirst = calls === 1;
    const url = new URL(route.request().url());
    const types = (url.searchParams.get("types") ?? "PAY,R/B,DEB,UNK").split(",");
    const body = { ...full, series: full.series.filter((s) => types.includes(s.key)) };
    await new Promise((r) => setTimeout(r, isFirst ? 700 : 30));
    await route.fulfill({ status: 200, body: JSON.stringify(body), contentType: "application/json" });
  });
  await page.goto("/");
  await expect(page.locator("path[data-series]")).toHaveCount(3, { timeout: 10_000 });
  await page.getByTestId("panel-dock").getByRole("button", { name: "Filters" }).click();
  await page.getByRole("button", { name: "Debris" }).click(); // drops DEB from `types` -> 2 series, fast response
  await expect(page.locator("path[data-series]")).toHaveCount(2, { timeout: 5_000 });
  await page.waitForTimeout(900); // outlive the slow first (unfiltered) response
  await expect(page.locator("path[data-series]")).toHaveCount(2); // must still be 2, not reverted to 3
  expect(errors).toEqual([]);
});

test("globe fills the viewport with no card frame", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockApi(page);
  await page.goto("/");
  // R3F's <Canvas> starts at the browser's default 300x150 and syncs to its container's real
  // size via a ResizeObserver a beat after mount (dynamic import + WebGL probe + hydration), so
  // poll instead of reading boundingBox() once right after goto.
  await expect.poll(async () => (await page.locator("canvas").boundingBox())?.width).toBeGreaterThanOrEqual(1440 - 1);
  const box = await page.locator("canvas").boundingBox();
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

// Every viewport: nothing overlaps (panels, dock, sheet, control bar) and the Live button is
// really clickable — the element at its centre is the button itself, not something covering it.
for (const [w, h] of [[640, 900], [768, 1024], [844, 390], [1024, 768], [1280, 720]] as const) {
  test(`${w}x${h}: no overlap and Live button clickable`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await mockApi(page);
    await page.goto("/");
    await expect(page.locator("canvas")).toBeVisible();
    await expect(page.locator("path[data-series], [data-testid=tile-PAY]").first()).toBeVisible({ timeout: 10_000 });
    const sheetLayout = w < 1024 || h < 560;
    await expect(page.getByTestId("mobile-sheet")).toHaveCount(sheetLayout ? 1 : 0);
    await expect(page.getByTestId("panel-dock")).toHaveCount(sheetLayout ? 0 : 1);
    await page.waitForTimeout(500); // let charts/ResizeObservers settle
    const boxes = await page.locator("[data-panel], [data-testid=panel-dock], [data-testid=mobile-sheet], [data-testid=globe-topbar]")
      .evaluateAll((els) => els.map((e) => {
        const target = e.getAttribute("data-testid") === "globe-topbar" ? [...e.children] : [e];
        const rs = target.map((t) => t.getBoundingClientRect());
        return { id: e.getAttribute("data-panel") ?? e.getAttribute("data-testid"), rects: rs.map((r) => r.toJSON() as DOMRect) };
      }));
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++)
        for (const a of boxes[i].rects)
          for (const b of boxes[j].rects) {
            const overlap = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
            expect(overlap, `${boxes[i].id} overlaps ${boxes[j].id}`).toBe(false);
          }
    // Panels may extend past the viewport inside a (scrollable) desktop column; the columns
    // themselves, the dock, the sheet and the control bar must all fit on screen.
    const onScreen = await page.locator("[data-col], [data-testid=panel-dock], [data-testid=mobile-sheet], [data-testid=globe-topbar] > *")
      .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect));
    for (const b of onScreen) {
      expect(b.left).toBeGreaterThanOrEqual(0);
      expect(b.right).toBeLessThanOrEqual(w);
      expect(b.top).toBeGreaterThanOrEqual(0);
      expect(b.bottom).toBeLessThanOrEqual(h);
    }
    const live = page.getByRole("button", { name: "Live" });
    const lb = (await live.boundingBox())!;
    const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.textContent ?? null, [lb.x + lb.width / 2, lb.y + lb.height / 2]);
    expect(hit, "element at the Live button's centre").toBe("Live");
    await live.click({ trial: true });
  });
}
