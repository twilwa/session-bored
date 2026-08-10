// ABOUTME: Tracks and logs every email Greenroom actually attempts to send.
// ABOUTME: Writes one email_dispatch row per recipient so sends stay auditable and retryable.
import { drizzle } from "drizzle-orm/d1";
import { emailDispatches } from "../../db/schema.ts";
import type { EmailAttachment, EmailDelivery, EmailDeliveryResult } from "../email.ts";

type EmailDatabase = ReturnType<typeof drizzle>;

export interface TrackedRecipient {
  email: string;
  name?: string;
}

export interface SendTrackedEmailInput {
  database: EmailDatabase;
  delivery: EmailDelivery;
  eventId: `evt_${string}`;
  templateKey: string;
  recipient: TrackedRecipient;
  subject: string;
  html: string;
  text: string;
  attachments?: EmailAttachment[];
  createdByUserId?: string | null;
}

/**
 * The single choke point every Greenroom send site should call through. It
 * delegates the network attempt to the injected `delivery`, logs a structured
 * outcome line, and - only once a real attempt was made - writes one
 * `email_dispatch` row per recipient so the send is later visible and, on
 * failure, distinguishable from a recipient who was silently never told.
 * Nothing is logged when delivery reports `provider_not_configured`, since no
 * attempt to reach the recipient actually happened.
 */
export function logEmailSendOutcome(params: {
  templateKey: string;
  recipient: string;
  eventId: `evt_${string}`;
  result: EmailDeliveryResult;
}): void {
  console.log(JSON.stringify({
    message: "email_send",
    template: params.templateKey,
    recipient: params.recipient,
    eventId: params.eventId,
    status: params.result.status,
    providerMessageId: params.result.providerMessageId ?? null,
    error: params.result.error ?? null,
  }));
}

export async function sendTrackedEmail(input: SendTrackedEmailInput): Promise<EmailDeliveryResult> {
  const result = await input.delivery.send({
    eventId: input.eventId,
    recipient: input.recipient.email,
    subject: input.subject,
    html: input.html,
    text: input.text,
    ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
  });

  logEmailSendOutcome({ templateKey: input.templateKey, recipient: input.recipient.email, eventId: input.eventId, result });

  if (result.status === "provider_not_configured") {
    return result;
  }

  await input.database.insert(emailDispatches).values({
    eventId: input.eventId,
    templateKey: input.templateKey,
    subject: input.subject,
    body: input.text,
    recipients: [input.recipient],
    status: result.status,
    providerMessageIds: result.providerMessageId ? [result.providerMessageId] : null,
    failureReason: result.error ?? null,
    sentAt: result.status === "sent" ? new Date() : null,
    createdByUserId: input.createdByUserId ?? null,
  });

  return result;
}

export function textToHtml(text: string): string {
  const escaped = text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return escaped
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${paragraph.replaceAll("\n", "<br>")}</p>`)
    .join("\n");
}
