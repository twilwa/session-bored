// ABOUTME: Stores private speaker-directory metadata and attributed identity merges.
// ABOUTME: Keeps organizer tags, fields, notes, and archived duplicates outside event rosters.
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { people, users } from "../schema.ts";
import type {
  SpeakerDirectoryDuplicateReason,
  SpeakerDirectorySavedFilters,
} from "../../shared/speaker-directory.ts";

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

export const speakerDirectoryTags = sqliteTable(
  "speaker_directory_tag",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => `dtag_${crypto.randomUUID().replaceAll("-", "")}`),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date()),
  },
  (table) => [uniqueIndex("speaker_directory_tag_name_unique").on(table.normalizedName)],
);

export const speakerDirectoryContactTags = sqliteTable(
  "speaker_directory_contact_tag",
  {
    personId: text("person_id").notNull().references(() => people.id),
    tagId: text("tag_id").notNull().references(() => speakerDirectoryTags.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    primaryKey({ columns: [table.personId, table.tagId] }),
    index("speaker_directory_contact_tag_person_idx").on(table.personId),
    index("speaker_directory_contact_tag_tag_idx").on(table.tagId, table.personId),
  ],
);

export const speakerDirectoryCustomFields = sqliteTable(
  "speaker_directory_custom_field",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => `dcf_${crypto.randomUUID().replaceAll("-", "")}`),
    personId: text("person_id").notNull().references(() => people.id),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    value: text("value").notNull(),
    normalizedValue: text("normalized_value").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("speaker_directory_custom_field_person_name_unique")
      .on(table.personId, table.normalizedName),
    index("speaker_directory_custom_field_filter_idx")
      .on(table.normalizedName, table.normalizedValue, table.personId),
    index("speaker_directory_custom_field_person_idx").on(table.personId),
  ],
);

export const speakerDirectoryNotes = sqliteTable(
  "speaker_directory_note",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => `dnote_${crypto.randomUUID().replaceAll("-", "")}`),
    personId: text("person_id").notNull().references(() => people.id),
    authorUserId: text("author_user_id").notNull().references(() => users.id),
    body: text("body").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date()),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  },
  (table) => [index("speaker_directory_note_person_idx").on(table.personId, table.deletedAt, table.createdAt)],
);

export const speakerDirectorySegments = sqliteTable(
  "speaker_directory_segment",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => `dseg_${crypto.randomUUID().replaceAll("-", "")}`),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    filters: text("filters", { mode: "json" }).$type<SpeakerDirectorySavedFilters>().notNull(),
    createdByUserId: text("created_by_user_id").notNull().references(() => users.id),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date()),
  },
  (table) => [uniqueIndex("speaker_directory_segment_name_unique").on(table.normalizedName)],
);
