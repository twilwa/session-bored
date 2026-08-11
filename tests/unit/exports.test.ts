// ABOUTME: Specifies portable export serialization for spreadsheet and calendar consumers.
// ABOUTME: Protects free-text escaping and multi-session calendar composition.
import { describe, expect, it } from "vitest";
import { buildScheduleIcs } from "../../worker/email/ics.ts";
import { serializeCsv } from "../../worker/exports/serialize.ts";

describe("serializeCsv", () => {
  it("preserves commas, quotes, and newlines in spreadsheet cells", () => {
    const csv = serializeCsv(
      ["proposal", "review_notes"],
      [["Talk, with commas", "First line\nSecond \"quoted\" line"]],
    );

    expect(csv).toBe(
      'proposal,review_notes\r\n"Talk, with commas","First line\nSecond ""quoted"" line"\r\n',
    );
  });

  it("returns a header-only document for an empty collection", () => {
    expect(serializeCsv(["submission_id", "decision"], [])).toBe(
      "submission_id,decision\r\n",
    );
  });
});

describe("buildScheduleIcs", () => {
  it("reuses the session calendar contract for every scheduled session", () => {
    const ics = buildScheduleIcs({
      calendarName: "DevFlow Conf 2027 schedule",
      organizer: { name: "DevFlow Conf 2027", email: "calendar@greenroom.invalid" },
      dtstamp: new Date("2026-08-11T12:00:00Z"),
      sessions: [
        {
          icsUid: "ses_one@greenroom",
          sequence: 2,
          title: "First session",
          startsAt: new Date("2027-05-12T16:00:00Z"),
          endsAt: new Date("2027-05-12T16:30:00Z"),
          room: "Main Stage",
        },
        {
          icsUid: "ses_two@greenroom",
          sequence: 1,
          title: "Second session",
          startsAt: new Date("2027-05-12T17:00:00Z"),
          endsAt: new Date("2027-05-12T18:00:00Z"),
        },
      ],
    });

    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(ics).toContain("X-WR-CALNAME:DevFlow Conf 2027 schedule");
    expect(ics).toContain("UID:ses_one@greenroom");
    expect(ics).toContain("UID:ses_two@greenroom");
    expect(ics).toContain("LOCATION:Main Stage");
    expect(ics).not.toContain("METHOD:REQUEST");
  });

  it("creates an importable empty calendar", () => {
    const ics = buildScheduleIcs({
      calendarName: "Empty event schedule",
      organizer: { name: "Empty event", email: "calendar@greenroom.invalid" },
      dtstamp: new Date("2026-08-11T12:00:00Z"),
      sessions: [],
    });

    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("END:VCALENDAR");
    expect(ics).not.toContain("BEGIN:VEVENT");
  });
});
