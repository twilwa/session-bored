// ABOUTME: Specifies server-side upload validation and storage-key shape for portal files.
// ABOUTME: Protects the size and type limits enforced independently of any browser-side check.
import { describe, expect, it } from "vitest";
import {
  buildStorageKey,
  defaultDeliverableLimits,
  headshotLimits,
  limitsForTask,
  validateUpload,
} from "../../worker/storage/files.ts";

describe("upload validation", () => {
  it("accepts a headshot within the size and type limits", () => {
    expect(validateUpload({ name: "priya.png", type: "image/png", size: 1024 }, headshotLimits)).toBeNull();
  });

  it("rejects an empty file", () => {
    expect(validateUpload({ name: "priya.png", type: "image/png", size: 0 }, headshotLimits)).toMatchObject({
      error: "file_required",
    });
  });

  it("rejects a file larger than the limit with the limit in the response", () => {
    const result = validateUpload(
      { name: "priya.png", type: "image/png", size: headshotLimits.maxBytes + 1 },
      headshotLimits,
    );
    expect(result).toMatchObject({ error: "file_too_large", maxBytes: headshotLimits.maxBytes });
    expect(result?.message.length).toBeGreaterThan(0);
  });

  it("rejects a disallowed file type by extension and mime type", () => {
    const result = validateUpload({ name: "resume.exe", type: "application/x-msdownload", size: 10 }, headshotLimits);
    expect(result).toMatchObject({ error: "unsupported_file_type", acceptedExtensions: headshotLimits.acceptedExtensions });
  });

  it("accepts a deliverable by extension even when the browser sends a generic mime type", () => {
    const result = validateUpload({ name: "slides.pdf", type: "", size: 10 }, defaultDeliverableLimits);
    expect(result).toBeNull();
  });
});

describe("task upload limits", () => {
  it("falls back to the deliverable defaults when a task sets no limits", () => {
    const limits = limitsForTask({ acceptedFileTypes: null, maximumFileBytes: null });
    expect(limits).toEqual(defaultDeliverableLimits);
  });

  it("honors a task's own accepted types and byte ceiling", () => {
    const limits = limitsForTask({ acceptedFileTypes: ["PDF", "Key"], maximumFileBytes: 2048 });
    expect(limits.maxBytes).toBe(2048);
    expect(limits.acceptedExtensions).toEqual(["pdf", "key"]);
  });
});

describe("storage key layout", () => {
  it("scopes a key by event, speaker, and file, and sanitizes the filename", () => {
    const key = buildStorageKey({
      eventId: "evt_devflow_conf_2027",
      speakerId: "spk_priya_devflow_2027",
      fileId: "fil_abc123",
      fileVersionId: "fver_def456",
      filename: "final slides (v2)!!.pdf",
    });
    expect(key).toBe(
      "portal/evt_devflow_conf_2027/spk_priya_devflow_2027/fil_abc123/fver_def456-final-slides-v2-.pdf",
    );
  });
});
