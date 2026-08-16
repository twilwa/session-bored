// ABOUTME: Turns an organizer's reviewer invitation into a real grant, only once the address is proved.
// ABOUTME: Signing up as an invited address grants nothing; a confirmed address is what redeems it.
import { and, eq, inArray, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  createPublicId,
  reviewerInvites,
  reviewerRoundPools,
  reviewerTracks,
  reviewRounds,
} from "../db/schema.ts";
import { chunkIds } from "./d1-limits.ts";
import { grantRole } from "./roles.ts";

type Database = ReturnType<typeof drizzle>;

export function normalizeInviteEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Gives a reviewer their readable remit for one event. Shared by direct organizer
 * provisioning, invitation redemption, and the People grant door so all three
 * produce the same rows.
 */
export async function applyReviewerRemit(
  database: Database,
  input: {
    eventId: string;
    reviewerUserId: string;
    trackIds: readonly string[];
    roundIds: readonly string[];
  },
): Promise<void> {
  const trackIds = [...new Set(input.trackIds)];
  const roundIds = [...new Set(input.roundIds)];
  const eventRoundIds = database
    .select({ id: reviewRounds.id })
    .from(reviewRounds)
    .where(eq(reviewRounds.eventId, input.eventId));
  const [currentTracks, currentRounds] = await Promise.all([
    database
      .select({ id: reviewerTracks.id, trackId: reviewerTracks.trackId })
      .from(reviewerTracks)
      .where(and(
        eq(reviewerTracks.eventId, input.eventId),
        eq(reviewerTracks.reviewerUserId, input.reviewerUserId),
      )),
    database
      .select({ id: reviewerRoundPools.id, roundId: reviewerRoundPools.roundId })
      .from(reviewerRoundPools)
      .innerJoin(reviewRounds, eq(reviewerRoundPools.roundId, reviewRounds.id))
      .where(and(
        eq(reviewRounds.eventId, input.eventId),
        eq(reviewerRoundPools.reviewerUserId, input.reviewerUserId),
      )),
  ]);
  const keptTrackIds = new Set(trackIds);
  const removeTracks = chunkIds(currentTracks.filter((row) => !keptTrackIds.has(row.trackId)).map((row) => row.id))
    .map((ids) =>
      database.delete(reviewerTracks).where(and(
        eq(reviewerTracks.eventId, input.eventId),
        eq(reviewerTracks.reviewerUserId, input.reviewerUserId),
        inArray(reviewerTracks.id, ids),
      ))
    );
  const keptRoundIds = new Set(roundIds);
  const removeRounds = chunkIds(currentRounds.filter((row) => !keptRoundIds.has(row.roundId)).map((row) => row.id))
    .map((ids) =>
      database.delete(reviewerRoundPools).where(and(
        eq(reviewerRoundPools.reviewerUserId, input.reviewerUserId),
        inArray(reviewerRoundPools.roundId, eventRoundIds),
        inArray(reviewerRoundPools.id, ids),
      ))
    );
  const heldTrackIds = new Set(currentTracks.map((row) => row.trackId));
  const addTracks = trackIds.filter((trackId) => !heldTrackIds.has(trackId)).map((trackId) =>
    database.insert(reviewerTracks).values({
        id: createPublicId("rtrk"),
        eventId: input.eventId,
        reviewerUserId: input.reviewerUserId,
        trackId,
      }).onConflictDoNothing()
  );
  const heldRoundIds = new Set(currentRounds.map((row) => row.roundId));
  const addRounds = roundIds.filter((roundId) => !heldRoundIds.has(roundId)).map((roundId) =>
    database.insert(reviewerRoundPools).values({
        id: createPublicId("rpool"),
        roundId,
        reviewerUserId: input.reviewerUserId,
      }).onConflictDoNothing()
  );
  const [first, ...rest] = [...removeTracks, ...removeRounds, ...addTracks, ...addRounds];
  if (first !== undefined) {
    await database.batch([first, ...rest]);
  }
}

export interface RedeemedInvite {
  inviteId: string;
  eventId: string;
}

/**
 * The shape `redeemInviteForAccount` needs: exactly what an open `reviewer_invite` row carries.
 */
export interface RedeemableInvite {
  id: string;
  eventId: string;
  trackIds: string[];
  roundIds: string[];
  invitedByUserId: string;
}

/**
 * Redeems one invitation for one account: the reviewer grant if it is not already held, the
 * invitation's own remit, and the once-only redeemed stamp. The conditional update is what
 * makes redemption single-shot, so concurrent callers resolve to one winner. Every door that
 * turns an invitation into access calls this - confirming the address, accepting it from the
 * invitation link, and an organizer upgrading an already-confirmed account - so they all
 * produce the same rows.
 */
export async function redeemInviteForAccount(
  database: Database,
  invite: RedeemableInvite,
  user: { id: string },
): Promise<boolean> {
  await grantRole(database, {
    userId: user.id,
    role: "reviewer",
    source: "reviewer_invite",
    grantedByUserId: invite.invitedByUserId,
    note: "Redeemed a reviewer invitation for this address.",
  });
  await applyReviewerRemit(database, {
    eventId: invite.eventId,
    reviewerUserId: user.id,
    trackIds: invite.trackIds,
    roundIds: invite.roundIds,
  });
  const won = await database
    .update(reviewerInvites)
    .set({ redeemedAt: new Date(), redeemedByUserId: user.id })
    .where(and(eq(reviewerInvites.id, invite.id), isNull(reviewerInvites.redeemedAt)))
    .returning({ id: reviewerInvites.id });
  return won.length > 0;
}

/**
 * Redeems every open reviewer invitation for a confirmed address.
 *
 * This runs from Better Auth's `afterEmailVerification` and from the invitation link's accept
 * action, and from nowhere else. That is the whole security property: an invitation names an
 * address, so the only person who may redeem it here is the one who can read that mailbox -
 * Better Auth proves it by writing `email_verified`, the accept route proves it by requiring a
 * signed-in account whose confirmed address is the invited one. Redeeming at sign-up instead
 * would hand reviewer access to anyone who guessed an invited address. Callers must never
 * invoke this with an address the account has not actually confirmed.
 */
export async function redeemReviewerInvites(
  database: Database,
  user: { id: string; email: string; emailVerified: boolean },
): Promise<RedeemedInvite[]> {
  if (!user.emailVerified) {
    return [];
  }
  const email = normalizeInviteEmail(user.email);
  const open = await database
    .select({
      id: reviewerInvites.id,
      eventId: reviewerInvites.eventId,
      trackIds: reviewerInvites.trackIds,
      roundIds: reviewerInvites.roundIds,
      invitedByUserId: reviewerInvites.invitedByUserId,
    })
    .from(reviewerInvites)
    .where(
      and(
        eq(reviewerInvites.email, email),
        isNull(reviewerInvites.redeemedAt),
        isNull(reviewerInvites.revokedAt),
      ),
    );
  const redeemed: RedeemedInvite[] = [];
  for (const invite of open) {
    if (await redeemInviteForAccount(database, invite, user)) {
      redeemed.push({ inviteId: invite.id, eventId: invite.eventId });
    }
  }
  return redeemed;
}

/**
 * The Better Auth hook entry point. Better Auth only calls `afterEmailVerification` once it
 * has written `email_verified`, so the address is proved by the time this runs.
 */
export async function redeemReviewerInvitesFor(
  env: { DB: D1Database },
  user: { id: string; email: string },
): Promise<RedeemedInvite[]> {
  return redeemReviewerInvites(drizzle(env.DB), { ...user, emailVerified: true });
}
