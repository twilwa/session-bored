// ABOUTME: Records attributed speaker-directory merges while preserving both person rows as history.
// ABOUTME: Makes an archived duplicate traceable to the canonical person an organizer kept.
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { people, users } from "../schema.ts";
import type { SpeakerDirectoryDuplicateReason } from "../../shared/speaker-directory.ts";

export const directoryMerges = sqliteTable(
  "directory_merge",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => `pmg_${crypto.randomUUID().replaceAll("-", "")}`),
    keptPersonId: text("kept_person_id").notNull().references(() => people.id),
    mergedPersonId: text("merged_person_id").notNull().references(() => people.id),
    mergedByUserId: text("merged_by_user_id").notNull().references(() => users.id),
    reasons: text("reasons", { mode: "json" }).$type<SpeakerDirectoryDuplicateReason[]>().notNull(),
    mergedProfile: text("merged_profile", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("directory_merge_merged_person_unique").on(table.mergedPersonId),
    index("directory_merge_kept_person_idx").on(table.keptPersonId),
  ],
);
