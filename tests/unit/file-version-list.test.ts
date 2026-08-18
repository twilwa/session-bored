// ABOUTME: Verifies the shared file-history label distinguishes merge-superseded downloads.
// ABOUTME: Keeps current versions visually distinct while preserving every download link.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FileVersionList } from "../../client/pages/content/FileVersionList.tsx";

describe("FileVersionList", () => {
  it("labels merge-superseded versions without hiding their download", () => {
    const markup = renderToStaticMarkup(createElement(FileVersionList, {
      versions: [
        {
          version: 2,
          displayName: "current-deck.pdf",
          sizeBytes: 2048,
          uploadedAt: "2026-08-18T12:00:00.000Z",
          current: true,
          supersededByMerge: false,
          downloadUrl: "/api/portal/files/fil_current?version=2",
        },
        {
          version: 1,
          displayName: "merged-deck.pdf",
          sizeBytes: 1024,
          uploadedAt: "2026-08-17T12:00:00.000Z",
          current: false,
          supersededByMerge: true,
          downloadUrl: "/api/portal/files/fil_merged?version=1",
        },
      ],
    }));

    expect(markup).toContain("Superseded — merged");
    expect(markup).toContain('href="/api/portal/files/fil_merged?version=1"');
  });

  it("does not label an ordinary prior version as merge-superseded", () => {
    const markup = renderToStaticMarkup(createElement(FileVersionList, {
      versions: [{
        version: 1,
        displayName: "draft-deck.pdf",
        sizeBytes: 1024,
        uploadedAt: "2026-08-17T12:00:00.000Z",
        current: false,
        supersededByMerge: false,
        downloadUrl: "/api/portal/files/fil_current?version=1",
      }],
    }));

    expect(markup).not.toContain("Superseded — merged");
  });
});
