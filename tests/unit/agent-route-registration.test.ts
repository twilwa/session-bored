// ABOUTME: Checks that crawler and agent entry routes reach the Worker before static assets.
// ABOUTME: Prevents the deployed SPA fallback from hiding text references and the demo door.
import { describe, expect, it } from "vitest";
import wranglerConfigText from "../../wrangler.jsonc?raw";

describe("agent entry route registration", () => {
  it("runs the Worker first for crawler guidance, references, and demo access", () => {
    const config = JSON.parse(wranglerConfigText) as {
      assets: { run_worker_first: string[] };
    };
    const registeredRoutes = new Set(config.assets.run_worker_first);

    expect(registeredRoutes).toContain("/robots.txt");
    expect(registeredRoutes).toContain("/llms.txt");
    expect(registeredRoutes).toContain("/llms-full.txt");
    expect(registeredRoutes).toContain("/demo");
  });
});
