// ABOUTME: Sends the account address confirmation that Better Auth requests at sign-up.
// ABOUTME: Account mail belongs to no event, so it is logged but never a tracked event dispatch.
import { resolveEmailDelivery, type EmailDelivery, type EmailEnvironment, type EmailDeliveryResult } from "../email.ts";
import { logEmailSendOutcome } from "./send.ts";

export const addressConfirmationTemplateKey = "account.address_confirmation";

export interface AddressConfirmationRecipient {
  name: string;
  email: string;
}

function render(recipient: AddressConfirmationRecipient, confirmUrl: string): { subject: string; html: string; text: string } {
  const subject = "Confirm your Greenroom address";
  const text = [
    `Hello ${recipient.name},`,
    "",
    `Someone created a Greenroom account with this address. Confirm it to finish setting up:`,
    confirmUrl,
    "",
    "Confirming also releases any reviewer invitation sent to this address.",
    "If this was not you, ignore this message and the account stays unconfirmed.",
  ].join("\n");
  const html = [
    `<p>Hello ${recipient.name},</p>`,
    `<p>Someone created a Greenroom account with this address. Confirm it to finish setting up.</p>`,
    `<p><a href="${confirmUrl}">Confirm this address</a></p>`,
    `<p>Confirming also releases any reviewer invitation sent to this address.</p>`,
    `<p>If this was not you, ignore this message and the account stays unconfirmed.</p>`,
  ].join("\n");
  return { subject, html, text };
}

/**
 * Confirming an address is what proves the person signing up owns the mailbox, so it is the
 * only thing that may release a reviewer invitation. Delivery stays best-effort: an
 * unconfigured environment reports `provider_not_configured` and the account remains a
 * perfectly usable attendee account, which is why sign-in never waits on this.
 */
export async function sendAddressConfirmationEmail(
  env: EmailEnvironment,
  recipient: AddressConfirmationRecipient,
  confirmUrl: string,
  delivery?: EmailDelivery,
): Promise<EmailDeliveryResult> {
  const rendered = render(recipient, confirmUrl);
  const result = await (delivery ?? resolveEmailDelivery(env)).send({
    eventId: "platform",
    recipient: recipient.email,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  });
  logEmailSendOutcome({
    templateKey: addressConfirmationTemplateKey,
    recipient: recipient.email,
    eventId: "platform",
    result,
  });
  return result;
}
