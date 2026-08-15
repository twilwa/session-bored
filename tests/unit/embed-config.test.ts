// ABOUTME: Verifies the shared visibility rule used by every public embed renderer.
// ABOUTME: Existing embeds default fields to visible while explicit organizer choices hide them.
import { describe, expect, it } from "vitest";
import { embedFieldIsVisible, type EmbedVisibilityField } from "../../shared/embed-config.ts";

const fields: EmbedVisibilityField[] = [
  "showDescription",
  "showSpeakers",
  "showLocation",
  "showEventName",
  "showTime",
  "showTrack",
  "showFormat",
  "showSpeakerImage",
  "showSpeakerDetails",
];

describe("embed field visibility", () => {
  it("keeps fields visible by default and honors only an explicit false choice", () => {
    for (const field of fields) {
      expect(embedFieldIsVisible({}, field), field).toBe(true);
      expect(embedFieldIsVisible({ [field]: true }, field), field).toBe(true);
      expect(embedFieldIsVisible({ [field]: false }, field), field).toBe(false);
    }
  });
});
