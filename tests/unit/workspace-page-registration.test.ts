// ABOUTME: Checks that every protected workspace page reaches the Worker before assets serve it.
// ABOUTME: Prevents an access gate from becoming inert when a page route is added or changed.
import { describe, expect, it } from "vitest";
import { protectedPageRoutes } from "../../worker/page-routes.ts";
import wranglerConfigText from "../../wrangler.jsonc?raw";

describe("protected workspace page registration", () => {
  it("runs the Worker first for every protected page route and its subtree", () => {
    const config = JSON.parse(wranglerConfigText) as {
      assets: { run_worker_first: string[] };
    };
    const registeredRoutes = new Set(config.assets.run_worker_first);

    for (const { path } of protectedPageRoutes) {
      expect(registeredRoutes.has(path), `${path} must reach its access gate`).toBe(true);
      expect(registeredRoutes.has(`${path}/*`), `${path} subtree must reach its access gate`).toBe(true);
    }
  });
});
