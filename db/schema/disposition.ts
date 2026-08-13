// ABOUTME: Stores reviewable decision batches and the once-only queue log for disposition notices.
// ABOUTME: Keeps committee decisions separate from deliberate communication dispatch records.
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const decisionOutcomes = ["accepted", "maybe", "declined"] as const;

const dispatchId = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => `eml_${crypto.randomUUID().replaceAll("-", "")}`);
const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date());
const updatedAt = () =>
  integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date());

export const decisionBatches = sqliteTable(
  "decision_batch",
  {
    id: dispatchId(),
    eventId: text("event_id").notNull(),
    status: text("status", { enum: ["draft", "queued"] }).notNull().default("draft"),
    createdByUserId: text("created_by_user_id").notNull(),
    dispatchedAt: integer("dispatched_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("decision_batch_event_status_idx").on(table.eventId, table.status)],
);

export const decisionBatchItems = sqliteTable(
  "decision_batch_item",
  {
    id: dispatchId(),
    batchId: text("batch_id").notNull(),
    submissionId: text("submission_id").notNull(),
    recipientName: text("recipient_name").notNull(),
    recipientEmail: text("recipient_email").notNull(),
    outcome: text("outcome", { enum: decisionOutcomes }).notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    dispatchedAt: integer("dispatched_at", { mode: "timestamp_ms" }),
    /**
     * Set when the letter this item would queue was retired. A preview rendered before a
     * correction freezes the recipient and copy that the correction replaced, so dispatching it
     * afterwards would silently reinstate them. Stamped by the cancellation itself rather than
     * inferred by comparing timestamps, which cannot order two writes in the same millisecond.
     */
    supersededAt: integer("superseded_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("decision_batch_item_unique").on(table.batchId, table.submissionId),
    index("decision_batch_item_submission_idx").on(table.submissionId),
  ],
);

export const decisionNotices = sqliteTable(
  "decision_notice",
  {
    id: dispatchId(),
    batchId: text("batch_id").notNull(),
    submissionId: text("submission_id").notNull(),
    outcome: text("outcome", { enum: decisionOutcomes }).notNull(),
    recipientName: text("recipient_name").notNull(),
    recipientEmail: text("recipient_email").notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    /**
     * `sending` is a claim, taken atomically before the provider call and released by its
     * outcome. It is what makes cancelling and sending mutually exclusive: whoever wins the
     * claim owns the letter, and the loser is refused rather than acting on a stale read.
     */
    deliveryStatus: text("delivery_status", { enum: ["queued", "sending", "sent", "failed"] })
      .notNull()
      .default("queued"),
    /** When the current `sending` claim was taken, so an abandoned one can be recognised. */
    sendingSince: integer("sending_since", { mode: "timestamp_ms" }),
    sentAt: integer("sent_at", { mode: "timestamp_ms" }),
    providerMessageId: text("provider_message_id"),
    failureReason: text("failure_reason"),
    queuedAt: integer("queued_at", { mode: "timestamp_ms" }).notNull(),
    cancelledAt: integer("cancelled_at", { mode: "timestamp_ms" }),
    cancelledByUserId: text("cancelled_by_user_id"),
    cancellationReason: text("cancellation_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // One live letter per submission, which is what makes dispatch once-only. A cancelled
    // letter stays for the record and releases the submission so a corrected letter can be
    // reviewed and queued in its place.
    uniqueIndex("decision_notice_submission_unique")
      .on(table.submissionId)
      .where(sql`${table.cancelledAt} is null`),
    index("decision_notice_batch_idx").on(table.batchId),
  ],
);
