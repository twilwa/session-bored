// ABOUTME: Verifies browser CI uses the Playwright image matching the project dependency.
// ABOUTME: Prevents browser setup from falling back to network-dependent OS package installation.
import { describe, expect, it } from "vitest";
import ciWorkflow from "../../.github/workflows/ci.yml?raw";
import packageManifest from "../../package.json?raw";

const playwrightVersion = JSON.parse(packageManifest).devDependencies["@playwright/test"];

describe("CI workflow", () => {
  it("runs browser tests in the matching Playwright container without installing browsers", () => {
    const browserJob = ciWorkflow.slice(
      ciWorkflow.indexOf("  browser:"),
      ciWorkflow.indexOf("  deploy:"),
    );

    expect(browserJob).toContain(
      `image: mcr.microsoft.com/playwright:v${playwrightVersion}-noble`,
    );
    expect(browserJob).not.toContain("playwright install");
  });
});
