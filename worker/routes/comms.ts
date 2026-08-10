// ABOUTME: Serves Greenroom's communications surface - the dispatch log, the F-11.7 reminder review
// ABOUTME: queue, template previews, decision-notice retry, and manual calendar-invite sends.
import { and, desc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { emailDispatches, type Role } from "../../db/schema.ts";
import { sendSessionCalendarInvite } from "../email/calendar-invite.ts";
import { discardDraftDispatch, sendQueuedDispatch, updateDraftDispatch } from "../email/dispatch-queue.ts";
import { retryDecisionNotice } from "../email/decision-notices.ts";
import { draftOverdueTaskReminders } from "../email/reminders.ts";
import { isTemplateKey, listTemplates, renderTemplate } from "../email/templates.ts";

type CommsEnvironment = {
  Bindings: CloudflareBindings;
  Variables: {
    authUser: { id: string } | null;
    role: Role | null;
  };
};

const commsRoutes = new Hono<CommsEnvironment>();

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

commsRoutes.get("/api/events/:eventId/comms/templates", (context) => context.json({ items: listTemplates() }));

commsRoutes.post("/api/events/:eventId/comms/templates/:key/preview", async (context) => {
  const key = context.req.param("key");
  if (!isTemplateKey(key)) {
    return context.json({ error: "unknown_template" }, 404);
  }
  const payload = await context.req.json<{ mergeFields?: unknown }>().catch(() => null);
  const mergeFields = typeof payload?.mergeFields === "object" && payload.mergeFields !== null
    ? payload.mergeFields as Record<string, unknown>
    : {};
  const template = listTemplates().find((item) => item.key === key);
  const missing = template?.mergeFields.filter((field) => typeof mergeFields[field] !== "string") ?? [];
  if (missing.length > 0) {
    return context.json({ error: "missing_merge_fields", fields: missing }, 422);
  }
  return context.json(renderTemplate(key, mergeFields as Record<string, string>));
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
