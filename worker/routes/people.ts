// ABOUTME: Serves the organizer's platform-wide view of who has an account and what it opens.
// ABOUTME: Owns granting, revoking, and reviewer invitations, each attributed to the organizer who acted.
import { and, asc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import {
  authAccounts,
  emailDispatches,
  type GrantableRole,
  grantableRoles,
  people,
  reviewerInvites,
  reviewRounds,
  roleGrants,
  sessions,
  sessionSpeakers,
  speakers,
  submissions,
  submissionSpeakers,
  tracks,
  users,
  type Role,
} from "../../db/schema.ts";
import { holdsAccess } from "../access.ts";
import type { PersonAccountEvidence, PersonAccountSummary } from "../../shared/api.ts";
import type { AuthSession } from "../auth.ts";
import type { EmailDeliveryResult } from "../email.ts";
import {
  reviewerInvitationTemplateKey,
  sendReviewerInvitationEmail,
} from "../email/reviewer-invitation.ts";
import { sendRoleGrantEmail } from "../email/role-grant.ts";
import { applyReviewerRemit, normalizeInviteEmail } from "../reviewer-invites.ts";
import { grantRole, hasLiveGrant, listLiveGrants, revokeRole } from "../roles.ts";

type PeopleEnvironment = {
  Bindings: CloudflareBindings;
  Variables: {
    authUser: AuthSession["user"] | null;
    roles: Role[] | null;
  };
};

const peopleRoutes = new Hono<PeopleEnvironment>();

type OpenReviewerInvite = {
  id: string;
  email: string;
  eventId: string;
  createdAt: Date;
};

type ReviewerInvitationDispatch = {
  eventId: string;
  recipients: Array<{ email: string }>;
  status: "draft" | "queued" | "sent" | "failed";
  createdAt: Date;
};

type ReviewerInvitationDelivery = "sent" | "failed" | "not_attempted";

function reviewerInvitationDeliveryFor(
  invite: OpenReviewerInvite,
  dispatches: readonly ReviewerInvitationDispatch[],
): ReviewerInvitationDelivery {
  const attempts = dispatches.filter((dispatch) =>
    dispatch.eventId === invite.eventId &&
    dispatch.createdAt >= invite.createdAt &&
    dispatch.recipients.some((recipient) => recipient.email === invite.email)
  );
  if (attempts.some((dispatch) => dispatch.status === "sent")) {
    return "sent";
  }
  if (attempts.some((dispatch) => dispatch.status === "failed")) {
    return "failed";
  }
  return "not_attempted";
}

/**
 * An invitation is only ever answered by an attempt made after it was created, so the read is
 * bounded by the oldest invitation it has to speak for. Attempt rows accumulate for the life of
 * an event; the open invitations they describe do not.
 */
async function readReviewerInvitationDispatches(
  database: ReturnType<typeof drizzle>,
  eventIds: readonly string[],
  since: Date,
): Promise<ReviewerInvitationDispatch[]> {
  if (eventIds.length === 0) {
    return [];
  }
  return database
    .select({
      eventId: emailDispatches.eventId,
      recipients: emailDispatches.recipients,
      status: emailDispatches.status,
      createdAt: emailDispatches.createdAt,
    })
    .from(emailDispatches)
    .where(and(
      inArray(emailDispatches.eventId, [...eventIds]),
      eq(emailDispatches.templateKey, reviewerInvitationTemplateKey),
      gte(emailDispatches.createdAt, since),
      isNull(emailDispatches.deletedAt),
    ));
}

/** The one wire vocabulary both invitation doors report delivery in. */
function invitationDeliveryResponse(
  result: EmailDeliveryResult,
): { emailDelivery: "sent" | "failed" | "not_configured"; failureReason?: string } {
  if (result.status === "provider_not_configured") {
    return { emailDelivery: "not_configured" };
  }
  if (result.status === "failed") {
    return { emailDelivery: "failed", failureReason: result.error ?? "send_failed" };
  }
  return { emailDelivery: "sent" };
}

/**
 * An invitation is redeemed only by confirming the address, so an address whose account has
 * already confirmed has no redemption left to make. The organizer is told that rather than
 * being handed an invitation that can never become access.
 */
async function confirmedAccountFor(
  database: ReturnType<typeof drizzle>,
  email: string,
): Promise<{ id: string; name: string } | undefined> {
  const [account] = await database
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(sql`lower(${users.email}) = ${email}`, eq(users.emailVerified, true)));
  return account;
}

/**
 * Names the door that is actually open. A reviewer onboarded by an earlier invitation is a
 * confirmed account that already holds the grant, and People offers no second grant for it, so
 * for them the only step left is this event's remit, which Committee setup owns. An account
 * without the grant goes through People's own grant, which asks for that remit in the same step.
 */
function confirmedAddressRefusalNote(accountName: string, holdsReviewer: boolean): string {
  if (holdsReviewer) {
    return `${accountName} already has reviewer access and has confirmed this address, so there is `
      + "no invitation left to redeem. Give them this event's tracks and a review round on "
      + "Committee setup to put its proposals in their queue.";
  }
  return `${accountName} has already confirmed this address, so an invitation has nothing left to `
    + "redeem. Grant reviewer access on their account, choosing this event's tracks and a review "
    + "round in the same step, and its proposals are in their queue when they sign in.";
}

const requireOrganizer = createMiddleware<PeopleEnvironment>(async (context, next) => {
  const roles = context.get("roles");
  if (roles === null) {
    return context.json({ error: "authentication_required" }, 401);
  }
  if (!holdsAccess(roles, "organizer")) {
    return context.json({ error: "forbidden" }, 403);
  }
  await next();
});

function isGrantableRole(value: unknown): value is GrantableRole {
  return typeof value === "string" && (grantableRoles as readonly string[]).includes(value);
}

interface ReviewerRemitInput {
  eventId: string;
  trackIds: string[];
  roundIds: string[];
}

function readReviewerRemit(value: unknown): ReviewerRemitInput | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const remit = value as Record<string, unknown>;
  if (
    typeof remit.eventId !== "string" ||
    remit.eventId.length === 0 ||
    !Array.isArray(remit.trackIds) ||
    remit.trackIds.length === 0 ||
    !remit.trackIds.every((id) => typeof id === "string") ||
    !Array.isArray(remit.roundIds) ||
    remit.roundIds.length === 0 ||
    !remit.roundIds.every((id) => typeof id === "string")
  ) {
    return null;
  }
  return {
    eventId: remit.eventId,
    trackIds: [...new Set(remit.trackIds)],
    roundIds: [...new Set(remit.roundIds)],
  };
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
    // Un-accepting keeps the session and its speaker links on purpose, so a live
    // `session_speaker` row is not by itself evidence of being in the programme. A
    // submission-backed session counts only while its submission is still accepted; a session
    // an organizer entered directly answers to no submission and always counts.
    database
      .select({ userId: people.userId, count: sql<number>`count(*)` })
      .from(sessionSpeakers)
      .innerJoin(sessions, eq(sessionSpeakers.sessionId, sessions.id))
      .leftJoin(submissions, eq(sessions.submissionId, submissions.id))
      .innerJoin(speakers, eq(sessionSpeakers.speakerId, speakers.id))
      .innerJoin(people, eq(speakers.personId, people.id))
      .where(and(
        inArray(people.userId, [...userIds]),
        isNull(sessionSpeakers.deletedAt),
        isNull(sessions.deletedAt),
        or(isNull(sessions.submissionId), eq(submissions.status, "accepted")),
      ))
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
  const inviteEventIds = [...new Set(openInvites.map((invite) => invite.eventId))];
  const oldestOpenInvite = openInvites[0];
  const invitationDispatches = oldestOpenInvite === undefined
    ? []
    : await readReviewerInvitationDispatches(database, inviteEventIds, oldestOpenInvite.createdAt);
  return context.json({
    items,
    invites: openInvites.map((invite) => {
      const emailDelivery = reviewerInvitationDeliveryFor(invite, invitationDispatches);
      return {
        id: invite.id,
        email: invite.email,
        eventId: invite.eventId,
        createdAt: invite.createdAt.toISOString(),
        emailDelivery,
        canResend: emailDelivery !== "sent",
      };
    }),
  });
});

peopleRoutes.post("/api/people/:userId/grants", requireOrganizer, async (context) => {
  const payload = await context.req.json<{
    role?: unknown;
    note?: unknown;
    notify?: unknown;
    reviewerRemit?: unknown;
  }>();
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
  const reviewerRemit = payload.role === "reviewer" ? readReviewerRemit(payload.reviewerRemit) : null;
  if (payload.role === "reviewer" && reviewerRemit === null) {
    return context.json({ error: "reviewer_remit_required" }, 400);
  }
  if (reviewerRemit !== null) {
    const [availableTracks, availableRounds] = await Promise.all([
      database
        .select({ id: tracks.id })
        .from(tracks)
        .where(eq(tracks.eventId, reviewerRemit.eventId)),
      database
        .select({ id: reviewRounds.id })
        .from(reviewRounds)
        .where(and(eq(reviewRounds.eventId, reviewerRemit.eventId), eq(reviewRounds.status, "open"))),
    ]);
    const availableTrackIds = new Set(availableTracks.map((track) => track.id));
    if (reviewerRemit.trackIds.some((trackId) => !availableTrackIds.has(trackId))) {
      return context.json({ error: "invalid_reviewer_tracks" }, 400);
    }
    const availableRoundIds = new Set(availableRounds.map((round) => round.id));
    if (reviewerRemit.roundIds.some((roundId) => !availableRoundIds.has(roundId))) {
      return context.json({ error: "invalid_reviewer_rounds" }, 400);
    }
  }
  if (reviewerRemit !== null) {
    await applyReviewerRemit(database, {
      ...reviewerRemit,
      reviewerUserId: userId,
    });
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
  const confirmedAccount = await confirmedAccountFor(database, email);
  if (confirmedAccount !== undefined) {
    const holdsReviewer = await hasLiveGrant(database, confirmedAccount.id, "reviewer");
    return context.json(
      {
        error: "account_already_confirmed",
        userId: confirmedAccount.id,
        holdsReviewer,
        note: confirmedAddressRefusalNote(confirmedAccount.name, holdsReviewer),
      },
      409,
    );
  }
  const [existing] = await database
    .select({ id: reviewerInvites.id, createdAt: reviewerInvites.createdAt })
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
    const openInvite = { id: existing.id, email, eventId, createdAt: existing.createdAt };
    const alreadySent = reviewerInvitationDeliveryFor(
      openInvite,
      await readReviewerInvitationDispatches(database, [eventId], existing.createdAt),
    ) === "sent";
    return context.json(
      {
        error: "invite_already_open",
        inviteId: existing.id,
        note: alreadySent
          ? `${email} already has an open invitation and it reached them. They become a reviewer once they confirm that address.`
          : `${email} already has an open invitation, so nothing new was recorded. `
            + "Use Resend invitation on its row below if the first one never arrived.",
      },
      409,
    );
  }
  // An invitation that names no remit carries the same default a directly provisioned
  // reviewer gets - every event track and the first open round - so redemption opens a queue
  // with work in it. Only an explicitly empty `trackIds` means no tracks.
  const [eventTracks, openRounds] = await Promise.all([
    database.select({ id: tracks.id }).from(tracks).where(eq(tracks.eventId, eventId)).orderBy(asc(tracks.sortOrder)),
    database
      .select({ id: reviewRounds.id })
      .from(reviewRounds)
      .where(and(eq(reviewRounds.eventId, eventId), eq(reviewRounds.status, "open")))
      .orderBy(asc(reviewRounds.sortOrder)),
  ]);
  const defaultRound = openRounds[0];
  if (defaultRound === undefined) {
    return context.json({ error: "open_round_required" }, 409);
  }
  const requestedRoundIds = Array.isArray(payload.roundIds)
    ? payload.roundIds.filter((id): id is string => typeof id === "string")
    : [];
  const [invite] = await database
    .insert(reviewerInvites)
    .values({
      email,
      eventId,
      trackIds: Array.isArray(payload.trackIds)
        ? payload.trackIds.filter((id): id is string => typeof id === "string")
        : eventTracks.map((track) => track.id),
      roundIds: requestedRoundIds.length === 0 ? [defaultRound.id] : requestedRoundIds,
      invitedByUserId: organizer.id,
    })
    .returning({ id: reviewerInvites.id });
  const delivery = await sendReviewerInvitationEmail({
    database,
    env: context.env,
    eventId: eventId as `evt_${string}`,
    recipientEmail: email,
    createdByUserId: organizer.id,
  });
  if (delivery.status === "event_not_found") {
    return context.json({ error: "event_not_found" }, 404);
  }
  return context.json(
    {
      invite: { id: invite!.id, email, eventId },
      ...invitationDeliveryResponse(delivery),
      // Said plainly so an organizer is never left believing an invitation is already access.
      note: "The invitation becomes reviewer access only when this address is confirmed.",
    },
    201,
  );
});

peopleRoutes.post("/api/events/:eventId/reviewer-invites/:inviteId/resend", requireOrganizer, async (context) => {
  const organizer = context.get("authUser");
  if (organizer === null) {
    return context.json({ error: "authentication_required" }, 401);
  }
  const database = drizzle(context.env.DB);
  const eventId = context.req.param("eventId");
  const [invite] = await database
    .select({
      id: reviewerInvites.id,
      email: reviewerInvites.email,
      eventId: reviewerInvites.eventId,
      createdAt: reviewerInvites.createdAt,
    })
    .from(reviewerInvites)
    .where(and(
      eq(reviewerInvites.id, context.req.param("inviteId")),
      eq(reviewerInvites.eventId, eventId),
      isNull(reviewerInvites.redeemedAt),
      isNull(reviewerInvites.revokedAt),
    ));
  if (invite === undefined) {
    return context.json({ error: "invite_not_found" }, 404);
  }
  const dispatches = await readReviewerInvitationDispatches(database, [eventId], invite.createdAt);
  if (reviewerInvitationDeliveryFor(invite, dispatches) === "sent") {
    return context.json({ error: "invitation_already_sent" }, 409);
  }
  const delivery = await sendReviewerInvitationEmail({
    database,
    env: context.env,
    eventId: eventId as `evt_${string}`,
    recipientEmail: invite.email,
    createdByUserId: organizer.id,
  });
  if (delivery.status === "event_not_found") {
    return context.json({ error: "event_not_found" }, 404);
  }
  return context.json({
    invite: { id: invite.id, email: invite.email, eventId },
    ...invitationDeliveryResponse(delivery),
  });
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
