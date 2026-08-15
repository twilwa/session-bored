// ABOUTME: Sends the organizer-created invitation that brings a reviewer to Greenroom.
// ABOUTME: Tracks the attempt in Communications while verified-address redemption remains separate.
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { events } from "../../db/schema.ts";
import { resolveEmailDelivery, type EmailDelivery, type EmailEnvironment } from "../email.ts";
import { sendTrackedEmail, textToHtml } from "./send.ts";

type EmailDatabase = ReturnType<typeof drizzle>;

export const reviewerInvitationTemplateKey = "reviewer_invitation";

/**
 * What the invitation route knows about the invited address when it sends: no account yet, an
 * account whose address is not confirmed, or a confirmed account. The emailed link is the
 * same either way - one link serves every path - only the copy around it changes.
 */
export type InvitedAccountStatus = "none" | "unconfirmed" | "confirmed";

export type ReviewerInvitationResult =
  | { status: "event_not_found" }
  | Awaited<ReturnType<typeof sendTrackedEmail>>;

/**
 * The invitation's own page: one address that works for a brand-new signup and for an
 * existing account. The invite id is the capability, so the page asks for no proof beyond
 * what its accept action already requires - a signed-in account whose confirmed address is
 * the invited one.
 */
export function reviewerInvitationUrl(
  appOrigin: string,
  inviteId: string,
  recipientEmail: string,
): string {
  const url = new URL(`/invitations/${inviteId}`, appOrigin);
  url.searchParams.set("email", recipientEmail);
  return url.toString();
}

/**
 * Where a recipient whose reviewer access is already open belongs: the review work itself.
 * The workspace gate meets a signed-out visit with sign-in and returns them here, so the one
 * link serves both states - and never sends them to an invitation that is already spent.
 */
export function reviewerAreaUrl(appOrigin: string): string {
  return new URL("/reviewer", appOrigin).toString();
}

export async function sendReviewerInvitationEmail(input: {
  database: EmailDatabase;
  env: EmailEnvironment;
  eventId: `evt_${string}`;
  inviteId: string;
  recipientEmail: string;
  accountStatus: InvitedAccountStatus;
  reviewerAccessOpened: boolean;
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

  const destination = input.reviewerAccessOpened
    ? reviewerAreaUrl(input.env.APP_ORIGIN)
    : reviewerInvitationUrl(input.env.APP_ORIGIN, input.inviteId, input.recipientEmail);
  const subject = `Review proposals for ${event.name}`;
  const lead = input.reviewerAccessOpened
    ? `You've been invited to review proposals for ${event.name}. Reviewer access is already open with your existing account.`
    : input.accountStatus === "confirmed"
    ? `You've been invited to review proposals for ${event.name}. Open the invitation to accept reviewer access with your confirmed Greenroom account.`
    : input.accountStatus === "unconfirmed"
    ? `You've been invited to review proposals for ${event.name}. You already have a Greenroom account for this address - confirming the address opens the review committee.`
    : `You've been invited to review proposals for ${event.name}. Create your Greenroom account using this email address, then confirm the address to open the review committee.`;
  const action = input.reviewerAccessOpened ? "Sign in to start reviewing:" : "Open the invitation:";
  const text = [lead, "", action, destination].join("\n");

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
