// ABOUTME: Sends the F-11.2 submission confirmation once a proposal is actually submitted.
// ABOUTME: Skips silently when the submitter has no address on file; never invents one.
import { drizzle } from "drizzle-orm/d1";
import { resolveEmailDelivery, type EmailDelivery, type EmailEnvironment } from "../email.ts";
import { submissionConfirmationTemplate } from "./templates.ts";
import { sendTrackedEmail } from "./send.ts";

type EmailDatabase = ReturnType<typeof drizzle>;

export interface SubmissionConfirmationInput {
  env: EmailEnvironment;
  database: EmailDatabase;
  eventId: `evt_${string}`;
  eventName: string;
  recipientEmail: string | null | undefined;
  recipientName: string;
  submissionTitle: string;
  returnUrl: string;
  /** The form's own configured confirmation email copy (may contain a `{talk_title}` token), if the organizer set one. */
  formConfirmationCopy?: string | null;
  /** Inject a fake delivery in tests so nothing reaches the network. */
  delivery?: EmailDelivery;
}

export type SubmissionConfirmationResult =
  | { status: "skipped_no_address" }
  | Awaited<ReturnType<typeof sendTrackedEmail>>;

export async function sendSubmissionConfirmationEmail(
  input: SubmissionConfirmationInput,
): Promise<SubmissionConfirmationResult> {
  const email = input.recipientEmail?.trim();
  if (!email) {
    return { status: "skipped_no_address" };
  }
  const submissionTitle = input.submissionTitle || "your proposal";
  const customCopy = input.formConfirmationCopy?.replaceAll("{talk_title}", submissionTitle);
  const rendered = submissionConfirmationTemplate.render({
    eventName: input.eventName,
    recipientName: input.recipientName,
    submissionTitle,
    returnUrl: input.returnUrl,
    ...(customCopy === undefined ? {} : { customCopy }),
  });
  return sendTrackedEmail({
    database: input.database,
    delivery: input.delivery ?? resolveEmailDelivery(input.env),
    eventId: input.eventId,
    templateKey: submissionConfirmationTemplate.key,
    recipient: { email, name: input.recipientName },
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  });
}
