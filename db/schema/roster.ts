// ABOUTME: Records whether a task targets explicitly selected speakers instead of future event speakers.
// ABOUTME: Keeps ad-hoc organizer work separate from event-wide onboarding templates.
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { tasks } from "../schema.ts";

export const taskScopes = sqliteTable("task_scope", {
  taskId: text("task_id").primaryKey().references(() => tasks.id, { onDelete: "cascade" }),
  scope: text("scope", { enum: ["selected_speakers"] }).notNull(),
});
