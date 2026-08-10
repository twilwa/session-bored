// ABOUTME: Sends transactional email through the Resend HTTP API.
// ABOUTME: Never throws across the delivery boundary; network and API failures resolve to a failed result.
import type { EmailAttachment, EmailDelivery, EmailDeliveryResult, EmailMessage } from "../email.ts";

export interface ResendConfig {
  apiKey: string;
  fromAddress: string;
  endpoint?: string;
}

interface ResendAttachment {
  filename: string;
  content: string;
  content_type: string;
}

function toResendAttachment(attachment: EmailAttachment): ResendAttachment {
  return {
    filename: attachment.filename,
    content: attachment.content,
    content_type: attachment.contentType,
  };
}

export function createResendEmailDelivery(config: ResendConfig): EmailDelivery {
  const endpoint = config.endpoint ?? "https://api.resend.com/emails";
  return {
    async send(message: EmailMessage): Promise<EmailDeliveryResult> {
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            from: config.fromAddress,
            to: [message.recipient],
            subject: message.subject,
            html: message.html,
            text: message.text,
            attachments: message.attachments?.map(toResendAttachment),
          }),
        });
      } catch (error) {
        return { status: "failed", error: error instanceof Error ? error.message : "network_error" };
      }
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        return { status: "failed", error: `resend_${response.status}: ${body.slice(0, 300)}` };
      }
      const payload = await response.json<{ id?: string }>().catch(() => ({}) as { id?: string });
      return payload.id === undefined ? { status: "sent" } : { status: "sent", providerMessageId: payload.id };
    },
  };
}
