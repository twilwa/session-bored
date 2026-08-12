// ABOUTME: Tells somebody an organizer opened a new area to them, when the organizer asks for it.
// ABOUTME: Never automatic: a grant is silent unless the organizer ticks notify on the grant itself.
import { resolveEmailDelivery, type EmailDelivery, type EmailDeliveryResult, type EmailEnvironment } from "../email.ts";
import { logEmailSendOutcome } from "./send.ts";

export const roleGrantTemplateKey = "account.role_granted";

const areaCopy: Record<"organizer" | "reviewer" | "speaker", { area: string; path: string }> = {
  organizer: { area: "the organizer workspace", path: "/organizer" },
  reviewer: { area: "the review committee", path: "/reviewer" },
  speaker: { area: "the speaker portal", path: "/speaker" },
};

/**
 * Sends only when the organizer asked for it on the grant itself. Greenroom's rule is that a
 * change of state is silent and telling somebody is a deliberate, separate act.
 */
export async function sendRoleGrantEmail(
  env: EmailEnvironment,
  input: {
    recipient: { name: string; email: string };
    role: "organizer" | "reviewer" | "speaker";
  },
  delivery?: EmailDelivery,
): Promise<EmailDeliveryResult> {
  const copy = areaCopy[input.role];
  const url = `${env.APP_ORIGIN}${copy.path}`;
  const subject = `You now have access to ${copy.area}`;
  const text = [
    `Hello ${input.recipient.name},`,
    "",
    `An organizer opened ${copy.area} to your Greenroom account.`,
    url,
  ].join("\n");
  const html = [
    `<p>Hello ${input.recipient.name},</p>`,
    `<p>An organizer opened ${copy.area} to your Greenroom account.</p>`,
    `<p><a href="${url}">Open ${copy.area}</a></p>`,
  ].join("\n");
  const result = await (delivery ?? resolveEmailDelivery(env)).send({
    eventId: "platform",
    recipient: input.recipient.email,
    subject,
    html,
    text,
  });
  logEmailSendOutcome({
    templateKey: roleGrantTemplateKey,
    recipient: input.recipient.email,
    eventId: "platform",
    result,
  });
  return result;
}
