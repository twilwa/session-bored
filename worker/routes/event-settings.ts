// ABOUTME: Lets organizers manage the room and track records that feed CFP and agenda workflows.
// ABOUTME: Keeps destructive taxonomy changes behind explicit reference checks.
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

type EventSettingsEnvironment = {
  Bindings: CloudflareBindings;
  Variables: {
    authUser: { id: string } | null;
    roles: Role[] | null;
  };
};

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
