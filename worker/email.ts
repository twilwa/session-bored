// ABOUTME: Defines Greenroom's provider-neutral transactional email boundary.
// ABOUTME: Fails visibly until the communications lane configures a delivery provider.
export interface EmailMessage {
  eventId: `evt_${string}`;
  recipient: string;
  subject: string;
  html: string;
  text: string;
}

export interface EmailDeliveryResult {
  status: "provider_not_configured" | "sent";
  providerMessageId?: string;
}

export interface EmailDelivery {
  send(message: EmailMessage): Promise<EmailDeliveryResult>;
}

export const emailDelivery: EmailDelivery = {
  async send(_message) {
    return { status: "provider_not_configured" };
  },
};
