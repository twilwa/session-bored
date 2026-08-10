// ABOUTME: Specifies the .ics builder's RFC 5545 shape and its UID/SEQUENCE stability contract.
// ABOUTME: A session's UID must never change on regenerate; only SEQUENCE may advance.
import { describe, expect, it } from "vitest";
import { buildSessionIcs, icsToBase64 } from "../../worker/email/ics.ts";

const organizer = { name: "Greenroom", email: "organizer@example.test" };
const attendees = [{ name: "Priya Raman", email: "priya@example.test" }];
const dtstamp = new Date("2026-08-09T12:00:00Z");

function baseSession(overrides: Partial<Parameters<typeof buildSessionIcs>[0]["session"]> = {}) {
  return {
    icsUid: "sub_ci_monorepo@greenroom",
    sequence: 0,
    title: "Taming CI",
    description: "How we cut CI time in half.",
    startsAt: new Date("2027-05-12T17:00:00Z"),
    endsAt: new Date("2027-05-12T17:30:00Z"),
    room: "Hall A",
    ...overrides,
  };
}

describe("buildSessionIcs", () => {
  it("produces a well-formed VCALENDAR/VEVENT with the expected fields", () => {
    const ics = buildSessionIcs({ session: baseSession(), organizer, attendees, dtstamp });
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("METHOD:REQUEST");
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("UID:sub_ci_monorepo@greenroom");
    expect(ics).toContain("SEQUENCE:0");
    expect(ics).toContain("DTSTART:20270512T170000Z");
    expect(ics).toContain("DTEND:20270512T173000Z");
    expect(ics).toContain("SUMMARY:Taming CI");
    expect(ics).toContain("LOCATION:Hall A");
    expect(ics).toContain("ORGANIZER;CN=Greenroom:mailto:organizer@example.test");
    const unfolded = ics.replaceAll("\r\n ", "");
    expect(unfolded).toContain(
      "ATTENDEE;CN=Priya Raman;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:priya@example.test",
    );
    expect(ics).toContain("END:VEVENT");
    expect(ics).toContain("END:VCALENDAR");
    expect(ics.endsWith("\r\n")).toBe(true);
  });

  it("never includes a video-meeting link", () => {
    const ics = buildSessionIcs({ session: baseSession(), organizer, attendees, dtstamp });
    expect(ics).not.toMatch(/zoom\.us|meet\.google|teams\.microsoft|URL:/i);
  });

  it("omits LOCATION when the room is not yet known", () => {
    const ics = buildSessionIcs({ session: baseSession({ room: null }), organizer, attendees, dtstamp });
    expect(ics).not.toContain("LOCATION:");
  });

  it("escapes commas, semicolons, and newlines in free text", () => {
    const ics = buildSessionIcs({
      session: baseSession({ title: "CI, at scale; fast", description: "Line one\nLine two" }),
      organizer,
      attendees,
      dtstamp,
    });
    expect(ics).toContain("SUMMARY:CI\\, at scale\\; fast");
    expect(ics).toContain("DESCRIPTION:Line one\\nLine two");
  });

  it("folds lines longer than 75 octets per RFC 5545", () => {
    const ics = buildSessionIcs({
      session: baseSession({ title: "A".repeat(120) }),
      organizer,
      attendees,
      dtstamp,
    });
    const summaryLine = ics.split("\r\n").find((line) => line.startsWith("SUMMARY:"));
    expect(summaryLine).toBeDefined();
    expect(summaryLine!.length).toBeLessThanOrEqual(75);
    expect(ics).toContain("\r\n A");
  });

  it("keeps the UID stable and advances SEQUENCE across a regenerate after the session changes", () => {
    const first = buildSessionIcs({ session: baseSession({ sequence: 1 }), organizer, attendees, dtstamp });
    const mutatedSession = baseSession({
      sequence: 2,
      title: "Taming CI (updated room)",
      room: "Hall B",
    });
    const second = buildSessionIcs({ session: mutatedSession, organizer, attendees, dtstamp });

    const uidOf = (ics: string) => ics.split("\r\n").find((line) => line.startsWith("UID:"));
    const sequenceOf = (ics: string) => ics.split("\r\n").find((line) => line.startsWith("SEQUENCE:"));

    expect(uidOf(first)).toBe(uidOf(second));
    expect(sequenceOf(first)).toBe("SEQUENCE:1");
    expect(sequenceOf(second)).toBe("SEQUENCE:2");
    expect(second).toContain("LOCATION:Hall B");
  });
});

describe("icsToBase64", () => {
  it("round-trips the ics content", () => {
    const ics = buildSessionIcs({ session: baseSession(), organizer, attendees, dtstamp });
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(icsToBase64(ics)), (char) => char.charCodeAt(0)),
    );
    expect(decoded).toBe(ics);
  });
});
