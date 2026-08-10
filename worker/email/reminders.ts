// ABOUTME: Drafts F-11.7 assisted-chasing reminders for speakers with overdue tasks into the review queue.
// ABOUTME: Never sends anything itself - drafting and sending are deliberately separate acts.
import { and, eq, isNotNull, isNull, lt, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { emailDispatches, events, people, speakers, taskAssignees, tasks } from "../../db/schema.ts";
import { taskReminderTemplate } from "./templates.ts";

type EmailDatabase = ReturnType<typeof drizzle>;

export interface DraftOverdueRemindersInput {
  database: EmailDatabase;
  eventId: `evt_${string}`;
  appOrigin: string;
  now: Date;
  createdByUserId: string;
}

export interface DraftedReminder {
  dispatchId: string;
  speakerId: string;
  recipientEmail: string;
  recipientName: string;
  overdueTaskCount: number;
}

interface SpeakerOverdueTasks {
  recipientName: string;
  recipientEmail: string;
  tasks: Array<{ title: string; dueAt: Date }>;
}

/**
 * Finds speakers with overdue, incomplete tasks and drafts one reminder email
 * per speaker as a `draft` row in `email_dispatch`. Nothing is sent here - an
 * organizer must review, optionally edit, and explicitly approve each draft
 * (see `sendQueuedDispatch` in dispatch-queue.ts) before anything reaches a
 * recipient. Speakers who already have an un-sent reminder draft are skipped
 * so re-running this doesn't pile up duplicate drafts.
 */
export async function draftOverdueTaskReminders(
  input: DraftOverdueRemindersInput,
): Promise<{ drafted: DraftedReminder[]; skipped: number }> {
  const { database, eventId, now } = input;
  const [event] = await database.select({ name: events.name }).from(events).where(eq(events.id, eventId));
  if (event === undefined) {
    return { drafted: [], skipped: 0 };
  }

  const overdueRows = await database
    .select({
      speakerId: speakers.id,
      recipientName: people.name,
      recipientEmail: people.email,
      taskTitle: tasks.title,
      dueAt: tasks.dueAt,
    })
    .from(taskAssignees)
    .innerJoin(tasks, eq(taskAssignees.taskId, tasks.id))
    .innerJoin(speakers, eq(taskAssignees.speakerId, speakers.id))
    .innerJoin(people, eq(speakers.personId, people.id))
    .where(
      and(
        eq(tasks.eventId, eventId),
        eq(tasks.status, "active"),
        ne(taskAssignees.status, "completed"),
        isNull(tasks.deletedAt),
        isNull(taskAssignees.deletedAt),
        isNotNull(tasks.dueAt),
        lt(tasks.dueAt, now),
      ),
    );

  const bySpeaker = new Map<string, SpeakerOverdueTasks>();
  for (const row of overdueRows) {
    if (row.dueAt === null) {
      continue;
    }
    const entry = bySpeaker.get(row.speakerId) ??
      { recipientName: row.recipientName, recipientEmail: row.recipientEmail, tasks: [] };
    entry.tasks.push({ title: row.taskTitle, dueAt: row.dueAt });
    bySpeaker.set(row.speakerId, entry);
  }
  if (bySpeaker.size === 0) {
    return { drafted: [], skipped: 0 };
  }

  const existingDrafts = await database
    .select({ recipients: emailDispatches.recipients })
    .from(emailDispatches)
    .where(
      and(
        eq(emailDispatches.eventId, eventId),
        eq(emailDispatches.templateKey, taskReminderTemplate.key),
        eq(emailDispatches.status, "draft"),
        isNull(emailDispatches.deletedAt),
      ),
    );
  const alreadyDrafted = new Set(
    existingDrafts.flatMap((row) => (row.recipients ?? []).map((recipient) => recipient.email)),
  );

  const drafted: DraftedReminder[] = [];
  let skipped = 0;
  for (const [speakerId, entry] of bySpeaker) {
    const email = entry.recipientEmail?.trim();
    if (!email || alreadyDrafted.has(email)) {
      skipped += 1;
      continue;
    }
    const taskList = entry.tasks
      .map((task) => `- ${task.title} (was due ${task.dueAt.toISOString().slice(0, 10)})`)
      .join("\n");
    const rendered = taskReminderTemplate.render({
      eventName: event.name,
      recipientName: entry.recipientName,
      taskList,
      portalUrl: `${input.appOrigin}/speaker`,
    });
    const [row] = await database
      .insert(emailDispatches)
      .values({
        eventId,
        templateKey: taskReminderTemplate.key,
        subject: rendered.subject,
        body: rendered.text,
        recipients: [{ email, name: entry.recipientName }],
        status: "draft",
        createdByUserId: input.createdByUserId,
      })
      .returning();
    if (row === undefined) {
      continue;
    }
    drafted.push({
      dispatchId: row.id,
      speakerId,
      recipientEmail: email,
      recipientName: entry.recipientName,
      overdueTaskCount: entry.tasks.length,
    });
  }

  return { drafted, skipped };
}
