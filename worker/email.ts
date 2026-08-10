// ABOUTME: Defines Greenroom's provider-neutral transactional email boundary.
// ABOUTME: Reports provider_not_configured until Wrangler secrets supply a real Resend key.
import { createResendEmailDelivery } from "./email/resend.ts";

export interface EmailAttachment {
  filename: string;
  content: string;
  contentType: string;
}

export interface EmailMessage {
  eventId: `evt_${string}`;
  recipient: string;
  subject: string;
  html: string;
  text: string;
  attachments?: EmailAttachment[];
}

export interface EmailDeliveryResult {
  status: "provider_not_configured" | "sent" | "failed";
  providerMessageId?: string;
  error?: string;
}

export interface EmailDelivery {
  send(message: EmailMessage): Promise<EmailDeliveryResult>;
}

export const emailDelivery: EmailDelivery = {
  async send(_message) {
    return { status: "provider_not_configured" };
  },
};

export interface EmailEnvironment {
  APP_ORIGIN: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_DOMAIN?: string;
  RESEND_FROM_ADDRESS?: string;
}

/**
 * Picks the real Resend-backed sender when Wrangler secrets are present, and the
 * visibly-unconfigured stub otherwise. Every send site should resolve delivery
 * through this function rather than importing `emailDelivery` directly, so that
 * running without secrets configured (local dev, CI, this repo's own tests)
 * degrades to the same safe, network-free behavior everywhere.
 */
export function isEmailConfigured(env: EmailEnvironment): boolean {
  return Boolean(env.RESEND_API_KEY && env.RESEND_FROM_ADDRESS);
}

export function resolveEmailDelivery(env: EmailEnvironment): EmailDelivery {
  if (!isEmailConfigured(env)) {
    return emailDelivery;
  }
  return createResendEmailDelivery({ apiKey: env.RESEND_API_KEY!, fromAddress: env.RESEND_FROM_ADDRESS! });
}
