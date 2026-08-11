// ABOUTME: Stores organizer-authored communication templates scoped to one event.
// ABOUTME: Soft deletion preserves dispatch snapshots while removing templates from future use.
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date());
const updatedAt = () =>
  integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date());

export const communicationTemplates = sqliteTable(
  "communication_template",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => `tmpl_${crypto.randomUUID().replaceAll("-", "")}`),
    eventId: text("event_id").notNull(),
    name: text("name").notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    mergeFields: text("merge_fields", { mode: "json" }).$type<string[]>().notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  },
  (table) => [index("communication_template_event_idx").on(table.eventId, table.deletedAt)],
);
