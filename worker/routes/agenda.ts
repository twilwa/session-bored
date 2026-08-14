// ABOUTME: Reads, approves, places, and publishes accepted sessions on an event agenda.
// ABOUTME: Recomputes speaker and room conflicts after every non-blocking scheduling change.
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
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
import { holdsAccess } from "../access.ts";
import { isPubliclyLiveSession } from "../public-queries.ts";
import type {
  AgendaConflict,
  AgendaPlacement,
  AgendaPublishResult,
  AgendaPublishSkip,
  AgendaPublishSkipReason,
  AgendaSession,
  AgendaState,
} from "../../shared/api.ts";

type AgendaEnvironment = {
  Bindings: CloudflareBindings;
  Variables: {
    authUser: { id: string } | null;
    roles: Role[] | null;
  };
};

const agendaRoutes = new Hono<AgendaEnvironment>();

const requireOrganizer = createMiddleware<AgendaEnvironment>(async (context, next) => {
  if (!holdsAccess(context.get("roles") ?? [], "organizer")) {
    const status = context.get("roles") === null ? 401 : 403;
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
        approvedContent: sessions.approvedContent,
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
        publishedAt: sessionSpeakers.publishedAt,
      })
      .from(sessionSpeakers)
      .innerJoin(speakers, eq(sessionSpeakers.speakerId, speakers.id))
      .innerJoin(people, eq(speakers.personId, people.id))
      // This one list is both the card's lineup and the input to the speaker-overlap rule, so a
      // removed participant left in it does not just misread - it invents a clash and offers to
      // unplace a correctly-placed session to resolve it.
      .where(and(
        inArray(sessionSpeakers.sessionId, sessionRows.map((session) => session.id)),
        isNull(sessionSpeakers.deletedAt),
        isNull(speakers.deletedAt),
      ))
      .orderBy(asc(sessionSpeakers.sortOrder), asc(people.name));
  const speakersBySession = new Map<string, Array<{ id: string; name: string }>>();
  const pendingSpeakersBySession = new Map<string, number>();
  for (const speaker of speakerRows) {
    const sessionParticipants = speakersBySession.get(speaker.sessionId) ?? [];
    sessionParticipants.push({ id: speaker.speakerId, name: speaker.name });
    speakersBySession.set(speaker.sessionId, sessionParticipants);
    if (speaker.publishedAt === null) {
      pendingSpeakersBySession.set(speaker.sessionId, (pendingSpeakersBySession.get(speaker.sessionId) ?? 0) + 1);
    }
  }

  const agendaSessions: AgendaSession[] = sessionRows.map((session) => ({
    id: session.id as `ses_${string}`,
    title: session.title ?? "Untitled session",
    abstract: session.abstract,
    approvedContent: session.approvedContent,
    editedSinceApproval: session.approvedContent !== null && (
      session.title !== session.approvedContent.title ||
      session.abstract !== session.approvedContent.abstract
    ),
    contentStatus: session.contentStatus,
    scheduleStatus: session.scheduleStatus,
    scheduledDate: session.scheduledDate,
    startsAt: session.startsAt?.getTime() ?? null,
    endsAt: session.endsAt?.getTime() ?? null,
    publishedAt: session.publishedAt?.getTime() ?? null,
    pendingSpeakerCount: isPubliclyLiveSession(session) ? (pendingSpeakersBySession.get(session.id) ?? 0) : 0,
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
  if (typeof input !== "object" || input === null) {
    return context.json({ error: "invalid_session_content" }, 400);
  }
  const eventId = context.req.param("eventId");
  const agenda = await readAgenda(context.env.DB, eventId);
  if (agenda === null) return context.json({ error: "event_not_found" }, 404);
  const session = agenda.sessions.find((item) => item.id === context.req.param("sessionId"));
  if (session === undefined) return context.json({ error: "session_not_found" }, 404);

  const database = drizzle(context.env.DB);
  if ("contentStatus" in input) {
    if (
      input.contentStatus !== "approved" ||
      "title" in input ||
      "abstract" in input
    ) {
      return context.json({ error: "invalid_content_status" }, 400);
    }
    if (session.contentStatus !== "approved") {
      const [currentContent] = await database
        .select({ title: sessions.title, abstract: sessions.abstract })
        .from(sessions)
        .where(eq(sessions.id, session.id));
      if (currentContent === undefined) return context.json({ error: "session_not_found" }, 404);
      await database
        .update(sessions)
        .set({
          contentStatus: "approved",
          approvedContent: currentContent,
        })
        .where(eq(sessions.id, session.id));
    }
  } else {
    const update: { title?: string; abstract?: string } = {};
    if ("title" in input) {
      if (typeof input.title !== "string" || input.title.trim().length === 0) {
        return context.json({ error: "invalid_session_content" }, 400);
      }
      update.title = input.title.trim();
    }
    if ("abstract" in input) {
      if (typeof input.abstract !== "string" || input.abstract.trim().length === 0) {
        return context.json({ error: "invalid_session_content" }, 400);
      }
      update.abstract = input.abstract.trim();
    }
    if (Object.keys(update).length === 0) {
      return context.json({ error: "invalid_session_content" }, 400);
    }
    await database.update(sessions).set(update).where(eq(sessions.id, session.id));
  }

  const updatedAgenda = await readAgenda(context.env.DB, eventId);
  if (updatedAgenda === null) throw new Error(`Agenda disappeared for ${eventId}`);
  return context.json(updatedAgenda);
});

function publishSkipReasons(session: AgendaSession): AgendaPublishSkipReason[] {
  const reasons: AgendaPublishSkipReason[] = [];
  if (session.contentStatus !== "approved") reasons.push("content_not_approved");
  if (session.scheduleStatus === "unplaced") reasons.push("not_placed");
  return reasons;
}

function skipNote(skip: AgendaPublishSkip): string {
  const reasons = skip.reasons.map((reason) =>
    reason === "content_not_approved"
      ? "its content is not approved yet"
      : "it is not on the schedule yet"
  );
  return `Skipped “${skip.title}” — ${reasons.join(" and ")}.`;
}

function countLabel(count: number): string {
  return `${count} ${count === 1 ? "session" : "sessions"}`;
}

function publishMessage(
  newlyPublished: number,
  alreadyPublic: number,
  skipped: number,
): string {
  if (newlyPublished === 0 && alreadyPublic === 0) {
    return skipped === 0
      ? "Nothing to publish — the agenda has no sessions."
      : `Nothing published — ${countLabel(skipped)} skipped.`;
  }
  const parts: string[] = [];
  if (newlyPublished > 0) parts.push(`${countLabel(newlyPublished)} published`);
  if (alreadyPublic > 0) parts.push(`${countLabel(alreadyPublic)} already public`);
  if (skipped > 0) parts.push(`${countLabel(skipped)} skipped`);
  return `${parts.join(" · ")}.`;
}

agendaRoutes.post("/api/events/:eventId/agenda/publish", async (context) => {
  const eventId = context.req.param("eventId");
  const agenda = await readAgenda(context.env.DB, eventId);
  if (agenda === null) return context.json({ error: "event_not_found" }, 404);
  const eligible = agenda.sessions.filter((session) =>
    session.contentStatus === "approved" && session.scheduleStatus !== "unplaced"
  );
  const skipped: AgendaPublishSkip[] = agenda.sessions
    .filter((session) => !eligible.includes(session))
    .map((session) => ({
      id: session.id,
      title: session.title,
      reasons: publishSkipReasons(session),
    }));
  const newlyPublishedCount = eligible.filter((session) =>
    session.publishedAt === null || session.pendingSpeakerCount > 0
  ).length;
  const alreadyPublicCount = eligible.length - newlyPublishedCount;
  const publishedAt = new Date();
  if (eligible.length > 0) {
    const database = drizzle(context.env.DB);
    await database
      .update(sessions)
      .set({ publishedAt })
      .where(inArray(sessions.id, eligible.map((session) => session.id)));
    // Only the links still waiting are stamped, so the column keeps recording when a
    // participant first became public, and what it returns is exactly who this publish reveals.
    // An archived speaker is not one of them: the agenda never counted their link as pending,
    // so stamping it here would hand them the public lineup the day somebody restores them.
    const revealedLinks = await database
      .update(sessionSpeakers)
      .set({ publishedAt })
      .where(and(
        inArray(sessionSpeakers.sessionId, eligible.map((session) => session.id)),
        isNull(sessionSpeakers.deletedAt),
        isNull(sessionSpeakers.publishedAt),
        sql`EXISTS (
          SELECT 1 FROM ${speakers}
          WHERE ${speakers.id} = ${sessionSpeakers.speakerId}
            AND ${speakers.deletedAt} IS NULL
        )`,
      ))
      .returning({ speakerId: sessionSpeakers.speakerId, sessionId: sessionSpeakers.sessionId });
    // Only the speakers this publish takes off a hold. The hold is placed on a session that was
    // already public, so a first publish reveals nobody who was waiting on one, and `invited`
    // there is a workflow status the organizer set by hand - not this route's to overrule.
    const republishedSessionIds = new Set<string>(
      eligible.filter((session) => session.publishedAt !== null).map((session) => session.id),
    );
    const releasedFromHold = revealedLinks.filter((link) => republishedSessionIds.has(link.sessionId));
    if (releasedFromHold.length > 0) {
      await database
        .update(speakers)
        .set({ status: "onboarding" })
        .where(and(
          inArray(speakers.id, releasedFromHold.map((link) => link.speakerId)),
          eq(speakers.status, "invited"),
        ));
    }
  }
  const result: AgendaPublishResult = {
    status: "published",
    publishedAt: publishedAt.getTime(),
    publishedCount: eligible.length,
    newlyPublishedCount,
    alreadyPublicCount,
    published: eligible.map((session) => ({ id: session.id, title: session.title })),
    skipped,
    message: publishMessage(newlyPublishedCount, alreadyPublicCount, skipped.length),
    notes: skipped.map(skipNote),
  };
  return context.json(result);
});

export default agendaRoutes;
