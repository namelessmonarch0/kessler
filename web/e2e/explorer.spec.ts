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
