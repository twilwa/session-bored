// ABOUTME: Registers Greenroom's merge-field email templates and renders them per recipient.
// ABOUTME: Decision letters are rendered by disposition.ts itself; this registry covers the sends this lane owns.
import { textToHtml } from "./send.ts";

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
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

export function isTemplateKey(value: unknown): value is TemplateKey {
  return typeof value === "string" && value in templateRegistry;
}

export function listTemplates(): Array<{ key: TemplateKey; mergeFields: readonly string[] }> {
  return Object.values(templateRegistry).map((template) => ({
    key: template.key,
    mergeFields: template.mergeFields,
  }));
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
