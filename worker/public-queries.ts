// ABOUTME: Centralizes the public read model for published event content with approval gating.
// ABOUTME: Keeps the unpublished/withdrawn content rule in one narrow module so it cannot drift.
import { and, desc, eq, inArray, isNotNull, isNull, like, or, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  events,
  formats,
  people,
  rooms,
  sessionSpeakers,
  sessions,
  speakers,
  submissions,
  tracks,
} from "../db/schema.ts";

// ABOUTME: A session is public only after explicit publication, while its content and source decision remain live.
// Schedule status is intentionally not a gate because published TBD sessions remain visible.
const PUBLIC_SESSION_GATE = and(
  eq(sessions.contentStatus, "approved"),
  isNotNull(sessions.publishedAt),
  isNull(sessions.deletedAt),
  or(
    eq(sessions.directEntry, true),
    sql`EXISTS (
      SELECT 1 FROM ${submissions}
      WHERE ${submissions.id} = ${sessions.submissionId}
        AND ${submissions.status} = 'accepted'
    )`,
  ),
);

// ABOUTME: Public speakers have cleared invitation and employer-approval states.
// Confirmed, onboarding, and ready speakers remain visible even when their profiles are incomplete.
const PUBLIC_SPEAKER_GATE = and(
  inArray(speakers.status, ["confirmed", "onboarding", "ready"]),
  isNull(speakers.deletedAt),
  isNull(people.deletedAt),
);

export interface PublicSpeakerRef {
  id: string;
  name: string;
  jobTitle: string | null;
  organization: string | null;
}

export interface PublicSessionCard {
  id: string;
  title: string | null;
  abstract: string | null;
  track: string | null;
  format: string | null;
  room: string | null;
  scheduledDate: string | null;
  startsAt: number | null;
  endsAt: number | null;
  scheduleStatus: string;
  speakers: PublicSpeakerRef[];
}

export interface PublicSpeakerCard {
  id: string;
  name: string;
  jobTitle: string | null;
  organization: string | null;
  bio: string | null;
  headshotUrl: string | null;
  twitter: string | null;
  linkedin: string | null;
  sessionCount: number;
}

export interface PublicSpeakerDetail extends PublicSpeakerCard {
  sessions: Array<{
    id: string;
    title: string | null;
    scheduledDate: string | null;
    startsAt: number | null;
    endsAt: number | null;
    room: string | null;
    track: string | null;
  }>;
}

export interface PublicEventFacets {
  event: {
    id: string;
    name: string;
    tagline: string | null;
    startDate: string | null;
    endDate: string | null;
    venue: string | null;
    timezone: string;
  };
  tracks: string[];
  formats: string[];
  rooms: string[];
  days: string[];
}

function tokenize(query: string | undefined): string | null {
  if (query === undefined) {
    return null;
  }
  const trimmed = query.trim().toLowerCase();
  return trimmed.length === 0 ? null : trimmed;
}

function surnameOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts[parts.length - 1] ?? name;
}

// ABOUTME: Builds a Drizzle predicate matching title, abstract, or any speaker name against q.
// D1 supports lower() and like(); % escapes are unnecessary because we wrap the literal manually.
function searchPredicate(q: string) {
  const term = `%${q.replace(/[%_]/g, (match) => `\\${match}`)}%`;
  return or(
    like(sql`lower(coalesce(${sessions.title}, ''))`, term),
    like(sql`lower(coalesce(${sessions.abstract}, ''))`, term),
    // ABOUTME: Speaker-name match: any session sharing a speaker whose name contains q is a hit.
    sql`EXISTS (
      SELECT 1 FROM ${sessionSpeakers}
      JOIN ${speakers} ON ${speakers}.id = ${sessionSpeakers}.speaker_id
      JOIN ${people} ON ${people}.id = ${speakers}.person_id
      WHERE ${sessionSpeakers}.session_id = ${sessions}.id
        AND ${sessionSpeakers}.deleted_at IS NULL
        AND ${speakers}.deleted_at IS NULL
        AND lower(coalesce(${people}.name, '')) LIKE ${term} ESCAPE '\\'
    )`,
  );
}

export interface SessionFilters {
  q: string | undefined;
  track: string | undefined;
  format: string | undefined;
  room: string | undefined;
  day: string | undefined;
}

export async function fetchPublicSessions(
  database: DrizzleD1Database,
  eventId: string,
  filters: SessionFilters,
): Promise<PublicSessionCard[]> {
  const q = tokenize(filters.q);
  const clauses = [
    eq(sessions.eventId, eventId),
    PUBLIC_SESSION_GATE,
    q === null ? null : searchPredicate(q),
    filters.track === undefined || filters.track === "" ? null : eq(tracks.name, filters.track),
    filters.format === undefined || filters.format === "" ? null : eq(formats.name, filters.format),
    filters.room === undefined || filters.room === "" ? null : eq(rooms.name, filters.room),
    filters.day === undefined || filters.day === "" ? null : eq(sessions.scheduledDate, filters.day),
  ].filter((clause): clause is NonNullable<typeof clause> => clause !== null);

  const rows = await database
    .select({
      id: sessions.id,
      title: sessions.title,
      abstract: sessions.abstract,
      track: tracks.name,
      format: formats.name,
      room: rooms.name,
      scheduledDate: sessions.scheduledDate,
      startsAt: sessions.startsAt,
      endsAt: sessions.endsAt,
      scheduleStatus: sessions.scheduleStatus,
    })
    .from(sessions)
    .leftJoin(tracks, eq(sessions.trackId, tracks.id))
    .leftJoin(formats, eq(sessions.formatId, formats.id))
    .leftJoin(rooms, eq(sessions.roomId, rooms.id))
    .where(and(...clauses))
    .orderBy(desc(sessions.scheduledDate), desc(sessions.startsAt), sessions.id);

  if (rows.length === 0) {
    return [];
  }
  const sessionIds = rows.map((row) => row.id);
  const speakerRows = await database
    .select({
      sessionId: sessionSpeakers.sessionId,
      id: speakers.id,
      name: people.name,
      jobTitle: people.jobTitle,
      organization: people.organization,
    })
    .from(sessionSpeakers)
    .innerJoin(speakers, eq(sessionSpeakers.speakerId, speakers.id))
    .innerJoin(people, eq(speakers.personId, people.id))
    .where(
      and(
        isNull(sessionSpeakers.deletedAt),
        PUBLIC_SPEAKER_GATE,
        inArray(sessionSpeakers.sessionId, sessionIds),
      ),
    )
    .orderBy(sessionSpeakers.sortOrder, people.name);

  const speakersBySession = new Map<string, PublicSpeakerRef[]>();
  for (const row of speakerRows) {
    const list = speakersBySession.get(row.sessionId) ?? [];
    list.push({ id: row.id, name: row.name, jobTitle: row.jobTitle, organization: row.organization });
    speakersBySession.set(row.sessionId, list);
  }

  return rows.map((row) => ({
    ...row,
    startsAt: row.startsAt === null ? null : row.startsAt.getTime(),
    endsAt: row.endsAt === null ? null : row.endsAt.getTime(),
    speakers: speakersBySession.get(row.id) ?? [],
  }));
}

export async function countPublicSessions(
  database: DrizzleD1Database,
  eventId: string,
): Promise<number> {
  const [row] = await database
    .select({ count: sql<number>`count(*)`.as("count") })
    .from(sessions)
    .where(and(eq(sessions.eventId, eventId), PUBLIC_SESSION_GATE));
  return row?.count ?? 0;
}

export async function fetchPublicSpeakers(
  database: DrizzleD1Database,
  eventId: string,
  filters: { q: string | undefined },
): Promise<PublicSpeakerCard[]> {
  const q = tokenize(filters.q);
  const clauses = [
    eq(speakers.eventId, eventId),
    PUBLIC_SPEAKER_GATE,
    q === null
      ? null
      : like(
          sql`lower(coalesce(${people.name}, ''))`,
          `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`,
        ),
  ].filter((clause): clause is NonNullable<typeof clause> => clause !== null);

  const rows = await database
    .select({
      id: speakers.id,
      name: people.name,
      jobTitle: people.jobTitle,
      organization: people.organization,
      bio: people.bio,
      headshotUrl: people.headshotUrl,
      twitter: people.twitter,
      linkedin: people.linkedin,
    })
    .from(speakers)
    .innerJoin(people, eq(speakers.personId, people.id))
    .where(and(...clauses));

  rows.sort((a, b) => {
    const sa = surnameOf(a.name).toLowerCase();
    const sb = surnameOf(b.name).toLowerCase();
    if (sa !== sb) {
      return sa < sb ? -1 : 1;
    }
    return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1;
  });

  if (rows.length === 0) {
    return [];
  }
  const speakerIds = rows.map((row) => row.id);
  const counts = await database
    .select({
      speakerId: sessionSpeakers.speakerId,
      count: sql<number>`count(*)`.as("count"),
    })
    .from(sessionSpeakers)
    .innerJoin(sessions, eq(sessionSpeakers.sessionId, sessions.id))
    .where(
      and(
        isNull(sessionSpeakers.deletedAt),
        eq(sessions.eventId, eventId),
        PUBLIC_SESSION_GATE,
        inArray(sessionSpeakers.speakerId, speakerIds),
      ),
    )
    .groupBy(sessionSpeakers.speakerId);

  const countBySpeaker = new Map<string, number>(counts.map((row) => [row.speakerId, row.count]));
  return rows.map((row) => ({ ...row, sessionCount: countBySpeaker.get(row.id) ?? 0 }));
}

export async function countPublicSpeakers(
  database: DrizzleD1Database,
  eventId: string,
): Promise<number> {
  const [row] = await database
    .select({ count: sql<number>`count(*)`.as("count") })
    .from(speakers)
    .innerJoin(people, eq(speakers.personId, people.id))
    .where(and(eq(speakers.eventId, eventId), PUBLIC_SPEAKER_GATE));
  return row?.count ?? 0;
}

export async function fetchPublicSpeaker(
  database: DrizzleD1Database,
  eventId: string,
  speakerId: string,
): Promise<PublicSpeakerDetail | null> {
  const [row] = await database
    .select({
      id: speakers.id,
      name: people.name,
      jobTitle: people.jobTitle,
      organization: people.organization,
      bio: people.bio,
      headshotUrl: people.headshotUrl,
      twitter: people.twitter,
      linkedin: people.linkedin,
    })
    .from(speakers)
    .innerJoin(people, eq(speakers.personId, people.id))
    .where(and(eq(speakers.id, speakerId), eq(speakers.eventId, eventId), PUBLIC_SPEAKER_GATE));
  if (row === undefined) {
    return null;
  }

  const speakerSessions = await database
    .select({
      id: sessions.id,
      title: sessions.title,
      scheduledDate: sessions.scheduledDate,
      startsAt: sessions.startsAt,
      endsAt: sessions.endsAt,
      room: rooms.name,
      track: tracks.name,
    })
    .from(sessionSpeakers)
    .innerJoin(sessions, eq(sessionSpeakers.sessionId, sessions.id))
    .leftJoin(rooms, eq(sessions.roomId, rooms.id))
    .leftJoin(tracks, eq(sessions.trackId, tracks.id))
    .where(
      and(
        eq(sessionSpeakers.speakerId, speakerId),
        eq(sessions.eventId, eventId),
        isNull(sessionSpeakers.deletedAt),
        PUBLIC_SESSION_GATE,
      ),
    )
    .orderBy(desc(sessions.scheduledDate), desc(sessions.startsAt), sessions.id);

  return {
    ...row,
    headshotUrl: row.headshotUrl,
    sessionCount: speakerSessions.length,
    sessions: speakerSessions.map((s) => ({
      id: s.id,
      title: s.title,
      scheduledDate: s.scheduledDate,
      startsAt: s.startsAt === null ? null : s.startsAt.getTime(),
      endsAt: s.endsAt === null ? null : s.endsAt.getTime(),
      room: s.room,
      track: s.track,
    })),
  };
}

export async function fetchPublicEventFacets(
  database: DrizzleD1Database,
  eventId: string,
): Promise<PublicEventFacets | null> {
  const [event] = await database
    .select({
      id: events.id,
      name: events.name,
      tagline: events.tagline,
      startDate: events.startDate,
      endDate: events.endDate,
      venue: events.venue,
      timezone: events.timezone,
    })
    .from(events)
    .where(and(eq(events.id, eventId), isNull(events.deletedAt)));
  if (event === undefined) {
    return null;
  }

  const [trackRows, formatRows, roomRows, dayRows] = await Promise.all([
    database.select({ name: tracks.name }).from(tracks).where(eq(tracks.eventId, eventId)).orderBy(tracks.sortOrder),
    database.select({ name: formats.name }).from(formats).where(eq(formats.eventId, eventId)).orderBy(formats.sortOrder),
    database.select({ name: rooms.name }).from(rooms).where(eq(rooms.eventId, eventId)).orderBy(rooms.sortOrder),
    database
      .selectDistinct({ day: sessions.scheduledDate })
      .from(sessions)
      .where(and(eq(sessions.eventId, eventId), PUBLIC_SESSION_GATE, sql`${sessions.scheduledDate} IS NOT NULL`)),
  ]);

  // ABOUTME: Days fall back to the event's start..end range when no sessions have been scheduled yet,
  // so the day facet stays useful while the agenda is still taking shape.
  let days = dayRows
    .map((row) => row.day)
    .filter((day): day is string => day !== null)
    .sort();
  if (days.length === 0 && event.startDate !== null && event.endDate !== null) {
    days = eachDayBetween(event.startDate, event.endDate);
  }

  return {
    event,
    tracks: trackRows.map((row) => row.name),
    formats: formatRows.map((row) => row.name),
    rooms: roomRows.map((row) => row.name),
    days,
  };
}

// ABOUTME: Enumerates inclusive ISO dates between two yyyy-MM-dd strings; bounded by the range.
function eachDayBetween(startIso: string, endIso: string): string[] {
  const start = new Date(`${startIso}T00:00:00Z`);
  const end = new Date(`${endIso}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
    return [];
  }
  const days: string[] = [];
  const cursor = new Date(start);
  let guard = 0;
  while (cursor <= end && guard < 60) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    guard += 1;
  }
  return days;
}
