// ABOUTME: Verifies the shipped HTML shell gives non-JavaScript crawlers a useful entrance.
// ABOUTME: Keeps Greenroom's description and public navigation in the raw document body.
import { describe, expect, it } from "vitest";
import shell from "../../index.html?raw";

describe("crawlable application shell", () => {
  it("describes Greenroom and links its public entry points", () => {
    expect(shell).toContain("Greenroom manages conference calls for proposals");
    expect(shell).toContain('<a href="/demo"');
    expect(shell).toContain('<a href="/schedule"');
    expect(shell).toContain('<a href="/llms.txt"');
  });
});
