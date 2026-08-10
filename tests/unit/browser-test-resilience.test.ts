// ABOUTME: Verifies CI browser reruns are limited to managed web-server failures.
// ABOUTME: Keeps assertion failures and configuration warnings outside the retry boundary.
import { describe, expect, it } from "vitest";
import { isWebServerFailure } from "../../scripts/run-browser-tests.js";

describe("browser test resilience", () => {
  it("recognizes the Wrangler exit signature from the failed main run", () => {
    const output = [
      "[WebServer] ✘ [ERROR]",
      'page.goto: Could not connect to 127.0.0.1: Connection refused',
    ].join("\n");

    expect(isWebServerFailure(output)).toBe(true);
    expect(isWebServerFailure("page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:8787"))
      .toBe(true);
    expect(isWebServerFailure("page.goto: Could not connect to the server.")).toBe(true);
  });

  it("does not retry assertion failures or Better Auth warnings", () => {
    expect(isWebServerFailure("Error: expect(locator).toBeVisible() failed")).toBe(false);
    expect(isWebServerFailure("Better Auth: Base URL is not set")).toBe(false);
  });
});
