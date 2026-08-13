// ABOUTME: Fills disposition.ts's dispatch seam - sends the letters it already rendered and queued.
// ABOUTME: Owns per-recipient delivery outcome and the one send path for a letter still undelivered.
import { and, eq, isNull, lt, ne, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { decisionBatchItems, decisionBatches, decisionNotices, people, submissions } from "../../db/schema.ts";
import { resolveEmailDelivery, type EmailDelivery, type EmailEnvironment } from "../email.ts";
import { sendTrackedEmail, textToHtml } from "./send.ts";

type EmailDatabase = ReturnType<typeof drizzle>;

export interface DecisionNoticeRow {
  id: string;
  submissionId: string;
  outcome: "accepted" | "maybe" | "declined";
  recipientEmail: string;
  subject: string;
  body: string;
}

export interface DispatchDecisionNoticeEmailsResult {
  /** True once at least one letter reached the provider - sent or rejected. */
  attempted: boolean;
  sent: string[];
  failed: string[];
}

/**
 * How long a `sending` claim is honoured before it is treated as abandoned. A Worker that dies
 * between claiming and recording its outcome would otherwise strand the letter forever, which is
 * the dead end this whole issue is about. Reclaiming risks delivering twice in the narrow case
 * where the provider accepted the mail and only the write was lost - accepted deliberately,
 * because before the claim existed that same crash left the row `queued` and the next retry
 * re-sent it immediately with no window at all.
 */
const staleSendClaimMs = 15 * 60_000;

export function staleClaimCutoff(now: Date): Date {
  return new Date(now.getTime() - staleSendClaimMs);
}

/**
 * Takes the letter for this send, atomically, and answers whether it was won. Only a letter that
 * is not cancelled, not already delivered, and not being sent by somebody else can be claimed, and
 * the claim is the row update itself rather than a decision made from an earlier read - so a
 * cancellation racing a send resolves to exactly one winner instead of both proceeding.
 */
async function claimForSending(
  database: EmailDatabase,
  noticeId: string,
  now: Date,
): Promise<
  { claimed: true; token: string; previousStatus: "queued" | "failed" | "sending" } | { claimed: false }
> {
  const token = crypto.randomUUID();
  const cutoff = staleClaimCutoff(now);
  const [before] = await database
    .select({ deliveryStatus: decisionNotices.deliveryStatus })
    .from(decisionNotices)
    .where(eq(decisionNotices.id, noticeId));
  const claimed = await database
    .update(decisionNotices)
    .set({ deliveryStatus: "sending", sendingSince: now, sendingClaimToken: token })
    .where(and(
      eq(decisionNotices.id, noticeId),
      isNull(decisionNotices.cancelledAt),
      or(
        eq(decisionNotices.deliveryStatus, "queued"),
        eq(decisionNotices.deliveryStatus, "failed"),
        and(
          eq(decisionNotices.deliveryStatus, "sending"),
          lt(decisionNotices.sendingSince, cutoff),
        ),
      ),
    ))
    .returning({ id: decisionNotices.id });
  return claimed.length === 0
    ? { claimed: false }
    : {
      claimed: true,
      token,
      previousStatus: (before?.deliveryStatus ?? "queued") as "queued" | "failed" | "sending",
    };
}

async function deliverAndRecord(
  database: EmailDatabase,
  delivery: EmailDelivery,
  eventId: `evt_${string}`,
  notice: Pick<DecisionNoticeRow, "id" | "outcome" | "recipientEmail" | "subject" | "body">,
  now: Date = new Date(),
): Promise<"sent" | "failed" | "provider_not_configured" | "not_claimable" | "lost_claim"> {
  const claim = await claimForSending(database, notice.id, now);
  if (!claim.claimed) {
    return "not_claimable";
  }
  const result = await sendTrackedEmail({
    database,
    delivery,
    eventId,
    templateKey: `decision_${notice.outcome}`,
    recipient: { email: notice.recipientEmail },
    subject: notice.subject,
    html: textToHtml(notice.body),
    text: notice.body,
  });
  // Every write below is conditioned on still holding the token taken above. A provider call that
  // outran the lease no longer owns the letter: somebody else may have legitimately reclaimed or
  // cancelled it, and overwriting them would report a cancelled letter as sent.
  const stillOurs = and(
    eq(decisionNotices.id, notice.id),
    eq(decisionNotices.sendingClaimToken, claim.token),
  );
  if (result.status === "provider_not_configured") {
    // Nothing was attempted, so put the letter back exactly as it was rather than leaving it
    // claimed. An unconfigured deployment must stay silent and leave a queued letter queued.
    await database
      .update(decisionNotices)
      .set({
        deliveryStatus: claim.previousStatus === "sending" ? "queued" : claim.previousStatus,
        sendingSince: null,
        sendingClaimToken: null,
      })
      .where(stillOurs);
    return "provider_not_configured";
  }
  const delivered = result.status === "sent";
  const recorded = await database
    .update(decisionNotices)
    .set({
      deliveryStatus: delivered ? "sent" : "failed",
      sendingSince: null,
      sendingClaimToken: null,
      sentAt: delivered ? new Date() : null,
      providerMessageId: delivered ? result.providerMessageId ?? null : null,
      failureReason: delivered ? null : result.error ?? "send_failed",
    })
    .where(stillOurs)
    .returning({ id: decisionNotices.id });
  if (recorded.length === 0) {
    // The attempt really happened and `email_dispatch` already records it, which is the durable
    // account of what reached the provider. What cannot be done is restate it on a letter this
    // send no longer owns, so the row is left to whoever holds it and the caller is told plainly.
    console.log(JSON.stringify({
      message: "decision_notice_claim_lost",
      noticeId: notice.id,
      attemptedStatus: result.status,
    }));
    return "lost_claim";
  }
  return delivered ? "sent" : "failed";
}

/**
 * Sends the letters for the notice rows disposition.ts hands over - every
 * notice in the batch still `queued`, which is how a batch dispatched with no
 * sender connected goes out once one is. Dispatching twice can't email anyone
 * twice, because a delivered notice is no longer `queued` and so is never
 * handed over again. Every attempt goes through `sendTrackedEmail`, so a
 * configured send also lands in the shared `email_dispatch` communications
 * log, not just `decision_notice`. Pass `delivery` explicitly in tests so
 * nothing reaches the network; production call sites can omit it and get the
 * env-resolved sender. When delivery reports `provider_not_configured` a
 * notice's row is left untouched (still `queued`), so unconfigured
 * environments record the decision without claiming an attempt.
 */
export async function dispatchDecisionNoticeEmails(
  database: EmailDatabase,
  env: EmailEnvironment,
  eventId: `evt_${string}`,
  notices: DecisionNoticeRow[],
  delivery: EmailDelivery = resolveEmailDelivery(env),
): Promise<DispatchDecisionNoticeEmailsResult> {
  const sent: string[] = [];
  const failed: string[] = [];
  let attempted = false;
  for (const notice of notices) {
    const outcome = await deliverAndRecord(database, delivery, eventId, notice);
    // Cancelled or already being sent by somebody else between the caller's read and here.
    // Nothing was attempted for it, so nothing is claimed about it either.
    if (outcome === "provider_not_configured" || outcome === "not_claimable" || outcome === "lost_claim") {
      continue;
    }
    attempted = true;
    (outcome === "sent" ? sent : failed).push(notice.submissionId);
  }
  return { attempted, sent, failed };
}

export type RetryDecisionNoticeResult =
  | { status: "not_found" }
  | { status: "not_retryable"; currentStatus: string }
  | { status: "superseded" }
  | { status: "delivery_unconfirmed" }
  | { status: "provider_not_configured" }
  | { status: "sent" }
  | { status: "failed"; error: string };

/**
 * The per-recipient send path for a notice that has not reached its recipient -
 * one whose send failed, and one still `queued` because no sender was connected
 * when its batch was dispatched. A notice already `sent` is refused here, so
 * this can never deliver the same letter twice.
 *
 * `noticeId` is the letter the caller was looking at, and it is **required**. Since a letter can be
 * cancelled and replaced, resolving by submission alone would let a page loaded before that send
 * the *new* letter under the old one's review - a different recipient, outcome, and copy than the
 * organizer read. Naming the letter turns that into a refusal.
 *
 * It is a required argument rather than an optional check because the consequence of getting it
 * wrong is delivering an unreviewed letter to a speaker. An optional guard is only as good as
 * every caller remembering it, and a caller that forgets - a stale bundle, a new call site, a
 * hand-made request - would silently fall back to sending whichever letter the query picked. There
 * is no such fallback: a send that cannot name its letter does not happen.
 */
export async function retryDecisionNotice(
  database: EmailDatabase,
  env: EmailEnvironment,
  eventId: `evt_${string}`,
  submissionId: string,
  noticeId: string,
  delivery: EmailDelivery = resolveEmailDelivery(env),
): Promise<RetryDecisionNoticeResult> {
  const [row] = await database
    .select({
      id: decisionNotices.id,
      submissionId: decisionNotices.submissionId,
      outcome: decisionNotices.outcome,
      recipientEmail: decisionNotices.recipientEmail,
      subject: decisionNotices.subject,
      body: decisionNotices.body,
      deliveryStatus: decisionNotices.deliveryStatus,
    })
    .from(decisionNotices)
    .innerJoin(decisionBatches, eq(decisionNotices.batchId, decisionBatches.id))
    .where(and(
      eq(decisionNotices.submissionId, submissionId),
      eq(decisionBatches.eventId, eventId),
      isNull(decisionNotices.cancelledAt),
    ));
  if (row === undefined) {
    return { status: "not_found" };
  }
  if (noticeId !== row.id) {
    return { status: "superseded" };
  }
  if (row.deliveryStatus === "sent") {
    return { status: "not_retryable", currentStatus: row.deliveryStatus };
  }
  const outcome = await deliverAndRecord(database, delivery, eventId, row);
  if (outcome === "provider_not_configured") {
    return { status: "provider_not_configured" };
  }
  // Somebody else is already sending this letter, or cancelled it while this call was deciding.
  if (outcome === "not_claimable") {
    return { status: "not_retryable", currentStatus: "sending" };
  }
  // The attempt outlived its claim, so its outcome could not be recorded on the letter.
  if (outcome === "lost_claim") {
    return { status: "delivery_unconfirmed" };
  }
  if (outcome === "sent") {
    return { status: "sent" };
  }
  const [updated] = await database
    .select({ failureReason: decisionNotices.failureReason })
    .from(decisionNotices)
    .where(eq(decisionNotices.id, row.id));
  return { status: "failed", error: updated?.failureReason ?? "send_failed" };
}

export type CancelDecisionNoticeResult =
  | { status: "not_found" }
  | { status: "already_cancelled" }
  | { status: "superseded" }
  | { status: "not_cancellable"; currentStatus: string }
  | { status: "invalid_recipient" }
  | { status: "recipient_taken" }
  | { status: "cancelled"; submissionId: string; recipientEmail: string };

/**
 * Retires a decision letter that has not reached its recipient, so a corrected one can be
 * reviewed and queued in its place. A letter already `sent` is history and is refused here.
 *
 * Cancelling is not editing. The letter itself is never rewritten - it keeps the recipient,
 * outcome, subject, and body it was approved with, and stays readable in Communications
 * alongside who retired it and why. What `correctedRecipientEmail` changes is the *person's*
 * address, the same field the roster already edits, which is what makes the replacement
 * letter come out right. The replacement is a fresh batch the organizer reviews and
 * dispatches, so the approval a letter carries always describes the letter that was sent.
 *
 * `noticeId` is required for the same reason it is on the send path. A modal left open for letter
 * A, while somebody else cancels A and queues replacement B, would otherwise retire B - and apply
 * an address correction typed while reading A. Retiring a letter nobody reviewed is the same fault
 * as sending one.
 */
export async function cancelDecisionNotice(params: {
  database: EmailDatabase;
  eventId: `evt_${string}`;
  submissionId: string;
  noticeId: string;
  cancelledByUserId: string;
  reason?: string | undefined;
  correctedRecipientEmail?: string | undefined;
}): Promise<CancelDecisionNoticeResult> {
  const { database, eventId, submissionId } = params;
  const rows = await database
    .select({
      id: decisionNotices.id,
      deliveryStatus: decisionNotices.deliveryStatus,
      sendingSince: decisionNotices.sendingSince,
      cancelledAt: decisionNotices.cancelledAt,
    })
    .from(decisionNotices)
    .innerJoin(decisionBatches, eq(decisionNotices.batchId, decisionBatches.id))
    .where(and(eq(decisionNotices.submissionId, submissionId), eq(decisionBatches.eventId, eventId)));
  if (rows.length === 0) {
    return { status: "not_found" };
  }
  const live = rows.find((row) => row.cancelledAt === null);
  if (live === undefined) {
    return { status: "already_cancelled" };
  }
  if (live.id !== params.noticeId) {
    return { status: "superseded" };
  }
  const now = new Date();
  const cutoff = staleClaimCutoff(now);
  const beingSent = live.deliveryStatus === "sending" &&
    live.sendingSince !== null && live.sendingSince >= cutoff;
  if (live.deliveryStatus === "sent" || beingSent) {
    return { status: "not_cancellable", currentStatus: live.deliveryStatus };
  }

  const [submission] = await database
    .select({ personId: submissions.submitterPersonId, currentEmail: people.email })
    .from(submissions)
    .innerJoin(people, eq(submissions.submitterPersonId, people.id))
    .where(eq(submissions.id, submissionId));
  if (submission === undefined) {
    return { status: "not_found" };
  }

  // Resolve the correction without writing it. Nothing about the person changes until the letter
  // is actually retired, so a cancellation that loses the race below leaves no half-applied edit.
  let recipientEmail = submission.currentEmail;
  let correctionToApply: string | null = null;
  if (params.correctedRecipientEmail !== undefined) {
    const corrected = params.correctedRecipientEmail.trim().toLowerCase();
    if (!corrected.includes("@") || corrected.startsWith("@") || corrected.endsWith("@")) {
      return { status: "invalid_recipient" };
    }
    if (corrected !== submission.currentEmail) {
      const [taken] = await database
        .select({ id: people.id })
        .from(people)
        .where(and(sql`lower(${people.email}) = ${corrected}`, sql`${people.id} <> ${submission.personId}`));
      // Someone else already answers to this address, so adopting it would silently merge two
      // people. Nothing is cancelled: the correction the organizer asked for did not happen.
      if (taken !== undefined) {
        return { status: "recipient_taken" };
      }
      correctionToApply = corrected;
    }
    recipientEmail = corrected;
  }

  // Retiring the letter is this one conditional write, so it and a send cannot both win. A send
  // that claimed the letter, delivered it, or a cancellation that got here first all leave these
  // conditions unmet, and this call is refused rather than overwriting their outcome.
  const retired = await database
    .update(decisionNotices)
    .set({
      cancelledAt: now,
      cancelledByUserId: params.cancelledByUserId,
      cancellationReason: params.reason?.trim() || null,
    })
    .where(and(
      eq(decisionNotices.id, live.id),
      isNull(decisionNotices.cancelledAt),
      ne(decisionNotices.deliveryStatus, "sent"),
      or(
        ne(decisionNotices.deliveryStatus, "sending"),
        lt(decisionNotices.sendingSince, cutoff),
      ),
    ))
    .returning({ id: decisionNotices.id });
  if (retired.length === 0) {
    const [current] = await database
      .select({ deliveryStatus: decisionNotices.deliveryStatus, cancelledAt: decisionNotices.cancelledAt })
      .from(decisionNotices)
      .where(eq(decisionNotices.id, live.id));
    return current?.cancelledAt != null
      ? { status: "already_cancelled" }
      : { status: "not_cancellable", currentStatus: current?.deliveryStatus ?? "sent" };
  }
  // Every preview still outstanding for this submission was rendered against the letter just
  // retired, so it would queue the very content the organizer is correcting. Stamping them here
  // is what makes "dispatch cannot undo a correction" a fact about the data rather than a race
  // between two timestamps.
  await database
    .update(decisionBatchItems)
    .set({ supersededAt: now })
    .where(and(
      eq(decisionBatchItems.submissionId, submissionId),
      isNull(decisionBatchItems.dispatchedAt),
      isNull(decisionBatchItems.supersededAt),
    ));

  // The letter is retired, so the correction can be applied. Only now: had the write above lost,
  // the person's address would have been changed for a letter that went out unchanged.
  if (correctionToApply !== null) {
    await database
      .update(people)
      .set({ email: correctionToApply })
      .where(eq(people.id, submission.personId));
  }
  return { status: "cancelled", submissionId, recipientEmail };
}
