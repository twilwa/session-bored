// ABOUTME: Checks that crawler and agent entry routes reach the Worker before static assets.
// ABOUTME: Prevents the deployed SPA fallback from hiding text references and the demo door.
import { describe, expect, it } from "vitest";
import wranglerConfigText from "../../wrangler.jsonc?raw";

describe("agent entry route registration", () => {
  it("runs the Worker first globally for crawler guidance, references, and demo access", () => {
    const config = JSON.parse(wranglerConfigText) as {
      assets: { run_worker_first: boolean | string[] };
    };

    expect(config.assets.run_worker_first).toBe(true);
  });
});
