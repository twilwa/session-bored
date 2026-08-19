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

  it("reclaims uploaded objects before rebuilding a preview database", () => {
    const migrationStep = previewWorkflow.slice(
      previewWorkflow.indexOf("- name: Migrate preview database"),
      previewWorkflow.indexOf("- name: Upload preview version"),
    );

    expect(migrationStep.indexOf("node scripts/preview-cleanup.js"))
      .toBeLessThan(migrationStep.indexOf("npx wrangler d1 create"));
    expect(migrationStep).toContain("npx wrangler r2 bucket create \"$BUCKET_NAME\"");
  });

  it("uses a fail-closed bucket lookup for cleanup", () => {
    const cleanupStep = previewWorkflow.slice(previewWorkflow.indexOf("- name: Delete preview resources"));

    expect(cleanupStep).toContain("node scripts/preview-bucket.js");
    expect(cleanupStep).not.toContain("wrangler r2 bucket info");
  });
});
