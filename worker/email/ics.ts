// ABOUTME: Builds RFC 5545 calendar invitations with a stable UID and incrementing SEQUENCE.
// ABOUTME: Never includes a video-meeting link; room is optional and may be added on a later regenerate.
export interface IcsSession {
  icsUid: string;
  sequence: number;
  title: string;
  description?: string | null;
  startsAt: Date;
  endsAt: Date;
  room?: string | null;
}

export interface IcsPerson {
  name: string;
  email: string;
}

export interface BuildSessionIcsInput {
  session: IcsSession;
  organizer: IcsPerson;
  attendees: IcsPerson[];
  dtstamp: Date;
  status?: "CONFIRMED" | "CANCELLED";
}

export interface BuildScheduleIcsInput {
  calendarName: string;
  organizer: IcsPerson;
  sessions: IcsSession[];
  dtstamp: Date;
}

function foldIcsLine(line: string): string {
  if (line.length <= 75) {
    return line;
  }
  const folded: string[] = [];
  let rest = line;
  let first = true;
  while (rest.length > 0) {
    const width = first ? 75 : 74;
    folded.push((first ? "" : " ") + rest.slice(0, width));
    rest = rest.slice(width);
    first = false;
  }
  return folded.join("\r\n");
}

function escapeIcsText(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,")
    .replaceAll("\n", "\\n");
}

function formatIcsUtc(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/**
 * Renders a Gmail/Outlook/iCal-compatible .ics invite for one session.
 * `session.icsUid` must be derived from the session's durable ID (never from
 * time, a sequence number, or randomness) so that regenerating the invite
 * after an edit updates the same calendar entry. Callers own bumping
 * `session.sequence` on every update before calling this again.
 */
export function buildSessionIcs(input: BuildSessionIcsInput): string {
  const { session, organizer, attendees, dtstamp } = input;
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Greenroom//Session Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:${session.icsUid}`,
    `SEQUENCE:${session.sequence}`,
    `DTSTAMP:${formatIcsUtc(dtstamp)}`,
    `DTSTART:${formatIcsUtc(session.startsAt)}`,
    `DTEND:${formatIcsUtc(session.endsAt)}`,
    `SUMMARY:${escapeIcsText(session.title)}`,
  ];
  if (session.description) {
    lines.push(`DESCRIPTION:${escapeIcsText(session.description)}`);
  }
  if (session.room) {
    lines.push(`LOCATION:${escapeIcsText(session.room)}`);
  }
  lines.push(`ORGANIZER;CN=${escapeIcsText(organizer.name)}:mailto:${organizer.email}`);
  for (const attendee of attendees) {
    lines.push(
      `ATTENDEE;CN=${escapeIcsText(attendee.name)};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${attendee.email}`,
    );
  }
  lines.push(`STATUS:${input.status ?? "CONFIRMED"}`, "TRANSP:OPAQUE", "END:VEVENT", "END:VCALENDAR");
  return lines.map(foldIcsLine).join("\r\n") + "\r\n";
}

/**
 * Builds one importable event calendar while preserving each session's durable
 * UID and sequence. Every VEVENT comes from the single-session builder used by
 * delivered calendar invitations, so escaping and folding stay identical.
 */
export function buildScheduleIcs(input: BuildScheduleIcsInput): string {
  const eventBlocks = input.sessions.map((session) => {
    const invitation = buildSessionIcs({
      session,
      organizer: input.organizer,
      attendees: [],
      dtstamp: input.dtstamp,
    });
    const start = invitation.indexOf("BEGIN:VEVENT");
    const end = invitation.indexOf("END:VEVENT") + "END:VEVENT".length;
    return invitation.slice(start, end);
  });
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Greenroom//Event Schedule//EN",
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${escapeIcsText(input.calendarName)}`,
    ...eventBlocks,
    "END:VCALENDAR",
  ];
  return lines.map((line) => line.includes("\r\n") ? line : foldIcsLine(line)).join("\r\n") + "\r\n";
}

export function icsToBase64(ics: string): string {
  const bytes = new TextEncoder().encode(ics);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
