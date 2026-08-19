// ABOUTME: Verifies downloadable file-version summaries preserve names and merge-superseded status.
// ABOUTME: Keeps organizer and speaker history responses aligned through one public helper.
import { describe, expect, it } from "vitest";
import { fileVersionSummary } from "../../worker/storage/file-versions.ts";

describe("file version summaries", () => {
  it("marks only merge-retained history as superseded by a merge", () => {
    const version = {
      id: "fver_history_1",
      fileId: "fil_history_1",
      version: 1,
      storageKey: "events/files/fver_history_1-speaker-deck.pdf",
      sizeBytes: 42,
      latest: false,
      uploadedAt: new Date("2026-08-18T12:00:00.000Z"),
      supersededByMergeId: null,
    };

    expect(fileVersionSummary(version, "current-name.pdf", "evt_history_1")).toEqual({
      version: 1,
      displayName: "speaker-deck.pdf",
      sizeBytes: 42,
      uploadedAt: "2026-08-18T12:00:00.000Z",
      current: false,
      supersededByMerge: false,
      downloadUrl: "/api/portal/files/fil_history_1?version=1&eventId=evt_history_1",
    });
    expect(fileVersionSummary(
      { ...version, supersededByMergeId: "pmg_history_1" },
      "current-name.pdf",
      "evt_history_1",
    )).toMatchObject({ supersededByMerge: true });
  });
});
