// ABOUTME: Changes submission decisions silently and exposes deliberate disposition operations.
// ABOUTME: Keeps notification dispatch separate from reversible committee status changes.
import { and, eq, inArray, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import {
  decisionBatchItems,
  decisionBatches,
  decisionNotices,
  events,
  formats,
  people,
  sessions,
  submissions,
  submissionTracks,
  tracks,
  type Role,
} from "../../db/schema.ts";
import { holdsAccess } from "../access.ts";
import { isEmailConfigured } from "../email.ts";
import { dispatchDecisionNoticeEmails } from "../email/decision-notices.ts";
import { changeSubmissionStatuses } from "../submission-decision.ts";

type DispositionEnvironment = {
  Bindings: CloudflareBindings;
  Variables: {
    authUser: { id: string } | null;
    roles: Role[] | null;
  };
};

const decisionStatuses = ["accepted", "maybe", "declined"] as const;
type DecisionStatus = (typeof decisionStatuses)[number];

function isDecisionStatus(value: unknown): value is DecisionStatus {
  return decisionStatuses.some((status) => status === value);
}

function isSubmissionIdList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) =>
    typeof item === "string" && item.startsWith("sub_")
  );
}

const dispositionRoutes = new Hono<DispositionEnvironment>();

const requireOrganizer = createMiddleware<DispositionEnvironment>(async (context, next) => {
  if (!holdsAccess(context.get("roles") ?? [], "organizer")) {
    return context.json({ error: context.get("roles") === null ? "authentication_required" : "forbidden" }, context.get("roles") === null ? 401 : 403);
  }
  await next();
});

dispositionRoutes.use("/api/events/:eventId/disposition", requireOrganizer);
dispositionRoutes.use("/api/events/:eventId/decision-batches", requireOrganizer);
dispositionRoutes.use("/api/events/:eventId/decision-batches/*", requireOrganizer);

function renderDecisionLetter(
  outcome: DecisionStatus,
  recipientName: string,
  submissionTitle: string,
  eventName: string,
): { subject: string; body: string } {
  if (outcome === "accepted") {
    return {
      subject: `Your talk has been accepted to ${eventName}`,
      body: `Hi ${recipientName}, congratulations! Your session '${submissionTitle}' has been accepted. Please confirm your participation and complete your speaker profile.`,
    };
  }
  if (outcome === "maybe") {
    return {
      subject: `An update on your ${eventName} proposal`,
      body: `Hi ${recipientName}, your proposal '${submissionTitle}' is still under consideration. No action is needed while the committee completes its program.`,
    };
  }
  return {
    subject: `Decision on your ${eventName} proposal`,
    body: `Hi ${recipientName}, thank you for proposing '${submissionTitle}'. We are not able to include it in this year's program.`,
  };
}

dispositionRoutes.get("/api/events/:eventId/disposition", async (context) => {
  const database = drizzle(context.env.DB);
  const rows = await database
    .select({
      id: submissions.id,
      title: submissions.title,
      status: submissions.status,
      recipientName: people.name,
      recipientEmail: people.email,
      format: formats.name,
      sessionId: sessions.id,
      noticeId: decisionNotices.id,
      noticeOutcome: decisionNotices.outcome,
      noticeDeliveryStatus: decisionNotices.deliveryStatus,
      noticeQueuedAt: decisionNotices.queuedAt,
      noticeFailureReason: decisionNotices.failureReason,
      noticeRecipientEmail: decisionNotices.recipientEmail,
    })
    .from(submissions)
    .innerJoin(people, eq(submissions.submitterPersonId, people.id))
    .leftJoin(formats, eq(submissions.formatId, formats.id))
    .leftJoin(sessions, eq(submissions.id, sessions.submissionId))
    // The live letter only. A submission whose letter was cancelled reads as unqueued again,
    // and joining the cancelled ones would list the submission once per letter it ever had.
    .leftJoin(
      decisionNotices,
      and(eq(submissions.id, decisionNotices.submissionId), isNull(decisionNotices.cancelledAt)),
    )
    .where(eq(submissions.eventId, context.req.param("eventId")))
    .orderBy(submissions.createdAt);
  const trackRows = rows.length === 0 ? [] : await database
    .select({ submissionId: submissionTracks.submissionId, name: tracks.name })
    .from(submissionTracks)
    .innerJoin(tracks, eq(submissionTracks.trackId, tracks.id))
    .where(inArray(submissionTracks.submissionId, rows.map((row) => row.id)));
  const tracksBySubmission = new Map<string, string[]>();
  for (const track of trackRows) {
    const names = tracksBySubmission.get(track.submissionId) ?? [];
    names.push(track.name);
    tracksBySubmission.set(track.submissionId, names);
  }
  return context.json({
    notificationMode: "silent",
    emailDelivery: isEmailConfigured(context.env) ? "configured" : "not_configured",
    items: rows.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      recipientName: row.recipientName,
      recipientEmail: row.recipientEmail,
      track: tracksBySubmission.get(row.id)?.join(", ") ?? null,
      format: row.format,
      handoff: row.sessionId === null ? null : {
        sessionId: row.sessionId,
        active: row.status === "accepted",
        retained: row.status !== "accepted",
      },
      notice: row.noticeOutcome === null ? null : {
        id: row.noticeId,
        outcome: row.noticeOutcome,
        deliveryStatus: row.noticeDeliveryStatus,
        queuedAt: row.noticeQueuedAt,
        failureReason: row.noticeFailureReason,
        recipientEmail: row.noticeRecipientEmail,
      },
      diverged: row.noticeOutcome !== null && row.noticeOutcome !== row.status,
    })),
  });
});

dispositionRoutes.patch("/api/events/:eventId/disposition", async (context) => {
  const payload = await context.req.json<{
    submissionIds?: unknown;
    status?: unknown;
  }>().catch(() => null);
  if (
    payload === null ||
    !isSubmissionIdList(payload.submissionIds) ||
    !isDecisionStatus(payload.status)
  ) {
    return context.json({ error: "invalid_disposition" }, 400);
  }

  const uniqueIds = [...new Set(payload.submissionIds)];
  const result = await changeSubmissionStatuses(
    context.env.DB,
    uniqueIds,
    payload.status,
    context.req.param("eventId"),
  );
  if (result === null) {
    return context.json({ error: "submission_not_found" }, 404);
  }

  return context.json({ notificationMode: "silent", ...result });
});

dispositionRoutes.post("/api/events/:eventId/decision-batches", async (context) => {
  const payload = await context.req.json<{ submissionIds?: unknown }>().catch(() => null);
  if (payload === null || !isSubmissionIdList(payload.submissionIds)) {
    return context.json({ error: "invalid_batch" }, 400);
  }
  const user = context.get("authUser");
  if (user === null) {
    return context.json({ error: "authentication_required" }, 401);
  }

  const eventId = context.req.param("eventId");
  const uniqueIds = [...new Set(payload.submissionIds)];
  const database = drizzle(context.env.DB);
  const [event] = await database.select({ name: events.name }).from(events).where(eq(events.id, eventId));
  if (event === undefined) {
    return context.json({ error: "event_not_found" }, 404);
  }
  const selected = await database
    .select({
      submissionId: submissions.id,
      title: submissions.title,
      outcome: submissions.status,
      recipientName: people.name,
      recipientEmail: people.email,
    })
    .from(submissions)
    .innerJoin(people, eq(submissions.submitterPersonId, people.id))
    .where(and(eq(submissions.eventId, eventId), inArray(submissions.id, uniqueIds)));
  const selectedById = new Map(selected.map((item) => [item.submissionId, item]));
  const ordered = uniqueIds.flatMap((id) => {
    const item = selectedById.get(id);
    return item === undefined ? [] : [item];
  });
  if (ordered.length !== uniqueIds.length) {
    return context.json({ error: "submission_not_found" }, 404);
  }
  if (ordered.some((item) => !isDecisionStatus(item.outcome))) {
    return context.json({ error: "submission_not_decided" }, 409);
  }

  const [batch] = await database
    .insert(decisionBatches)
    .values({ eventId, createdByUserId: user.id })
    .returning();
  if (batch === undefined) {
    throw new Error("Decision batch was not created");
  }
  const itemValues = ordered.map((item) => {
    const title = item.title ?? "Untitled proposal";
    const letter = renderDecisionLetter(item.outcome as DecisionStatus, item.recipientName, title, event.name);
    return {
      batchId: batch.id,
      submissionId: item.submissionId,
      recipientName: item.recipientName,
      recipientEmail: item.recipientEmail,
      outcome: item.outcome as DecisionStatus,
      ...letter,
    };
  });
  const items = await database.insert(decisionBatchItems).values(itemValues).returning();
  return context.json({ ...batch, items }, 201);
});

dispositionRoutes.post("/api/events/:eventId/decision-batches/:batchId/dispatch", async (context) => {
  const database = drizzle(context.env.DB);
  const [batch] = await database
    .select()
    .from(decisionBatches)
    .where(
      and(
        eq(decisionBatches.id, context.req.param("batchId")),
        eq(decisionBatches.eventId, context.req.param("eventId")),
      ),
    );
  if (batch === undefined) {
    return context.json({ error: "batch_not_found" }, 404);
  }
  const allItems = await database
    .select()
    .from(decisionBatchItems)
    .where(eq(decisionBatchItems.batchId, batch.id));
  // A cancelled letter releases its submission, so uniqueness no longer decides what may be
  // queued and this route has to. Two ways a batch item is spent:
  //
  //   - it was already handed to the queue, so dispatching again would re-queue the same letter;
  //   - a cancellation superseded it, because its frozen recipient, outcome and copy predate the
  //     correction. Dispatching it would reinstate exactly what the organizer just retired.
  //
  // Claiming is the stamp itself, conditioned in the database, not a filter over rows read a
  // moment ago: a cancellation landing between the read and the insert would leave an in-memory
  // filter still holding the pre-cancellation row, and the insert would succeed because the
  // cancellation had just released the partial unique index. Whatever this claim returns is what
  // this request may queue, and nothing else. Spent items are skipped rather than refused, so a
  // batch that is partly spent still queues the rest and reports the difference.
  const queuedAt = new Date();
  const items = allItems.length === 0 ? [] : await database
    .update(decisionBatchItems)
    .set({ dispatchedAt: queuedAt })
    .where(and(
      eq(decisionBatchItems.batchId, batch.id),
      isNull(decisionBatchItems.dispatchedAt),
      isNull(decisionBatchItems.supersededAt),
    ))
    .returning();
  const inserted = items.length === 0
    ? []
    : await database
      .insert(decisionNotices)
      .values(items.map((item) => ({
        batchId: batch.id,
        submissionId: item.submissionId,
        outcome: item.outcome,
        recipientName: item.recipientName,
        recipientEmail: item.recipientEmail,
        subject: item.subject,
        body: item.body,
        queuedAt,
      })))
      .onConflictDoNothing()
      .returning();
  await database
    .update(decisionBatches)
    .set({ status: "queued", dispatchedAt: batch.dispatchedAt ?? queuedAt })
    .where(eq(decisionBatches.id, batch.id));

  // Every notice in this batch that has never reached a recipient, not only the
  // rows this call inserted. A batch dispatched while no sender was connected
  // left its notices `queued`, and this is how they go out once one is. The
  // status filter is what keeps a second dispatch from emailing anyone twice.
  const pending = await database
    .select({
      id: decisionNotices.id,
      submissionId: decisionNotices.submissionId,
      outcome: decisionNotices.outcome,
      recipientEmail: decisionNotices.recipientEmail,
      subject: decisionNotices.subject,
      body: decisionNotices.body,
    })
    .from(decisionNotices)
    .where(and(
      eq(decisionNotices.batchId, batch.id),
      eq(decisionNotices.deliveryStatus, "queued"),
      isNull(decisionNotices.cancelledAt),
    ));

  const emailResult = await dispatchDecisionNoticeEmails(
    database,
    context.env,
    context.req.param("eventId") as `evt_${string}`,
    pending,
  );

  // Whether this deployment can send at all, which is not the same question as
  // whether this call happened to have anything left to hand over.
  const connected = isEmailConfigured(context.env);
  return context.json({
    status: "queued",
    queuedCount: inserted.length,
    skippedCount: allItems.length - inserted.length,
    pendingCount: connected ? 0 : pending.length,
    emailDelivery: connected ? "dispatched" : "not_configured",
    sent: emailResult.sent,
    failed: emailResult.failed,
    message: connected
      ? `Decision notices dispatched: ${emailResult.sent.length} sent, ${emailResult.failed.length} failed.`
      : "Decision notices are recorded in Greenroom and waiting to send. No email sender is connected, so nothing was attempted.",
  });
});

export default dispositionRoutes;
