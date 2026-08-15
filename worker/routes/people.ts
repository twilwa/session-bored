// ABOUTME: Serves the organizer's platform-wide view of who has an account and what it opens.
// ABOUTME: Owns granting, revoking, and reviewer invitations, each attributed to the organizer who acted.
import { and, asc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import {
  authAccounts,
  emailDispatches,
  events,
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
  type InvitedAccountStatus,
} from "../email/reviewer-invitation.ts";
import { sendRoleGrantEmail } from "../email/role-grant.ts";
import {
  applyReviewerRemit,
  normalizeInviteEmail,
  redeemInviteForAccount,
  redeemReviewerInvites,
} from "../reviewer-invites.ts";
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

/** The one single-invite reading of the resend rule, shared by every door that asks it. */
async function deliveryForInvite(
  database: ReturnType<typeof drizzle>,
  invite: OpenReviewerInvite,
): Promise<ReviewerInvitationDelivery> {
  return reviewerInvitationDeliveryFor(
    invite,
    await readReviewerInvitationDispatches(database, [invite.eventId], invite.createdAt),
  );
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

interface InvitedAccount {
  userId: string;
  name: string;
  emailVerified: boolean;
}

/**
 * The account an invited address already belongs to, if any. Better Auth stores addresses
 * lower-case and invitations normalize them, but the comparison stays case-insensitive so a
 * legacy mixed-case account is still found rather than silently re-invited as new.
 */
async function invitedAccountFor(
  database: ReturnType<typeof drizzle>,
  email: string,
): Promise<InvitedAccount | null> {
  const [account] = await database
    .select({ userId: users.id, name: users.name, emailVerified: users.emailVerified })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`);
  return account ?? null;
}

function accountStatusFor(account: { emailVerified: boolean } | null): InvitedAccountStatus {
  if (account === null) {
    return "none";
  }
  return account.emailVerified ? "confirmed" : "unconfirmed";
}

/**
 * Validates that every id an organizer named belongs to this event - tracks to the event's
 * taxonomy, rounds to its open rounds, exactly as the People grant door demands. An
 * invitation's stored remit is what redemption applies, so it may not carry an id that reads
 * nothing once it lands.
 */
async function validateExplicitRemit(
  database: ReturnType<typeof drizzle>,
  input: { eventId: string; trackIds: string[]; roundIds: string[] },
): Promise<{ error: "invalid_reviewer_tracks" | "invalid_reviewer_rounds" } | null> {
  const [availableTracks, openRounds] = await Promise.all([
    database.select({ id: tracks.id }).from(tracks).where(eq(tracks.eventId, input.eventId)),
    database
      .select({ id: reviewRounds.id })
      .from(reviewRounds)
      .where(and(eq(reviewRounds.eventId, input.eventId), eq(reviewRounds.status, "open"))),
  ]);
  const availableTrackIds = new Set(availableTracks.map((track) => track.id));
  if (input.trackIds.some((trackId) => !availableTrackIds.has(trackId))) {
    return { error: "invalid_reviewer_tracks" };
  }
  const openRoundIds = new Set(openRounds.map((round) => round.id));
  if (input.roundIds.some((roundId) => !openRoundIds.has(roundId))) {
    return { error: "invalid_reviewer_rounds" };
  }
  return null;
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
  // Whether an invited address already has an account decides what the organizer can do with
  // the open invitation: a confirmed account can be upgraded now, an unconfirmed one is
  // waiting on its confirmation, and no account is waiting on a sign-up.
  const inviteEmails = [...new Set(openInvites.map((invite) => invite.email))];
  const inviteAccounts = inviteEmails.length === 0
    ? []
    : await database
      .select({ email: users.email, emailVerified: users.emailVerified })
      .from(users)
      .where(inArray(sql`lower(${users.email})`, inviteEmails));
  const inviteAccountByEmail = new Map(
    inviteAccounts.map((account) => [normalizeInviteEmail(account.email), account]),
  );
  return context.json({
    items,
    invites: openInvites.map((invite) => {
      const emailDelivery = reviewerInvitationDeliveryFor(invite, invitationDispatches);
      const account = inviteAccountByEmail.get(invite.email) ?? null;
      return {
        id: invite.id,
        email: invite.email,
        eventId: invite.eventId,
        createdAt: invite.createdAt.toISOString(),
        emailDelivery,
        canResend: emailDelivery !== "sent",
        accountStatus: accountStatusFor(account),
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
    return context.json(
      {
        error: "invalid_email",
        note: "An invitation is redeemed by confirming the address it was sent to, so it needs a "
          + "valid email address. Check the address and send it again.",
      },
      400,
    );
  }
  const organizer = context.get("authUser");
  if (organizer === null) {
    return context.json({ error: "authentication_required" }, 401);
  }
  const database = drizzle(context.env.DB);
  const email = normalizeInviteEmail(payload.email);
  const eventId = context.req.param("eventId");
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
    const alreadySent = await deliveryForInvite(database, openInvite) === "sent";
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
    return context.json(
      {
        error: "open_round_required",
        note: "This event has no open review round, so a redeemed invitation would open an empty "
          + "queue. Open a review round on Committee setup, then send this invitation again.",
      },
      409,
    );
  }
  const explicitTrackIds = Array.isArray(payload.trackIds)
    ? payload.trackIds.filter((id): id is string => typeof id === "string")
    : null;
  const explicitRoundIds = Array.isArray(payload.roundIds)
    ? payload.roundIds.filter((id): id is string => typeof id === "string")
    : null;
  // A named remit is validated exactly as the People grant door validates one, because it is
  // what redemption will apply - an id that reads nothing here must not reach an account later.
  if (explicitTrackIds !== null || explicitRoundIds !== null) {
    const invalid = await validateExplicitRemit(database, {
      eventId,
      trackIds: explicitTrackIds ?? [],
      roundIds: explicitRoundIds ?? [],
    });
    if (invalid !== null) {
      return context.json(invalid, 400);
    }
  }
  const resolvedTrackIds = explicitTrackIds ?? eventTracks.map((track) => track.id);
  const resolvedRoundIds = explicitRoundIds !== null && explicitRoundIds.length > 0
    ? explicitRoundIds
    : [defaultRound.id];
  const [invite] = await database
    .insert(reviewerInvites)
    .values({
      email,
      eventId,
      trackIds: resolvedTrackIds,
      roundIds: resolvedRoundIds,
      invitedByUserId: organizer.id,
    })
    .returning({ id: reviewerInvites.id });

  // An invited address that already has a confirmed account is a normal case, not an error:
  // people sign up on their own before anyone invites them. Nothing will ever re-fire email
  // verification for them, so the invitation can only become access through this door or
  // through the emailed link's accept action.
  const invitedAccount = await invitedAccountFor(database, email);
  const accountStatus = accountStatusFor(invitedAccount);
  // The organizer-side upgrade applies a remit the organizer explicitly named - the same rule
  // the People grant door follows (#166) - never the silent default above. Without one, the
  // invitation stays open and resolvable: the link opens it with the stored remit, and the
  // upgrade route can still apply a chosen remit later.
  const namedFullRemit = explicitTrackIds !== null && explicitRoundIds !== null && explicitRoundIds.length > 0;
  let upgrade: {
    account: { userId: string; name: string };
    grantedReviewerRole: boolean;
    appliedRemit: { trackIds: string[]; roundIds: string[] };
  } | null = null;
  if (invitedAccount !== null && invitedAccount.emailVerified && namedFullRemit) {
    const alreadyReviewer = await hasLiveGrant(database, invitedAccount.userId, "reviewer");
    await redeemInviteForAccount(
      database,
      {
        id: invite!.id,
        eventId,
        trackIds: resolvedTrackIds,
        roundIds: resolvedRoundIds,
        invitedByUserId: organizer.id,
      },
      { id: invitedAccount.userId },
    );
    upgrade = {
      account: { userId: invitedAccount.userId, name: invitedAccount.name },
      grantedReviewerRole: !alreadyReviewer,
      appliedRemit: { trackIds: resolvedTrackIds, roundIds: resolvedRoundIds },
    };
  }
  const delivery = await sendReviewerInvitationEmail({
    database,
    env: context.env,
    eventId: eventId as `evt_${string}`,
    inviteId: invite!.id,
    recipientEmail: email,
    accountStatus,
    createdByUserId: organizer.id,
  });
  if (delivery.status === "event_not_found") {
    return context.json({ error: "event_not_found" }, 404);
  }
  const note = upgrade !== null
    ? null
    : accountStatus === "unconfirmed"
    ? "An account already exists for this address, but it is not confirmed yet. The invitation opens reviewer access once that address is confirmed."
    : accountStatus === "confirmed"
    ? "That address already has a confirmed account. Open reviewer access now by naming a remit, or leave the invitation to open through its link."
    : "The invitation becomes reviewer access only when this address is confirmed.";
  return context.json(
    {
      invite: { id: invite!.id, email, eventId },
      ...invitationDeliveryResponse(delivery),
      accountStatus,
      upgraded: upgrade !== null,
      ...(upgrade !== null ? upgrade : {}),
      ...(note === null ? {} : { note }),
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
  if (await deliveryForInvite(database, invite) === "sent") {
    return context.json({ error: "invitation_already_sent" }, 409);
  }
  // The resend speaks to the address as it stands now, so the copy fits an account that may
  // have appeared since the invitation was first recorded.
  const accountStatus = accountStatusFor(await invitedAccountFor(database, invite.email));
  const delivery = await sendReviewerInvitationEmail({
    database,
    env: context.env,
    eventId: eventId as `evt_${string}`,
    inviteId: invite.id,
    recipientEmail: invite.email,
    accountStatus,
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

/**
 * Applies an organizer-chosen remit to an open invitation whose address already has a
 * confirmed account, and redeems it for that account now. This is the completion of the
 * invite-time upgrade when the organizer did not name a remit up front, and it follows the
 * same rule the People grant door does (#166): an explicit remit with at least one open
 * round, never a silent default. The remit is stored on the invitation before redemption, so
 * what the account receives is what the organizer chose.
 */
peopleRoutes.post(
  "/api/events/:eventId/reviewer-invites/:inviteId/upgrade",
  requireOrganizer,
  async (context) => {
    const organizer = context.get("authUser");
    if (organizer === null) {
      return context.json({ error: "authentication_required" }, 401);
    }
    const payload = await context.req.json<{ trackIds?: unknown; roundIds?: unknown }>();
    const trackIds = Array.isArray(payload.trackIds)
      ? payload.trackIds.filter((id): id is string => typeof id === "string")
      : null;
    const roundIds = Array.isArray(payload.roundIds)
      ? payload.roundIds.filter((id): id is string => typeof id === "string")
      : null;
    if (trackIds === null || roundIds === null || roundIds.length === 0) {
      return context.json({ error: "reviewer_remit_required" }, 400);
    }
    const database = drizzle(context.env.DB);
    const eventId = context.req.param("eventId");
    const [invite] = await database
      .select({
        id: reviewerInvites.id,
        email: reviewerInvites.email,
        invitedByUserId: reviewerInvites.invitedByUserId,
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
    const invalid = await validateExplicitRemit(database, { eventId, trackIds, roundIds });
    if (invalid !== null) {
      return context.json(invalid, 400);
    }
    const invitedAccount = await invitedAccountFor(database, invite.email);
    if (invitedAccount === null || !invitedAccount.emailVerified) {
      // The invitation itself still stands: the link opens it once the address is confirmed.
      return context.json(
        { error: "account_not_confirmed", accountStatus: accountStatusFor(invitedAccount) },
        409,
      );
    }
    await database
      .update(reviewerInvites)
      .set({ trackIds, roundIds })
      .where(eq(reviewerInvites.id, invite.id));
    const alreadyReviewer = await hasLiveGrant(database, invitedAccount.userId, "reviewer");
    await redeemInviteForAccount(
      database,
      { ...invite, eventId, trackIds, roundIds },
      { id: invitedAccount.userId },
    );
    return context.json({
      invite: { id: invite.id, email: invite.email, eventId },
      account: { userId: invitedAccount.userId, name: invitedAccount.name },
      grantedReviewerRole: !alreadyReviewer,
      appliedRemit: { trackIds, roundIds },
    });
  },
);

/**
 * What the emailed link's page needs: whether the invitation is still open and which event it
 * names. The invite id is the capability, so nothing here is secret beyond it - no address,
 * no remit, no account state.
 */
peopleRoutes.get("/api/reviewer-invites/:inviteId", async (context) => {
  const [invite] = await drizzle(context.env.DB)
    .select({
      eventId: reviewerInvites.eventId,
      redeemedAt: reviewerInvites.redeemedAt,
      revokedAt: reviewerInvites.revokedAt,
      eventName: events.name,
    })
    .from(reviewerInvites)
    .innerJoin(events, eq(reviewerInvites.eventId, events.id))
    .where(eq(reviewerInvites.id, context.req.param("inviteId")));
  if (invite === undefined) {
    return context.json({ error: "invite_not_found" }, 404);
  }
  const status = invite.revokedAt !== null
    ? "revoked"
    : invite.redeemedAt !== null
    ? "redeemed"
    : "open";
  return context.json({ status, event: { id: invite.eventId, name: invite.eventName } });
});

/**
 * The emailed link's action for an account that already exists: the signed-in caller whose
 * confirmed address is the invited one opens reviewer access now. This is the same proof the
 * Better Auth hook relies on - the address is confirmed - observed from a live session rather
 * than from a verification event, so an account that verified long before the invitation can
 * still redeem it. Redeeming applies every open invitation for the address, exactly as a
 * confirmation event would.
 */
peopleRoutes.post("/api/reviewer-invites/:inviteId/accept", async (context) => {
  const caller = context.get("authUser");
  if (caller === null) {
    return context.json({ error: "authentication_required" }, 401);
  }
  const database = drizzle(context.env.DB);
  const [invite] = await database
    .select({
      email: reviewerInvites.email,
      redeemedAt: reviewerInvites.redeemedAt,
      revokedAt: reviewerInvites.revokedAt,
    })
    .from(reviewerInvites)
    .where(eq(reviewerInvites.id, context.req.param("inviteId")));
  if (invite === undefined) {
    return context.json({ error: "invite_not_found" }, 404);
  }
  if (invite.revokedAt !== null) {
    return context.json({ error: "invite_revoked" }, 409);
  }
  if (invite.redeemedAt !== null) {
    return context.json({ accepted: false, reason: "already_redeemed" });
  }
  // Read the account from the database rather than trusting the session's copy, so the
  // confirmed-address check is the same one every redemption door applies.
  const [account] = await database
    .select({ id: users.id, email: users.email, emailVerified: users.emailVerified })
    .from(users)
    .where(eq(users.id, caller.id));
  if (account === undefined) {
    return context.json({ error: "authentication_required" }, 401);
  }
  if (normalizeInviteEmail(account.email) !== normalizeInviteEmail(invite.email)) {
    return context.json({ error: "invite_email_mismatch" }, 403);
  }
  if (!account.emailVerified) {
    return context.json({ error: "email_unconfirmed" }, 403);
  }
  const redeemed = await redeemReviewerInvites(database, account);
  return context.json({ accepted: true, redeemed });
});

export default peopleRoutes;
