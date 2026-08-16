// ABOUTME: Checks that public agent guidance reaches the Worker before static assets.
// ABOUTME: Prevents the deployed SPA fallback from hiding llms.txt route handlers.
import { describe, expect, it } from "vitest";
import wranglerConfigText from "../../wrangler.jsonc?raw";

describe("agent guidance route registration", () => {
  it("runs the Worker first for both public text references", () => {
    const config = JSON.parse(wranglerConfigText) as {
      assets: { run_worker_first: string[] };
    };
    const registeredRoutes = new Set(config.assets.run_worker_first);

    expect(registeredRoutes).toContain("/llms.txt");
    expect(registeredRoutes).toContain("/llms-full.txt");
  });
});
