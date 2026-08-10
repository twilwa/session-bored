// ABOUTME: Exercises the deployed-style application through a real browser and Worker server.
// ABOUTME: Covers role entry points and the public 375-pixel layout without mocked requests.
import { defineConfig, devices } from "@playwright/test";

declare const process: { env: { PLAYWRIGHT_PORT?: string } };
const PORT = Number(process.env.PLAYWRIGHT_PORT ?? 8787);

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `npm run dev -- --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["iPhone 13"] } },
  ],
});
