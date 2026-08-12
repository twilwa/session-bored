// ABOUTME: Serves the organizer's platform-wide view of who has an account and what it opens.
// ABOUTME: Owns granting, revoking, and reviewer invitations, each attributed to the organizer who acted.
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import {
  authAccounts,
  type GrantableRole,
  grantableRoles,
  people,
  reviewerInvites,
  roleGrants,
  sessionSpeakers,
  speakers,
  submissionSpeakers,
  users,
  type Role,
} from "../../db/schema.ts";
import type { PersonAccountEvidence, PersonAccountSummary } from "../../shared/api.ts";
import type { AuthSession } from "../auth.ts";
import { sendRoleGrantEmail } from "../email/role-grant.ts";
import { normalizeInviteEmail } from "../reviewer-invites.ts";
import { grantRole, listLiveGrants, revokeRole } from "../roles.ts";

type PeopleEnvironment = {
  Bindings: CloudflareBindings;
  Variables: {
    authUser: AuthSession["user"] | null;
    role: Role | null;
  };
};

const peopleRoutes = new Hono<PeopleEnvironment>();

const requireOrganizer = createMiddleware<PeopleEnvironment>(async (context, next) => {
  const role = context.get("role");
  if (role === null) {
    return context.json({ error: "authentication_required" }, 401);
  }
  if (role !== "organizer") {
    return context.json({ error: "forbidden" }, 403);
  }
  await next();
});

function isGrantableRole(value: unknown): value is GrantableRole {
  return typeof value === "string" && (grantableRoles as readonly string[]).includes(value);
}

/**
 * What an organizer needs in order to grant without guessing: whether this account is already
 * in the programme, only holds proposals, or has no records at all. It is what makes the
 * conservative backfill safe to correct by hand.
 */
async function evidenceFor(
  database: ReturnType<typeof drizzle>,
  userIds: readonly string[],
): Promise<Map<string, PersonAccountEvidence>> {
  const evidence = new Map<string, PersonAccountEvidence>(
    userIds.map((userId) => [userId, { kind: "none", programmedSessions: 0, proposals: 0 }]),
  );
  if (userIds.length === 0) {
    return evidence;
  }
  const [programmed, proposals] = await Promise.all([
    database
      .select({ userId: people.userId, count: sql<number>`count(*)` })
      .from(sessionSpeakers)
      .innerJoin(speakers, eq(sessionSpeakers.speakerId, speakers.id))
      .innerJoin(people, eq(speakers.personId, people.id))
      .where(and(inArray(people.userId, [...userIds]), isNull(sessionSpeakers.deletedAt)))
      .groupBy(people.userId),
    database
      .select({ userId: people.userId, count: sql<number>`count(*)` })
      .from(submissionSpeakers)
      .innerJoin(people, eq(submissionSpeakers.personId, people.id))
      .where(and(inArray(people.userId, [...userIds]), isNull(submissionSpeakers.deletedAt)))
      .groupBy(people.userId),
  ]);
  for (const row of proposals) {
    if (row.userId === null) continue;
    const current = evidence.get(row.userId);
    if (current === undefined) continue;
    evidence.set(row.userId, { ...current, kind: "proposals", proposals: Number(row.count) });
  }
  for (const row of programmed) {
    if (row.userId === null) continue;
    const current = evidence.get(row.userId);
    if (current === undefined) continue;
    evidence.set(row.userId, {
      ...current,
      kind: "programmed",
      programmedSessions: Number(row.count),
    });
  }
  return evidence;
}

peopleRoutes.get("/api/people", requireOrganizer, async (context) => {
  const database = drizzle(context.env.DB);
  const accounts = await database
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      emailVerified: users.emailVerified,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(asc(users.createdAt));
  const userIds = accounts.map((account) => account.id);
  const [grants, evidence, providers, grantorNames] = await Promise.all([
    listLiveGrants(database, userIds),
    evidenceFor(database, userIds),
    userIds.length === 0
      ? Promise.resolve([])
      : database
        .select({ userId: authAccounts.userId, providerId: authAccounts.providerId })
        .from(authAccounts)
        .where(inArray(authAccounts.userId, userIds)),
    database.select({ id: users.id, name: users.name }).from(users),
  ]);
  const nameById = new Map(grantorNames.map((row) => [row.id, row.name]));
  const items: PersonAccountSummary[] = accounts.map((account) => {
    const held = grants.filter((grant) => grant.userId === account.id);
    return {
      id: account.id,
      name: account.name,
      email: account.email,
      emailVerified: account.emailVerified,
      joinedAt: account.createdAt.toISOString(),
      signInMethods: [
        ...new Set(
          providers
            .filter((provider) => provider.userId === account.id)
            .map((provider) => (provider.providerId === "credential" ? "password" : provider.providerId)),
        ),
      ].sort(),
      evidence: evidence.get(account.id) ?? { kind: "none", programmedSessions: 0, proposals: 0 },
      grants: held.map((grant) => ({
        role: grant.role,
        source: grant.source,
        note: grant.note,
        grantedAt: grant.grantedAt.toISOString(),
        grantedByName: grant.grantedByUserId === null ? null : nameById.get(grant.grantedByUserId) ?? null,
      })),
    };
  });
  const openInvites = await database
    .select({
      id: reviewerInvites.id,
      email: reviewerInvites.email,
      eventId: reviewerInvites.eventId,
      createdAt: reviewerInvites.createdAt,
    })
    .from(reviewerInvites)
    .where(and(isNull(reviewerInvites.redeemedAt), isNull(reviewerInvites.revokedAt)))
    .orderBy(asc(reviewerInvites.createdAt));
  return context.json({
    items,
    invites: openInvites.map((invite) => ({
      id: invite.id,
      email: invite.email,
      eventId: invite.eventId,
      createdAt: invite.createdAt.toISOString(),
    })),
  });
});

peopleRoutes.post("/api/people/:userId/grants", requireOrganizer, async (context) => {
  const payload = await context.req.json<{ role?: unknown; note?: unknown; notify?: unknown }>();
  if (!isGrantableRole(payload.role)) {
    return context.json({ error: "invalid_role" }, 400);
  }
  const organizer = context.get("authUser");
  if (organizer === null) {
    return context.json({ error: "authentication_required" }, 401);
  }
  const database = drizzle(context.env.DB);
  const userId = context.req.param("userId");
  const [account] = await database
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, userId));
  if (account === undefined) {
    return context.json({ error: "not_found" }, 404);
  }
  const { granted } = await grantRole(database, {
    userId,
    role: payload.role,
    source: "organizer",
    grantedByUserId: organizer.id,
    note: typeof payload.note === "string" && payload.note.trim().length > 0 ? payload.note.trim() : null,
  });
  // Silent unless the organizer asked otherwise, matching how a status change never announces
  // itself and delivery is always a deliberate act.
  const notified = payload.notify === true && granted
    ? (await sendRoleGrantEmail(context.env, { recipient: account, role: payload.role })).status === "sent"
    : false;
  return context.json({ granted, role: payload.role, notified });
});

peopleRoutes.delete("/api/people/:userId/grants/:role", requireOrganizer, async (context) => {
  const role = context.req.param("role");
  if (!isGrantableRole(role)) {
    return context.json({ error: "invalid_role" }, 400);
  }
  const organizer = context.get("authUser");
  if (organizer === null) {
    return context.json({ error: "authentication_required" }, 401);
  }
  const database = drizzle(context.env.DB);
  const { revoked } = await revokeRole(database, {
    userId: context.req.param("userId"),
    role,
    revokedByUserId: organizer.id,
  });
  return revoked ? context.json({ revoked, role }) : context.json({ error: "not_found" }, 404);
});

peopleRoutes.post("/api/events/:eventId/reviewer-invites", requireOrganizer, async (context) => {
  const payload = await context.req.json<{ email?: unknown; trackIds?: unknown; roundIds?: unknown }>();
  if (typeof payload.email !== "string" || !payload.email.includes("@")) {
    return context.json({ error: "invalid_email" }, 400);
  }
  const organizer = context.get("authUser");
  if (organizer === null) {
    return context.json({ error: "authentication_required" }, 401);
  }
  const database = drizzle(context.env.DB);
  const email = normalizeInviteEmail(payload.email);
  const eventId = context.req.param("eventId");
  const [existing] = await database
    .select({ id: reviewerInvites.id })
    .from(reviewerInvites)
    .where(
      and(
        eq(reviewerInvites.email, email),
        eq(reviewerInvites.eventId, eventId),
        isNull(reviewerInvites.redeemedAt),
        isNull(reviewerInvites.revokedAt),
      ),
    );
  if (existing !== undefined) {
    return context.json({ error: "invite_already_open", inviteId: existing.id }, 409);
  }
  const [invite] = await database
    .insert(reviewerInvites)
    .values({
      email,
      eventId,
      trackIds: Array.isArray(payload.trackIds)
        ? payload.trackIds.filter((id): id is string => typeof id === "string")
        : [],
      roundIds: Array.isArray(payload.roundIds)
        ? payload.roundIds.filter((id): id is string => typeof id === "string")
        : [],
      invitedByUserId: organizer.id,
    })
    .returning({ id: reviewerInvites.id });
  return context.json(
    {
      invite: { id: invite!.id, email, eventId },
      // Said plainly so an organizer is never left believing an invitation is already access.
      note: "The invitation becomes reviewer access only when this address is confirmed.",
    },
    201,
  );
});

peopleRoutes.delete("/api/reviewer-invites/:inviteId", requireOrganizer, async (context) => {
  const organizer = context.get("authUser");
  if (organizer === null) {
    return context.json({ error: "authentication_required" }, 401);
  }
  const revoked = await drizzle(context.env.DB)
    .update(reviewerInvites)
    .set({ revokedAt: new Date(), revokedByUserId: organizer.id })
    .where(and(eq(reviewerInvites.id, context.req.param("inviteId")), isNull(reviewerInvites.revokedAt)))
    .returning({ id: reviewerInvites.id });
  return revoked.length > 0 ? context.json({ revoked: true }) : context.json({ error: "not_found" }, 404);
});

export default peopleRoutes;
