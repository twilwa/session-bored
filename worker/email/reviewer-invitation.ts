// ABOUTME: Sends the organizer-created invitation that brings a reviewer to Greenroom.
// ABOUTME: Tracks the attempt in Communications while verified-address redemption remains separate.
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { events } from "../../db/schema.ts";
import { resolveEmailDelivery, type EmailDelivery, type EmailEnvironment } from "../email.ts";
import { sendTrackedEmail, textToHtml } from "./send.ts";

type EmailDatabase = ReturnType<typeof drizzle>;

export const reviewerInvitationTemplateKey = "reviewer_invitation";

export type ReviewerInvitationResult =
  | { status: "event_not_found" }
  | Awaited<ReturnType<typeof sendTrackedEmail>>;

export async function sendReviewerInvitationEmail(input: {
  database: EmailDatabase;
  env: EmailEnvironment;
  eventId: `evt_${string}`;
  recipientEmail: string;
  createdByUserId: string;
  delivery?: EmailDelivery;
}): Promise<ReviewerInvitationResult> {
  const [event] = await input.database
    .select({ name: events.name })
    .from(events)
    .where(eq(events.id, input.eventId));
  if (event === undefined) {
    return { status: "event_not_found" };
  }

  const signupUrl = new URL("/signup", input.env.APP_ORIGIN);
  signupUrl.searchParams.set("email", input.recipientEmail);
  const subject = `Review proposals for ${event.name}`;
  const text = [
    `You've been invited to review proposals for ${event.name}.`,
    "",
    "Create your Greenroom account using this email address, then confirm the address to open the review committee:",
    signupUrl.toString(),
  ].join("\n");

  return sendTrackedEmail({
    database: input.database,
    delivery: input.delivery ?? resolveEmailDelivery(input.env),
    eventId: input.eventId,
    templateKey: reviewerInvitationTemplateKey,
    recipient: { email: input.recipientEmail },
    subject,
    html: textToHtml(text),
    text,
    createdByUserId: input.createdByUserId,
  });
}
