// ABOUTME: Streams selected event deliverables into one deterministic ZIP of current file versions.
// ABOUTME: Keeps archive paths safe, readable, and collision-free without exposing storage keys.
import { Zip, ZipPassThrough } from "fflate";

export interface ContentArchiveEntry {
  fileId: string;
  displayName: string;
  speakerName: string;
  taskTitle: string;
  uploadedAt: Date;
  openBody: () => Promise<ReadableStream<Uint8Array>>;
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

export function streamContentArchive(entries: ContentArchiveEntry[]): ReadableStream<Uint8Array> {
  const output = new TransformStream<Uint8Array, Uint8Array>();
  const writer = output.writable.getWriter();
  let outputWrites = Promise.resolve();
  const archive = new Zip((error, chunk, final) => {
    outputWrites = outputWrites.then(async () => {
      if (error !== null) throw error;
      if (chunk.byteLength > 0) await writer.write(chunk);
      if (final) await writer.close();
    });
  });

  void (async () => {
    try {
      const orderedEntries = [...entries].sort((first, second) => first.fileId.localeCompare(second.fileId));
      for (const entry of orderedEntries) {
        const body = await entry.openBody();
        const input = new ZipPassThrough(contentArchivePath(entry));
        input.mtime = entry.uploadedAt;
        archive.add(input);
        const reader = body.getReader();
        let complete = false;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            input.push(value);
            await outputWrites;
          }
          input.push(new Uint8Array(), true);
          await outputWrites;
          complete = true;
        } finally {
          if (!complete) await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      }
      archive.end();
      await outputWrites;
    } catch (error) {
      archive.terminate();
      await writer.abort(error).catch(() => undefined);
    }
  })();

  return output.readable;
}
