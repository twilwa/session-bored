// ABOUTME: Specifies server-side upload validation and storage-key shape for portal files.
// ABOUTME: Protects the size and type limits enforced independently of any browser-side check.
import { describe, expect, it } from "vitest";
import { fileRequestKindOf, pictureRequestFileTypes } from "../../shared/api.ts";
import {
  buildStorageKey,
  defaultDeliverableLimits,
  headshotLimits,
  isPictureRequest,
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
    expect(result).toMatchObject({
      error: "unsupported_file_type",
      acceptedExtensions: Object.keys(headshotLimits.mimeTypeByExtension),
    });
  });

  it("accepts a deliverable by extension even when the browser sends no mime type", () => {
    const result = validateUpload({ name: "slides.pdf", type: "", size: 10 }, defaultDeliverableLimits);
    expect(result).toBeNull();
  });

  it("rejects HTML bytes disguised with an image extension and a caller-controlled mime type", () => {
    const result = validateUpload({ name: "payload.png", type: "text/html", size: 42 }, headshotLimits);
    expect(result).toMatchObject({ error: "unsupported_file_type" });
  });

  it("rejects a mime type that does not match the extension's expected type, even if it is a mime type this app otherwise accepts", () => {
    // "notes.docx" carrying the PDF mime type: the extension is known, but the two disagree.
    const result = validateUpload(
      { name: "notes.docx", type: "application/pdf", size: 10 },
      defaultDeliverableLimits,
    );
    expect(result).toMatchObject({ error: "unsupported_file_type" });
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
    expect(Object.keys(limits.mimeTypeByExtension)).toEqual(["pdf", "key"]);
  });

  it("narrows the accepted mime types along with the extensions, not just the extension list", () => {
    const limits = limitsForTask({ acceptedFileTypes: ["pptx"], maximumFileBytes: null });
    // A .docx file carrying its own standard Word mime type must not slip through
    // just because that mime type happens to appear in the app's broader default pool.
    const result = validateUpload(
      { name: "notes.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 10 },
      limits,
    );
    expect(result).toMatchObject({ error: "unsupported_file_type" });
  });
});

describe("picture file requests", () => {
  const pictureRequest = { acceptedFileTypes: pictureRequestFileTypes, maximumFileBytes: null };

  it("offers exactly the images the headshot picker takes", () => {
    expect(pictureRequestFileTypes).toEqual(Object.keys(headshotLimits.mimeTypeByExtension));
  });

  it("accepts a png and applies the image ceiling rather than the office-document one", () => {
    const limits = limitsForTask(pictureRequest);
    expect(limits.maxBytes).toBe(headshotLimits.maxBytes);
    expect(validateUpload({ name: "priya.png", type: "image/png", size: 1024 }, limits)).toBeNull();
  });

  it("still refuses the documents a picture request never asked for", () => {
    const result = validateUpload(
      { name: "slides.pdf", type: "application/pdf", size: 10 },
      limitsForTask(pictureRequest),
    );
    expect(result).toMatchObject({ error: "unsupported_file_type", acceptedExtensions: pictureRequestFileTypes });
  });

  it("rejects HTML bytes disguised as a picture, the stored-XSS payload this widening could have let back in", () => {
    // Extension and content type must BOTH match: "payload.png" declaring text/html is the
    // exact upload that once reached an unauthenticated, inline-served endpoint.
    const result = validateUpload(
      { name: "payload.png", type: "text/html", size: 42 },
      limitsForTask(pictureRequest),
    );
    expect(result).toMatchObject({ error: "unsupported_file_type" });
  });

  it("drops a type it does not know rather than trusting the name a request supplied", () => {
    const limits = limitsForTask({ acceptedFileTypes: ["png", "svg"], maximumFileBytes: null });
    expect(Object.keys(limits.mimeTypeByExtension)).toEqual(["png"]);
    expect(validateUpload({ name: "payload.svg", type: "image/svg+xml", size: 10 }, limits))
      .toMatchObject({ error: "unsupported_file_type" });
  });

  it("reads a mixed or document request as a document request", () => {
    expect(isPictureRequest(pictureRequest)).toBe(true);
    expect(isPictureRequest({ acceptedFileTypes: ["png", "pdf"], maximumFileBytes: null })).toBe(false);
    expect(isPictureRequest({ acceptedFileTypes: null, maximumFileBytes: null })).toBe(false);
    expect(fileRequestKindOf(null)).toBe("document");
    expect(fileRequestKindOf(["PNG"])).toBe("picture");
  });

  it("honors a request's own byte ceiling over the image default", () => {
    expect(limitsForTask({ acceptedFileTypes: ["png"], maximumFileBytes: 2048 }).maxBytes).toBe(2048);
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
