// ABOUTME: Changes submission decisions silently and exposes deliberate disposition operations.
// ABOUTME: Keeps notification dispatch separate from reversible committee status changes.
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
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
  createPublicId,
  sessionSpeakers,
  sessions,
  speakers,
  submissions,
  submissionSpeakers,
  submissionTracks,
  taskAssignees,
  tasks,
  tracks,
  type Role,
  type SubmissionStatus,
} from "../../db/schema.ts";

type DispositionEnvironment = {
  Bindings: CloudflareBindings;
  Variables: {
    authUser: { id: string } | null;
    role: Role | null;
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
  if (context.get("role") !== "organizer") {
    return context.json({ error: context.get("role") === null ? "authentication_required" : "forbidden" }, context.get("role") === null ? 401 : 403);
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

const defaultOnboardingTasks = [
  "Confirm participation",
  "Upload headshot",
  "Complete bio and profile",
  "Upload final slides by 2027-05-01",
  "Sign speaker release form",
] as const;

async function ensureAcceptedHandoff(
  binding: D1Database,
  eventId: string,
  submissionId: string,
) {
  const database = drizzle(binding);
  const [submission] = await database
    .select()
    .from(submissions)
    .where(and(eq(submissions.id, submissionId), eq(submissions.eventId, eventId)));
  if (submission === undefined) {
    throw new Error(`Submission ${submissionId} was not found for handoff`);
  }
  const [submissionTrack] = await database
    .select({ trackId: submissionTracks.trackId })
    .from(submissionTracks)
    .where(eq(submissionTracks.submissionId, submissionId))
    .limit(1);

  let [session] = await database
    .select()
    .from(sessions)
    .where(eq(sessions.submissionId, submissionId));
  if (session === undefined) {
    await database
      .insert(sessions)
      .values({
        id: createPublicId("ses"),
        eventId,
        submissionId,
        trackId: submissionTrack?.trackId,
        formatId: submission.formatId,
        title: submission.title,
        abstract: submission.abstract,
        contentStatus: "draft",
        scheduleStatus: "unplaced",
        icsUid: `${submissionId}@greenroom`,
      })
      .onConflictDoNothing();
    [session] = await database
      .select()
      .from(sessions)
      .where(eq(sessions.submissionId, submissionId));
  }
  if (session === undefined) {
    throw new Error(`Session handoff failed for ${submissionId}`);
  }

  let participants = await database
    .select({
      personId: people.id,
      name: people.name,
      email: people.email,
      jobTitle: people.jobTitle,
      organization: people.organization,
      bio: people.bio,
      roleLabel: submissionSpeakers.roleLabel,
      sortOrder: submissionSpeakers.sortOrder,
    })
    .from(submissionSpeakers)
    .innerJoin(people, eq(submissionSpeakers.personId, people.id))
    .where(eq(submissionSpeakers.submissionId, submissionId))
    .orderBy(submissionSpeakers.sortOrder);
  if (participants.length === 0) {
    const [submitter] = await database
      .select({
        personId: people.id,
        name: people.name,
        email: people.email,
        jobTitle: people.jobTitle,
        organization: people.organization,
        bio: people.bio,
      })
      .from(people)
      .where(eq(people.id, submission.submitterPersonId));
    participants = submitter === undefined ? [] : [{ ...submitter, roleLabel: "speaker", sortOrder: 0 }];
  }

  const acceptedSpeakers = [];
  for (const participant of participants) {
    let [speaker] = await database
      .select()
      .from(speakers)
      .where(and(eq(speakers.personId, participant.personId), eq(speakers.eventId, eventId)));
    if (speaker === undefined) {
      await database
        .insert(speakers)
        .values({
          id: createPublicId("spk"),
          personId: participant.personId,
          eventId,
          status: "onboarding",
        })
        .onConflictDoNothing();
      [speaker] = await database
        .select()
        .from(speakers)
        .where(and(eq(speakers.personId, participant.personId), eq(speakers.eventId, eventId)));
    }
    if (speaker === undefined) {
      throw new Error(`Speaker handoff failed for ${participant.personId}`);
    }
    await database
      .insert(sessionSpeakers)
      .values({
        id: createPublicId("ssnr"),
        sessionId: session.id,
        speakerId: speaker.id,
        roleLabel: participant.roleLabel,
        sortOrder: participant.sortOrder,
      })
      .onConflictDoNothing();
    acceptedSpeakers.push({
      id: speaker.id,
      name: participant.name,
      email: participant.email,
      jobTitle: participant.jobTitle,
      organization: participant.organization,
      bio: participant.bio,
    });
  }

  let onboardingTasks = await database
    .select({ id: tasks.id, title: tasks.title })
    .from(tasks)
    .where(
      and(
        eq(tasks.eventId, eventId),
        isNull(tasks.sessionId),
        ne(tasks.status, "complete"),
      ),
    )
    .orderBy(tasks.id);
  if (onboardingTasks.length === 0) {
    onboardingTasks = await database
      .select({ id: tasks.id, title: tasks.title })
      .from(tasks)
      .where(eq(tasks.sessionId, session.id))
      .orderBy(tasks.title);
    if (onboardingTasks.length === 0) {
      await database
        .insert(tasks)
        .values(defaultOnboardingTasks.map((title) => ({
          id: createPublicId("tsk"),
          eventId,
          sessionId: session.id,
          taskType: title.includes("Upload") ? "file_request" as const : "general" as const,
          title,
          dueAt: title.includes("2027-05-01") ? new Date("2027-05-01T23:59:59Z") : null,
          status: "active" as const,
        })))
        .onConflictDoNothing();
      onboardingTasks = await database
        .select({ id: tasks.id, title: tasks.title })
        .from(tasks)
        .where(eq(tasks.sessionId, session.id))
        .orderBy(tasks.title);
    } else {
      await database
        .update(tasks)
        .set({ status: "active" })
        .where(eq(tasks.sessionId, session.id));
    }
  }
  for (const task of onboardingTasks) {
    for (const speaker of acceptedSpeakers) {
      await database
        .insert(taskAssignees)
        .values({
          id: createPublicId("tassn"),
          taskId: task.id,
          speakerId: speaker.id,
        })
        .onConflictDoNothing();
    }
  }

  return {
    submissionId,
    active: true,
    session: {
      id: session.id,
      title: session.title,
      abstract: session.abstract,
      trackId: session.trackId,
      formatId: session.formatId,
    },
    speakers: acceptedSpeakers,
    tasks: onboardingTasks,
  };
}

async function retainUnacceptedHandoff(
  binding: D1Database,
  eventId: string,
  submissionId: string,
) {
  const database = drizzle(binding);
  const [session] = await database
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.eventId, eventId),
        eq(sessions.submissionId, submissionId),
      ),
    );
  if (session === undefined) {
    return null;
  }
  await database
    .update(sessions)
    .set({ contentStatus: "draft" })
    .where(eq(sessions.id, session.id));
  await database
    .update(tasks)
    .set({ status: "draft" })
    .where(eq(tasks.sessionId, session.id));
  return {
    submissionId,
    active: false,
    retained: true,
    sessionId: session.id,
    contentStatus: "draft",
    schedulePreserved: true,
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
      noticeOutcome: decisionNotices.outcome,
      noticeDeliveryStatus: decisionNotices.deliveryStatus,
      noticeQueuedAt: decisionNotices.queuedAt,
    })
    .from(submissions)
    .innerJoin(people, eq(submissions.submitterPersonId, people.id))
    .leftJoin(formats, eq(submissions.formatId, formats.id))
    .leftJoin(sessions, eq(submissions.id, sessions.submissionId))
    .leftJoin(decisionNotices, eq(submissions.id, decisionNotices.submissionId))
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
    emailDelivery: "not_configured",
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
        outcome: row.noticeOutcome,
        deliveryStatus: row.noticeDeliveryStatus,
        queuedAt: row.noticeQueuedAt,
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
  const database = drizzle(context.env.DB);
  const selected = await database
    .select({ id: submissions.id })
    .from(submissions)
    .where(
      and(
        eq(submissions.eventId, context.req.param("eventId")),
        inArray(submissions.id, uniqueIds),
      ),
    );
  if (selected.length !== uniqueIds.length) {
    return context.json({ error: "submission_not_found" }, 404);
  }
  const handoffs = payload.status === "accepted"
    ? await Promise.all(uniqueIds.map((id) =>
      ensureAcceptedHandoff(context.env.DB, context.req.param("eventId"), id)
    ))
    : [];
  const retainedHandoffs = payload.status === "accepted"
    ? []
    : (await Promise.all(uniqueIds.map((id) =>
      retainUnacceptedHandoff(context.env.DB, context.req.param("eventId"), id)
    ))).filter((handoff) => handoff !== null);
  const updated = await database
    .update(submissions)
    .set({ status: payload.status satisfies SubmissionStatus })
    .where(
      and(
        eq(submissions.eventId, context.req.param("eventId")),
        inArray(submissions.id, uniqueIds),
      ),
    )
    .returning({ id: submissions.id, status: submissions.status });
  const updatedById = new Map(updated.map((item) => [item.id, item]));
  const ordered = uniqueIds.flatMap((id) => {
    const item = updatedById.get(id);
    return item === undefined ? [] : [item];
  });

  return context.json({ notificationMode: "silent", updated: ordered, handoffs, retainedHandoffs });
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
  const items = await database
    .select()
    .from(decisionBatchItems)
    .where(eq(decisionBatchItems.batchId, batch.id));
  const queuedAt = new Date();
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
      .returning({ submissionId: decisionNotices.submissionId });
  if (inserted.length > 0) {
    const insertedIds = inserted.map((item) => item.submissionId);
    await database
      .update(decisionBatchItems)
      .set({ dispatchedAt: queuedAt })
      .where(
        and(
          eq(decisionBatchItems.batchId, batch.id),
          inArray(decisionBatchItems.submissionId, insertedIds),
        ),
      );
  }
  await database
    .update(decisionBatches)
    .set({ status: "queued", dispatchedAt: batch.dispatchedAt ?? queuedAt })
    .where(eq(decisionBatches.id, batch.id));

  return context.json({
    status: "queued",
    queuedCount: inserted.length,
    skippedCount: items.length - inserted.length,
    emailDelivery: "not_configured",
    message: "Decision notices are queued in Greenroom. No email provider is connected in this lane.",
  });
});

export default dispositionRoutes;
