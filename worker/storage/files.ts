// ABOUTME: Builds R2 storage keys and streams portal upload bytes to and from the FILES bucket.
// ABOUTME: Defines the server-side file-type and size limits enforced on every speaker upload.

export interface UploadLimits {
  maxBytes: number;
  acceptedExtensions: string[];
  acceptedMimeTypes: string[];
}

export const headshotLimits: UploadLimits = {
  maxBytes: 5 * 1024 * 1024,
  acceptedExtensions: ["png", "jpg", "jpeg", "webp"],
  acceptedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
};

export const defaultDeliverableLimits: UploadLimits = {
  maxBytes: 25 * 1024 * 1024,
  acceptedExtensions: ["pdf", "ppt", "pptx", "doc", "docx", "key", "zip"],
  acceptedMimeTypes: [
    "application/pdf",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/zip",
    "application/x-iwork-keynote-sffkey",
  ],
};

export function extensionOf(filename: string): string {
  const dotIndex = filename.lastIndexOf(".");
  return dotIndex === -1 ? "" : filename.slice(dotIndex + 1).toLowerCase();
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
  const extension = extensionOf(file.name);
  const typeAllowed = limits.acceptedMimeTypes.includes(file.type) ||
    limits.acceptedExtensions.includes(extension);
  if (!typeAllowed) {
    return {
      error: "unsupported_file_type",
      message: `Accepted file types: ${limits.acceptedExtensions.join(", ")}.`,
      acceptedExtensions: limits.acceptedExtensions,
    };
  }
  return null;
}

export function limitsForTask(
  task: { acceptedFileTypes: string[] | null; maximumFileBytes: number | null },
): UploadLimits {
  return {
    maxBytes: task.maximumFileBytes ?? defaultDeliverableLimits.maxBytes,
    acceptedExtensions: task.acceptedFileTypes !== null && task.acceptedFileTypes.length > 0
      ? task.acceptedFileTypes.map((type) => type.toLowerCase())
      : defaultDeliverableLimits.acceptedExtensions,
    acceptedMimeTypes: defaultDeliverableLimits.acceptedMimeTypes,
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
