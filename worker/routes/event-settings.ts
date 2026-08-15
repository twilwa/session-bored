// ABOUTME: Lets organizers manage event identity, branding, rooms, and tracks from one route group.
// ABOUTME: Validates public brand assets and keeps destructive taxonomy changes reference-safe.
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import {
  createPublicId,
  events,
  reviewerTracks,
  rooms,
  sessions,
  submissionTracks,
  tracks,
  type Role,
} from "../../db/schema.ts";
import { holdsAccess } from "../access.ts";
import { getFileObject, headshotLimits, putFileObject, validateUpload } from "../storage/files.ts";

type EventSettingsEnvironment = {
  Bindings: CloudflareBindings;
  Variables: {
    authUser: { id: string } | null;
    roles: Role[] | null;
  };
};

interface EventSetupInput {
  name: string;
  slug: string;
  tagline: string | null;
  description: string | null;
  startDate: string | null;
  endDate: string | null;
  venue: string | null;
  timezone: string;
  branding: Record<string, string>;
}

interface EventSetupValidation {
  input: EventSetupInput | null;
  fields: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function imageUrl(
  value: unknown,
  field: string,
  fields: Record<string, string>,
  eventId: string,
): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    fields[field] = "Use an http or https image URL.";
    return null;
  }
  const trimmed = value.trim();
  const ownAssetPrefix = `/api/public/events/${eventId}/branding/`;
  for (const asset of ["background", "logo"]) {
    const versionPrefix = `${ownAssetPrefix}${asset}?version=`;
    if (trimmed.startsWith(versionPrefix) && /^[0-9a-f-]+$/.test(trimmed.slice(versionPrefix.length))) {
      return trimmed;
    }
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
    return url.toString();
  } catch {
    fields[field] = "Use an http or https image URL.";
    return null;
  }
}

function eventSetupInput(payload: unknown, eventId: string): EventSetupValidation {
  const fields: Record<string, string> = {};
  if (!isRecord(payload)) return { input: null, fields: { form: "Send event details as a JSON object." } };

  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  const slug = typeof payload.slug === "string" ? payload.slug.trim() : "";
  const tagline = typeof payload.tagline === "string" && payload.tagline.trim().length > 0
    ? payload.tagline.trim()
    : null;
  const description = typeof payload.description === "string" && payload.description.trim().length > 0
    ? payload.description.trim()
    : null;
  const startDate = typeof payload.startDate === "string" ? payload.startDate : "";
  const endDate = typeof payload.endDate === "string" ? payload.endDate : "";
  const venue = typeof payload.venue === "string" && payload.venue.trim().length > 0
    ? payload.venue.trim()
    : null;
  const timezone = typeof payload.timezone === "string" ? payload.timezone : "";
  const branding = isRecord(payload.branding) ? payload.branding : {};
  const primaryColor = typeof branding.primaryColor === "string" ? branding.primaryColor.trim() : "";
  const accentColor = typeof branding.accentColor === "string" ? branding.accentColor.trim() : "";

  if (name.length === 0) fields.name = "Enter an event name.";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    fields.slug = "Use lowercase letters, numbers, and single hyphens.";
  }
  if (!isDate(startDate)) fields.startDate = "Choose a valid start date.";
  if (!isDate(endDate)) {
    fields.endDate = "Choose a valid end date.";
  } else if (isDate(startDate) && endDate < startDate) {
    fields.endDate = "The event must end on or after its start date.";
  }
  if (!isTimezone(timezone)) fields.timezone = "Choose a valid IANA timezone.";
  if (!/^#[0-9a-fA-F]{6}$/.test(primaryColor)) {
    fields["branding.primaryColor"] = "Choose a six-digit hex color.";
  }
  if (!/^#[0-9a-fA-F]{6}$/.test(accentColor)) {
    fields["branding.accentColor"] = "Choose a six-digit hex color.";
  }
  const logoUrl = imageUrl(branding.logoUrl, "branding.logoUrl", fields, eventId);
  const backgroundImageUrl = imageUrl(
    branding.backgroundImageUrl,
    "branding.backgroundImageUrl",
    fields,
    eventId,
  );

  if (Object.keys(fields).length > 0) return { input: null, fields };
  return {
    input: {
      name,
      slug,
      tagline,
      description,
      startDate,
      endDate,
      venue,
      timezone,
      branding: {
        primaryColor,
        accentColor,
        ...(logoUrl === null ? {} : { logoUrl }),
        ...(backgroundImageUrl === null ? {} : { backgroundImageUrl }),
      },
    },
    fields,
  };
}

function uploadedFile(formData: FormData | null): File | null {
  const value = formData?.get("file");
  return value instanceof File ? value : null;
}

function fileErrorStatus(error: "file_required" | "file_too_large" | "unsupported_file_type"): 400 | 413 | 415 {
  return error === "file_too_large" ? 413 : error === "unsupported_file_type" ? 415 : 400;
}

function brandingAsset(value: string): "background" | "logo" | null {
  return value === "background" || value === "logo" ? value : null;
}

function brandingStorageKey(eventId: string, asset: "background" | "logo"): string {
  return `events/${eventId}/branding/${asset}`;
}

const eventSettingsRoutes = new Hono<EventSettingsEnvironment>();

const requireOrganizer = createMiddleware<EventSettingsEnvironment>(async (context, next) => {
  if (!holdsAccess(context.get("roles") ?? [], "organizer")) {
    const status = context.get("roles") === null ? 401 : 403;
    return context.json({ error: status === 401 ? "authentication_required" : "forbidden" }, status);
  }
  await next();
});

eventSettingsRoutes.use("/api/events/:eventId/rooms", requireOrganizer);
eventSettingsRoutes.use("/api/events/:eventId/rooms/*", requireOrganizer);
eventSettingsRoutes.use("/api/events/:eventId/tracks", requireOrganizer);
eventSettingsRoutes.use("/api/events/:eventId/tracks/*", requireOrganizer);
eventSettingsRoutes.use("/api/events/:eventId/branding/*", requireOrganizer);

eventSettingsRoutes.patch("/api/events/:eventId", requireOrganizer, async (context) => {
  const validation = eventSetupInput(
    await context.req.json<unknown>().catch(() => null),
    context.req.param("eventId"),
  );
  if (validation.input === null) {
    return context.json({
      error: "invalid_event_setup",
      fields: validation.fields,
      message: "Check the highlighted event details.",
    }, 400);
  }
  const input = validation.input;
  const [updated] = await drizzle(context.env.DB)
    .update(events)
    .set({
      name: input.name,
      slug: input.slug,
      tagline: input.tagline,
      description: input.description,
      startDate: input.startDate,
      endDate: input.endDate,
      venue: input.venue,
      timezone: input.timezone,
      branding: input.branding,
      updatedAt: new Date(),
    })
    .where(and(eq(events.id, context.req.param("eventId")), isNull(events.deletedAt)))
    .returning();
  return updated === undefined
    ? context.json({ error: "event_not_found", message: "This event could not be found." }, 404)
    : context.json(updated);
});

eventSettingsRoutes.post("/api/events/:eventId/branding/:asset", async (context) => {
  const asset = brandingAsset(context.req.param("asset"));
  if (asset === null) return context.json({ error: "not_found" }, 404);
  const database = drizzle(context.env.DB);
  const [event] = await database
    .select()
    .from(events)
    .where(and(eq(events.id, context.req.param("eventId")), isNull(events.deletedAt)));
  if (event === undefined) {
    return context.json({ error: "event_not_found", message: "This event could not be found." }, 404);
  }
  const file = uploadedFile(await context.req.formData().catch(() => null));
  if (file === null) {
    return context.json({ error: "file_required", message: "Choose an image to upload." }, 400);
  }
  const bytes = await file.arrayBuffer();
  const validationError = validateUpload(file, headshotLimits, bytes);
  if (validationError !== null) {
    return context.json(validationError, fileErrorStatus(validationError.error));
  }
  await putFileObject(
    context.env.FILES,
    brandingStorageKey(event.id, asset),
    bytes,
    file.type,
  );
  const publicUrl = `/api/public/events/${event.id}/branding/${asset}?version=${crypto.randomUUID()}`;
  const urlField = asset === "logo" ? "logoUrl" : "backgroundImageUrl";
  const [updated] = await database
    .update(events)
    .set({
      branding: { ...(event.branding ?? {}), [urlField]: publicUrl },
      updatedAt: new Date(),
    })
    .where(eq(events.id, event.id))
    .returning();
  return context.json(updated, 201);
});

eventSettingsRoutes.get("/api/public/events/:eventId/branding/:asset", async (context) => {
  const asset = brandingAsset(context.req.param("asset"));
  if (asset === null) return context.json({ error: "not_found" }, 404);
  const object = await getFileObject(
    context.env.FILES,
    brandingStorageKey(context.req.param("eventId"), asset),
  );
  if (object === null) return context.json({ error: "not_found" }, 404);
  return new Response(object.body, {
    headers: {
      "cache-control": "no-cache, must-revalidate",
      "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "x-content-type-options": "nosniff",
    },
  });
});

async function resourceName(request: Request): Promise<string | null> {
  const payload = await request.json<{ name?: unknown }>().catch(() => null);
  if (payload === null || typeof payload.name !== "string" || payload.name.trim().length === 0) {
    return null;
  }
  return payload.name.trim();
}

eventSettingsRoutes.post("/api/events/:eventId/rooms", async (context) => {
  const name = await resourceName(context.req.raw);
  if (name === null) {
    return context.json({ error: "invalid_room", message: "Enter a room name." }, 400);
  }
  const eventId = context.req.param("eventId");
  const database = drizzle(context.env.DB);
  const [event] = await database
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.id, eventId), isNull(events.deletedAt)));
  if (event === undefined) {
    return context.json({ error: "event_not_found", message: "This event could not be found." }, 404);
  }
  const [created] = await database
    .insert(rooms)
    .values({ id: createPublicId("rm"), eventId, name })
    .returning();
  return context.json(created, 201);
});

eventSettingsRoutes.patch("/api/events/:eventId/rooms/:roomId", async (context) => {
  const name = await resourceName(context.req.raw);
  if (name === null) {
    return context.json({ error: "invalid_room", message: "Enter a room name." }, 400);
  }
  const [updated] = await drizzle(context.env.DB)
    .update(rooms)
    .set({ name, updatedAt: new Date() })
    .where(and(
      eq(rooms.id, context.req.param("roomId")),
      eq(rooms.eventId, context.req.param("eventId")),
      isNull(rooms.deletedAt),
    ))
    .returning();
  return updated === undefined
    ? context.json({ error: "room_not_found", message: "This room could not be found." }, 404)
    : context.json(updated);
});

eventSettingsRoutes.delete("/api/events/:eventId/rooms/:roomId", async (context) => {
  const database = drizzle(context.env.DB);
  const [room] = await database
    .select({ id: rooms.id, name: rooms.name })
    .from(rooms)
    .where(and(
      eq(rooms.id, context.req.param("roomId")),
      eq(rooms.eventId, context.req.param("eventId")),
      isNull(rooms.deletedAt),
    ));
  if (room === undefined) {
    return context.json({ error: "room_not_found", message: "This room could not be found." }, 404);
  }
  const assignedSessions = await database
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.roomId, room.id), isNull(sessions.deletedAt)));
  if (assignedSessions.length > 0) {
    const noun = assignedSessions.length === 1 ? "session" : "sessions";
    return context.json({
      error: "room_in_use",
      message: `${room.name} still has ${assignedSessions.length} ${noun} assigned. Move ${assignedSessions.length === 1 ? "it" : "them"} to another room or TBD before removing this room.`,
    }, 409);
  }
  await database
    .delete(rooms)
    .where(eq(rooms.id, room.id));
  return context.body(null, 204);
});

eventSettingsRoutes.post("/api/events/:eventId/tracks", async (context) => {
  const name = await resourceName(context.req.raw);
  if (name === null) {
    return context.json({ error: "invalid_track", message: "Enter a track name." }, 400);
  }
  const eventId = context.req.param("eventId");
  const database = drizzle(context.env.DB);
  const [event] = await database
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.id, eventId), isNull(events.deletedAt)));
  if (event === undefined) {
    return context.json({ error: "event_not_found", message: "This event could not be found." }, 404);
  }
  const [created] = await database
    .insert(tracks)
    .values({ id: createPublicId("trk"), eventId, name })
    .returning();
  return context.json(created, 201);
});

eventSettingsRoutes.patch("/api/events/:eventId/tracks/:trackId", async (context) => {
  const name = await resourceName(context.req.raw);
  if (name === null) {
    return context.json({ error: "invalid_track", message: "Enter a track name." }, 400);
  }
  const [updated] = await drizzle(context.env.DB)
    .update(tracks)
    .set({ name, updatedAt: new Date() })
    .where(and(
      eq(tracks.id, context.req.param("trackId")),
      eq(tracks.eventId, context.req.param("eventId")),
      isNull(tracks.deletedAt),
    ))
    .returning();
  return updated === undefined
    ? context.json({ error: "track_not_found", message: "This track could not be found." }, 404)
    : context.json(updated);
});

eventSettingsRoutes.delete("/api/events/:eventId/tracks/:trackId", async (context) => {
  const database = drizzle(context.env.DB);
  const [track] = await database
    .select({ id: tracks.id, name: tracks.name })
    .from(tracks)
    .where(and(
      eq(tracks.id, context.req.param("trackId")),
      eq(tracks.eventId, context.req.param("eventId")),
      isNull(tracks.deletedAt),
    ));
  if (track === undefined) {
    return context.json({ error: "track_not_found", message: "This track could not be found." }, 404);
  }
  const [proposalReferences, sessionReferences, reviewerReferences] = await Promise.all([
    database
      .select({ id: submissionTracks.id })
      .from(submissionTracks)
      .where(and(eq(submissionTracks.trackId, track.id), isNull(submissionTracks.deletedAt))),
    database
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.trackId, track.id), isNull(sessions.deletedAt))),
    database
      .select({ id: reviewerTracks.id })
      .from(reviewerTracks)
      .where(and(eq(reviewerTracks.trackId, track.id), isNull(reviewerTracks.deletedAt))),
  ]);
  const uses = [
    proposalReferences.length === 0
      ? null
      : `${proposalReferences.length} ${proposalReferences.length === 1 ? "proposal" : "proposals"}`,
    sessionReferences.length === 0
      ? null
      : `${sessionReferences.length} program ${sessionReferences.length === 1 ? "session" : "sessions"}`,
    reviewerReferences.length === 0
      ? null
      : `${reviewerReferences.length} reviewer ${reviewerReferences.length === 1 ? "remit" : "remits"}`,
  ].filter((use): use is string => use !== null);
  if (uses.length > 0) {
    const usage = uses.length === 1
      ? uses[0]
      : uses.length === 2
        ? `${uses[0]} and ${uses[1]}`
        : `${uses.slice(0, -1).join(", ")}, and ${uses.at(-1)}`;
    const referenceCount = proposalReferences.length + sessionReferences.length + reviewerReferences.length;
    return context.json({
      error: "track_in_use",
      message: `${track.name} is used by ${usage}. Reassign ${referenceCount === 1 ? "it" : "them"} before removing this track.`,
    }, 409);
  }
  await database
    .delete(tracks)
    .where(eq(tracks.id, track.id));
  return context.body(null, 204);
});

export default eventSettingsRoutes;
