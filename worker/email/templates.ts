// ABOUTME: Manages built-in and event-authored merge-field templates, recipients, previews, and draft queueing.
// ABOUTME: Decision letters remain in disposition.ts; this module owns only Communications template workflows.
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  communicationTemplates,
  emailDispatches,
  events,
  people,
  speakers,
} from "../../db/schema.ts";
import { textToHtml } from "./send.ts";

type EmailDatabase = ReturnType<typeof drizzle>;

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export type AuthoredTemplateRenderResult =
  | { status: "rendered"; email: RenderedEmail }
  | { status: "missing_fields"; fields: string[] };

export function findMergeFields(template: { subject: string; body: string }): string[] {
  const fields: string[] = [];
  for (const value of [template.subject, template.body]) {
    for (const match of value.matchAll(/{{\s*([a-zA-Z][a-zA-Z0-9]*)\s*}}/g)) {
      const field = match[1];
      if (field !== undefined && !fields.includes(field)) {
        fields.push(field);
      }
    }
  }
  return fields;
}

export function hasValidMergeFieldSyntax(template: { subject: string; body: string }): boolean {
  return [template.subject, template.body].every((value) => {
    const withoutFields = value.replace(/{{\s*[a-zA-Z][a-zA-Z0-9]*\s*}}/g, "");
    return !withoutFields.includes("{{") && !withoutFields.includes("}}");
  });
}

export function renderAuthoredTemplate(
  template: { subject: string; body: string },
  context: Record<string, string>,
): AuthoredTemplateRenderResult {
  const missingFields = findMergeFields(template).filter((field) => context[field] === undefined);
  if (missingFields.length > 0) {
    return { status: "missing_fields", fields: missingFields };
  }
  const substitute = (value: string) => value.replace(
    /{{\s*([a-zA-Z][a-zA-Z0-9]*)\s*}}/g,
    (_placeholder, field: string) => context[field] ?? "",
  );
  const subject = substitute(template.subject);
  const text = substitute(template.body);
  return { status: "rendered", email: { subject, text, html: textToHtml(text) } };
}

export interface SubmissionConfirmationContext {
  eventName: string;
  recipientName: string;
  submissionTitle: string;
  returnUrl: string;
  /** The form's own configured confirmation copy, merge-substituted by the caller. Falls back to a default message when absent. */
  customCopy?: string;
}

export interface PortalInvitationContext {
  eventName: string;
  recipientName: string;
  portalUrl: string;
}

export interface TaskReminderContext {
  eventName: string;
  recipientName: string;
  taskList: string;
  portalUrl: string;
}

export const submissionConfirmationTemplate = {
  key: "submission_confirmation" as const,
  mergeFields: ["eventName", "recipientName", "submissionTitle", "returnUrl"] as const,
  render(context: SubmissionConfirmationContext): RenderedEmail {
    const subject = `We received your proposal for ${context.eventName}`;
    const message = context.customCopy?.trim() ||
      `Thanks for submitting "${context.submissionTitle}" to ${context.eventName}. The committee will review it and follow up with a decision.`;
    const text =
      `Hi ${context.recipientName},\n\n${message}\n\nYou can return to your proposal any time using this private link:\n${context.returnUrl}`;
    return { subject, text, html: textToHtml(text) };
  },
};

export const portalInvitationTemplate = {
  key: "portal_invitation" as const,
  mergeFields: ["eventName", "recipientName", "portalUrl"] as const,
  render(context: PortalInvitationContext): RenderedEmail {
    const subject = `Set up your speaker portal for ${context.eventName}`;
    const text =
      `Hi ${context.recipientName},\n\nYou're set up as a speaker for ${context.eventName}. Sign in to your speaker portal to confirm your details, upload a headshot, and see your assigned tasks:\n${context.portalUrl}`;
    return { subject, text, html: textToHtml(text) };
  },
};

export const taskReminderTemplate = {
  key: "task_reminder" as const,
  mergeFields: ["eventName", "recipientName", "taskList", "portalUrl"] as const,
  render(context: TaskReminderContext): RenderedEmail {
    const subject = `A few things are still open for ${context.eventName}`;
    const text =
      `Hi ${context.recipientName},\n\nA few speaker tasks for ${context.eventName} are past due:\n\n${context.taskList}\n\nYou can complete them from your speaker portal:\n${context.portalUrl}`;
    return { subject, text, html: textToHtml(text) };
  },
};

export type TemplateKey =
  | typeof submissionConfirmationTemplate.key
  | typeof portalInvitationTemplate.key
  | typeof taskReminderTemplate.key;

const templateRegistry = {
  [submissionConfirmationTemplate.key]: submissionConfirmationTemplate,
  [portalInvitationTemplate.key]: portalInvitationTemplate,
  [taskReminderTemplate.key]: taskReminderTemplate,
};

const builtInTemplateNames: Record<TemplateKey, string> = {
  submission_confirmation: "Submission confirmation",
  portal_invitation: "Portal invitation",
  task_reminder: "Task reminder",
};

export interface EmailTemplateDescriptor {
  key: string;
  name: string;
  mergeFields: readonly string[];
  editable: boolean;
  subject: string | null;
  body: string | null;
}

export interface CommunicationRecipient {
  id: string;
  name: string;
  email: string;
}

function describeAuthoredTemplate(
  template: typeof communicationTemplates.$inferSelect,
): EmailTemplateDescriptor {
  return {
    key: template.id,
    name: template.name,
    mergeFields: template.mergeFields,
    editable: true,
    subject: template.subject,
    body: template.body,
  };
}

export function isTemplateKey(value: unknown): value is TemplateKey {
  return typeof value === "string" && value in templateRegistry;
}

export function listTemplates(): EmailTemplateDescriptor[] {
  return Object.values(templateRegistry).map((template) => ({
    key: template.key,
    name: builtInTemplateNames[template.key],
    mergeFields: template.mergeFields,
    editable: false,
    subject: null,
    body: null,
  }));
}

export async function listEventTemplates(database: EmailDatabase, eventId: string): Promise<EmailTemplateDescriptor[]> {
  const authored = await database
    .select()
    .from(communicationTemplates)
    .where(and(eq(communicationTemplates.eventId, eventId), isNull(communicationTemplates.deletedAt)));
  return [
    ...listTemplates(),
    ...authored.map(describeAuthoredTemplate),
  ];
}

export async function listCommunicationRecipients(
  database: EmailDatabase,
  eventId: string,
): Promise<CommunicationRecipient[]> {
  const rows = await database
    .select({ id: speakers.id, name: people.name, email: people.email })
    .from(speakers)
    .innerJoin(people, eq(speakers.personId, people.id))
    .where(and(
      eq(speakers.eventId, eventId),
      isNull(speakers.deletedAt),
      isNull(people.deletedAt),
    ));
  return rows.flatMap((row) => {
    const email = row.email?.trim();
    return email ? [{ id: row.id, name: row.name, email }] : [];
  });
}

export type ResolveTemplateContextResult =
  | { status: "event_not_found" }
  | { status: "recipient_not_found" }
  | { status: "resolved"; context: Record<string, string> };

export async function resolveTemplateContext(
  database: EmailDatabase,
  eventId: string,
  recipientId: string | null,
  mergeFields: Record<string, string>,
): Promise<ResolveTemplateContextResult> {
  const [event] = await database
    .select({ name: events.name })
    .from(events)
    .where(eq(events.id, eventId));
  if (event === undefined) {
    return { status: "event_not_found" };
  }
  if (recipientId === null) {
    return { status: "resolved", context: { ...mergeFields, eventName: event.name } };
  }
  const recipient = (await listCommunicationRecipients(database, eventId))
    .find((item) => item.id === recipientId);
  if (recipient === undefined) {
    return { status: "recipient_not_found" };
  }
  return {
    status: "resolved",
    context: {
      ...mergeFields,
      eventName: event.name,
      recipientName: recipient.name,
      recipientEmail: recipient.email,
    },
  };
}

export type QueueTemplateDraftsResult =
  | { status: "template_not_found" }
  | { status: "event_not_found" }
  | { status: "recipients_not_found"; recipientIds: string[] }
  | { status: "missing_fields"; fields: string[] }
  | { status: "queued"; drafts: Array<{ dispatchId: string; recipientId: string }> };

export async function queueTemplateDrafts(
  database: EmailDatabase,
  input: {
    eventId: string;
    templateKey: string;
    recipientIds: string[];
    mergeFields: Record<string, string>;
    createdByUserId: string;
  },
): Promise<QueueTemplateDraftsResult> {
  const template = (await listEventTemplates(database, input.eventId))
    .find((item) => item.key === input.templateKey);
  if (template === undefined) {
    return { status: "template_not_found" };
  }
  const [event] = await database
    .select({ name: events.name })
    .from(events)
    .where(eq(events.id, input.eventId));
  if (event === undefined) {
    return { status: "event_not_found" };
  }
  const availableRecipients = await listCommunicationRecipients(database, input.eventId);
  const recipientsById = new Map(availableRecipients.map((recipient) => [recipient.id, recipient]));
  const recipientIds = [...new Set(input.recipientIds)];
  const missingRecipientIds = recipientIds.filter((recipientId) => !recipientsById.has(recipientId));
  if (missingRecipientIds.length > 0) {
    return { status: "recipients_not_found", recipientIds: missingRecipientIds };
  }

  const renderedRecipients = recipientIds.map((recipientId) => {
    const recipient = recipientsById.get(recipientId)!;
    const context: Record<string, string> = {
      ...input.mergeFields,
      eventName: event.name,
      recipientName: recipient.name,
      recipientEmail: recipient.email,
    };
    const missingFields = template.mergeFields.filter((field) => !context[field]?.trim());
    if (missingFields.length > 0) {
      return { recipient, missingFields, email: null };
    }
    if (isTemplateKey(template.key)) {
      return { recipient, missingFields: [], email: renderTemplate(template.key, context) };
    }
    const rendered = renderAuthoredTemplate(
      { subject: template.subject ?? "", body: template.body ?? "" },
      context,
    );
    return {
      recipient,
      missingFields: rendered.status === "missing_fields" ? rendered.fields : [],
      email: rendered.status === "rendered" ? rendered.email : null,
    };
  });
  const missingFields = [...new Set(renderedRecipients.flatMap((entry) => entry.missingFields))];
  if (missingFields.length > 0) {
    return { status: "missing_fields", fields: missingFields };
  }

  const drafts: Array<{ dispatchId: string; recipientId: string }> = [];
  for (const entry of renderedRecipients) {
    if (entry.email === null) {
      continue;
    }
    const [dispatch] = await database
      .insert(emailDispatches)
      .values({
        eventId: input.eventId,
        templateKey: input.templateKey,
        subject: entry.email.subject,
        body: entry.email.text,
        recipients: [{ email: entry.recipient.email, name: entry.recipient.name }],
        status: "draft",
        createdByUserId: input.createdByUserId,
      })
      .returning({ id: emailDispatches.id });
    if (dispatch !== undefined) {
      drafts.push({ dispatchId: dispatch.id, recipientId: entry.recipient.id });
    }
  }
  return { status: "queued", drafts };
}

export async function createEventTemplate(
  database: EmailDatabase,
  eventId: string,
  createdByUserId: string,
  input: { name: string; subject: string; body: string },
): Promise<EmailTemplateDescriptor | null> {
  const [event] = await database
    .select({ id: events.id })
    .from(events)
    .where(eq(events.id, eventId));
  if (event === undefined) {
    return null;
  }
  const [template] = await database
    .insert(communicationTemplates)
    .values({
      eventId,
      createdByUserId,
      name: input.name,
      subject: input.subject,
      body: input.body,
      mergeFields: findMergeFields(input),
    })
    .returning();
  if (template === undefined) {
    throw new Error("communication_template_not_created");
  }
  return describeAuthoredTemplate(template);
}

export async function updateEventTemplate(
  database: EmailDatabase,
  eventId: string,
  templateId: string,
  input: { name: string; subject: string; body: string },
): Promise<EmailTemplateDescriptor | null> {
  const [template] = await database
    .update(communicationTemplates)
    .set({
      name: input.name,
      subject: input.subject,
      body: input.body,
      mergeFields: findMergeFields(input),
    })
    .where(and(
      eq(communicationTemplates.id, templateId),
      eq(communicationTemplates.eventId, eventId),
      isNull(communicationTemplates.deletedAt),
    ))
    .returning();
  if (template === undefined) {
    return null;
  }
  return describeAuthoredTemplate(template);
}

export async function removeEventTemplate(
  database: EmailDatabase,
  eventId: string,
  templateId: string,
): Promise<boolean> {
  const removed = await database
    .update(communicationTemplates)
    .set({ deletedAt: new Date() })
    .where(and(
      eq(communicationTemplates.id, templateId),
      eq(communicationTemplates.eventId, eventId),
      isNull(communicationTemplates.deletedAt),
    ))
    .returning({ id: communicationTemplates.id });
  return removed.length === 1;
}

/**
 * Renders any registered template by key against a flat merge-field map, for
 * the organizer-facing preview endpoint. Callers that already have a typed
 * context (submission confirmation, portal invitation, reminders) should call
 * that template's own `render` directly instead - this generic entry point
 * exists for previewing arbitrary merge-field input before anything sends.
 */
export function renderTemplate(key: TemplateKey, context: Record<string, string>): RenderedEmail {
  switch (key) {
    case "submission_confirmation":
      return submissionConfirmationTemplate.render(context as unknown as SubmissionConfirmationContext);
    case "portal_invitation":
      return portalInvitationTemplate.render(context as unknown as PortalInvitationContext);
    case "task_reminder":
      return taskReminderTemplate.render(context as unknown as TaskReminderContext);
  }
}
