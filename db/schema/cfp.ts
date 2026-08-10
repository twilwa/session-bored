// ABOUTME: Stores the author credential that makes anonymous CFP drafts resumable and editable.
// ABOUTME: Keeps the raw credential out of D1 while tying one author access record to one submission.
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const submissionAuthorAccess = sqliteTable(
  "submission_author_access",
  {
    submissionId: text("submission_id").primaryKey(),
    authorKeyHash: text("author_key_hash").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date()),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("submission_author_key_unique").on(table.authorKeyHash),
    index("submission_author_updated_idx").on(table.updatedAt),
  ],
);
