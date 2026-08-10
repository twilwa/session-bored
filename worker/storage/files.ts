// ABOUTME: Builds R2 storage keys and streams portal upload bytes to and from the FILES bucket.
// ABOUTME: Defines the server-side file-type and size limits enforced on every speaker upload.

export interface UploadLimits {
  maxBytes: number;
  mimeTypeByExtension: Record<string, string>;
}

const headshotMimeTypeByExtension: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

const deliverableMimeTypeByExtension: Record<string, string> = {
  pdf: "application/pdf",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  zip: "application/zip",
  key: "application/x-iwork-keynote-sffkey",
};

export const headshotLimits: UploadLimits = {
  maxBytes: 5 * 1024 * 1024,
  mimeTypeByExtension: headshotMimeTypeByExtension,
};

export const defaultDeliverableLimits: UploadLimits = {
  maxBytes: 25 * 1024 * 1024,
  mimeTypeByExtension: deliverableMimeTypeByExtension,
};

export function extensionOf(filename: string): string {
  const dotIndex = filename.lastIndexOf(".");
  return dotIndex === -1 ? "" : filename.slice(dotIndex + 1).toLowerCase();
}

export function imageContentTypeForFilename(filename: string): string {
  return headshotMimeTypeByExtension[extensionOf(filename)] ?? "application/octet-stream";
}

export interface FileValidationError {
  error: "file_required" | "file_too_large" | "unsupported_file_type";
  message: string;
  maxBytes?: number;
  acceptedExtensions?: string[];
}

export function validateUpload(
  file: { name: string; type: string; size: number },
  limits: UploadLimits,
): FileValidationError | null {
  if (file.size === 0) {
    return { error: "file_required", message: "Choose a file to upload." };
  }
  if (file.size > limits.maxBytes) {
    return {
      error: "file_too_large",
      message: `That file is larger than the ${Math.round(limits.maxBytes / (1024 * 1024))}MB limit.`,
      maxBytes: limits.maxBytes,
    };
  }
  const acceptedExtensions = Object.keys(limits.mimeTypeByExtension);
  const expectedMimeType = limits.mimeTypeByExtension[extensionOf(file.name)];
  const matchesExpectedType = expectedMimeType !== undefined &&
    (file.type.length === 0 || file.type === expectedMimeType);
  if (!matchesExpectedType) {
    return {
      error: "unsupported_file_type",
      message: `Accepted file types: ${acceptedExtensions.join(", ")}.`,
      acceptedExtensions,
    };
  }
  return null;
}

export function limitsForTask(
  task: { acceptedFileTypes: string[] | null; maximumFileBytes: number | null },
): UploadLimits {
  const requestedExtensions = task.acceptedFileTypes !== null && task.acceptedFileTypes.length > 0
    ? task.acceptedFileTypes.map((type) => type.toLowerCase())
    : null;
  const mimeTypeByExtension = requestedExtensions === null
    ? defaultDeliverableLimits.mimeTypeByExtension
    : Object.fromEntries(
      Object.entries(defaultDeliverableLimits.mimeTypeByExtension)
        .filter(([extension]) => requestedExtensions.includes(extension)),
    );
  return {
    maxBytes: task.maximumFileBytes ?? defaultDeliverableLimits.maxBytes,
    mimeTypeByExtension,
  };
}

function sanitizeFilename(filename: string): string {
  const cleaned = filename.trim().replace(/[^a-zA-Z0-9._-]+/g, "-");
  return cleaned.length === 0 ? "upload" : cleaned.slice(-120);
}

export function buildStorageKey(params: {
  eventId: string;
  speakerId: string;
  fileId: string;
  fileVersionId: string;
  filename: string;
}): string {
  const { eventId, speakerId, fileId, fileVersionId, filename } = params;
  return `portal/${eventId}/${speakerId}/${fileId}/${fileVersionId}-${sanitizeFilename(filename)}`;
}

export async function putFileObject(
  bucket: R2Bucket,
  key: string,
  body: ArrayBuffer,
  contentType: string,
): Promise<void> {
  await bucket.put(key, body, { httpMetadata: { contentType } });
}

export async function getFileObject(bucket: R2Bucket, key: string): Promise<R2ObjectBody | null> {
  return bucket.get(key);
}
