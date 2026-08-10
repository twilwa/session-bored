// ABOUTME: Stores event opt-in and cached AI-generated review reading aids.
// ABOUTME: Keeps machine summaries and suggestions separate from human reviews and decisions.
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const generatedId = (prefix: "ais" | "aig") =>
  text("id")
    .primaryKey()
    .$defaultFn(() => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`);
const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date());
const updatedAt = () =>
  integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date());

export const eventReviewConfigs = sqliteTable("event_review_config", {
  eventId: text("event_id").primaryKey(),
  aiAssistanceEnabled: integer("ai_assistance_enabled", { mode: "boolean" })
    .notNull()
    .default(false),
  updatedByUserId: text("updated_by_user_id").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const aiSubmissionSummaries = sqliteTable(
  "ai_submission_summary",
  {
    id: generatedId("ais"),
    submissionId: text("submission_id").notNull(),
    formVersion: integer("form_version").notNull(),
    visibility: text("visibility", { enum: ["identified", "blind"] }).notNull(),
    summary: text("summary").notNull(),
    model: text("model").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("ai_summary_submission_version_visibility_unique").on(
      table.submissionId,
      table.formVersion,
      table.visibility,
    ),
    index("ai_summary_submission_idx").on(table.submissionId),
  ],
);

export const aiScoreSuggestions = sqliteTable(
  "ai_score_suggestion",
  {
    id: generatedId("aig"),
    submissionId: text("submission_id").notNull(),
    formVersion: integer("form_version").notNull(),
    roundId: text("round_id").notNull(),
    visibility: text("visibility", { enum: ["identified", "blind"] }).notNull(),
    criteriaFingerprint: text("criteria_fingerprint").notNull(),
    scores: text("scores", { mode: "json" }).$type<Record<string, string | number>>().notNull(),
    reasoning: text("reasoning", { mode: "json" }).$type<Record<string, string>>().notNull(),
    model: text("model").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("ai_score_submission_round_criteria_unique").on(
      table.submissionId,
      table.formVersion,
      table.roundId,
      table.visibility,
      table.criteriaFingerprint,
    ),
    index("ai_score_submission_round_idx").on(table.submissionId, table.roundId),
  ],
);
