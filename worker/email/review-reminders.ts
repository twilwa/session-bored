// ABOUTME: Creates reviewable Communications drafts for reviewers who still owe proposal reads.
// ABOUTME: Keeps reminder drafting separate from the organizer's explicit approve-and-send action.
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { emailDispatches } from "../../db/schema.ts";
import { reviewReminderTemplate } from "./templates.ts";

type EmailDatabase = ReturnType<typeof drizzle>;

interface OutstandingReviewRecipient {
  reviewerUserId: string;
  recipientName: string;
  recipientEmail: string;
  outstandingReviewCount: number;
}

export interface DraftOutstandingReviewRemindersInput {
  database: EmailDatabase;
  eventId: `evt_${string}`;
  eventName: string;
  reviewUrl: string;
  createdByUserId: string;
  recipients: OutstandingReviewRecipient[];
}

/**
 * Writes one draft per selected reviewer. A draft stays editable and cannot reach a provider
 * until the organizer approves it through the existing Communications dispatch path.
 */
export async function draftOutstandingReviewReminders(
  input: DraftOutstandingReviewRemindersInput,
): Promise<{
  drafts: Array<{
    dispatchId: string;
    reviewerUserId: string;
    recipientName: string;
    recipientEmail: string;
    outstandingReviewCount: number;
  }>;
  skippedReviewerUserIds: string[];
}> {
  const existingDrafts = await input.database
    .select({ recipients: emailDispatches.recipients })
    .from(emailDispatches)
    .where(and(
      eq(emailDispatches.eventId, input.eventId),
      eq(emailDispatches.templateKey, reviewReminderTemplate.key),
      eq(emailDispatches.status, "draft"),
      isNull(emailDispatches.deletedAt),
    ));
  const alreadyDrafted = new Set(
    existingDrafts.flatMap((row) => row.recipients.map((recipient) => recipient.email.toLowerCase())),
  );
  const drafts = [];
  const skippedReviewerUserIds: string[] = [];

  for (const recipient of input.recipients) {
    const recipientEmail = recipient.recipientEmail.trim();
    if (recipientEmail === "" || alreadyDrafted.has(recipientEmail.toLowerCase())) {
      skippedReviewerUserIds.push(recipient.reviewerUserId);
      continue;
    }
    const rendered = reviewReminderTemplate.render({
      eventName: input.eventName,
      recipientName: recipient.recipientName,
      outstandingReviewCount: recipient.outstandingReviewCount,
      reviewUrl: input.reviewUrl,
    });
    const [dispatch] = await input.database
      .insert(emailDispatches)
      .values({
        eventId: input.eventId,
        templateKey: reviewReminderTemplate.key,
        subject: rendered.subject,
        body: rendered.text,
        recipients: [{ email: recipientEmail, name: recipient.recipientName }],
        status: "draft",
        createdByUserId: input.createdByUserId,
      })
      .returning({ id: emailDispatches.id });
    if (dispatch === undefined) {
      continue;
    }
    alreadyDrafted.add(recipientEmail.toLowerCase());
    drafts.push({
      dispatchId: dispatch.id,
      reviewerUserId: recipient.reviewerUserId,
      recipientName: recipient.recipientName,
      recipientEmail,
      outstandingReviewCount: recipient.outstandingReviewCount,
    });
  }

  return { drafts, skippedReviewerUserIds };
}
