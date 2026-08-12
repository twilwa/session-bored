// ABOUTME: Sends a session's stable-UID calendar invite to its speakers, bumping SEQUENCE on every regenerate.
// ABOUTME: A deliberate, organizer-triggered action - never wired to a schedule or status change.
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { events, people, rooms, sessions, sessionSpeakers, speakers } from "../../db/schema.ts";
import { resolveEmailDelivery, type EmailDelivery, type EmailEnvironment } from "../email.ts";
import { buildSessionIcs, icsToBase64 } from "./ics.ts";
import { sendTrackedEmail } from "./send.ts";

type EmailDatabase = ReturnType<typeof drizzle>;

export type SendCalendarInviteResult =
  | { status: "session_not_found" }
  | { status: "not_scheduled" }
  | { status: "no_attendees" }
  | { status: "not_configured" }
  | { status: "sent"; sentCount: number; failedCount: number; sequence: number };

function organizerAddress(env: EmailEnvironment): { name: string; email: string } {
  const raw = env.RESEND_FROM_ADDRESS ?? "Greenroom <noreply@greenroom.invalid>";
  const match = raw.match(/^(.*)<(.+)>$/);
  if (match?.[1] !== undefined && match[2] !== undefined) {
    return { name: match[1].trim() || "Greenroom", email: match[2].trim() };
  }
  return { name: "Greenroom", email: raw.trim() };
}

/**
 * Regenerates and sends the calendar invite for one session. `sessions.icsUid`
 * is fixed at session creation (derived from the session's durable ID), so
 * the UID here is always the same value; only SEQUENCE advances. Requires the
 * session to already have a start and end time - room may still be unknown,
 * matching the PRD's "invite before a room exists, update after" allowance.
 */
export async function sendSessionCalendarInvite(
  database: EmailDatabase,
  env: EmailEnvironment,
  eventId: `evt_${string}`,
  sessionId: string,
  createdByUserId?: string | null,
  delivery: EmailDelivery = resolveEmailDelivery(env),
): Promise<SendCalendarInviteResult> {
  const [row] = await database
    .select({
      title: sessions.title,
      abstract: sessions.abstract,
      icsUid: sessions.icsUid,
      icsSequence: sessions.icsSequence,
      startsAt: sessions.startsAt,
      endsAt: sessions.endsAt,
      roomName: rooms.name,
      eventName: events.name,
    })
    .from(sessions)
    .innerJoin(events, eq(sessions.eventId, events.id))
    .leftJoin(rooms, eq(sessions.roomId, rooms.id))
    .where(and(eq(sessions.id, sessionId), eq(sessions.eventId, eventId)));
  if (row === undefined) {
    return { status: "session_not_found" };
  }
  if (row.startsAt === null || row.endsAt === null) {
    return { status: "not_scheduled" };
  }

  const attendeeRows = await database
    .select({ name: people.name, email: people.email })
    .from(sessionSpeakers)
    .innerJoin(speakers, eq(sessionSpeakers.speakerId, speakers.id))
    .innerJoin(people, eq(speakers.personId, people.id))
    .where(and(eq(sessionSpeakers.sessionId, sessionId), isNull(sessionSpeakers.deletedAt)));
  const attendees = attendeeRows.filter((attendee) => attendee.email.trim() !== "");
  if (attendees.length === 0) {
    return { status: "no_attendees" };
  }

  const nextSequence = row.icsSequence + 1;
  const ics = buildSessionIcs({
    session: {
      icsUid: row.icsUid,
      sequence: nextSequence,
      title: row.title ?? "Untitled session",
      description: row.abstract,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      room: row.roomName,
    },
    organizer: organizerAddress(env),
    attendees,
    dtstamp: new Date(),
  });
  const attachment = {
    filename: "session.ics",
    content: icsToBase64(ics),
    contentType: "text/calendar; method=REQUEST",
  };

  let sentCount = 0;
  let failedCount = 0;
  let attempted = 0;
  for (const attendee of attendees) {
    const subject = `Calendar invite: ${row.title ?? "Your session"} at ${row.eventName}`;
    const text = `Attached is the calendar invite for your session at ${row.eventName}.`;
    const result = await sendTrackedEmail({
      database,
      delivery,
      eventId,
      templateKey: "calendar_invite",
      recipient: { email: attendee.email, name: attendee.name },
      subject,
      html: `<p>${text}</p>`,
      text,
      attachments: [attachment],
      createdByUserId: createdByUserId ?? null,
    });
    if (result.status === "provider_not_configured") {
      continue;
    }
    attempted += 1;
    if (result.status === "sent") {
      sentCount += 1;
    } else {
      failedCount += 1;
    }
  }
  if (attempted === 0) {
    return { status: "not_configured" };
  }
  await database.update(sessions).set({ icsSequence: nextSequence }).where(eq(sessions.id, sessionId));
  return { status: "sent", sentCount, failedCount, sequence: nextSequence };
}
