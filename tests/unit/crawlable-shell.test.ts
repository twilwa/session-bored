// ABOUTME: Verifies the shipped HTML shell gives non-JavaScript crawlers a useful entrance.
// ABOUTME: Keeps Greenroom's description and public navigation in the raw document body.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("crawlable application shell", () => {
  it("describes Greenroom and links its public entry points", () => {
    const shell = readFileSync(new URL("../../index.html", import.meta.url), "utf8");

    expect(shell).toContain("Greenroom manages conference calls for proposals");
    expect(shell).toContain('<a href="/demo"');
    expect(shell).toContain('<a href="/schedule"');
    expect(shell).toContain('<a href="/llms.txt"');
  });
});
