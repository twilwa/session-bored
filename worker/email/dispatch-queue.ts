// ABOUTME: Lets an organizer review, edit, discard, or approve-and-send a queued email_dispatch row.
// ABOUTME: This is the only path that turns a drafted message into an actual send.
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { emailDispatches } from "../../db/schema.ts";
import { resolveEmailDelivery, type EmailDelivery, type EmailEnvironment } from "../email.ts";
import { sendTrackedEmail, textToHtml } from "./send.ts";

type EmailDatabase = ReturnType<typeof drizzle>;

async function findDispatch(database: EmailDatabase, eventId: string, dispatchId: string) {
  const [row] = await database
    .select()
    .from(emailDispatches)
    .where(
      and(
        eq(emailDispatches.id, dispatchId),
        eq(emailDispatches.eventId, eventId),
        isNull(emailDispatches.deletedAt),
      ),
    );
  return row;
}

export type SendQueuedDispatchResult =
  | { status: "not_found" }
  | { status: "not_sendable"; currentStatus: string }
  | { status: "not_configured" }
  | { status: "attempted"; sentCount: number; failedCount: number };

/**
 * The organizer's explicit approval step. Sends every recipient on a `draft`
 * or previously `failed` dispatch, then writes the outcome back onto the same
 * row (never a new one) so a retry after a partial failure stays visible from
 * one status plus the failure reason. Pass `delivery` explicitly in tests so
 * nothing reaches the network. A recipient `delivery` reports
 * `provider_not_configured` for is left alone rather than marked failed -
 * nothing was actually attempted for them, so nothing is claimed either.
 */
export async function sendQueuedDispatch(
  database: EmailDatabase,
  env: EmailEnvironment,
  eventId: `evt_${string}`,
  dispatchId: string,
  delivery: EmailDelivery = resolveEmailDelivery(env),
): Promise<SendQueuedDispatchResult> {
  const row = await findDispatch(database, eventId, dispatchId);
  if (row === undefined) {
    return { status: "not_found" };
  }
  if (row.status !== "draft" && row.status !== "failed") {
    return { status: "not_sendable", currentStatus: row.status };
  }

  const recipients = row.recipients ?? [];
  const providerMessageIds: string[] = [];
  const failures: string[] = [];
  let sentCount = 0;
  let attempted = 0;

  for (const recipient of recipients) {
    const result = await sendTrackedEmail({
      database,
      delivery,
      eventId,
      templateKey: row.templateKey ?? "unknown",
      recipient,
      subject: row.subject,
      html: textToHtml(row.body),
      text: row.body,
      createdByUserId: row.createdByUserId,
      draftDispatchId: row.id,
    });
    if (result.status === "provider_not_configured") {
      continue;
    }
    attempted += 1;
    if (result.status === "sent") {
      sentCount += 1;
      if (result.providerMessageId) {
        providerMessageIds.push(result.providerMessageId);
      }
    } else {
      failures.push(`${recipient.email}: ${result.error ?? "send_failed"}`);
    }
  }

  if (attempted === 0) {
    return { status: "not_configured" };
  }

  const allSent = failures.length === 0;
  await database
    .update(emailDispatches)
    .set({
      status: allSent ? "sent" : "failed",
      providerMessageIds: providerMessageIds.length > 0 ? providerMessageIds : null,
      failureReason: failures.length > 0 ? failures.join("; ") : null,
      sentAt: allSent ? new Date() : null,
    })
    .where(eq(emailDispatches.id, dispatchId));

  return { status: "attempted", sentCount, failedCount: failures.length };
}

export type UpdateDraftDispatchResult = { status: "not_found" } | { status: "not_editable" } | { status: "updated" };

export async function updateDraftDispatch(
  database: EmailDatabase,
  eventId: `evt_${string}`,
  dispatchId: string,
  changes: { subject?: string; body?: string },
): Promise<UpdateDraftDispatchResult> {
  const row = await findDispatch(database, eventId, dispatchId);
  if (row === undefined) {
    return { status: "not_found" };
  }
  if (row.status !== "draft") {
    return { status: "not_editable" };
  }
  await database
    .update(emailDispatches)
    .set({
      subject: changes.subject ?? row.subject,
      body: changes.body ?? row.body,
    })
    .where(eq(emailDispatches.id, dispatchId));
  return { status: "updated" };
}

export type DiscardDraftDispatchResult = { status: "not_found" } | { status: "not_discardable" } | { status: "discarded" };

export async function discardDraftDispatch(
  database: EmailDatabase,
  eventId: `evt_${string}`,
  dispatchId: string,
): Promise<DiscardDraftDispatchResult> {
  const row = await findDispatch(database, eventId, dispatchId);
  if (row === undefined) {
    return { status: "not_found" };
  }
  if (row.status !== "draft") {
    return { status: "not_discardable" };
  }
  await database
    .update(emailDispatches)
    .set({ deletedAt: new Date() })
    .where(eq(emailDispatches.id, dispatchId));
  return { status: "discarded" };
}
