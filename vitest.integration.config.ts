// ABOUTME: Runs Worker integration tests with real local Cloudflare bindings.
// ABOUTME: Applies the checked-in D1 migrations before each isolated test environment.
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        compatibilityDate: "2026-08-08",
        d1Databases: ["DB"],
        r2Buckets: ["FILES"],
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(new URL("./migrations", import.meta.url).pathname),
        },
      },
    })),
  ],
  test: {
    include: ["tests/integration/**/*.test.ts"],
    setupFiles: ["./tests/integration/setup.ts"],
  },
});
