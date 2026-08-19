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
          APP_ORIGIN: "http://example.test",
          BETTER_AUTH_SECRET: "greenroom-integration-secret-for-ci-only",
          BETTER_AUTH_URL: "http://example.test",
          TEST_MIGRATIONS: await readD1Migrations(new URL("./migrations", import.meta.url).pathname),
          // Force email delivery into its unconfigured state regardless of what a
          // developer's local .dev.vars happens to hold, so these tests never send
          // real mail. The one real-send test opts in explicitly (see email-live.test.ts).
          RESEND_API_KEY: "",
          RESEND_FROM_DOMAIN: "",
          RESEND_FROM_ADDRESS: "",
        },
      },
    })),
  ],
  test: {
    include: ["tests/integration/**/*.test.ts"],
    setupFiles: ["./tests/integration/setup.ts"],
    // Shared CI contention has slowed real Worker, D1, and password-hashing paths by 5-8x.
    // These harness ceilings do not replace the product latency budgets asserted in individual tests.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
