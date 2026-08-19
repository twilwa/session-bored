// ABOUTME: Verifies preview deployment provisions isolated storage and closure reclaims it.
// ABOUTME: Keeps the GitHub workflow wired to the tested preview cleanup entry point.
import { describe, expect, it } from "vitest";
import previewWorkflow from "../../.github/workflows/preview.yml?raw";

describe("preview deployment workflow", () => {
  it("provisions and binds a pull-request-scoped R2 bucket", () => {
    expect(previewWorkflow).toContain("BUCKET_NAME: session-bored-pr-${{ github.event.pull_request.number }}-files");
    expect(previewWorkflow).toContain("npx wrangler r2 bucket create \"$BUCKET_NAME\"");
    expect(previewWorkflow.indexOf("Provision preview bucket"))
      .toBeLessThan(previewWorkflow.indexOf("Configure preview bindings"));
  });

  it("runs the preview resource cleanup entry point when a pull request closes", () => {
    expect(previewWorkflow).toContain("BUCKET_EXISTS=");
    expect(previewWorkflow).toContain("DATABASE_EXISTS=");
    expect(previewWorkflow).toContain("node scripts/preview-cleanup.js");
  });
});
