// ABOUTME: Stores reviewable decision batches and the once-only queue log for disposition notices.
// ABOUTME: Keeps committee decisions separate from deliberate communication dispatch records.
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
    deliveryStatus: text("delivery_status", { enum: ["queued"] }).notNull().default("queued"),
    queuedAt: integer("queued_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("decision_notice_submission_unique").on(table.submissionId),
    index("decision_notice_batch_idx").on(table.batchId),
  ],
);
