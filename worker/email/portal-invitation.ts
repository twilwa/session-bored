// ABOUTME: Sends the F-6.6 / F-11.4 portal invitation for one speaker, on deliberate organizer action.
// ABOUTME: The single entry point other lanes (roster) should call instead of duplicating sending code.
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { events, people, speakers } from "../../db/schema.ts";
import { resolveEmailDelivery, type EmailDelivery, type EmailEnvironment } from "../email.ts";
import { sendTrackedEmail } from "./send.ts";
import { portalInvitationTemplate } from "./templates.ts";

export interface PortalInvitationEnvironment extends EmailEnvironment {
  DB: D1Database;
}

export interface SendPortalInvitationInput {
  env: PortalInvitationEnvironment;
  eventId: `evt_${string}`;
  speakerId: `spk_${string}`;
  createdByUserId?: string | null;
  /** Inject a fake delivery in tests so nothing reaches the network. */
  delivery?: EmailDelivery;
}

export type PortalInvitationResult =
  | { status: "speaker_not_found" }
  | { status: "skipped_no_address" }
  | Awaited<ReturnType<typeof sendTrackedEmail>>;

/**
 * Looks up the speaker, renders the portal invitation, and sends it. Callers
 * only need an event ID and speaker ID - this owns its own database access so
 * the roster lane never has to reimplement sending or template rendering.
 * Never call this from a status-change hook; it must stay a deliberate,
 * organizer-triggered action.
 */
export async function sendPortalInvitationEmail(input: SendPortalInvitationInput): Promise<PortalInvitationResult> {
  const database = drizzle(input.env.DB);
  const [row] = await database
    .select({
      eventName: events.name,
      recipientName: people.name,
      recipientEmail: people.email,
    })
    .from(speakers)
    .innerJoin(people, eq(speakers.personId, people.id))
    .innerJoin(events, eq(speakers.eventId, events.id))
    .where(and(
      eq(speakers.id, input.speakerId),
      eq(speakers.eventId, input.eventId),
      sql`${speakers.deletedAt} is null`,
    ));
  if (row === undefined) {
    return { status: "speaker_not_found" };
  }
  const email = row.recipientEmail?.trim();
  if (!email) {
    return { status: "skipped_no_address" };
  }
  const rendered = portalInvitationTemplate.render({
    eventName: row.eventName,
    recipientName: row.recipientName,
    portalUrl: `${input.env.APP_ORIGIN}/speaker`,
  });
  return sendTrackedEmail({
    database,
    delivery: input.delivery ?? resolveEmailDelivery(input.env),
    eventId: input.eventId,
    templateKey: portalInvitationTemplate.key,
    recipient: { email, name: row.recipientName },
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    createdByUserId: input.createdByUserId ?? null,
  });
}
