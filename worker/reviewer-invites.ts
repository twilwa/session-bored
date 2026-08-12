// ABOUTME: Turns an organizer's reviewer invitation into a real grant, only once the address is proved.
// ABOUTME: Signing up as an invited address grants nothing; confirming that address is what redeems it.
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  createPublicId,
  reviewerInvites,
  reviewerRoundPools,
  reviewerTracks,
} from "../db/schema.ts";
import { grantRole } from "./roles.ts";

type Database = ReturnType<typeof drizzle>;

export function normalizeInviteEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Gives a reviewer their readable remit for one event. Shared by direct organizer
 * provisioning and invitation redemption so both produce the same rows.
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
  for (const trackId of input.trackIds) {
    await database
      .insert(reviewerTracks)
      .values({
        id: createPublicId("rtrk"),
        eventId: input.eventId,
        reviewerUserId: input.reviewerUserId,
        trackId,
      })
      .onConflictDoNothing();
  }
  for (const roundId of input.roundIds) {
    await database
      .insert(reviewerRoundPools)
      .values({
        id: createPublicId("rpool"),
        roundId,
        reviewerUserId: input.reviewerUserId,
      })
      .onConflictDoNothing();
  }
}

export interface RedeemedInvite {
  inviteId: string;
  eventId: string;
}

/**
 * Redeems every open reviewer invitation for a freshly confirmed address.
 *
 * This runs from Better Auth's `afterEmailVerification` and from nowhere else. That is the
 * whole security property: an invitation names an address, so the only person who may redeem
 * it is the one who can read that mailbox. Redeeming at sign-up instead would hand reviewer
 * access to anyone who guessed an invited address. Callers must never invoke this with an
 * address the account has not actually confirmed.
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
    await grantRole(database, {
      userId: user.id,
      role: "reviewer",
      source: "reviewer_invite",
      grantedByUserId: invite.invitedByUserId,
      note: "Redeemed a reviewer invitation after confirming this address.",
    });
    await applyReviewerRemit(database, {
      eventId: invite.eventId,
      reviewerUserId: user.id,
      trackIds: invite.trackIds,
      roundIds: invite.roundIds,
    });
    await database
      .update(reviewerInvites)
      .set({ redeemedAt: new Date(), redeemedByUserId: user.id })
      .where(and(eq(reviewerInvites.id, invite.id), isNull(reviewerInvites.redeemedAt)));
    redeemed.push({ inviteId: invite.id, eventId: invite.eventId });
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
