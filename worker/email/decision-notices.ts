// ABOUTME: Fills disposition.ts's dispatch seam - sends the letters it already rendered and queued.
// ABOUTME: Owns per-recipient delivery outcome and the one send path for a letter still undelivered.
import { and, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { decisionBatches, decisionNotices, people, submissions } from "../../db/schema.ts";
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

async function deliverAndRecord(
  database: EmailDatabase,
  delivery: EmailDelivery,
  eventId: `evt_${string}`,
  notice: Pick<DecisionNoticeRow, "id" | "outcome" | "recipientEmail" | "subject" | "body">,
): Promise<"sent" | "failed" | "provider_not_configured"> {
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
  if (result.status === "provider_not_configured") {
    return "provider_not_configured";
  }
  const delivered = result.status === "sent";
  await database
    .update(decisionNotices)
    .set({
      deliveryStatus: delivered ? "sent" : "failed",
      sentAt: delivered ? new Date() : null,
      providerMessageId: delivered ? result.providerMessageId ?? null : null,
      failureReason: delivered ? null : result.error ?? "send_failed",
    })
    .where(eq(decisionNotices.id, notice.id));
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
    if (outcome === "provider_not_configured") {
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
  | { status: "provider_not_configured" }
  | { status: "sent" }
  | { status: "failed"; error: string };

/**
 * The per-recipient send path for a notice that has not reached its recipient -
 * one whose send failed, and one still `queued` because no sender was connected
 * when its batch was dispatched. A notice already `sent` is refused here, so
 * this can never deliver the same letter twice.
 */
export async function retryDecisionNotice(
  database: EmailDatabase,
  env: EmailEnvironment,
  eventId: `evt_${string}`,
  submissionId: string,
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
  if (row.deliveryStatus === "sent") {
    return { status: "not_retryable", currentStatus: row.deliveryStatus };
  }
  const outcome = await deliverAndRecord(database, delivery, eventId, row);
  if (outcome === "provider_not_configured") {
    return { status: "provider_not_configured" };
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
 */
export async function cancelDecisionNotice(params: {
  database: EmailDatabase;
  eventId: `evt_${string}`;
  submissionId: string;
  cancelledByUserId: string;
  reason?: string | undefined;
  correctedRecipientEmail?: string | undefined;
}): Promise<CancelDecisionNoticeResult> {
  const { database, eventId, submissionId } = params;
  const rows = await database
    .select({
      id: decisionNotices.id,
      deliveryStatus: decisionNotices.deliveryStatus,
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
  if (live.deliveryStatus === "sent") {
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

  let recipientEmail = submission.currentEmail;
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
      await database.update(people).set({ email: corrected }).where(eq(people.id, submission.personId));
    }
    recipientEmail = corrected;
  }

  await database
    .update(decisionNotices)
    .set({
      cancelledAt: new Date(),
      cancelledByUserId: params.cancelledByUserId,
      cancellationReason: params.reason?.trim() || null,
    })
    .where(eq(decisionNotices.id, live.id));
  return { status: "cancelled", submissionId, recipientEmail };
}
