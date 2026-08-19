// ABOUTME: Verifies preview bucket lookup distinguishes confirmed absence from Cloudflare failures.
// ABOUTME: Keeps cleanup from deleting D1 when R2 ownership state is unknown.
import { describe, expect, it } from "vitest";
import { previewBucketExists } from "../../scripts/preview-bucket.js";

const lookup = (request: typeof fetch) => previewBucketExists({
  accountId: "account-id",
  apiToken: "api-token",
  bucketName: "session-bored-pr-216-files",
  request,
});

describe("preview bucket lookup", () => {
  it("reports absence only when Cloudflare confirms not found", async () => {
    await expect(lookup(async () => new Response("not found", { status: 404 }))).resolves.toBe(false);
  });

  it("fails when Cloudflare cannot establish whether the bucket exists", async () => {
    await expect(lookup(async () => new Response("unavailable", { status: 503 })))
      .rejects.toThrow(/503/);
  });
});
