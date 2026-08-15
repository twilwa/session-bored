// ABOUTME: Specifies the compact active-event summary shown in the organizer shell.
// ABOUTME: Keeps saved dates and venue readable without depending on the browser locale.
import { describe, expect, it } from "vitest";
import { eventSummary } from "../../client/pages/event-setup/event-setup.ts";

describe("event setup presentation", () => {
  it("summarizes a same-month event and its venue", () => {
    expect(eventSummary({
      startDate: "2027-05-12",
      endDate: "2027-05-14",
      venue: "Moscone West",
    })).toBe("May 12–14, 2027 · Moscone West");
  });

  it("keeps honest placeholders when dates or venue are not set", () => {
    expect(eventSummary({ startDate: null, endDate: null, venue: null })).toBe("Dates TBD · Venue TBD");
  });
});
