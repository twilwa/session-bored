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

/** Bytes that really are the format their name and content type claim. */
const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]).buffer;
const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).buffer;
/** An office document carries no signature this app checks, so any bytes stand in for one. */
const documentBytes = new TextEncoder().encode("%PDF-1.7 anything").buffer;
/** The stored-XSS payload: markup wearing an image's name. */
const htmlBytes = new TextEncoder().encode("<html><script>alert(document.domain)</script></html>").buffer;

describe("upload validation", () => {
  it("accepts a headshot within the size and type limits", () => {
    expect(validateUpload({ name: "priya.png", type: "image/png", size: 1024 }, headshotLimits, pngBytes)).toBeNull();
  });

  it("rejects an empty file", () => {
    expect(validateUpload({ name: "priya.png", type: "image/png", size: 0 }, headshotLimits, pngBytes)).toMatchObject({
      error: "file_required",
    });
  });

  it("rejects a file larger than the limit with the limit in the response", () => {
    const result = validateUpload(
      { name: "priya.png", type: "image/png", size: headshotLimits.maxBytes + 1 },
      headshotLimits,
      pngBytes,
    );
    expect(result).toMatchObject({ error: "file_too_large", maxBytes: headshotLimits.maxBytes });
    expect(result?.message.length).toBeGreaterThan(0);
  });

  it("rejects a disallowed file type by extension and mime type", () => {
    const result = validateUpload({ name: "resume.exe", type: "application/x-msdownload", size: 10 }, headshotLimits, documentBytes);
    expect(result).toMatchObject({
      error: "unsupported_file_type",
      acceptedExtensions: Object.keys(headshotLimits.mimeTypeByExtension),
    });
  });

  it("rejects an empty declared content type instead of accepting the extension alone", () => {
    // The declared type is entirely caller-supplied, so declining to declare one must cost
    // an attacker exactly what lying about it costs. Both halves have to name a type.
    const result = validateUpload({ name: "slides.pdf", type: "", size: 10 }, defaultDeliverableLimits, documentBytes);
    expect(result).toMatchObject({
      error: "unsupported_file_type",
      acceptedExtensions: Object.keys(defaultDeliverableLimits.mimeTypeByExtension),
    });
  });

  it("rejects a whitespace-only or otherwise malformed declared content type", () => {
    for (const declared of ["   ", "\t\n", "image", "png", "image/", "/png", "image/png; charset=utf-8", "*/*"]) {
      expect(validateUpload({ name: "priya.png", type: declared, size: 10 }, headshotLimits, pngBytes))
        .toMatchObject({ error: "unsupported_file_type" });
    }
  });

  it("accepts a declared content type that differs only in case or surrounding whitespace", () => {
    expect(validateUpload({ name: "priya.png", type: " IMAGE/PNG ", size: 10 }, headshotLimits, pngBytes)).toBeNull();
  });

  it("rejects HTML bytes disguised with an image extension and a caller-controlled mime type", () => {
    const result = validateUpload({ name: "payload.png", type: "text/html", size: 42 }, headshotLimits, htmlBytes);
    expect(result).toMatchObject({ error: "unsupported_file_type" });
  });

  it("rejects a mime type that does not match the extension's expected type, even if it is a mime type this app otherwise accepts", () => {
    // "notes.docx" carrying the PDF mime type: the extension is known, but the two disagree.
    const result = validateUpload(
      { name: "notes.docx", type: "application/pdf", size: 10 },
      defaultDeliverableLimits,
      documentBytes,
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
      documentBytes,
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
    expect(validateUpload({ name: "priya.png", type: "image/png", size: 1024 }, limits, pngBytes)).toBeNull();
  });

  it("still refuses the documents a picture request never asked for", () => {
    const result = validateUpload(
      { name: "slides.pdf", type: "application/pdf", size: 10 },
      limitsForTask(pictureRequest),
      documentBytes,
    );
    expect(result).toMatchObject({ error: "unsupported_file_type", acceptedExtensions: pictureRequestFileTypes });
  });

  it("rejects HTML bytes disguised as a picture, the stored-XSS payload this widening could have let back in", () => {
    // Extension and content type must BOTH match: "payload.png" declaring text/html is the
    // exact upload that once reached an unauthenticated, inline-served endpoint.
    const result = validateUpload(
      { name: "payload.png", type: "text/html", size: 42 },
      limitsForTask(pictureRequest),
      htmlBytes,
    );
    expect(result).toMatchObject({ error: "unsupported_file_type" });
  });

  it("rejects a picture whose declared content type is empty, the bypass that reached the public headshot", () => {
    // A picture request publishes what it stores at an unauthenticated endpoint, so the
    // half an attacker controls for free — omitting the content type — must not be a way in.
    const result = validateUpload(
      { name: "payload.png", type: "", size: 42 },
      limitsForTask(pictureRequest),
      htmlBytes,
    );
    expect(result).toMatchObject({ error: "unsupported_file_type", acceptedExtensions: pictureRequestFileTypes });
  });

  it("rejects bytes that are not the image both halves claim", () => {
    // Extension and content type can agree and still both be lies. An image has a mandatory
    // signature, so this check narrows what the two halves already allowed — never widens it.
    expect(validateUpload({ name: "payload.png", type: "image/png", size: 42 }, headshotLimits, htmlBytes))
      .toMatchObject({ error: "unsupported_file_type" });
    expect(validateUpload({ name: "photo.jpg", type: "image/jpeg", size: 42 }, headshotLimits, pngBytes))
      .toMatchObject({ error: "unsupported_file_type" });
    expect(validateUpload({ name: "photo.jpg", type: "image/jpeg", size: 42 }, headshotLimits, jpegBytes)).toBeNull();
  });

  it("drops a type it does not know rather than trusting the name a request supplied", () => {
    const limits = limitsForTask({ acceptedFileTypes: ["png", "svg"], maximumFileBytes: null });
    expect(Object.keys(limits.mimeTypeByExtension)).toEqual(["png"]);
    expect(validateUpload({ name: "payload.svg", type: "image/svg+xml", size: 10 }, limits, htmlBytes))
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
