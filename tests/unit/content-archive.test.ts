// ABOUTME: Verifies deterministic, collision-free paths and bytes in organizer content archives.
// ABOUTME: Exercises the archive module directly without storage or route concerns.
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { contentArchivePath, createContentArchive, type ContentArchiveEntry } from "../../worker/content-archive.ts";

const uploadedAt = new Date("2026-08-15T12:00:00.000Z");

function entry(fileId: string, displayName: string, bytes: number[]): ContentArchiveEntry {
  return {
    fileId,
    displayName,
    speakerName: "Priya Raman",
    taskTitle: "Upload final slides",
    uploadedAt,
    bytes: new Uint8Array(bytes),
  };
}

describe("content archives", () => {
  it("sorts selected files by stable id while preserving their exact bytes", () => {
    const later = entry("fil_z", "deck.pdf", [9, 8, 7]);
    const earlier = entry("fil_a", "deck.pdf", [1, 2, 3]);

    const firstArchive = createContentArchive([later, earlier]);
    const secondArchive = createContentArchive([earlier, later]);
    expect(firstArchive).toEqual(secondArchive);

    const files = unzipSync(firstArchive);
    expect(Object.keys(files)).toEqual([
      "Priya Raman/Upload final slides/fil_a-deck.pdf",
      "Priya Raman/Upload final slides/fil_z-deck.pdf",
    ]);
    expect([...files["Priya Raman/Upload final slides/fil_a-deck.pdf"]!]).toEqual([1, 2, 3]);
    expect([...files["Priya Raman/Upload final slides/fil_z-deck.pdf"]!]).toEqual([9, 8, 7]);
  });

  it("keeps user-controlled metadata inside safe archive path segments", () => {
    expect(contentArchivePath({
      fileId: "fil_safe",
      displayName: "../slides?.pdf",
      speakerName: "Priya/Raman",
      taskTitle: "Deck: final",
    })).toBe("Priya-Raman/Deck- final/fil_safe--slides-.pdf");
  });
});
