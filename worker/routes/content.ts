// ABOUTME: Serves organizer deliverable tracking, bulk archives, and role-scoped discussion on uploaded content.
// ABOUTME: Reads canonical task, file, session, and comment records without changing their lifecycle meanings.
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { FileArchiveRequest } from "../../shared/api.ts";
import {
  comments,
  createPublicId,
  files,
  fileVersions,
  people,
  sessions,
  sessionSpeakers,
  speakers,
  taskAssignees,
  tasks,
  type Role,
  users,
} from "../../db/schema.ts";
import { holdsAccess } from "../access.ts";
import type { AuthSession } from "../auth.ts";
import { streamContentArchive } from "../content-archive.ts";
import { chunkIds } from "../d1-limits.ts";
import { deriveDeliverableStatus } from "../deliverable-status.ts";
import { resolveEffectiveRoles } from "../roles.ts";
import { activeSpeakerEventFor, type ActiveSpeakerEventError } from "../speaker-event.ts";
import { filenameForVersion, fileVersionSummary } from "../storage/file-versions.ts";
import { getFileObject } from "../storage/files.ts";

type ContentEnvironment = {
  Bindings: CloudflareBindings;
  Variables: {
    authSession: AuthSession["session"] | null;
    authUser: AuthSession["user"] | null;
    roles: Role[] | null;
  };
};

const contentRoutes = new Hono<ContentEnvironment>();

const requireOrganizer = createMiddleware<ContentEnvironment>(async (context, next) => {
  const roles = context.get("roles");
  if (roles === null) {
    return context.json({ error: "authentication_required" }, 401);
  }
  if (!holdsAccess(roles, "organizer")) {
    return context.json({ error: "forbidden" }, 403);
  }
  await next();
});

async function fileAccess(
  database: ReturnType<typeof drizzle>,
  fileId: string,
  userId: string,
  roles: readonly Role[],
  eventId: string | undefined,
): Promise<"allowed" | ActiveSpeakerEventError | "forbidden" | "not_found"> {
  const organizerAccess = holdsAccess(roles, "organizer");
  if (!organizerAccess && !holdsAccess(roles, "speaker")) {
    return "forbidden";
  }
  const speakerEvent = organizerAccess ? null : activeSpeakerEventFor(eventId);
  if (speakerEvent !== null && "error" in speakerEvent) {
    return speakerEvent.error;
  }
  const [file] = await database
    .select({ id: files.id, eventId: files.eventId, speakerId: files.speakerId })
    .from(files)
    .where(and(eq(files.id, fileId), isNull(files.deletedAt)));
  if (file === undefined) {
    return "not_found";
  }
  if (organizerAccess) {
    return "allowed";
  }
  if (file.speakerId === null || speakerEvent === null) {
    return "forbidden";
  }
  if (file.eventId !== speakerEvent.id) {
    return "forbidden";
  }
  const [owned] = await database
    .select({ id: speakers.id })
    .from(speakers)
    .innerJoin(people, eq(speakers.personId, people.id))
    .where(and(
      eq(speakers.id, file.speakerId),
      eq(speakers.eventId, speakerEvent.id),
      eq(people.userId, userId),
      isNull(speakers.deletedAt),
      isNull(people.deletedAt),
    ));
  return owned === undefined ? "forbidden" : "allowed";
}

contentRoutes.get("/api/events/:eventId/deliverables", requireOrganizer, async (context) => {
  const database = drizzle(context.env.DB);
  const rows = await database
    .select({
      assignmentId: taskAssignees.id,
      assignmentStatus: taskAssignees.status,
      completedAt: taskAssignees.completedAt,
      taskId: tasks.id,
      taskTitle: tasks.title,
      instructions: tasks.instructions,
      dueAt: tasks.dueAt,
      sessionId: sessions.id,
      sessionTitle: sessions.title,
      speakerId: speakers.id,
      speakerName: people.name,
      speakerEmail: people.email,
      fileId: files.id,
      displayName: files.displayName,
      version: fileVersions.version,
      supersededByMergeId: fileVersions.supersededByMergeId,
      mimeType: fileVersions.mimeType,
      sizeBytes: fileVersions.sizeBytes,
      uploadedAt: fileVersions.createdAt,
    })
    .from(taskAssignees)
    .innerJoin(tasks, eq(taskAssignees.taskId, tasks.id))
    .innerJoin(speakers, eq(taskAssignees.speakerId, speakers.id))
    .innerJoin(people, eq(speakers.personId, people.id))
    .leftJoin(sessions, and(eq(tasks.sessionId, sessions.id), isNull(sessions.deletedAt)))
    .leftJoin(files, and(
      eq(files.taskId, tasks.id),
      eq(files.speakerId, speakers.id),
      eq(files.kind, "deliverable"),
      isNull(files.deletedAt),
    ))
    .leftJoin(fileVersions, and(
      eq(fileVersions.fileId, files.id),
      eq(fileVersions.latest, true),
      isNull(fileVersions.deletedAt),
    ))
    .where(and(
      eq(tasks.eventId, context.req.param("eventId")),
      eq(tasks.taskType, "file_request"),
      eq(tasks.status, "active"),
      isNull(tasks.deletedAt),
      isNull(taskAssignees.deletedAt),
      isNull(speakers.deletedAt),
    ));
  const storedVersions = await database
    .select({
      id: fileVersions.id,
      fileId: fileVersions.fileId,
      displayName: files.displayName,
      version: fileVersions.version,
      storageKey: fileVersions.storageKey,
      sizeBytes: fileVersions.sizeBytes,
      latest: fileVersions.latest,
      supersededByMergeId: fileVersions.supersededByMergeId,
      uploadedAt: fileVersions.createdAt,
    })
    .from(fileVersions)
    .innerJoin(files, eq(fileVersions.fileId, files.id))
    .innerJoin(tasks, eq(files.taskId, tasks.id))
    .where(and(
      eq(tasks.eventId, context.req.param("eventId")),
      eq(tasks.taskType, "file_request"),
      eq(tasks.status, "active"),
      eq(files.kind, "deliverable"),
      isNull(tasks.deletedAt),
      isNull(files.deletedAt),
      isNull(fileVersions.deletedAt),
    ));

  const now = Date.now();
  const eventId = context.req.param("eventId");
  const items = rows.map((row) => {
    const delivered = row.fileId !== null
      && row.version !== null
      && row.mimeType !== null
      && row.sizeBytes !== null
      && row.uploadedAt !== null;
    const status = deriveDeliverableStatus({
      assignmentStatus: row.assignmentStatus,
      dueAt: row.dueAt,
      hasFile: delivered,
      now,
    });
    return {
      assignmentId: row.assignmentId,
      taskId: row.taskId,
      speaker: { id: row.speakerId, name: row.speakerName, email: row.speakerEmail },
      task: {
        title: row.taskTitle,
        instructions: row.instructions,
        dueAt: row.dueAt,
        session: row.sessionId === null ? null : { id: row.sessionId, title: row.sessionTitle },
      },
      assignment: { status: row.assignmentStatus, completedAt: row.completedAt },
      status,
      file: !delivered
        ? null
        : {
          id: row.fileId,
          displayName: row.displayName,
          version: row.version,
          supersededByMerge: row.supersededByMergeId !== null,
          mimeType: row.mimeType,
          sizeBytes: row.sizeBytes,
          uploadedAt: row.uploadedAt,
          downloadUrl: `/api/portal/files/${row.fileId}?eventId=${encodeURIComponent(eventId)}`,
          versions: storedVersions
            .filter((version) => version.fileId === row.fileId)
            .sort((first, second) => second.version - first.version)
            .map((version) => fileVersionSummary(
              version,
              version.displayName,
              eventId,
            )),
        },
    } as const;
  });
  const approvalRows = await database
    .select({
      sessionId: sessions.id,
      title: sessions.title,
      contentStatus: sessions.contentStatus,
      speakerId: speakers.id,
      speakerName: people.name,
    })
    .from(sessions)
    .innerJoin(sessionSpeakers, eq(sessionSpeakers.sessionId, sessions.id))
    .innerJoin(speakers, eq(sessionSpeakers.speakerId, speakers.id))
    .innerJoin(people, eq(speakers.personId, people.id))
    .where(and(
      eq(sessions.eventId, context.req.param("eventId")),
      eq(sessions.contentStatus, "in_review"),
      isNull(sessions.deletedAt),
      isNull(sessionSpeakers.deletedAt),
      isNull(speakers.deletedAt),
    ));
  const sessionsAwaitingApproval = [...new Set(approvalRows.map((row) => row.sessionId))].map((sessionId) => {
    const first = approvalRows.find((row) => row.sessionId === sessionId);
    if (first === undefined) {
      throw new Error(`Session ${sessionId} disappeared while building deliverables`);
    }
    return {
      id: first.sessionId,
      title: first.title,
      contentStatus: first.contentStatus,
      speakers: approvalRows
        .filter((row) => row.sessionId === sessionId)
        .map((row) => ({ id: row.speakerId, name: row.speakerName })),
    };
  });

  return context.json({
    generatedAt: new Date(now),
    metrics: {
      total: items.length,
      requested: items.filter((item) => item.status === "requested").length,
      overdue: items.filter((item) => item.status === "overdue").length,
      completed: items.filter((item) => item.status === "completed").length,
      delivered: items.filter((item) => item.status === "delivered").length,
      awaitingApproval: sessionsAwaitingApproval.length,
    },
    items,
    sessionsAwaitingApproval,
  });
});

contentRoutes.post("/api/events/:eventId/files/archive", requireOrganizer, async (context) => {
  const payload = await context.req.json<FileArchiveRequest>().catch(() => null);
  if (
    payload === null
    || !Array.isArray(payload.fileIds)
    || payload.fileIds.length === 0
    || payload.fileIds.some((fileId) => typeof fileId !== "string")
  ) {
    return context.json({ error: "file_selection_required", message: "Select at least one file." }, 400);
  }
  const fileIds = [...new Set(payload.fileIds)];
  const database = drizzle(context.env.DB);
  const selected = (
    await Promise.all(chunkIds(fileIds).map((batch) =>
      database
        .select({
          id: fileVersions.id,
          fileId: files.id,
          displayName: files.displayName,
          storageKey: fileVersions.storageKey,
          uploadedAt: fileVersions.createdAt,
          speakerName: people.name,
          taskTitle: tasks.title,
        })
        .from(files)
        .innerJoin(fileVersions, and(
          eq(fileVersions.fileId, files.id),
          eq(fileVersions.latest, true),
          isNull(fileVersions.deletedAt),
        ))
        .innerJoin(tasks, eq(files.taskId, tasks.id))
        .innerJoin(taskAssignees, and(
          eq(taskAssignees.taskId, tasks.id),
          eq(taskAssignees.speakerId, files.speakerId),
          isNull(taskAssignees.deletedAt),
        ))
        .innerJoin(speakers, eq(files.speakerId, speakers.id))
        .innerJoin(people, eq(speakers.personId, people.id))
        .where(and(
          eq(tasks.eventId, context.req.param("eventId")),
          eq(tasks.taskType, "file_request"),
          eq(tasks.status, "active"),
          eq(files.kind, "deliverable"),
          inArray(files.id, batch),
          isNull(tasks.deletedAt),
          isNull(files.deletedAt),
          isNull(speakers.deletedAt),
          isNull(people.deletedAt),
        )),
    ))
  ).flat();
  const selectedById = new Map(selected.map((file) => [file.fileId, file]));
  if (selectedById.size !== fileIds.length) {
    return context.json({ error: "invalid_file_selection", message: "One or more selected files are unavailable." }, 400);
  }

  const archiveEntries = fileIds.map((fileId) => {
    const file = selectedById.get(fileId);
    if (file === undefined) {
      throw new Error(`Selected file ${fileId} disappeared while building its archive`);
    }
    return {
      fileId: file.fileId,
      displayName: filenameForVersion(file, file.displayName),
      speakerName: file.speakerName,
      taskTitle: file.taskTitle,
      uploadedAt: file.uploadedAt,
      openBody: async () => {
        const object = await getFileObject(context.env.FILES, file.storageKey);
        if (object === null) throw new Error(`Stored file ${file.fileId} is missing`);
        return object.body;
      },
    };
  });
  const archive = streamContentArchive(archiveEntries);
  const archiveEvent = context.req.param("eventId").replace(/[^a-zA-Z0-9._-]+/g, "-") || "event";
  const archiveName = `${archiveEvent}-files.zip`;
  return new Response(archive, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${archiveName}"`,
      "x-content-type-options": "nosniff",
    },
  });
});

contentRoutes.get("/api/content/files/:fileId/comments", async (context) => {
  const user = context.get("authUser");
  const roles = context.get("roles") ?? null;
  if (user === null || roles === null) {
    return context.json({ error: "authentication_required" }, 401);
  }
  const database = drizzle(context.env.DB);
  const access = await fileAccess(
    database,
    context.req.param("fileId"),
    user.id,
    roles,
    context.req.query("eventId"),
  );
  if (access === "not_found") {
    return context.json({ error: "not_found" }, 404);
  }
  if (access === "speaker_event_required" || access === "invalid_speaker_event") {
    return context.json({ error: access }, 400);
  }
  if (access === "forbidden") {
    return context.json({ error: "forbidden" }, 403);
  }
  const items = await database
    .select({
      id: comments.id,
      body: comments.body,
      createdAt: comments.createdAt,
      authorUserId: comments.authorUserId,
      authorName: users.name,
    })
    .from(comments)
    .innerJoin(users, eq(comments.authorUserId, users.id))
    .where(and(eq(comments.fileId, context.req.param("fileId")), isNull(comments.deletedAt)))
    .orderBy(asc(comments.createdAt));
  const authorRoles = await resolveEffectiveRoles(
    database,
    items.map((item) => item.authorUserId),
  );
  return context.json({
    items: items.map((item) => ({
      id: item.id,
      body: item.body,
      createdAt: item.createdAt,
      author: { name: item.authorName, role: authorRoles.get(item.authorUserId) ?? "attendee" },
    })),
  });
});

contentRoutes.post("/api/content/files/:fileId/comments", async (context) => {
  const user = context.get("authUser");
  const roles = context.get("roles") ?? null;
  if (user === null || roles === null) {
    return context.json({ error: "authentication_required" }, 401);
  }
  const database = drizzle(context.env.DB);
  const access = await fileAccess(
    database,
    context.req.param("fileId"),
    user.id,
    roles,
    context.req.query("eventId"),
  );
  if (access === "not_found") {
    return context.json({ error: "not_found" }, 404);
  }
  if (access === "speaker_event_required" || access === "invalid_speaker_event") {
    return context.json({ error: access }, 400);
  }
  if (access === "forbidden") {
    return context.json({ error: "forbidden" }, 403);
  }
  const payload = await context.req.json<{ body?: unknown }>().catch(() => null);
  if (typeof payload?.body !== "string" || payload.body.trim().length === 0) {
    return context.json({ error: "invalid_comment" }, 400);
  }
  const [saved] = await database
    .insert(comments)
    .values({
      id: createPublicId("cmt"),
      fileId: context.req.param("fileId"),
      authorUserId: user.id,
      body: payload.body.trim(),
    })
    .returning({ id: comments.id, body: comments.body, createdAt: comments.createdAt });
  if (saved === undefined) {
    throw new Error("File comment disappeared after insert");
  }
  return context.json({
    ...saved,
    author: { name: user.name, role: roles[0] },
  }, 201);
});

export default contentRoutes;
