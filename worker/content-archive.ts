// ABOUTME: Packages selected event deliverables into one deterministic ZIP of current file versions.
// ABOUTME: Keeps archive paths safe, readable, and collision-free without exposing storage keys.
import { zipSync, type Zippable } from "fflate";

export interface ContentArchiveEntry {
  fileId: string;
  displayName: string;
  speakerName: string;
  taskTitle: string;
  uploadedAt: Date;
  bytes: Uint8Array<ArrayBuffer>;
}

function archivePathSegment(value: string, fallback: string): string {
  const safe = value
    .normalize("NFC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|\.+$/g, "");
  return safe.length === 0 ? fallback : safe;
}

export function contentArchivePath(
  entry: Pick<ContentArchiveEntry, "fileId" | "displayName" | "speakerName" | "taskTitle">,
): string {
  const speaker = archivePathSegment(entry.speakerName, "Speaker");
  const task = archivePathSegment(entry.taskTitle, "Deliverable");
  const filename = archivePathSegment(entry.displayName, "file");
  return `${speaker}/${task}/${entry.fileId}-${filename}`;
}

export function createContentArchive(entries: ContentArchiveEntry[]): Uint8Array<ArrayBuffer> {
  const files: Zippable = {};
  for (const entry of [...entries].sort((first, second) => first.fileId.localeCompare(second.fileId))) {
    files[contentArchivePath(entry)] = [entry.bytes, { level: 0, mtime: entry.uploadedAt }];
  }
  return zipSync(files, { level: 0 });
}
