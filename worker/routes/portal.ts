// ABOUTME: Serves the signed-in speaker's own profile, session, task, and file self-service surface.
// ABOUTME: Scopes every read and write to the caller's own speaker record; headshots serve publicly.
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import {
  createPublicId,
  type FileKind,
  files,
  fileVersions,
  people,
  sessions,
  sessionSpeakers,
  speakers,
  taskAssignees,
  tasks,
  type Role,
} from "../../db/schema.ts";
import { holdsAccess } from "../access.ts";
import type { AuthSession } from "../auth.ts";
import { livingSessionSpeakers } from "../speaker-access.ts";
import { activeSpeakerEventFor } from "../speaker-event.ts";
import { filenameForVersion } from "../storage/file-versions.ts";
import {
  buildStorageKey,
  getFileObject,
  headshotLimits,
  imageContentTypeForFilename,
  isPictureRequest,
  limitsForTask,
  putFileObject,
  readUploadedFile,
  type UploadLimits,
  validateUpload,
  validationErrorStatus,
} from "../storage/files.ts";

type PortalEnvironment = {
  Bindings: CloudflareBindings;
  Variables: {
    authSession: AuthSession["session"] | null;
    authUser: AuthSession["user"] | null;
    roles: Role[] | null;
    speakerEventId: string;
  };
};

const portalRoutes = new Hono<PortalEnvironment>();

const requireSpeaker = createMiddleware<PortalEnvironment>(async (context, next) => {
  const roles = context.get("roles") ?? null;
  if (roles === null) {
    return context.json({ error: "authentication_required" }, 401);
  }
  if (!holdsAccess(roles, "speaker")) {
    return context.json({ error: "forbidden" }, 403);
  }
  await next();
});

const requireSpeakerEvent = createMiddleware<PortalEnvironment>(async (context, next) => {
  const speakerEvent = activeSpeakerEventFor(context.req.query("eventId"));
  if ("error" in speakerEvent) {
    return context.json({ error: speakerEvent.error }, 400);
  }
  context.set("speakerEventId", speakerEvent.id);
  await next();
});

interface SpeakerProfile {
  speakerId: string;
  personId: string;
  eventId: string;
}

async function loadOwnSpeaker(
  database: ReturnType<typeof drizzle>,
  userId: string,
  eventId: string,
): Promise<SpeakerProfile | undefined> {
  const [profile] = await database
    .select({ speakerId: speakers.id, personId: people.id, eventId: speakers.eventId })
    .from(people)
    .innerJoin(speakers, eq(speakers.personId, people.id))
    .where(and(eq(people.userId, userId), eq(speakers.eventId, eventId)));
  return profile;
}

interface MatchingTask {
  taskId: string;
  taskType: "general" | "file_request";
}

async function findMatchingTasks(
  database: ReturnType<typeof drizzle>,
  speakerId: string,
  titlePattern: RegExp,
): Promise<MatchingTask[]> {
  const assigned = await database
    .select({ taskId: tasks.id, taskType: tasks.taskType, title: tasks.title })
    .from(taskAssignees)
    .innerJoin(tasks, eq(taskAssignees.taskId, tasks.id))
    .where(and(
      eq(taskAssignees.speakerId, speakerId),
      isNull(taskAssignees.deletedAt),
      isNull(tasks.deletedAt),
    ));
  return assigned.filter((task) => titlePattern.test(task.title));
}

async function completeTasks(
  database: ReturnType<typeof drizzle>,
  speakerId: string,
  taskIds: string[],
): Promise<void> {
  if (taskIds.length === 0) return;
  await database
    .update(taskAssignees)
    .set({ status: "completed", completedAt: new Date() })
    .where(and(
      eq(taskAssignees.speakerId, speakerId),
      inArray(taskAssignees.taskId, taskIds),
      ne(taskAssignees.status, "completed"),
    ));
}

async function recordFileVersion(
  env: CloudflareBindings,
  database: ReturnType<typeof drizzle>,
  params: {
    existingFileId: string | null;
    eventId: string;
    speakerId: string;
    taskId: string | null;
    kind: FileKind;
    file: File;
    bytes: ArrayBuffer;
    uploadedByUserId: string;
  },
): Promise<{ fileId: string; version: number }> {
  const fileId = params.existingFileId ?? createPublicId("fil");
  if (params.existingFileId === null) {
    await database.insert(files).values({
      id: fileId,
      eventId: params.eventId,
      taskId: params.taskId,
      speakerId: params.speakerId,
      kind: params.kind,
      displayName: params.file.name,
    });
  } else {
    await database.update(files).set({ displayName: params.file.name }).where(eq(files.id, fileId));
  }

  const priorVersions = await database
    .select({ version: fileVersions.version })
    .from(fileVersions)
    .where(eq(fileVersions.fileId, fileId));
  const version = priorVersions.length === 0
    ? 1
    : Math.max(...priorVersions.map((row) => row.version)) + 1;

  const fileVersionId = createPublicId("fver");
  const storageKey = buildStorageKey({
    eventId: params.eventId,
    speakerId: params.speakerId,
    fileId,
    fileVersionId,
    filename: params.file.name,
  });
  const contentType = params.file.type.length > 0 ? params.file.type : "application/octet-stream";
  await putFileObject(env.FILES, storageKey, params.bytes, contentType);

  if (priorVersions.length > 0) {
    await database.update(fileVersions).set({ latest: false }).where(eq(fileVersions.fileId, fileId));
  }
  await database.insert(fileVersions).values({
    id: fileVersionId,
    fileId,
    version,
    storageKey,
    mimeType: contentType,
    sizeBytes: params.file.size,
    latest: true,
    uploadedByUserId: params.uploadedByUserId,
  });

  return { fileId, version };
}

// A `?version=` value is caller-supplied text; anything but a whole number names no
// stored version, so it yields no filter rather than a query for NaN.
function fileVersionFilter(requestedVersion: string | undefined) {
  if (requestedVersion === undefined) {
    return eq(fileVersions.latest, true);
  }
  const version = Number(requestedVersion);
  return Number.isInteger(version) ? eq(fileVersions.version, version) : null;
}

portalRoutes.patch("/portal/profile", requireSpeaker, requireSpeakerEvent, async (context) => {
  const user = context.get("authUser");
  if (user === null) {
    return context.json({ error: "authentication_required" }, 401);
  }
  const database = drizzle(context.env.DB);
  const profile = await loadOwnSpeaker(database, user.id, context.get("speakerEventId"));
  if (profile === undefined) {
    return context.json({ error: "forbidden" }, 403);
  }
  const payload = await context.req.json<{
    bio?: unknown;
    twitter?: unknown;
    linkedin?: unknown;
    socialLinks?: unknown;
  }>().catch(() => null);
  if (payload === null) {
    return context.json({ error: "invalid_profile_update" }, 400);
  }
  const update: { bio?: string | null; twitter?: string | null; linkedin?: string | null; socialLinks?: Record<string, string> | null } = {};
  for (const key of ["bio", "twitter", "linkedin"] as const) {
    const value = payload[key];
    if (value === undefined) continue;
    if (value !== null && typeof value !== "string") {
      return context.json({ error: "invalid_profile_update" }, 400);
    }
    update[key] = value === null ? null : value.trim();
  }
  if (payload.socialLinks !== undefined) {
    const rawSocialLinks = payload.socialLinks;
    if (rawSocialLinks !== null && (typeof rawSocialLinks !== "object" || Array.isArray(rawSocialLinks))) {
      return context.json({ error: "invalid_profile_update" }, 400);
    }
    if (rawSocialLinks !== null) {
      const invalid = Object.values(rawSocialLinks as Record<string, unknown>).some(
        (value) => typeof value !== "string",
      );
      if (invalid) {
        return context.json({ error: "invalid_profile_update" }, 400);
      }
    }
    update.socialLinks = rawSocialLinks as Record<string, string> | null;
  }
  if (Object.keys(update).length === 0) {
    return context.json({ error: "invalid_profile_update" }, 400);
  }
  await database.update(people).set(update).where(eq(people.id, profile.personId));
  if (typeof update.bio === "string" && update.bio.length > 0) {
    const matchingTasks = await findMatchingTasks(database, profile.speakerId, /bio|profile/i);
    await completeTasks(database, profile.speakerId, matchingTasks.map((task) => task.taskId));
  }
  const [updated] = await database
    .select({
      personId: people.id,
      bio: people.bio,
      twitter: people.twitter,
      linkedin: people.linkedin,
      socialLinks: people.socialLinks,
      headshotUrl: people.headshotUrl,
    })
    .from(people)
    .where(eq(people.id, profile.personId));
  return context.json(updated);
});

/**
 * Stores an image as the speaker's one profile headshot: a new version of the headshot
 * file they already have, the profile photo every other surface reads, and any headshot
 * task it settles. Both doors a speaker can deliver a headshot through call this, so the
 * picture they end up with never depends on which one they used.
 */
async function storeSpeakerHeadshot(
  env: CloudflareBindings,
  database: ReturnType<typeof drizzle>,
  profile: SpeakerProfile,
  file: File,
  bytes: ArrayBuffer,
  uploadedByUserId: string,
  deliveredTaskId: string | null = null,
): Promise<{ fileId: string; version: number; headshotUrl: string }> {
  const [existing] = await database
    .select({ id: files.id })
    .from(files)
    .where(and(eq(files.speakerId, profile.speakerId), eq(files.kind, "headshot")));
  const { fileId, version } = await recordFileVersion(env, database, {
    existingFileId: existing?.id ?? null,
    eventId: profile.eventId,
    speakerId: profile.speakerId,
    taskId: null,
    kind: "headshot",
    file,
    bytes,
    uploadedByUserId,
  });
  const headshotUrl = `/api/public/portal/speakers/${profile.speakerId}/headshot?version=${version}`;
  await database.update(people).set({ headshotUrl }).where(eq(people.id, profile.personId));
  const matchingTasks = await findMatchingTasks(database, profile.speakerId, /headshot/i);
  for (const matchingTask of matchingTasks) {
    if (matchingTask.taskType !== "file_request" || matchingTask.taskId === deliveredTaskId) continue;
    const [existingDeliverable] = await database
      .select({ id: files.id })
      .from(files)
      .where(and(
        eq(files.taskId, matchingTask.taskId),
        eq(files.speakerId, profile.speakerId),
        eq(files.kind, "deliverable"),
        isNull(files.deletedAt),
      ));
    await recordFileVersion(env, database, {
      existingFileId: existingDeliverable?.id ?? null,
      eventId: profile.eventId,
      speakerId: profile.speakerId,
      taskId: matchingTask.taskId,
      kind: "deliverable",
      file,
      bytes,
      uploadedByUserId,
    });
  }
  await completeTasks(database, profile.speakerId, matchingTasks.map((task) => task.taskId));
  return { fileId, version, headshotUrl };
}

portalRoutes.post("/portal/profile/headshot", requireSpeaker, requireSpeakerEvent, async (context) => {
  const user = context.get("authUser");
  if (user === null) {
    return context.json({ error: "authentication_required" }, 401);
  }
  const database = drizzle(context.env.DB);
  const profile = await loadOwnSpeaker(database, user.id, context.get("speakerEventId"));
  if (profile === undefined) {
    return context.json({ error: "forbidden" }, 403);
  }
  const file = readUploadedFile(await context.req.formData().catch(() => null));
  if (file === null) {
    return context.json({ error: "file_required", message: "Choose a file to upload." }, 400);
  }
  const bytes = await file.arrayBuffer();
  const validationError = validateUpload(file, headshotLimits, bytes);
  if (validationError !== null) {
    return context.json(validationError, validationErrorStatus(validationError.error));
  }
  return context.json(await storeSpeakerHeadshot(context.env, database, profile, file, bytes, user.id), 201);
});

portalRoutes.patch("/portal/sessions/:sessionId", requireSpeaker, requireSpeakerEvent, async (context) => {
  const user = context.get("authUser");
  if (user === null) {
    return context.json({ error: "authentication_required" }, 401);
  }
  const database = drizzle(context.env.DB);
  const profile = await loadOwnSpeaker(database, user.id, context.get("speakerEventId"));
  if (profile === undefined) {
    return context.json({ error: "forbidden" }, 403);
  }
  const sessionId = context.req.param("sessionId");
  const [owned] = await database
    .select({ id: sessions.id, contentStatus: sessions.contentStatus })
    .from(sessions)
    .innerJoin(sessionSpeakers, livingSessionSpeakers())
    .where(and(eq(sessions.id, sessionId), eq(sessionSpeakers.speakerId, profile.speakerId)));
  if (owned === undefined) {
    return context.json({ error: "forbidden" }, 403);
  }
  if (owned.contentStatus === "approved") {
    return context.json({ error: "session_locked" }, 409);
  }
  const payload = await context.req.json<{ title?: unknown; abstract?: unknown }>().catch(() => null);
  if (payload === null) {
    return context.json({ error: "invalid_session_update" }, 400);
  }
  const update: { title?: string; abstract?: string; contentStatus?: "in_review" } = {};
  if (payload.title !== undefined) {
    if (typeof payload.title !== "string" || payload.title.trim().length === 0) {
      return context.json({ error: "invalid_session_update" }, 400);
    }
    update.title = payload.title.trim();
  }
  if (payload.abstract !== undefined) {
    if (typeof payload.abstract !== "string" || payload.abstract.trim().length === 0) {
      return context.json({ error: "invalid_session_update" }, 400);
    }
    update.abstract = payload.abstract.trim();
  }
  if (Object.keys(update).length === 0) {
    return context.json({ error: "invalid_session_update" }, 400);
  }
  if (owned.contentStatus === "draft") {
    update.contentStatus = "in_review";
  }
  await database.update(sessions).set(update).where(eq(sessions.id, sessionId));
  const [updated] = await database
    .select({
      id: sessions.id,
      title: sessions.title,
      abstract: sessions.abstract,
      contentStatus: sessions.contentStatus,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  return context.json(updated);
});

portalRoutes.patch("/portal/tasks/:taskId", requireSpeaker, requireSpeakerEvent, async (context) => {
  const user = context.get("authUser");
  if (user === null) {
    return context.json({ error: "authentication_required" }, 401);
  }
  const database = drizzle(context.env.DB);
  const profile = await loadOwnSpeaker(database, user.id, context.get("speakerEventId"));
  if (profile === undefined) {
    return context.json({ error: "forbidden" }, 403);
  }
  const taskId = context.req.param("taskId");
  const [assignment] = await database
    .select({ id: taskAssignees.id })
    .from(taskAssignees)
    .innerJoin(tasks, eq(taskAssignees.taskId, tasks.id))
    .where(and(
      eq(taskAssignees.taskId, taskId),
      eq(taskAssignees.speakerId, profile.speakerId),
      isNull(taskAssignees.deletedAt),
      isNull(tasks.deletedAt),
    ));
  if (assignment === undefined) {
    return context.json({ error: "forbidden" }, 403);
  }
  const payload = await context.req.json<{ status?: unknown }>().catch(() => null);
  const statuses = ["assigned", "in_progress", "completed"] as const;
  const status = statuses.find((item) => item === payload?.status);
  if (status === undefined) {
    return context.json({ error: "invalid_task_status" }, 400);
  }
  await database
    .update(taskAssignees)
    .set({ status, completedAt: status === "completed" ? new Date() : null })
    .where(eq(taskAssignees.id, assignment.id));
  const [updated] = await database
    .select({
      id: taskAssignees.id,
      taskId: taskAssignees.taskId,
      status: taskAssignees.status,
      completedAt: taskAssignees.completedAt,
    })
    .from(taskAssignees)
    .where(eq(taskAssignees.id, assignment.id));
  return context.json(updated);
});

portalRoutes.post("/portal/tasks/:taskId/files", requireSpeaker, requireSpeakerEvent, async (context) => {
  const user = context.get("authUser");
  if (user === null) {
    return context.json({ error: "authentication_required" }, 401);
  }
  const database = drizzle(context.env.DB);
  const profile = await loadOwnSpeaker(database, user.id, context.get("speakerEventId"));
  if (profile === undefined) {
    return context.json({ error: "forbidden" }, 403);
  }
  const taskId = context.req.param("taskId");
  const [assignment] = await database
    .select({
      taskType: tasks.taskType,
      acceptedFileTypes: tasks.acceptedFileTypes,
      maximumFileBytes: tasks.maximumFileBytes,
    })
    .from(taskAssignees)
    .innerJoin(tasks, eq(taskAssignees.taskId, tasks.id))
    .where(and(
      eq(taskAssignees.taskId, taskId),
      eq(taskAssignees.speakerId, profile.speakerId),
      isNull(taskAssignees.deletedAt),
      isNull(tasks.deletedAt),
    ));
  if (assignment === undefined) {
    return context.json({ error: "forbidden" }, 403);
  }
  if (assignment.taskType !== "file_request") {
    return context.json({ error: "task_not_file_request" }, 400);
  }
  const formData = await context.req.formData().catch(() => null);
  const displayedRequestKind = formData?.get("displayedRequestKind");
  const currentRequestKind = isPictureRequest(assignment) ? "picture" : "document";
  if (displayedRequestKind !== currentRequestKind) {
    return context.json({
      error: "request_changed",
      message: "This request changed. Reload the portal to review how your file will be used before uploading.",
    }, 409);
  }
  const file = readUploadedFile(formData);
  if (file === null) {
    return context.json({ error: "file_required", message: "Choose a file to upload." }, 400);
  }
  const limits: UploadLimits = limitsForTask(assignment);
  const bytes = await file.arrayBuffer();
  const validationError = validateUpload(file, limits, bytes);
  if (validationError !== null) {
    return context.json(validationError, validationErrorStatus(validationError.error));
  }
  const [existing] = await database
    .select({ id: files.id })
    .from(files)
    .where(and(eq(files.taskId, taskId), eq(files.speakerId, profile.speakerId), isNull(files.deletedAt)));
  const { fileId, version } = await recordFileVersion(context.env, database, {
    existingFileId: existing?.id ?? null,
    eventId: profile.eventId,
    speakerId: profile.speakerId,
    taskId,
    kind: "deliverable",
    file,
    bytes,
    uploadedByUserId: user.id,
  });
  await database
    .update(taskAssignees)
    .set({ status: "completed", completedAt: new Date() })
    .where(and(eq(taskAssignees.taskId, taskId), eq(taskAssignees.speakerId, profile.speakerId)));
  // An organizer who asks for a picture is asking for the speaker's headshot, so this
  // upload also becomes their profile photo. The deliverable itself stays a task file
  // behind the same authentication as every other one; only the headshot serves publicly.
  const headshotUrl = isPictureRequest(assignment)
    ? (await storeSpeakerHeadshot(context.env, database, profile, file, bytes, user.id, taskId)).headshotUrl
    : null;
  return context.json({ fileId, version, taskId, status: "completed", headshotUrl }, 201);
});

portalRoutes.get("/portal/files/:fileId", async (context) => {
  const user = context.get("authUser");
  const roles = context.get("roles") ?? [];
  if (user === null) {
    return context.json({ error: "authentication_required" }, 401);
  }
  if (!holdsAccess(roles, "speaker") && !holdsAccess(roles, "organizer")) {
    return context.json({ error: "forbidden" }, 403);
  }
  const organizerAccess = holdsAccess(roles, "organizer");
  const speakerEvent = organizerAccess ? null : activeSpeakerEventFor(context.req.query("eventId"));
  if (speakerEvent !== null && "error" in speakerEvent) {
    return context.json({ error: speakerEvent.error }, 400);
  }
  const database = drizzle(context.env.DB);
  const [file] = await database
    .select()
    .from(files)
    .where(eq(files.id, context.req.param("fileId")));
  if (file === undefined) {
    return context.json({ error: "not_found" }, 404);
  }
  // An organizer reads any file; a speaker only their own, so a speaker who is also an
  // organizer keeps the wider reach rather than being narrowed by the second grant.
  if (speakerEvent !== null) {
    const profile = await loadOwnSpeaker(database, user.id, speakerEvent.id);
    if (profile === undefined || profile.speakerId !== file.speakerId) {
      return context.json({ error: "forbidden" }, 403);
    }
  }
  const versionFilter = fileVersionFilter(context.req.query("version"));
  if (versionFilter === null) {
    return context.json({ error: "not_found" }, 404);
  }
  const [version] = await database
    .select()
    .from(fileVersions)
    .where(and(eq(fileVersions.fileId, file.id), versionFilter));
  if (version === undefined) {
    return context.json({ error: "not_found" }, 404);
  }
  const object = await getFileObject(context.env.FILES, version.storageKey);
  if (object === null) {
    return context.json({ error: "file_object_missing" }, 404);
  }
  const downloadName = filenameForVersion(version, file.displayName);
  return new Response(object.body, {
    headers: {
      "content-type": version.mimeType,
      "x-content-type-options": "nosniff",
      "content-disposition": `attachment; filename="${downloadName.replaceAll('"', "")}"`,
      "content-length": String(version.sizeBytes),
    },
  });
});

portalRoutes.get("/public/portal/speakers/:speakerId/headshot", async (context) => {
  const database = drizzle(context.env.DB);
  const [file] = await database
    .select({ id: files.id, displayName: files.displayName })
    .from(files)
    .where(and(eq(files.speakerId, context.req.param("speakerId")), eq(files.kind, "headshot")));
  if (file === undefined) {
    return context.json({ error: "not_found" }, 404);
  }
  const requestedVersion = context.req.query("version");
  const versionFilter = fileVersionFilter(requestedVersion);
  if (versionFilter === null) {
    return context.json({ error: "not_found" }, 404);
  }
  const [version] = await database
    .select({ id: fileVersions.id, storageKey: fileVersions.storageKey })
    .from(fileVersions)
    .where(and(eq(fileVersions.fileId, file.id), versionFilter));
  if (version === undefined) {
    return context.json({ error: "not_found" }, 404);
  }
  const object = await getFileObject(context.env.FILES, version.storageKey);
  if (object === null) {
    return context.json({ error: "not_found" }, 404);
  }
  return new Response(object.body, {
    headers: {
      // Never trust the stored/caller-supplied mime type for a publicly, unauthenticated,
      // inline-served response — derive it independently from the validated extension,
      // taken from the served version's own filename rather than the newest upload's.
      "content-type": imageContentTypeForFilename(filenameForVersion(version, file.displayName)),
      // The served type is a stated fact, not a hint: a browser must not sniff its way to
      // treating these bytes as anything else.
      "x-content-type-options": "nosniff",
      // A versioned URL names fixed bytes and may be cached forever; the unversioned
      // form resolves the latest version, which a replacement changes, so it must
      // keep revalidating.
      "cache-control": requestedVersion === undefined
        ? "public, max-age=300"
        : "public, max-age=31536000, immutable",
    },
  });
});

export default portalRoutes;
