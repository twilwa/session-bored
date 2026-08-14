// ABOUTME: Persists each signed-in account's selected public sessions across devices.
// ABOUTME: Filters every saved selection through the same public programme gate attendees browse.
import { and, eq, getTableColumns, inArray } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { Hono } from "hono";
import { personalScheduleSessions } from "../../db/schema.ts";
import { personalScheduleUpdateLimit, type PersonalScheduleResponse } from "../../shared/api.ts";
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

// D1 binds at most 100 parameters per query, so a request that fits the route's own id
// limit still reaches the database as several smaller statements.
const boundParameterLimit = 100;
const insertRowLimit = Math.floor(
  boundParameterLimit / Object.keys(getTableColumns(personalScheduleSessions)).length,
);
const removeIdLimit = boundParameterLimit - 1;

function chunk<Item>(values: Item[], size: number): Item[][] {
  const chunks: Item[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function sessionIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > personalScheduleUpdateLimit) {
    return null;
  }
  const ids = value.filter((item): item is string => typeof item === "string" && item !== "");
  return ids.length === value.length ? [...new Set(ids)] : null;
}

async function readSchedule(
  database: DrizzleD1Database,
  userId: string,
  publicSessions: Awaited<ReturnType<typeof fetchPublicSessions>>,
): Promise<string[]> {
  if (publicSessions.length === 0) {
    return [];
  }
  const selected = await database
    .select({ sessionId: personalScheduleSessions.sessionId })
    .from(personalScheduleSessions)
    .where(eq(personalScheduleSessions.userId, userId));
  const selectedIds = new Set(selected.map((item) => item.sessionId));
  return publicSessions.map((session) => session.id).filter((sessionId) => selectedIds.has(sessionId));
}

personalScheduleRoutes.get("/attendee/events/:eventId/schedule", async (context) => {
  const user = context.get("authUser");
  if (user === null) {
    return context.json({ error: "authentication_required" }, 401);
  }
  const database = drizzle(context.env.DB);
  const publicSessions = await fetchPublicSessions(database, context.req.param("eventId"), publicSessionFilters);
  return context.json(
    { sessionIds: await readSchedule(database, user.id, publicSessions) } satisfies PersonalScheduleResponse,
  );
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
  const publicSessions = await fetchPublicSessions(database, eventId, publicSessionFilters);
  const publicIds = new Set(publicSessions.map((session) => session.id));
  if (add.some((sessionId) => !publicIds.has(sessionId))) {
    return context.json({ error: "invalid_personal_schedule" }, 400);
  }

  for (const batch of chunk(remove, removeIdLimit)) {
    await database.delete(personalScheduleSessions).where(and(
      eq(personalScheduleSessions.userId, user.id),
      inArray(personalScheduleSessions.sessionId, batch),
    ));
  }
  const removed = new Set(remove);
  const additions = add.filter((sessionId) => !removed.has(sessionId));
  for (const batch of chunk(additions, insertRowLimit)) {
    await database
      .insert(personalScheduleSessions)
      .values(batch.map((sessionId) => ({ userId: user.id, sessionId })))
      .onConflictDoNothing();
  }

  return context.json(
    { sessionIds: await readSchedule(database, user.id, publicSessions) } satisfies PersonalScheduleResponse,
  );
});

export default personalScheduleRoutes;
