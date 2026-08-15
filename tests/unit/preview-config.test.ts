// ABOUTME: Verifies a pull request preview binds its own D1 database and origin.
// ABOUTME: Keeps a preview that lost its database id from falling back to production bindings.
import { describe, expect, it } from "vitest";
import productionConfig from "../../wrangler.jsonc?raw";
import { buildPreviewConfig } from "../../scripts/preview-database.js";

const bindings = {
  databaseName: "session-bored-pr-172",
  databaseId: "865e3ae0-e0af-4fbe-8e34-76d9f74f3d24",
  previewUrl: "https://pr-172-session-bored.techwilliams-warren.workers.dev",
};

describe("preview configuration", () => {
  it("points the preview at the pull request's own database and origin", () => {
    const config = buildPreviewConfig(productionConfig, bindings);

    expect(config.preview_urls).toBe(true);
    expect(config.d1_databases[0]).toMatchObject({
      binding: "DB",
      database_name: bindings.databaseName,
      database_id: bindings.databaseId,
    });
    expect(config.vars.APP_ORIGIN).toBe(bindings.previewUrl);
  });

  it("reads a config that carries comments", () => {
    const commented = `// a preview deploys from the checked-in config\n${productionConfig}`;

    expect(buildPreviewConfig(commented, bindings).d1_databases[0]?.database_id).toBe(
      bindings.databaseId,
    );
  });

  it("refuses to build a config that would deploy against another database", () => {
    expect(() => buildPreviewConfig(productionConfig, { ...bindings, databaseId: undefined }))
      .toThrow(/databaseId/);
    expect(() => buildPreviewConfig(productionConfig, { ...bindings, databaseName: "" }))
      .toThrow(/databaseName/);
    expect(() => buildPreviewConfig(productionConfig, { ...bindings, previewUrl: undefined }))
      .toThrow(/previewUrl/);
  });
});
