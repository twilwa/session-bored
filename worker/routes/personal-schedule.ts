// ABOUTME: Persists each signed-in account's selected public sessions across devices.
// ABOUTME: Filters every saved selection through the same public programme gate attendees browse.
import { and, desc, eq, getTableColumns, inArray } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { Hono } from "hono";
import { personalScheduleSessions, sessions } from "../../db/schema.ts";
import { personalScheduleUpdateLimit, type PersonalScheduleResponse } from "../../shared/api.ts";
import type { AuthSession } from "../auth.ts";
import { boundParameterBudget, chunkIds } from "../d1-limits.ts";
import { filterPublicSessionIds } from "../public-queries.ts";

type PersonalScheduleEnvironment = {
  Bindings: CloudflareBindings;
  Variables: {
    authUser: AuthSession["user"] | null;
  };
};

const personalScheduleRoutes = new Hono<PersonalScheduleEnvironment>();

// A request that fits the route's own id limit still reaches the database as several
// smaller statements, each within D1's bound-parameter budget.
const insertRowLimit = Math.floor(
  boundParameterBudget / Object.keys(getTableColumns(personalScheduleSessions)).length,
);

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
  eventId: string,
): Promise<string[]> {
  const selected = await database
    .select({ sessionId: personalScheduleSessions.sessionId })
    .from(personalScheduleSessions)
    .innerJoin(sessions, eq(personalScheduleSessions.sessionId, sessions.id))
    .where(and(eq(personalScheduleSessions.userId, userId), eq(sessions.eventId, eventId)))
    .orderBy(desc(sessions.scheduledDate), desc(sessions.startsAt), sessions.id);
  return filterPublicSessionIds(database, eventId, selected.map((item) => item.sessionId));
}

personalScheduleRoutes.get("/attendee/events/:eventId/schedule", async (context) => {
  const user = context.get("authUser");
  if (user === null) {
    return context.json({ error: "authentication_required" }, 401);
  }
  const database = drizzle(context.env.DB);
  const eventId = context.req.param("eventId");
  return context.json(
    { sessionIds: await readSchedule(database, user.id, eventId) } satisfies PersonalScheduleResponse,
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
  if ((await filterPublicSessionIds(database, eventId, add)).length !== add.length) {
    return context.json({ error: "invalid_personal_schedule" }, 400);
  }

  for (const batch of chunkIds(remove)) {
    await database.delete(personalScheduleSessions).where(and(
      eq(personalScheduleSessions.userId, user.id),
      inArray(personalScheduleSessions.sessionId, batch),
      inArray(
        personalScheduleSessions.sessionId,
        database.select({ id: sessions.id }).from(sessions).where(eq(sessions.eventId, eventId)),
      ),
    ));
  }
  const removed = new Set(remove);
  const additions = add.filter((sessionId) => !removed.has(sessionId));
  for (const batch of chunkIds(additions, insertRowLimit)) {
    await database
      .insert(personalScheduleSessions)
      .values(batch.map((sessionId) => ({ userId: user.id, sessionId })))
      .onConflictDoNothing();
  }

  return context.json(
    { sessionIds: await readSchedule(database, user.id, eventId) } satisfies PersonalScheduleResponse,
  );
});

export default personalScheduleRoutes;
