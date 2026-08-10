// ABOUTME: Fills disposition.ts's dispatch seam - sends the letters it already rendered and queued.
// ABOUTME: Owns per-recipient delivery outcome and the one retry path for a notice that failed.
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { decisionBatches, decisionNotices } from "../../db/schema.ts";
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
  configured: boolean;
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
 * Sends the letters for notice rows disposition.ts just newly queued (its
 * unique index on submissionId means a repeated dispatch of the same batch
 * inserts nothing new, so this only ever runs against rows queued for the
 * first time - dispatching twice can't email anyone twice). Every attempt
 * goes through `sendTrackedEmail`, so a configured send also lands in the
 * shared `email_dispatch` communications log, not just `decision_notice`.
 * Pass `delivery` explicitly in tests so nothing reaches the network;
 * production call sites can omit it and get the env-resolved sender. When
 * delivery reports `provider_not_configured` a notice's row is left
 * untouched (still `queued`), so unconfigured environments keep
 * disposition.ts's exact existing `not_configured` behavior.
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
  let configured = false;
  for (const notice of notices) {
    const outcome = await deliverAndRecord(database, delivery, eventId, notice);
    if (outcome === "provider_not_configured") {
      continue;
    }
    configured = true;
    (outcome === "sent" ? sent : failed).push(notice.submissionId);
  }
  return { configured, sent, failed };
}

export type RetryDecisionNoticeResult =
  | { status: "not_found" }
  | { status: "not_retryable"; currentStatus: string }
  | { status: "provider_not_configured" }
  | { status: "sent" }
  | { status: "failed"; error: string };

/** The per-recipient retry path for a notice whose send previously failed. */
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
    .where(and(eq(decisionNotices.submissionId, submissionId), eq(decisionBatches.eventId, eventId)));
  if (row === undefined) {
    return { status: "not_found" };
  }
  if (row.deliveryStatus !== "failed") {
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
