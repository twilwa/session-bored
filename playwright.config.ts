// ABOUTME: Exercises the deployed-style application through a real browser and Worker server.
// ABOUTME: Covers role entry points and the public 375-pixel layout without mocked requests.
import { defineConfig, devices } from "@playwright/test";

declare const process: { env: { CI?: string; PLAYWRIGHT_PORT?: string } };
const PORT = Number(process.env.PLAYWRIGHT_PORT ?? 8787);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `npm run dev -- --port ${PORT} --var APP_ORIGIN:${BASE_URL} --var BETTER_AUTH_URL:${BASE_URL}`,
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["iPhone 13"] } },
  ],
});
