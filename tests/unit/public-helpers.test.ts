// ABOUTME: Unit tests for the public-surface formatting and URL-state helpers.
// ABOUTME: Pure functions in client/pages/public/shared.ts; no DOM beyond URLSearchParams.
import { describe, expect, it } from "vitest";
import {
  EMPTY_FILTERS,
  activeFilterCount,
  formatDayLabel,
  formatSchedule,
  formatSpeakerLine,
  formatTime,
  initialsOf,
  readFiltersFromUrl,
  surnameOf,
  truncate,
} from "../../client/pages/public/shared.ts";

describe("formatSchedule", () => {
  it("returns TBD when no date is set", () => {
    expect(formatSchedule({ scheduledDate: null, startsAt: null, endsAt: null, scheduleStatus: "unplaced" })).toBe(
      "Schedule TBD",
    );
  });

  it("shows date with time TBD when date exists but no times", () => {
    expect(formatSchedule({ scheduledDate: "2027-05-13", startsAt: null, endsAt: null, scheduleStatus: "tbd" })).toContain(
      "time TBD",
    );
  });

  it("formats a full placed range", () => {
    const text = formatSchedule({
      scheduledDate: "2027-05-13",
      startsAt: new Date("2027-05-13T14:00:00Z").getTime(),
      endsAt: new Date("2027-05-13T14:30:00Z").getTime(),
      scheduleStatus: "placed",
    });
    expect(text).toContain("Thu, May 13");
    expect(text).toContain("2:00 PM");
    expect(text).toContain("2:30 PM");
  });
});

describe("formatDayLabel / formatTime", () => {
  it("formatDayLabel renders weekday, month, day", () => {
    expect(formatDayLabel("2027-05-12")).toBe("Wed, May 12");
    expect(formatDayLabel("2027-05-14")).toBe("Fri, May 14");
  });

  it("formatDayLabel passes through unparseable input", () => {
    expect(formatDayLabel("not-a-date")).toBe("not-a-date");
  });

  it("formatTime renders 12-hour UTC", () => {
    expect(formatTime(new Date("2027-05-13T09:15:00Z").getTime())).toMatch(/9:15 AM/i);
    expect(formatTime(new Date("2027-05-13T16:45:00Z").getTime())).toMatch(/4:45 PM/i);
  });
});

describe("truncate", () => {
  it("returns short text unchanged", () => {
    expect(truncate("short", 50)).toBe("short");
  });

  it("cuts at a word boundary and adds an ellipsis", () => {
    const text = "The quick brown fox jumps over the lazy dog repeatedly";
    const out = truncate(text, 25);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThan(text.length);
  });

  it("falls back to a hard cut when there is no whitespace", () => {
    expect(truncate("abcdefghijklmnopqrstuvwxyz", 10)).toBe("abcdefghij…");
  });
});

describe("formatSpeakerLine", () => {
  it("returns TBD when the list is empty", () => {
    expect(formatSpeakerLine([])).toBe("Speaker TBD");
  });

  it("joins name with title and company", () => {
    expect(
      formatSpeakerLine([
        { id: "spk_1", name: "Priya Raman", jobTitle: "Principal Engineer", organization: "Latticework" },
      ]),
    ).toBe("Priya Raman · Principal Engineer, Latticework");
  });

  it("omits missing fields without leaving stray separators", () => {
    expect(formatSpeakerLine([{ id: "spk_2", name: "Anonymous", jobTitle: null, organization: null }])).toBe(
      "Anonymous",
    );
  });

  it("separates multiple speakers with semicolons", () => {
    expect(
      formatSpeakerLine([
        { id: "spk_1", name: "A Speaker", jobTitle: "Dev", organization: "Acme" },
        { id: "spk_2", name: "B Speaker", jobTitle: null, organization: "Beta" },
      ]),
    ).toBe("A Speaker · Dev, Acme; B Speaker · Beta");
  });
});

describe("initialsOf", () => {
  it("returns first + last initial for full names", () => {
    expect(initialsOf("Priya Raman")).toBe("PR");
    expect(initialsOf("Marcus Okafor")).toBe("MO");
  });

  it("returns first two chars of a single token", () => {
    expect(initialsOf("Cher")).toBe("CH");
  });

  it("handles trailing whitespace", () => {
    expect(initialsOf("  Priya Raman  ")).toBe("PR");
  });
});

describe("surnameOf", () => {
  it("takes the last whitespace-delimited token", () => {
    expect(surnameOf("Priya Raman")).toBe("Raman");
    expect(surnameOf("Marcus Okafor")).toBe("Okafor");
  });

  it("returns the whole string when there is one token", () => {
    expect(surnameOf("Madonna")).toBe("Madonna");
  });
});

describe("URL filter state", () => {
  it("reads filters from a query string", () => {
    expect(readFiltersFromUrl("?q=docs&track=Platform%20%26%20Infra&day=2027-05-12")).toEqual({
      q: "docs",
      track: "Platform & Infra",
      format: "",
      room: "",
      day: "2027-05-12",
    });
  });

  it("returns empty filters for a blank query", () => {
    expect(readFiltersFromUrl("")).toEqual(EMPTY_FILTERS);
  });

  it("counts active filters excluding blanks", () => {
    expect(activeFilterCount({ q: "", track: "", format: "", room: "", day: "" })).toBe(0);
    expect(activeFilterCount({ q: "docs", track: "", format: "Talk (30 min)", room: "", day: "" })).toBe(2);
  });
});
