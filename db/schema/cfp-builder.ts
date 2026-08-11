// ABOUTME: Stores immutable CFP form versions and their ordered field snapshots.
// ABOUTME: Keeps a stable public form identity while submissions pin the contract they used.
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { formFields, forms } from "../schema.ts";

const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date());
const updatedAt = () =>
  integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date());

export const formVersions = sqliteTable(
  "form_version",
  {
    id: text("id").primaryKey(),
    formId: text("form_id").notNull().references(() => forms.id),
    version: integer("version").notNull(),
    status: text("status", { enum: ["draft", "published", "closed"] })
      .notNull()
      .default("draft"),
    openAt: integer("open_at", { mode: "timestamp_ms" }),
    closeAt: integer("close_at", { mode: "timestamp_ms" }),
    welcomeCopy: text("welcome_copy"),
    confirmationCopy: text("confirmation_copy"),
    confirmationEmailCopy: text("confirmation_email_copy"),
    minimumSpeakers: integer("minimum_speakers").notNull().default(1),
    maximumSpeakers: integer("maximum_speakers"),
    publishedAt: integer("published_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("form_version_number_unique").on(table.formId, table.version),
    index("form_version_status_idx").on(table.formId, table.status),
    check("form_version_minimum_speakers_check", sql`${table.minimumSpeakers} >= 1`),
  ],
);

export const formVersionFields = sqliteTable(
  "form_version_field",
  {
    id: text("id").primaryKey(),
    formVersionId: text("form_version_id").notNull().references(() => formVersions.id),
    stableFieldId: text("stable_field_id").notNull().references(() => formFields.id),
    key: text("key").notNull(),
    label: text("label").notNull(),
    description: text("description"),
    fieldType: text("field_type", { enum: ["short_text", "long_text", "dropdown"] }).notNull(),
    required: integer("required", { mode: "boolean" }).notNull().default(false),
    visibleInBlindReview: integer("visible_in_blind_review", { mode: "boolean" })
      .notNull()
      .default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    options: text("options", { mode: "json" }).$type<string[]>(),
    conditionalFieldId: text("conditional_field_id").references(
      (): AnySQLiteColumn => formVersionFields.id,
    ),
    conditionalOperator: text("conditional_operator", { enum: ["equals"] }),
    conditionalValue: text("conditional_value"),
    validation: text("validation", { mode: "json" }).$type<Record<string, string | number>>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("form_version_field_key_unique").on(table.formVersionId, table.key),
    index("form_version_field_order_idx").on(table.formVersionId, table.sortOrder),
  ],
);
