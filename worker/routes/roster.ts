// ABOUTME: Manages the organizer speaker roster, onboarding assignments, and missing-information worklist.
// ABOUTME: Derives workflow visibility from event-scoped speakers, accepted sessions, tasks, and files.
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import {
  files as uploadedFiles,
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

type RosterEnvironment = {
  Bindings: CloudflareBindings;
  Variables: {
    authUser: { id: string } | null;
    role: Role | null;
  };
};

const rosterRoutes = new Hono<RosterEnvironment>();

function isSpeakerStatus(value: unknown): value is SpeakerStatus {
  return speakerStatuses.some((status) => status === value);
}

const requireOrganizer = createMiddleware<RosterEnvironment>(async (context, next) => {
  if (context.get("role") !== "organizer") {
    const status = context.get("role") === null ? 401 : 403;
    return context.json({ error: status === 401 ? "authentication_required" : "forbidden" }, status);
  }
  await next();
});

rosterRoutes.use("/api/events/:eventId/roster", requireOrganizer);
rosterRoutes.use("/api/events/:eventId/speakers", requireOrganizer);
rosterRoutes.use("/api/events/:eventId/speakers/*", requireOrganizer);
rosterRoutes.use("/api/events/:eventId/tasks", requireOrganizer);
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
      status: speakers.status,
    })
    .from(speakers)
    .innerJoin(people, eq(speakers.personId, people.id))
    .where(eq(speakers.eventId, context.req.param("eventId")))
    .orderBy(people.name);

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
      .where(inArray(taskAssignees.speakerId, items.map((item) => item.id)));

  return context.json({
    items: items.map((item) => {
      const speakerAssignments = assignments.filter((assignment) => assignment.speakerId === item.id);
      return {
        ...item,
        profile: {
          bioComplete: item.bio !== null && item.bio.trim().length > 0,
          headshotComplete: item.headshotUrl !== null && item.headshotUrl.trim().length > 0,
        },
        taskSummary: {
          total: speakerAssignments.length,
          incomplete: speakerAssignments.filter((assignment) =>
            assignment.assignmentStatus !== "completed" && assignment.taskStatus === "active"
          ).length,
        },
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
    (payload.acceptedFileTypes !== undefined && (
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
    ));
  if (selectedSpeakers.length !== uniqueSpeakerIds.length) {
    return context.json({ error: "speaker_not_found" }, 404);
  }

  const taskId = createPublicId("tsk");
  const instructions = typeof payload.instructions === "string" ? payload.instructions.trim() || null : null;
  const acceptedFileTypes = taskType === "file_request" && Array.isArray(payload.acceptedFileTypes)
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

rosterRoutes.get("/api/events/:eventId/tasks", async (context) => {
  const database = drizzle(context.env.DB);
  const taskRows = await database
    .select()
    .from(tasks)
    .where(eq(tasks.eventId, context.req.param("eventId")))
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
      .where(inArray(taskAssignees.taskId, taskRows.map((task) => task.id)));
  return context.json({
    items: taskRows.map((task) => ({
      ...task,
      assignees: assignmentRows.filter((assignment) => assignment.taskId === task.id),
    })),
  });
});

rosterRoutes.post("/api/events/:eventId/speakers/:speakerId/invitation", async (context) => {
  const [speaker] = await drizzle(context.env.DB)
    .select({ id: speakers.id })
    .from(speakers)
    .where(and(
      eq(speakers.id, context.req.param("speakerId")),
      eq(speakers.eventId, context.req.param("eventId")),
    ));
  if (speaker === undefined) {
    return context.json({ error: "speaker_not_found" }, 404);
  }
  return context.json({
    error: "invitation_sender_unavailable",
    invitationQueued: false,
    message: "The communications invitation function is not available in this build.",
  }, 503);
});

rosterRoutes.get("/api/events/:eventId/missing-information", async (context) => {
  const database = drizzle(context.env.DB);
  const acceptedSpeakers = await database
    .selectDistinct({
      speakerId: speakers.id,
      name: people.name,
      email: people.email,
      bio: people.bio,
      headshotUrl: people.headshotUrl,
      status: speakers.status,
    })
    .from(speakers)
    .innerJoin(people, eq(speakers.personId, people.id))
    .innerJoin(sessionSpeakers, eq(sessionSpeakers.speakerId, speakers.id))
    .innerJoin(sessions, eq(sessionSpeakers.sessionId, sessions.id))
    .innerJoin(submissions, eq(sessions.submissionId, submissions.id))
    .where(and(
      eq(speakers.eventId, context.req.param("eventId")),
      eq(submissions.status, "accepted"),
    ));

  const speakerIds = acceptedSpeakers.map((speaker) => speaker.speakerId);
  const [assignments, files] = speakerIds.length === 0
    ? [[], []] as const
    : await Promise.all([
      database
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
        .where(and(
          eq(tasks.eventId, context.req.param("eventId")),
          inArray(taskAssignees.speakerId, speakerIds),
        )),
      database
        .select({ speakerId: uploadedFiles.speakerId, taskId: uploadedFiles.taskId })
        .from(uploadedFiles)
        .where(and(
          eq(uploadedFiles.eventId, context.req.param("eventId")),
          inArray(uploadedFiles.speakerId, speakerIds),
        )),
    ]);

  const now = Date.now();
  const millisecondsPerDay = 86_400_000;
  const items = acceptedSpeakers.flatMap((speaker) => {
    const missing: Array<{
      kind: "bio" | "file" | "form" | "headshot" | "task";
      label: string;
      taskId: string | null;
      dueAt: Date | null;
      overdueDays: number;
    }> = [];
    if (speaker.bio === null || speaker.bio.trim().length === 0) {
      missing.push({ kind: "bio", label: "Speaker bio", taskId: null, dueAt: null, overdueDays: 0 });
    }
    if (speaker.headshotUrl === null || speaker.headshotUrl.trim().length === 0) {
      missing.push({ kind: "headshot", label: "Headshot", taskId: null, dueAt: null, overdueDays: 0 });
    }
    for (const assignment of assignments) {
      if (
        assignment.speakerId !== speaker.speakerId ||
        assignment.assignmentStatus === "completed" ||
        assignment.taskStatus !== "active"
      ) {
        continue;
      }
      const normalizedTitle = assignment.title.toLowerCase();
      if (normalizedTitle.includes("headshot") || normalizedTitle.includes("bio")) {
        continue;
      }
      if (
        assignment.taskType === "file_request" &&
        files.some((file) => file.speakerId === speaker.speakerId && file.taskId === assignment.taskId)
      ) {
        continue;
      }
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
    acceptedSpeakerCount: acceptedSpeakers.length,
    incompleteSpeakerCount: items.length,
    items,
  });
});

export default rosterRoutes;
