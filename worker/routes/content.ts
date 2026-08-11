// ABOUTME: Serves organizer deliverable tracking and role-scoped discussion on uploaded content.
// ABOUTME: Reads canonical task, file, session, and comment records without changing their lifecycle meanings.
import { and, asc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
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
import type { AuthSession } from "../auth.ts";

type ContentEnvironment = {
  Bindings: CloudflareBindings;
  Variables: {
    authSession: AuthSession["session"] | null;
    authUser: AuthSession["user"] | null;
    role: Role | null;
  };
};

const contentRoutes = new Hono<ContentEnvironment>();

const requireOrganizer = createMiddleware<ContentEnvironment>(async (context, next) => {
  const role = context.get("role");
  if (role === null) {
    return context.json({ error: "authentication_required" }, 401);
  }
  if (role !== "organizer") {
    return context.json({ error: "forbidden" }, 403);
  }
  await next();
});

async function fileAccess(
  database: ReturnType<typeof drizzle>,
  fileId: string,
  userId: string,
  role: Role,
): Promise<"allowed" | "forbidden" | "not_found"> {
  const [file] = await database
    .select({ id: files.id, speakerId: files.speakerId })
    .from(files)
    .where(and(eq(files.id, fileId), isNull(files.deletedAt)));
  if (file === undefined) {
    return "not_found";
  }
  if (role === "organizer") {
    return "allowed";
  }
  if (role !== "speaker" || file.speakerId === null) {
    return "forbidden";
  }
  const [owned] = await database
    .select({ id: speakers.id })
    .from(speakers)
    .innerJoin(people, eq(speakers.personId, people.id))
    .where(and(
      eq(speakers.id, file.speakerId),
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
      speakerId: speakers.id,
      speakerName: people.name,
      speakerEmail: people.email,
      fileId: files.id,
      displayName: files.displayName,
      version: fileVersions.version,
      mimeType: fileVersions.mimeType,
      sizeBytes: fileVersions.sizeBytes,
      uploadedAt: fileVersions.createdAt,
    })
    .from(taskAssignees)
    .innerJoin(tasks, eq(taskAssignees.taskId, tasks.id))
    .innerJoin(speakers, eq(taskAssignees.speakerId, speakers.id))
    .innerJoin(people, eq(speakers.personId, people.id))
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

  const now = Date.now();
  const items = rows.map((row) => {
    const delivered = row.fileId !== null || row.assignmentStatus === "completed";
    const overdue = !delivered && row.dueAt !== null && row.dueAt.getTime() < now;
    const status = delivered ? "delivered" : overdue ? "overdue" : "requested";
    return {
      assignmentId: row.assignmentId,
      taskId: row.taskId,
      speaker: { id: row.speakerId, name: row.speakerName, email: row.speakerEmail },
      task: { title: row.taskTitle, instructions: row.instructions, dueAt: row.dueAt },
      assignment: { status: row.assignmentStatus, completedAt: row.completedAt },
      status,
      file: row.fileId === null || row.version === null || row.mimeType === null || row.sizeBytes === null || row.uploadedAt === null
        ? null
        : {
          id: row.fileId,
          displayName: row.displayName,
          version: row.version,
          mimeType: row.mimeType,
          sizeBytes: row.sizeBytes,
          uploadedAt: row.uploadedAt,
          downloadUrl: `/api/portal/files/${row.fileId}`,
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
      delivered: items.filter((item) => item.status === "delivered").length,
      awaitingApproval: sessionsAwaitingApproval.length,
    },
    items,
    sessionsAwaitingApproval,
  });
});

contentRoutes.get("/api/content/files/:fileId/comments", async (context) => {
  const user = context.get("authUser");
  const role = context.get("role");
  if (user === null || role === null) {
    return context.json({ error: "authentication_required" }, 401);
  }
  const database = drizzle(context.env.DB);
  const access = await fileAccess(database, context.req.param("fileId"), user.id, role);
  if (access === "not_found") {
    return context.json({ error: "not_found" }, 404);
  }
  if (access === "forbidden") {
    return context.json({ error: "forbidden" }, 403);
  }
  const items = await database
    .select({
      id: comments.id,
      body: comments.body,
      createdAt: comments.createdAt,
      authorName: users.name,
      authorRole: users.role,
    })
    .from(comments)
    .innerJoin(users, eq(comments.authorUserId, users.id))
    .where(and(eq(comments.fileId, context.req.param("fileId")), isNull(comments.deletedAt)))
    .orderBy(asc(comments.createdAt));
  return context.json({
    items: items.map((item) => ({
      id: item.id,
      body: item.body,
      createdAt: item.createdAt,
      author: { name: item.authorName, role: item.authorRole },
    })),
  });
});

contentRoutes.post("/api/content/files/:fileId/comments", async (context) => {
  const user = context.get("authUser");
  const role = context.get("role");
  if (user === null || role === null) {
    return context.json({ error: "authentication_required" }, 401);
  }
  const database = drizzle(context.env.DB);
  const access = await fileAccess(database, context.req.param("fileId"), user.id, role);
  if (access === "not_found") {
    return context.json({ error: "not_found" }, 404);
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
    author: { name: user.name, role },
  }, 201);
});

export default contentRoutes;
