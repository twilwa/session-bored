// ABOUTME: Manages the organizer speaker roster, onboarding assignments, and missing-information worklist.
// ABOUTME: Derives workflow visibility from event-scoped speakers, accepted sessions, and task assignments.
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import {
  people,
  createPublicId,
  sessionSpeakers,
  sessions,
  speakerStatuses,
  speakers,
  submissions,
  taskAssignees,
  tasks,
  type Role,
  type SpeakerStatus,
} from "../../db/schema.ts";
import { holdsAccess } from "../access.ts";
import { sendPortalInvitationEmail } from "../email/portal-invitation.ts";
import { deriveRosterWorkSummary } from "../roster-work.ts";

type RosterEnvironment = {
  Bindings: CloudflareBindings;
  Variables: {
    authUser: { id: string } | null;
    roles: Role[] | null;
  };
};

const rosterRoutes = new Hono<RosterEnvironment>();

function isSpeakerStatus(value: unknown): value is SpeakerStatus {
  return speakerStatuses.some((status) => status === value);
}

const requireOrganizer = createMiddleware<RosterEnvironment>(async (context, next) => {
  if (!holdsAccess(context.get("roles") ?? [], "organizer")) {
    const status = context.get("roles") === null ? 401 : 403;
    return context.json({ error: status === 401 ? "authentication_required" : "forbidden" }, status);
  }
  await next();
});

rosterRoutes.use("/api/events/:eventId/roster", requireOrganizer);
rosterRoutes.use("/api/events/:eventId/speakers", requireOrganizer);
rosterRoutes.use("/api/events/:eventId/speakers/*", requireOrganizer);
rosterRoutes.use("/api/events/:eventId/tasks", requireOrganizer);
rosterRoutes.use("/api/events/:eventId/tasks/*", requireOrganizer);
rosterRoutes.use("/api/events/:eventId/missing-information", requireOrganizer);

rosterRoutes.get("/api/events/:eventId/roster", async (context) => {
  const database = drizzle(context.env.DB);
  const items = await database
    .select({
      id: speakers.id,
      personId: people.id,
      name: people.name,
      email: people.email,
      jobTitle: people.jobTitle,
      organization: people.organization,
      bio: people.bio,
      headshotUrl: people.headshotUrl,
      twitter: people.twitter,
      linkedin: people.linkedin,
      socialLinks: people.socialLinks,
      status: speakers.status,
    })
    .from(speakers)
    .innerJoin(people, eq(speakers.personId, people.id))
    .where(and(
      eq(speakers.eventId, context.req.param("eventId")),
      sql`${speakers.deletedAt} is null`,
    ))
    .orderBy(people.name);

  const acceptedSpeakerRows = items.length === 0
    ? []
    : await database
      .selectDistinct({ speakerId: speakers.id })
      .from(speakers)
      .innerJoin(sessionSpeakers, and(
        eq(sessionSpeakers.speakerId, speakers.id),
        sql`${sessionSpeakers.deletedAt} is null`,
      ))
      .innerJoin(sessions, eq(sessionSpeakers.sessionId, sessions.id))
      .innerJoin(submissions, eq(sessions.submissionId, submissions.id))
      .where(and(
        inArray(speakers.id, items.map((item) => item.id)),
        eq(submissions.status, "accepted"),
      ));

  const pendingPublicationRows = items.length === 0
    ? []
    : await database
      .select({
        speakerId: sessionSpeakers.speakerId,
        sessionId: sessions.id,
        sessionTitle: sessions.title,
      })
      .from(sessionSpeakers)
      .innerJoin(sessions, eq(sessionSpeakers.sessionId, sessions.id))
      .where(and(
        inArray(sessionSpeakers.speakerId, items.map((item) => item.id)),
        isNull(sessionSpeakers.publishedAt),
        isNull(sessionSpeakers.deletedAt),
        isNotNull(sessions.publishedAt),
        isNull(sessions.deletedAt),
      ));

  const assignments = items.length === 0
    ? []
    : await database
      .select({
        speakerId: taskAssignees.speakerId,
        assignmentStatus: taskAssignees.status,
        taskStatus: tasks.status,
      })
      .from(taskAssignees)
      .innerJoin(tasks, eq(taskAssignees.taskId, tasks.id))
      .where(and(
        inArray(taskAssignees.speakerId, items.map((item) => item.id)),
        sql`${tasks.deletedAt} is null`,
        sql`${taskAssignees.deletedAt} is null`,
      ));

  const acceptedSpeakerIds = new Set(acceptedSpeakerRows.map((speaker) => speaker.speakerId));
  return context.json({
    items: items.map((item) => {
      const speakerAssignments = assignments.filter((assignment) => assignment.speakerId === item.id);
      const bioComplete = item.bio !== null && item.bio.trim().length > 0;
      const headshotComplete = item.headshotUrl !== null && item.headshotUrl.trim().length > 0;
      const workSummary = deriveRosterWorkSummary({
        assignments: speakerAssignments,
        bioComplete,
        headshotComplete,
        tracksProfile: acceptedSpeakerIds.has(item.id),
      });
      const pendingPublicationSessions = pendingPublicationRows
        .filter((row) => row.speakerId === item.id)
        .map((row) => ({
          id: row.sessionId as `ses_${string}`,
          title: row.sessionTitle ?? "Untitled session",
        }));
      return {
        ...item,
        profile: {
          bioComplete,
          headshotComplete,
        },
        workSummary,
        pendingPublicationSessions,
      };
    }),
  });
});

rosterRoutes.post("/api/events/:eventId/speakers", async (context) => {
  const payload = await context.req.json<{
    name?: unknown;
    email?: unknown;
    jobTitle?: unknown;
    organization?: unknown;
    bio?: unknown;
    headshotUrl?: unknown;
    status?: unknown;
  }>().catch(() => null);
  if (
    payload === null ||
    typeof payload.name !== "string" || payload.name.trim().length === 0 ||
    typeof payload.email !== "string" || !payload.email.includes("@") ||
    !isSpeakerStatus(payload.status)
  ) {
    return context.json({ error: "invalid_speaker" }, 400);
  }

  const eventId = context.req.param("eventId");
  const email = payload.email.trim().toLowerCase();
  const database = drizzle(context.env.DB);
  let [person] = await database
    .select()
    .from(people)
    .where(sql`lower(${people.email}) = ${email}`);
  const adoptedExistingPerson = person !== undefined;
  if (person === undefined) {
    const personId = createPublicId("psn");
    await database.insert(people).values({
      id: personId,
      name: payload.name.trim(),
      email,
      jobTitle: typeof payload.jobTitle === "string" ? payload.jobTitle.trim() || null : null,
      organization: typeof payload.organization === "string" ? payload.organization.trim() || null : null,
      bio: typeof payload.bio === "string" ? payload.bio.trim() || null : null,
      headshotUrl: typeof payload.headshotUrl === "string" ? payload.headshotUrl.trim() || null : null,
    });
    [person] = await database.select().from(people).where(eq(people.id, personId));
  }
  if (person === undefined) {
    throw new Error(`Person was not created for ${email}`);
  }

  let [speaker] = await database
    .select()
    .from(speakers)
    .where(and(eq(speakers.eventId, eventId), eq(speakers.personId, person.id)));
  const createdSpeaker = speaker === undefined;
  const restoredSpeaker = speaker !== undefined && speaker.deletedAt !== null;
  if (speaker === undefined) {
    const speakerId = createPublicId("spk");
    await database.insert(speakers).values({
      id: speakerId,
      eventId,
      personId: person.id,
      status: payload.status,
    });
    [speaker] = await database.select().from(speakers).where(eq(speakers.id, speakerId));
  }
  if (speaker !== undefined && restoredSpeaker) {
    await database
      .update(speakers)
      .set({ status: payload.status, deletedAt: null })
      .where(eq(speakers.id, speaker.id));
    [speaker] = await database.select().from(speakers).where(eq(speakers.id, speaker.id));
  }
  if (speaker === undefined) {
    throw new Error(`Speaker was not created for ${person.id}`);
  }

  return context.json({
    ...speaker,
    personId: person.id,
    name: person.name,
    email: person.email,
    adoptedExistingPerson,
    createdSpeaker,
    restoredSpeaker,
  }, createdSpeaker ? 201 : 200);
});

rosterRoutes.patch("/api/events/:eventId/speakers/:speakerId", async (context) => {
  const payload = await context.req.json<{
    name?: unknown;
    email?: unknown;
    jobTitle?: unknown;
    organization?: unknown;
    bio?: unknown;
    headshotUrl?: unknown;
    status?: unknown;
  }>().catch(() => null);
  if (payload === null || (payload.status !== undefined && !isSpeakerStatus(payload.status))) {
    return context.json({ error: "invalid_speaker" }, 400);
  }

  const database = drizzle(context.env.DB);
  const [current] = await database
    .select({ speakerId: speakers.id, personId: people.id })
    .from(speakers)
    .innerJoin(people, eq(speakers.personId, people.id))
    .where(and(
      eq(speakers.id, context.req.param("speakerId")),
      eq(speakers.eventId, context.req.param("eventId")),
      sql`${speakers.deletedAt} is null`,
    ));
  if (current === undefined) {
    return context.json({ error: "speaker_not_found" }, 404);
  }

  const personUpdate: {
    name?: string;
    email?: string;
    jobTitle?: string | null;
    organization?: string | null;
    bio?: string | null;
    headshotUrl?: string | null;
  } = {};
  if (payload.name !== undefined) {
    if (typeof payload.name !== "string" || payload.name.trim().length === 0) {
      return context.json({ error: "invalid_speaker" }, 400);
    }
    personUpdate.name = payload.name.trim();
  }
  if (payload.email !== undefined) {
    if (typeof payload.email !== "string" || !payload.email.includes("@")) {
      return context.json({ error: "invalid_speaker" }, 400);
    }
    personUpdate.email = payload.email.trim().toLowerCase();
  }
  for (const field of ["jobTitle", "organization", "bio", "headshotUrl"] as const) {
    const value = payload[field];
    if (value !== undefined) {
      if (value !== null && typeof value !== "string") {
        return context.json({ error: "invalid_speaker" }, 400);
      }
      if (field === "headshotUrl" && typeof value === "string" && value.trim().length === 0) {
        continue;
      }
      personUpdate[field] = value === null ? null : value.trim() || null;
    }
  }
  if (Object.keys(personUpdate).length === 0 && payload.status === undefined) {
    return context.json({ error: "invalid_speaker" }, 400);
  }

  if (Object.keys(personUpdate).length > 0) {
    await database.update(people).set(personUpdate).where(eq(people.id, current.personId));
  }
  if (payload.status !== undefined) {
    await database.update(speakers).set({ status: payload.status }).where(eq(speakers.id, current.speakerId));
  }
  const [updated] = await database
    .select({
      id: speakers.id,
      personId: people.id,
      name: people.name,
      email: people.email,
      jobTitle: people.jobTitle,
      organization: people.organization,
      bio: people.bio,
      headshotUrl: people.headshotUrl,
      status: speakers.status,
    })
    .from(speakers)
    .innerJoin(people, eq(speakers.personId, people.id))
    .where(eq(speakers.id, current.speakerId));
  if (updated === undefined) {
    throw new Error(`Speaker ${current.speakerId} disappeared after update`);
  }
  return context.json({ ...updated, notificationSent: false });
});

rosterRoutes.post("/api/events/:eventId/tasks", async (context) => {
  const payload = await context.req.json<{
    taskType?: unknown;
    title?: unknown;
    instructions?: unknown;
    dueAt?: unknown;
    acceptedFileTypes?: unknown;
    maximumFileBytes?: unknown;
    speakerIds?: unknown;
  }>().catch(() => null);
  const taskType = payload?.taskType;
  const title = payload?.title;
  const speakerIds = payload?.speakerIds;
  if (
    payload === null ||
    (taskType !== "general" && taskType !== "file_request") ||
    typeof title !== "string" || title.trim().length === 0 ||
    !Array.isArray(speakerIds) || speakerIds.length === 0 ||
    !speakerIds.every((speakerId) => typeof speakerId === "string" && speakerId.startsWith("spk_")) ||
    (payload.instructions !== undefined && payload.instructions !== null && typeof payload.instructions !== "string") ||
    (payload.acceptedFileTypes !== undefined && payload.acceptedFileTypes !== null && (
      !Array.isArray(payload.acceptedFileTypes) ||
      !payload.acceptedFileTypes.every((fileType) => typeof fileType === "string")
    )) ||
    (payload.maximumFileBytes !== undefined && payload.maximumFileBytes !== null && (
      typeof payload.maximumFileBytes !== "number" ||
      !Number.isInteger(payload.maximumFileBytes) ||
      payload.maximumFileBytes <= 0
    ))
  ) {
    return context.json({ error: "invalid_task" }, 400);
  }
  const dueAt = payload.dueAt === undefined || payload.dueAt === null
    ? null
    : typeof payload.dueAt === "string"
      ? new Date(payload.dueAt)
      : null;
  if (payload.dueAt !== undefined && payload.dueAt !== null && (dueAt === null || Number.isNaN(dueAt.getTime()))) {
    return context.json({ error: "invalid_task" }, 400);
  }

  const uniqueSpeakerIds = [...new Set(speakerIds)];
  const database = drizzle(context.env.DB);
  const selectedSpeakers = await database
    .select({ id: speakers.id })
    .from(speakers)
    .where(and(
      eq(speakers.eventId, context.req.param("eventId")),
      inArray(speakers.id, uniqueSpeakerIds),
      sql`${speakers.deletedAt} is null`,
    ));
  if (selectedSpeakers.length !== uniqueSpeakerIds.length) {
    return context.json({ error: "speaker_not_found" }, 404);
  }

  const taskId = createPublicId("tsk");
  const instructions = typeof payload.instructions === "string" ? payload.instructions.trim() || null : null;
  const acceptedFileTypes = taskType === "file_request" &&
      Array.isArray(payload.acceptedFileTypes) && payload.acceptedFileTypes.length > 0
    ? payload.acceptedFileTypes
    : null;
  const maximumFileBytes = taskType === "file_request" && typeof payload.maximumFileBytes === "number"
    ? payload.maximumFileBytes
    : null;
  const createdAt = Date.now();
  const assignees = uniqueSpeakerIds.map((speakerId) => ({
    id: createPublicId("tassn"),
    speakerId,
    status: "assigned" as const,
  }));
  await context.env.DB.batch([
    context.env.DB.prepare(
      "insert into task (id, event_id, task_type, title, instructions, due_at, status, accepted_file_types, maximum_file_bytes, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      taskId,
      context.req.param("eventId"),
      taskType,
      title.trim(),
      instructions,
      dueAt?.getTime() ?? null,
      "active",
      acceptedFileTypes === null ? null : JSON.stringify(acceptedFileTypes),
      maximumFileBytes,
      createdAt,
      createdAt,
    ),
    context.env.DB.prepare(
      "insert into task_scope (task_id, scope) values (?, ?)",
    ).bind(taskId, "selected_speakers"),
    ...assignees.map((assignee) => context.env.DB.prepare(
      "insert into task_assignee (id, task_id, speaker_id, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
    ).bind(assignee.id, taskId, assignee.speakerId, assignee.status, createdAt, createdAt)),
  ]);
  const [task] = await database.select().from(tasks).where(eq(tasks.id, taskId));
  if (task === undefined) {
    throw new Error("Task was not created");
  }

  return context.json({ ...task, assignmentCount: assignees.length, assignees }, 201);
});

rosterRoutes.patch("/api/events/:eventId/tasks/:taskId", async (context) => {
  const payload = await context.req.json<{
    taskType?: unknown;
    title?: unknown;
    instructions?: unknown;
    dueAt?: unknown;
    acceptedFileTypes?: unknown;
    speakerIds?: unknown;
  }>().catch(() => null);
  if (
    payload === null ||
    (payload.taskType !== undefined && payload.taskType !== "general" && payload.taskType !== "file_request") ||
    (payload.title !== undefined && (typeof payload.title !== "string" || payload.title.trim().length === 0)) ||
    (payload.instructions !== undefined && payload.instructions !== null && typeof payload.instructions !== "string") ||
    (payload.dueAt !== undefined && payload.dueAt !== null && typeof payload.dueAt !== "string") ||
    (payload.acceptedFileTypes !== undefined && payload.acceptedFileTypes !== null && (
      !Array.isArray(payload.acceptedFileTypes) ||
      !payload.acceptedFileTypes.every((fileType) => typeof fileType === "string")
    )) ||
    (payload.speakerIds !== undefined && (
      !Array.isArray(payload.speakerIds) ||
      !payload.speakerIds.every((speakerId) => typeof speakerId === "string" && speakerId.startsWith("spk_"))
    )) ||
    Object.keys(payload).length === 0
  ) {
    return context.json({ error: "invalid_task" }, 400);
  }
  const dueAt = payload.dueAt === undefined || payload.dueAt === null
    ? null
    : new Date(payload.dueAt);
  if (dueAt !== null && Number.isNaN(dueAt.getTime())) {
    return context.json({ error: "invalid_task" }, 400);
  }

  const database = drizzle(context.env.DB);
  const [current] = await database
    .select()
    .from(tasks)
    .where(and(
      eq(tasks.id, context.req.param("taskId")),
      eq(tasks.eventId, context.req.param("eventId")),
      sql`${tasks.deletedAt} is null`,
    ));
  if (current === undefined) {
    return context.json({ error: "task_not_found" }, 404);
  }
  const requestedSpeakerIds = payload.speakerIds === undefined
    ? null
    : [...new Set(payload.speakerIds as string[])];
  if (requestedSpeakerIds !== null && requestedSpeakerIds.length > 0) {
    const selectedSpeakers = await database
      .select({ id: speakers.id })
      .from(speakers)
      .where(and(
        eq(speakers.eventId, context.req.param("eventId")),
        inArray(speakers.id, requestedSpeakerIds),
        sql`${speakers.deletedAt} is null`,
      ));
    if (selectedSpeakers.length !== requestedSpeakerIds.length) {
      return context.json({ error: "speaker_not_found" }, 404);
    }
  }
  if (payload.taskType !== undefined && payload.taskType !== current.taskType) {
    const [completedAssignment] = await database
      .select({ id: taskAssignees.id })
      .from(taskAssignees)
      .where(and(
        eq(taskAssignees.taskId, current.id),
        eq(taskAssignees.status, "completed"),
      ));
    if (completedAssignment !== undefined) {
      return context.json({ error: "task_kind_locked" }, 409);
    }
  }

  const update: {
    taskType?: "general" | "file_request";
    title?: string;
    instructions?: string | null;
    dueAt?: Date | null;
    acceptedFileTypes?: string[] | null;
    maximumFileBytes?: number | null;
  } = {};
  if (payload.taskType !== undefined) {
    update.taskType = payload.taskType;
    if (payload.taskType === "general") {
      update.acceptedFileTypes = null;
      update.maximumFileBytes = null;
    }
  }
  // A file request can change what it asks for; clearing the list returns it to documents.
  if (payload.acceptedFileTypes !== undefined && update.acceptedFileTypes === undefined) {
    update.acceptedFileTypes = payload.acceptedFileTypes === null || payload.acceptedFileTypes.length === 0
      ? null
      : (payload.acceptedFileTypes as string[]);
  }
  if (payload.title !== undefined) update.title = payload.title.trim();
  if (payload.instructions !== undefined) {
    update.instructions = payload.instructions === null ? null : payload.instructions.trim() || null;
  }
  if (payload.dueAt !== undefined) update.dueAt = dueAt;

  let updated = current;
  if (Object.keys(update).length > 0) {
    const [saved] = await database
      .update(tasks)
      .set(update)
      .where(eq(tasks.id, current.id))
      .returning();
    if (saved === undefined) {
      throw new Error(`Task ${current.id} disappeared after update`);
    }
    updated = saved;
  }

  if (requestedSpeakerIds !== null) {
    const existingAssignments = await database
      .select({
        id: taskAssignees.id,
        speakerId: taskAssignees.speakerId,
        deletedAt: taskAssignees.deletedAt,
      })
      .from(taskAssignees)
      .where(eq(taskAssignees.taskId, current.id));
    const requested = new Set(requestedSpeakerIds);
    const existingBySpeaker = new Map(existingAssignments.map((assignment) => [assignment.speakerId, assignment]));
    const changedAt = Date.now();
    const statements = [
      ...existingAssignments
        .filter((assignment) => !requested.has(assignment.speakerId) && assignment.deletedAt === null)
        .map((assignment) => context.env.DB.prepare(
          "update task_assignee set deleted_at = ?, updated_at = ? where id = ?",
        ).bind(changedAt, changedAt, assignment.id)),
      // An organizer handing the work back makes it the speaker's own, whoever gave it to them
      // first, so it stops being a session's to take back when they leave that session.
      ...existingAssignments
        .filter((assignment) => requested.has(assignment.speakerId) && assignment.deletedAt !== null)
        .map((assignment) => context.env.DB.prepare(
          "update task_assignee set deleted_at = null, granted_by_session_id = null, updated_at = ? where id = ?",
        ).bind(changedAt, assignment.id)),
      ...requestedSpeakerIds
        .filter((speakerId) => !existingBySpeaker.has(speakerId))
        .map((speakerId) => context.env.DB.prepare(
          "insert into task_assignee (id, task_id, speaker_id, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
        ).bind(createPublicId("tassn"), current.id, speakerId, "assigned", changedAt, changedAt)),
    ];
    if (statements.length > 0) {
      await context.env.DB.batch(statements);
    }
  }

  const assignees = await database
    .select({
      id: taskAssignees.id,
      speakerId: taskAssignees.speakerId,
      speakerName: people.name,
      status: taskAssignees.status,
    })
    .from(taskAssignees)
    .innerJoin(speakers, eq(taskAssignees.speakerId, speakers.id))
    .innerJoin(people, eq(speakers.personId, people.id))
    .where(and(
      eq(taskAssignees.taskId, current.id),
      sql`${taskAssignees.deletedAt} is null`,
      sql`${speakers.deletedAt} is null`,
    ));
  return context.json({ ...updated, assignees });
});

rosterRoutes.delete("/api/events/:eventId/tasks/:taskId", async (context) => {
  const database = drizzle(context.env.DB);
  const [task] = await database
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(
      eq(tasks.id, context.req.param("taskId")),
      eq(tasks.eventId, context.req.param("eventId")),
      sql`${tasks.deletedAt} is null`,
    ));
  if (task === undefined) {
    return context.json({ error: "task_not_found" }, 404);
  }

  const archivedAt = new Date();
  await database
    .update(tasks)
    .set({ status: "complete", deletedAt: archivedAt })
    .where(eq(tasks.id, task.id));
  return context.json({ id: task.id, archived: true, archivedAt });
});

rosterRoutes.patch("/api/events/:eventId/tasks/:taskId/assignees/:speakerId", async (context) => {
  const payload = await context.req.json<{ status?: unknown }>().catch(() => null);
  const status = payload?.status;
  if (status !== "assigned" && status !== "completed") {
    return context.json({ error: "invalid_task_status" }, 400);
  }

  const database = drizzle(context.env.DB);
  const [assignment] = await database
    .select({ id: taskAssignees.id })
    .from(taskAssignees)
    .innerJoin(tasks, eq(taskAssignees.taskId, tasks.id))
    .innerJoin(speakers, eq(taskAssignees.speakerId, speakers.id))
    .where(and(
      eq(taskAssignees.taskId, context.req.param("taskId")),
      eq(taskAssignees.speakerId, context.req.param("speakerId")),
      eq(tasks.eventId, context.req.param("eventId")),
      sql`${tasks.deletedAt} is null`,
      sql`${taskAssignees.deletedAt} is null`,
      sql`${speakers.deletedAt} is null`,
    ));
  if (assignment === undefined) {
    return context.json({ error: "task_assignment_not_found" }, 404);
  }

  await database
    .update(taskAssignees)
    .set({ status, completedAt: status === "completed" ? new Date() : null })
    .where(eq(taskAssignees.id, assignment.id));
  const [updated] = await database
    .select({
      id: taskAssignees.id,
      taskId: taskAssignees.taskId,
      speakerId: taskAssignees.speakerId,
      status: taskAssignees.status,
      completedAt: taskAssignees.completedAt,
    })
    .from(taskAssignees)
    .where(eq(taskAssignees.id, assignment.id));
  return context.json(updated);
});

rosterRoutes.delete("/api/events/:eventId/speakers/:speakerId", async (context) => {
  const database = drizzle(context.env.DB);
  const [speaker] = await database
    .select({ id: speakers.id })
    .from(speakers)
    .where(and(
      eq(speakers.id, context.req.param("speakerId")),
      eq(speakers.eventId, context.req.param("eventId")),
      sql`${speakers.deletedAt} is null`,
    ));
  if (speaker === undefined) {
    return context.json({ error: "speaker_not_found" }, 404);
  }

  const archivedAt = new Date();
  await database
    .update(speakers)
    .set({ status: "withdrawn", deletedAt: archivedAt })
    .where(eq(speakers.id, speaker.id));
  return context.json({ id: speaker.id, archived: true, archivedAt });
});

rosterRoutes.get("/api/events/:eventId/tasks", async (context) => {
  const database = drizzle(context.env.DB);
  const taskRows = await database
    .select()
    .from(tasks)
    .where(and(
      eq(tasks.eventId, context.req.param("eventId")),
      sql`${tasks.deletedAt} is null`,
    ))
    .orderBy(tasks.dueAt, tasks.title);
  const assignmentRows = taskRows.length === 0
    ? []
    : await database
      .select({
        id: taskAssignees.id,
        taskId: taskAssignees.taskId,
        speakerId: taskAssignees.speakerId,
        speakerName: people.name,
        status: taskAssignees.status,
      })
      .from(taskAssignees)
      .innerJoin(speakers, eq(taskAssignees.speakerId, speakers.id))
      .innerJoin(people, eq(speakers.personId, people.id))
      .where(and(
        inArray(taskAssignees.taskId, taskRows.map((task) => task.id)),
        sql`${taskAssignees.deletedAt} is null`,
        sql`${speakers.deletedAt} is null`,
      ));
  return context.json({
    items: taskRows.map((task) => ({
      ...task,
      assignees: assignmentRows.filter((assignment) => assignment.taskId === task.id),
    })),
  });
});

rosterRoutes.post("/api/events/:eventId/speakers/:speakerId/invitation", async (context) => {
  const result = await sendPortalInvitationEmail({
    env: context.env,
    eventId: context.req.param("eventId") as `evt_${string}`,
    speakerId: context.req.param("speakerId") as `spk_${string}`,
    createdByUserId: context.get("authUser")?.id ?? null,
  });
  if (result.status === "speaker_not_found") {
    return context.json({ error: "speaker_not_found" }, 404);
  }
  return context.json(result);
});

rosterRoutes.get("/api/events/:eventId/missing-information", async (context) => {
  const database = drizzle(context.env.DB);
  const rosterSpeakers = await database
    .select({
      speakerId: speakers.id,
      name: people.name,
      email: people.email,
      bio: people.bio,
      headshotUrl: people.headshotUrl,
      status: speakers.status,
    })
    .from(speakers)
    .innerJoin(people, eq(speakers.personId, people.id))
    .where(and(
      eq(speakers.eventId, context.req.param("eventId")),
      sql`${speakers.deletedAt} is null`,
    ));
  const acceptedSpeakerRows = await database
    .selectDistinct({
      speakerId: speakers.id,
    })
    .from(speakers)
    .innerJoin(sessionSpeakers, and(
      eq(sessionSpeakers.speakerId, speakers.id),
      sql`${sessionSpeakers.deletedAt} is null`,
    ))
    .innerJoin(sessions, eq(sessionSpeakers.sessionId, sessions.id))
    .innerJoin(submissions, eq(sessions.submissionId, submissions.id))
    .where(and(
      eq(speakers.eventId, context.req.param("eventId")),
      eq(submissions.status, "accepted"),
      sql`${speakers.deletedAt} is null`,
    ));
  const assignments = await database
    .select({
      speakerId: taskAssignees.speakerId,
      assignmentStatus: taskAssignees.status,
      taskId: tasks.id,
      taskType: tasks.taskType,
      title: tasks.title,
      dueAt: tasks.dueAt,
      taskStatus: tasks.status,
    })
    .from(taskAssignees)
    .innerJoin(tasks, eq(taskAssignees.taskId, tasks.id))
    .innerJoin(speakers, eq(taskAssignees.speakerId, speakers.id))
    .where(and(
      eq(tasks.eventId, context.req.param("eventId")),
      eq(speakers.eventId, context.req.param("eventId")),
      sql`${tasks.deletedAt} is null`,
      sql`${taskAssignees.deletedAt} is null`,
      sql`${speakers.deletedAt} is null`,
    ));
  const acceptedSpeakerIds = new Set(acceptedSpeakerRows.map((speaker) => speaker.speakerId));
  const activeAssignments = assignments.filter((assignment) =>
    assignment.assignmentStatus !== "completed" && assignment.taskStatus === "active"
  );
  const worklistSpeakers = rosterSpeakers.filter((speaker) =>
    acceptedSpeakerIds.has(speaker.speakerId) ||
    activeAssignments.some((assignment) => assignment.speakerId === speaker.speakerId)
  );

  const now = Date.now();
  const millisecondsPerDay = 86_400_000;
  const items = worklistSpeakers.flatMap((speaker) => {
    const missing: Array<{
      kind: "bio" | "file" | "form" | "headshot" | "task";
      label: string;
      taskId: string | null;
      dueAt: Date | null;
      overdueDays: number;
    }> = [];
    if (
      acceptedSpeakerIds.has(speaker.speakerId) &&
      (speaker.bio === null || speaker.bio.trim().length === 0)
    ) {
      missing.push({ kind: "bio", label: "Speaker bio", taskId: null, dueAt: null, overdueDays: 0 });
    }
    if (
      acceptedSpeakerIds.has(speaker.speakerId) &&
      (speaker.headshotUrl === null || speaker.headshotUrl.trim().length === 0)
    ) {
      missing.push({ kind: "headshot", label: "Headshot", taskId: null, dueAt: null, overdueDays: 0 });
    }
    for (const assignment of activeAssignments) {
      if (assignment.speakerId !== speaker.speakerId) {
        continue;
      }
      const normalizedTitle = assignment.title.toLowerCase();
      const overdueDays = assignment.dueAt !== null && assignment.dueAt.getTime() < now
        ? Math.ceil((now - assignment.dueAt.getTime()) / millisecondsPerDay)
        : 0;
      missing.push({
        kind: assignment.taskType === "file_request"
          ? "file"
          : normalizedTitle.includes("form")
            ? "form"
            : "task",
        label: assignment.title,
        taskId: assignment.taskId,
        dueAt: assignment.dueAt,
        overdueDays,
      });
    }
    if (missing.length === 0) {
      return [];
    }
    return [{
      speakerId: speaker.speakerId,
      name: speaker.name,
      email: speaker.email,
      status: speaker.status,
      missing,
      missingCount: missing.length,
      mostOverdueDays: Math.max(0, ...missing.map((item) => item.overdueDays)),
    }];
  }).sort((left, right) =>
    right.mostOverdueDays - left.mostOverdueDays ||
    right.missingCount - left.missingCount ||
    left.name.localeCompare(right.name)
  );

  return context.json({
    generatedAt: new Date(now),
    worklistSpeakerCount: worklistSpeakers.length,
    incompleteSpeakerCount: items.length,
    items,
  });
});

export default rosterRoutes;
