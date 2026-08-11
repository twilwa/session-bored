// ABOUTME: Reads, approves, places, and publishes accepted sessions on an event agenda.
// ABOUTME: Recomputes speaker and room conflicts after every non-blocking scheduling change.
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
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
  type Role,
} from "../../db/schema.ts";
import type {
  AgendaConflict,
  AgendaPlacement,
  AgendaSession,
  AgendaState,
} from "../../shared/api.ts";

type AgendaEnvironment = {
  Bindings: CloudflareBindings;
  Variables: {
    authUser: { id: string } | null;
    role: Role | null;
  };
};

const agendaRoutes = new Hono<AgendaEnvironment>();

const requireOrganizer = createMiddleware<AgendaEnvironment>(async (context, next) => {
  if (context.get("role") !== "organizer") {
    const status = context.get("role") === null ? 401 : 403;
    return context.json(
      { error: status === 401 ? "authentication_required" : "forbidden" },
      status,
    );
  }
  await next();
});

agendaRoutes.use("/api/events/:eventId/agenda", requireOrganizer);
agendaRoutes.use("/api/events/:eventId/agenda/*", requireOrganizer);

function eventDays(startDate: string, endDate: string): string[] {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    return [];
  }
  const days: string[] = [];
  for (let current = start; current <= end; current = new Date(current.getTime() + 86_400_000)) {
    days.push(current.toISOString().slice(0, 10));
  }
  return days;
}

function overlaps(first: AgendaSession, second: AgendaSession): boolean {
  return first.startsAt !== null && first.endsAt !== null &&
    second.startsAt !== null && second.endsAt !== null &&
    first.startsAt < second.endsAt && second.startsAt < first.endsAt;
}

function conflictFix(first: AgendaSession, second: AgendaSession): AgendaSession {
  if (first.startsAt !== second.startsAt) {
    return (first.startsAt ?? 0) < (second.startsAt ?? 0) ? second : first;
  }
  return first.id.localeCompare(second.id) < 0 ? second : first;
}

function agendaConflicts(items: AgendaSession[]): AgendaConflict[] {
  const placed = items.filter((item) => item.scheduleStatus === "placed");
  const conflicts: AgendaConflict[] = [];
  for (let firstIndex = 0; firstIndex < placed.length; firstIndex += 1) {
    const first = placed[firstIndex];
    if (first === undefined) continue;
    for (let secondIndex = firstIndex + 1; secondIndex < placed.length; secondIndex += 1) {
      const second = placed[secondIndex];
      if (second === undefined || !overlaps(first, second)) continue;
      const fix = conflictFix(first, second);
      const sessionIds: [string, string] = [first.id, second.id];
      if (first.room !== null && second.room !== null && first.room.id === second.room.id) {
        conflicts.push({
          id: `room:${first.room.id}:${sessionIds.join(":")}`,
          kind: "room",
          name: first.room.name,
          label: `${first.room.name} overlaps: ${first.title} + ${second.title}`,
          sessionIds,
          fixSessionId: fix.id,
          fixLabel: `Move ${fix.title} to TBD`,
        });
      }
      const secondSpeakerIds = new Set(second.speakers.map((speaker) => speaker.id));
      for (const speaker of first.speakers) {
        if (!secondSpeakerIds.has(speaker.id)) continue;
        conflicts.push({
          id: `speaker:${speaker.id}:${sessionIds.join(":")}`,
          kind: "speaker",
          name: speaker.name,
          label: `${speaker.name} overlaps: ${first.title} + ${second.title}`,
          sessionIds,
          fixSessionId: fix.id,
          fixLabel: `Move ${fix.title} to TBD`,
        });
      }
    }
  }
  return conflicts;
}

async function readAgenda(binding: D1Database, eventId: string): Promise<AgendaState | null> {
  const database = drizzle(binding);
  const [event] = await database
    .select({
      id: events.id,
      name: events.name,
      startDate: events.startDate,
      endDate: events.endDate,
      timezone: events.timezone,
    })
    .from(events)
    .where(and(eq(events.id, eventId), isNull(events.deletedAt)));
  if (event === undefined || event.startDate === null || event.endDate === null) {
    return null;
  }

  const [roomRows, trackRows, sessionRows] = await Promise.all([
    database
      .select({ id: rooms.id, name: rooms.name })
      .from(rooms)
      .where(and(eq(rooms.eventId, eventId), isNull(rooms.deletedAt)))
      .orderBy(asc(rooms.sortOrder), asc(rooms.name)),
    database
      .select({ id: tracks.id, name: tracks.name, color: tracks.color })
      .from(tracks)
      .where(and(eq(tracks.eventId, eventId), isNull(tracks.deletedAt)))
      .orderBy(asc(tracks.sortOrder), asc(tracks.name)),
    database
      .select({
        id: sessions.id,
        title: sessions.title,
        abstract: sessions.abstract,
        contentStatus: sessions.contentStatus,
        scheduleStatus: sessions.scheduleStatus,
        scheduledDate: sessions.scheduledDate,
        startsAt: sessions.startsAt,
        endsAt: sessions.endsAt,
        publishedAt: sessions.publishedAt,
        durationMinutes: formats.durationMinutes,
        trackId: tracks.id,
        trackName: tracks.name,
        trackColor: tracks.color,
        roomId: rooms.id,
        roomName: rooms.name,
      })
      .from(sessions)
      .leftJoin(submissions, eq(sessions.submissionId, submissions.id))
      .leftJoin(formats, eq(sessions.formatId, formats.id))
      .leftJoin(tracks, eq(sessions.trackId, tracks.id))
      .leftJoin(rooms, eq(sessions.roomId, rooms.id))
      .where(
        and(
          eq(sessions.eventId, eventId),
          isNull(sessions.deletedAt),
          or(eq(sessions.directEntry, true), eq(submissions.status, "accepted")),
        ),
      )
      .orderBy(asc(sessions.scheduledDate), asc(sessions.startsAt), asc(sessions.title)),
  ]);

  const speakerRows = sessionRows.length === 0
    ? []
    : await database
      .select({
        sessionId: sessionSpeakers.sessionId,
        speakerId: speakers.id,
        name: people.name,
      })
      .from(sessionSpeakers)
      .innerJoin(speakers, eq(sessionSpeakers.speakerId, speakers.id))
      .innerJoin(people, eq(speakers.personId, people.id))
      .where(inArray(sessionSpeakers.sessionId, sessionRows.map((session) => session.id)))
      .orderBy(asc(sessionSpeakers.sortOrder), asc(people.name));
  const speakersBySession = new Map<string, Array<{ id: string; name: string }>>();
  for (const speaker of speakerRows) {
    const sessionParticipants = speakersBySession.get(speaker.sessionId) ?? [];
    sessionParticipants.push({ id: speaker.speakerId, name: speaker.name });
    speakersBySession.set(speaker.sessionId, sessionParticipants);
  }

  const agendaSessions: AgendaSession[] = sessionRows.map((session) => ({
    id: session.id as `ses_${string}`,
    title: session.title ?? "Untitled session",
    abstract: session.abstract,
    contentStatus: session.contentStatus,
    scheduleStatus: session.scheduleStatus,
    scheduledDate: session.scheduledDate,
    startsAt: session.startsAt?.getTime() ?? null,
    endsAt: session.endsAt?.getTime() ?? null,
    publishedAt: session.publishedAt?.getTime() ?? null,
    durationMinutes: session.durationMinutes ?? 30,
    track: session.trackId === null || session.trackName === null
      ? null
      : { id: session.trackId, name: session.trackName, color: session.trackColor },
    room: session.roomId === null || session.roomName === null
      ? null
      : { id: session.roomId, name: session.roomName },
    speakers: speakersBySession.get(session.id) ?? [],
  }));
  const conflicts = agendaConflicts(agendaSessions);
  return {
    event: { ...event, startDate: event.startDate, endDate: event.endDate },
    days: eventDays(event.startDate, event.endDate),
    rooms: roomRows,
    tracks: trackRows,
    sessions: agendaSessions,
    conflicts,
    metrics: {
      unplaced: agendaSessions.filter((session) => session.scheduleStatus === "unplaced").length,
      conflicts: conflicts.length,
      tbd: agendaSessions.filter((session) => session.scheduleStatus === "tbd").length,
    },
  };
}

function isPlacement(value: unknown): value is AgendaPlacement {
  if (typeof value !== "object" || value === null || !("scheduleStatus" in value)) return false;
  const placement = value as Record<string, unknown>;
  if (placement.scheduleStatus === "unplaced") return true;
  if (placement.scheduleStatus === "tbd") {
    return typeof placement.scheduledDate === "string";
  }
  return placement.scheduleStatus === "placed" &&
    typeof placement.scheduledDate === "string" &&
    typeof placement.roomId === "string" &&
    typeof placement.startsAt === "number" &&
    Number.isFinite(placement.startsAt);
}

agendaRoutes.get("/api/events/:eventId/agenda", async (context) => {
  const agenda = await readAgenda(context.env.DB, context.req.param("eventId"));
  return agenda === null ? context.json({ error: "event_not_found" }, 404) : context.json(agenda);
});

agendaRoutes.patch("/api/events/:eventId/agenda/sessions/:sessionId", async (context) => {
  const placement = await context.req.json<unknown>().catch(() => null);
  if (!isPlacement(placement)) {
    return context.json({ error: "invalid_placement" }, 400);
  }
  const eventId = context.req.param("eventId");
  const agenda = await readAgenda(context.env.DB, eventId);
  if (agenda === null) return context.json({ error: "event_not_found" }, 404);
  const session = agenda.sessions.find((item) => item.id === context.req.param("sessionId"));
  if (session === undefined) return context.json({ error: "session_not_found" }, 404);
  const database = drizzle(context.env.DB);
  if (placement.scheduleStatus === "unplaced") {
    await database.update(sessions).set({
      scheduleStatus: "unplaced",
      scheduledDate: null,
      roomId: null,
      startsAt: null,
      endsAt: null,
      publishedAt: null,
    }).where(eq(sessions.id, session.id));
  } else {
    if (!agenda.days.includes(placement.scheduledDate)) {
      return context.json({ error: "invalid_event_day" }, 400);
    }
    if (placement.scheduleStatus === "tbd") {
      await database.update(sessions).set({
        scheduleStatus: "tbd",
        scheduledDate: placement.scheduledDate,
        roomId: null,
        startsAt: null,
        endsAt: null,
        publishedAt: null,
      }).where(eq(sessions.id, session.id));
    } else {
      if (!agenda.rooms.some((room) => room.id === placement.roomId)) {
        return context.json({ error: "invalid_room" }, 400);
      }
      await database.update(sessions).set({
        scheduleStatus: "placed",
        scheduledDate: placement.scheduledDate,
        roomId: placement.roomId,
        startsAt: new Date(placement.startsAt),
        endsAt: new Date(placement.startsAt + session.durationMinutes * 60_000),
        publishedAt: null,
      }).where(eq(sessions.id, session.id));
    }
  }
  const updatedAgenda = await readAgenda(context.env.DB, eventId);
  if (updatedAgenda === null) throw new Error(`Agenda disappeared for ${eventId}`);
  return context.json(updatedAgenda);
});

agendaRoutes.patch("/api/events/:eventId/agenda/sessions/:sessionId/content", async (context) => {
  const input = await context.req.json<unknown>().catch(() => null);
  if (
    typeof input !== "object" || input === null ||
    !("contentStatus" in input) || input.contentStatus !== "approved"
  ) {
    return context.json({ error: "invalid_content_status" }, 400);
  }
  const eventId = context.req.param("eventId");
  const agenda = await readAgenda(context.env.DB, eventId);
  if (agenda === null) return context.json({ error: "event_not_found" }, 404);
  const session = agenda.sessions.find((item) => item.id === context.req.param("sessionId"));
  if (session === undefined) return context.json({ error: "session_not_found" }, 404);

  await drizzle(context.env.DB)
    .update(sessions)
    .set({ contentStatus: "approved" })
    .where(eq(sessions.id, session.id));

  const updatedAgenda = await readAgenda(context.env.DB, eventId);
  if (updatedAgenda === null) throw new Error(`Agenda disappeared for ${eventId}`);
  return context.json(updatedAgenda);
});

agendaRoutes.post("/api/events/:eventId/agenda/publish", async (context) => {
  const eventId = context.req.param("eventId");
  const agenda = await readAgenda(context.env.DB, eventId);
  if (agenda === null) return context.json({ error: "event_not_found" }, 404);
  const eligibleIds = agenda.sessions
    .filter((session) =>
      session.contentStatus === "approved" && session.scheduleStatus !== "unplaced"
    )
    .map((session) => session.id);
  const publishedAt = new Date();
  if (eligibleIds.length > 0) {
    await drizzle(context.env.DB)
      .update(sessions)
      .set({ publishedAt })
      .where(inArray(sessions.id, eligibleIds));
  }
  return context.json({
    status: "published",
    publishedCount: eligibleIds.length,
    publishedAt: publishedAt.getTime(),
    message: `${eligibleIds.length} approved agenda ${eligibleIds.length === 1 ? "session" : "sessions"} published.`,
  });
});

export default agendaRoutes;
