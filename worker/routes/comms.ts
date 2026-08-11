// ABOUTME: Serves Greenroom's communications surface for event templates and reviewable dispatch drafts.
// ABOUTME: Also exposes reminder drafting, decision-notice retry, and deliberate calendar-invite sends.
import { and, desc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { emailDispatches, type Role } from "../../db/schema.ts";
import { sendSessionCalendarInvite } from "../email/calendar-invite.ts";
import { discardDraftDispatch, sendQueuedDispatch, updateDraftDispatch } from "../email/dispatch-queue.ts";
import { retryDecisionNotice } from "../email/decision-notices.ts";
import { draftOverdueTaskReminders } from "../email/reminders.ts";
import {
  createEventTemplate,
  hasValidMergeFieldSyntax,
  isTemplateKey,
  listCommunicationRecipients,
  listEventTemplates,
  queueTemplateDrafts,
  removeEventTemplate,
  renderAuthoredTemplate,
  renderTemplate,
  resolveTemplateContext,
  updateEventTemplate,
} from "../email/templates.ts";

type CommsEnvironment = {
  Bindings: CloudflareBindings;
  Variables: {
    authUser: { id: string } | null;
    role: Role | null;
  };
};

const commsRoutes = new Hono<CommsEnvironment>();

type TemplateInputResult =
  | { status: "valid"; input: { name: string; subject: string; body: string } }
  | { status: "invalid"; error: "invalid_template" | "invalid_merge_field_syntax" };

function readTemplateInput(payload: unknown): TemplateInputResult {
  if (typeof payload !== "object" || payload === null) {
    return { status: "invalid", error: "invalid_template" };
  }
  const values = payload as Record<string, unknown>;
  if (typeof values.name !== "string" || typeof values.subject !== "string" ||
    typeof values.body !== "string" || values.name.trim() === "" || values.subject.trim() === "" ||
    values.body.trim() === "") {
    return { status: "invalid", error: "invalid_template" };
  }
  if (!hasValidMergeFieldSyntax({ subject: values.subject, body: values.body })) {
    return { status: "invalid", error: "invalid_merge_field_syntax" };
  }
  return {
    status: "valid",
    input: { name: values.name.trim(), subject: values.subject.trim(), body: values.body.trim() },
  };
}

const requireOrganizer = createMiddleware<CommsEnvironment>(async (context, next) => {
  if (context.get("role") !== "organizer") {
    return context.json(
      { error: context.get("role") === null ? "authentication_required" : "forbidden" },
      context.get("role") === null ? 401 : 403,
    );
  }
  await next();
});

commsRoutes.use("/api/events/:eventId/email-dispatches", requireOrganizer);
commsRoutes.use("/api/events/:eventId/email-dispatches/*", requireOrganizer);
commsRoutes.use("/api/events/:eventId/decision-notices/*", requireOrganizer);
commsRoutes.use("/api/events/:eventId/comms/*", requireOrganizer);
commsRoutes.use("/api/events/:eventId/sessions/:sessionId/calendar-invite", requireOrganizer);

commsRoutes.get("/api/events/:eventId/email-dispatches", async (context) => {
  const database = drizzle(context.env.DB);
  const items = await database
    .select()
    .from(emailDispatches)
    .where(and(eq(emailDispatches.eventId, context.req.param("eventId")), isNull(emailDispatches.deletedAt)))
    .orderBy(desc(emailDispatches.createdAt));
  return context.json({ items });
});

commsRoutes.patch("/api/events/:eventId/email-dispatches/:dispatchId", async (context) => {
  const payload = await context.req.json<{ subject?: unknown; body?: unknown }>().catch(() => null);
  if (payload === null || (payload.subject !== undefined && typeof payload.subject !== "string") ||
    (payload.body !== undefined && typeof payload.body !== "string")) {
    return context.json({ error: "invalid_edit" }, 400);
  }
  const database = drizzle(context.env.DB);
  const changes: { subject?: string; body?: string } = {};
  if (typeof payload.subject === "string") {
    changes.subject = payload.subject;
  }
  if (typeof payload.body === "string") {
    changes.body = payload.body;
  }
  const result = await updateDraftDispatch(
    database,
    context.req.param("eventId") as `evt_${string}`,
    context.req.param("dispatchId"),
    changes,
  );
  if (result.status === "not_found") {
    return context.json({ error: "dispatch_not_found" }, 404);
  }
  if (result.status === "not_editable") {
    return context.json({ error: "dispatch_not_editable" }, 409);
  }
  return context.json({ status: "updated" });
});

commsRoutes.delete("/api/events/:eventId/email-dispatches/:dispatchId", async (context) => {
  const database = drizzle(context.env.DB);
  const result = await discardDraftDispatch(
    database,
    context.req.param("eventId") as `evt_${string}`,
    context.req.param("dispatchId"),
  );
  if (result.status === "not_found") {
    return context.json({ error: "dispatch_not_found" }, 404);
  }
  if (result.status === "not_discardable") {
    return context.json({ error: "dispatch_not_discardable" }, 409);
  }
  return context.json({ status: "discarded" });
});

commsRoutes.post("/api/events/:eventId/email-dispatches/:dispatchId/send", async (context) => {
  const database = drizzle(context.env.DB);
  const result = await sendQueuedDispatch(
    database,
    context.env,
    context.req.param("eventId") as `evt_${string}`,
    context.req.param("dispatchId"),
  );
  if (result.status === "not_found") {
    return context.json({ error: "dispatch_not_found" }, 404);
  }
  if (result.status === "not_sendable") {
    return context.json({ error: "dispatch_not_sendable", currentStatus: result.currentStatus }, 409);
  }
  if (result.status === "not_configured") {
    return context.json({ error: "email_not_configured" }, 409);
  }
  return context.json({ status: "sent", sentCount: result.sentCount, failedCount: result.failedCount });
});

commsRoutes.post("/api/events/:eventId/email-dispatches/reminders/draft", async (context) => {
  const user = context.get("authUser");
  if (user === null) {
    return context.json({ error: "authentication_required" }, 401);
  }
  const database = drizzle(context.env.DB);
  const result = await draftOverdueTaskReminders({
    database,
    eventId: context.req.param("eventId") as `evt_${string}`,
    appOrigin: context.env.APP_ORIGIN,
    now: new Date(),
    createdByUserId: user.id,
  });
  return context.json(result);
});

commsRoutes.post("/api/events/:eventId/decision-notices/:submissionId/retry", async (context) => {
  const database = drizzle(context.env.DB);
  const result = await retryDecisionNotice(
    database,
    context.env,
    context.req.param("eventId") as `evt_${string}`,
    context.req.param("submissionId"),
  );
  if (result.status === "not_found") {
    return context.json({ error: "notice_not_found" }, 404);
  }
  if (result.status === "not_retryable") {
    return context.json({ error: "notice_not_retryable", currentStatus: result.currentStatus }, 409);
  }
  if (result.status === "provider_not_configured") {
    return context.json({ error: "email_not_configured" }, 409);
  }
  if (result.status === "failed") {
    return context.json({ status: "failed", error: result.error }, 502);
  }
  return context.json({ status: "sent" });
});

commsRoutes.get("/api/events/:eventId/comms/templates", async (context) => {
  const database = drizzle(context.env.DB);
  return context.json({ items: await listEventTemplates(database, context.req.param("eventId")) });
});

commsRoutes.get("/api/events/:eventId/comms/recipients", async (context) => {
  const database = drizzle(context.env.DB);
  return context.json({ items: await listCommunicationRecipients(database, context.req.param("eventId")) });
});

commsRoutes.post("/api/events/:eventId/comms/templates", async (context) => {
  const user = context.get("authUser");
  if (user === null) {
    return context.json({ error: "authentication_required" }, 401);
  }
  const input = readTemplateInput(await context.req.json<unknown>().catch(() => null));
  if (input.status === "invalid") {
    return context.json({ error: input.error }, 400);
  }
  const database = drizzle(context.env.DB);
  const item = await createEventTemplate(database, context.req.param("eventId"), user.id, input.input);
  return item === null
    ? context.json({ error: "event_not_found" }, 404)
    : context.json({ item }, 201);
});

commsRoutes.patch("/api/events/:eventId/comms/templates/:templateId", async (context) => {
  const templateId = context.req.param("templateId");
  if (isTemplateKey(templateId)) {
    return context.json({ error: "built_in_template_read_only" }, 409);
  }
  const input = readTemplateInput(await context.req.json<unknown>().catch(() => null));
  if (input.status === "invalid") {
    return context.json({ error: input.error }, 400);
  }
  const database = drizzle(context.env.DB);
  const item = await updateEventTemplate(database, context.req.param("eventId"), templateId, input.input);
  return item === null
    ? context.json({ error: "template_not_found" }, 404)
    : context.json({ item });
});

commsRoutes.delete("/api/events/:eventId/comms/templates/:templateId", async (context) => {
  const templateId = context.req.param("templateId");
  if (isTemplateKey(templateId)) {
    return context.json({ error: "built_in_template_read_only" }, 409);
  }
  const database = drizzle(context.env.DB);
  const removed = await removeEventTemplate(database, context.req.param("eventId"), templateId);
  return removed
    ? context.json({ status: "removed" })
    : context.json({ error: "template_not_found" }, 404);
});

commsRoutes.post("/api/events/:eventId/comms/templates/:key/drafts", async (context) => {
  const user = context.get("authUser");
  if (user === null) {
    return context.json({ error: "authentication_required" }, 401);
  }
  const payload = await context.req.json<{ recipientIds?: unknown; mergeFields?: unknown }>().catch(() => null);
  const recipientIds = Array.isArray(payload?.recipientIds) &&
      payload.recipientIds.every((recipientId): recipientId is string => typeof recipientId === "string")
    ? payload.recipientIds
    : null;
  const mergeFields = typeof payload?.mergeFields === "object" && payload.mergeFields !== null &&
      Object.values(payload.mergeFields).every((value) => typeof value === "string")
    ? payload.mergeFields as Record<string, string>
    : null;
  if (recipientIds === null || recipientIds.length === 0 || mergeFields === null) {
    return context.json({ error: "invalid_draft_request" }, 400);
  }
  const database = drizzle(context.env.DB);
  const result = await queueTemplateDrafts(database, {
    eventId: context.req.param("eventId"),
    templateKey: context.req.param("key"),
    recipientIds,
    mergeFields,
    createdByUserId: user.id,
  });
  if (result.status === "template_not_found") {
    return context.json({ error: "unknown_template" }, 404);
  }
  if (result.status === "event_not_found") {
    return context.json({ error: "event_not_found" }, 404);
  }
  if (result.status === "recipients_not_found") {
    return context.json({ error: "recipients_not_found", recipientIds: result.recipientIds }, 422);
  }
  if (result.status === "missing_fields") {
    return context.json({ error: "missing_merge_fields", fields: result.fields }, 422);
  }
  return context.json({ drafts: result.drafts }, 201);
});

commsRoutes.post("/api/events/:eventId/comms/templates/:key/preview", async (context) => {
  const key = context.req.param("key");
  const payload = await context.req.json<{ mergeFields?: unknown; recipientId?: unknown }>().catch(() => null);
  const mergeFields = typeof payload?.mergeFields === "object" && payload.mergeFields !== null
    ? payload.mergeFields as Record<string, unknown>
    : {};
  const database = drizzle(context.env.DB);
  const template = (await listEventTemplates(database, context.req.param("eventId")))
    .find((item) => item.key === key);
  if (template === undefined) {
    return context.json({ error: "unknown_template" }, 404);
  }
  const stringMergeFields = Object.fromEntries(
    Object.entries(mergeFields).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  const resolvedContext = await resolveTemplateContext(
    database,
    context.req.param("eventId"),
    typeof payload?.recipientId === "string" ? payload.recipientId : null,
    stringMergeFields,
  );
  if (resolvedContext.status === "event_not_found") {
    return context.json({ error: "event_not_found" }, 404);
  }
  if (resolvedContext.status === "recipient_not_found") {
    return context.json({ error: "recipient_not_found" }, 422);
  }
  const templateContext = resolvedContext.context;
  const missing = template.mergeFields.filter((field) =>
    !templateContext[field]?.trim()
  );
  if (missing.length > 0) {
    return context.json({ error: "missing_merge_fields", fields: missing }, 422);
  }
  if (isTemplateKey(key)) {
    return context.json(renderTemplate(key, templateContext));
  }
  const rendered = renderAuthoredTemplate(
    { subject: template.subject ?? "", body: template.body ?? "" },
    templateContext,
  );
  return rendered.status === "rendered"
    ? context.json(rendered.email)
    : context.json({ error: "missing_merge_fields", fields: rendered.fields }, 422);
});

commsRoutes.post("/api/events/:eventId/sessions/:sessionId/calendar-invite", async (context) => {
  const user = context.get("authUser");
  const database = drizzle(context.env.DB);
  const result = await sendSessionCalendarInvite(
    database,
    context.env,
    context.req.param("eventId") as `evt_${string}`,
    context.req.param("sessionId"),
    user?.id ?? null,
  );
  if (result.status === "session_not_found") {
    return context.json({ error: "session_not_found" }, 404);
  }
  if (result.status === "not_scheduled") {
    return context.json({ error: "session_not_scheduled" }, 409);
  }
  if (result.status === "no_attendees") {
    return context.json({ error: "session_has_no_attendees" }, 409);
  }
  if (result.status === "not_configured") {
    return context.json({ error: "email_not_configured" }, 409);
  }
  return context.json({
    status: "sent",
    sentCount: result.sentCount,
    failedCount: result.failedCount,
    sequence: result.sequence,
  });
});

export default commsRoutes;
