// ABOUTME: Persists each signed-in account's selected public sessions across devices.
// ABOUTME: Filters every saved selection through the same public programme gate attendees browse.
import { and, eq, inArray } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { Hono } from "hono";
import { personalScheduleSessions } from "../../db/schema.ts";
import type { AuthSession } from "../auth.ts";
import { fetchPublicSessions } from "../public-queries.ts";

type PersonalScheduleEnvironment = {
  Bindings: CloudflareBindings;
  Variables: {
    authUser: AuthSession["user"] | null;
  };
};

const personalScheduleRoutes = new Hono<PersonalScheduleEnvironment>();

const publicSessionFilters = {
  q: undefined,
  track: undefined,
  format: undefined,
  room: undefined,
  day: undefined,
};

function sessionIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 100) {
    return null;
  }
  const ids = value.filter((item): item is string => typeof item === "string" && item !== "");
  return ids.length === value.length ? [...new Set(ids)] : null;
}

async function readSchedule(
  database: DrizzleD1Database,
  userId: string,
  eventId: string,
): Promise<string[]> {
  const publicSessions = await fetchPublicSessions(database, eventId, publicSessionFilters);
  if (publicSessions.length === 0) {
    return [];
  }
  const selected = await database
    .select({ sessionId: personalScheduleSessions.sessionId })
    .from(personalScheduleSessions)
    .where(and(
      eq(personalScheduleSessions.userId, userId),
      inArray(personalScheduleSessions.sessionId, publicSessions.map((session) => session.id)),
    ));
  const selectedIds = new Set(selected.map((item) => item.sessionId));
  return publicSessions.map((session) => session.id).filter((sessionId) => selectedIds.has(sessionId));
}

personalScheduleRoutes.get("/attendee/events/:eventId/schedule", async (context) => {
  const user = context.get("authUser");
  if (user === null) {
    return context.json({ error: "authentication_required" }, 401);
  }
  const sessionIds = await readSchedule(drizzle(context.env.DB), user.id, context.req.param("eventId"));
  return context.json({ sessionIds });
});

personalScheduleRoutes.patch("/attendee/events/:eventId/schedule", async (context) => {
  const user = context.get("authUser");
  if (user === null) {
    return context.json({ error: "authentication_required" }, 401);
  }

  const body = await context.req.json<unknown>().catch(() => null);
  if (typeof body !== "object" || body === null) {
    return context.json({ error: "invalid_personal_schedule" }, 400);
  }
  const candidate = body as Record<string, unknown>;
  const add = sessionIds(candidate.add);
  const remove = sessionIds(candidate.remove);
  if (add === null || remove === null) {
    return context.json({ error: "invalid_personal_schedule" }, 400);
  }

  const database = drizzle(context.env.DB);
  const eventId = context.req.param("eventId");
  const publicIds = new Set(
    (await fetchPublicSessions(database, eventId, publicSessionFilters)).map((session) => session.id),
  );
  if (add.some((sessionId) => !publicIds.has(sessionId))) {
    return context.json({ error: "invalid_personal_schedule" }, 400);
  }

  if (remove.length > 0) {
    await database.delete(personalScheduleSessions).where(and(
      eq(personalScheduleSessions.userId, user.id),
      inArray(personalScheduleSessions.sessionId, remove),
    ));
  }
  const removed = new Set(remove);
  const additions = add.filter((sessionId) => !removed.has(sessionId));
  if (additions.length > 0) {
    await database
      .insert(personalScheduleSessions)
      .values(additions.map((sessionId) => ({ userId: user.id, sessionId })))
      .onConflictDoNothing();
  }

  return context.json({ sessionIds: await readSchedule(database, user.id, eventId) });
});

export default personalScheduleRoutes;
