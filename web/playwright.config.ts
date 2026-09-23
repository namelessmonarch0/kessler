import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  use: {
    baseURL: "http://localhost:3100",
    ...devices["Desktop Chrome"],
    // Headless Chromium only exposes WebGL2 through the SwiftShader software rasterizer, and it
    // needs to be requested explicitly (see the globe-render note below) or `hasWebGL()` returns
    // false, the <Canvas> never mounts, and every test that expects a canvas element fails.
    launchOptions: {
      args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    },
  },
  webServer: {
    command: "npx next dev --port 3100",
    url: "http://localhost:3100/about",
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    // web/.env.local (gitignored, developer-local) points API_ORIGIN_URL at the real FastAPI dev
    // server. The e2e suite mocks every /api/** call in the browser via page.route and must never
    // reach a real backend, so this overrides that value for the dev server this config spawns.
    env: { API_ORIGIN_URL: "http://127.0.0.1:9" },
  },
});
