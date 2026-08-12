// ABOUTME: Serves Greenroom's public, no-auth audience surfaces: program, speakers, speaker detail.
// ABOUTME: Reads only approved, non-withdrawn content; all filtering and search happen server-side.
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { events, formFields, forms, formats, tracks } from "../../db/schema.ts";
import { buildScheduleIcs } from "../email/ics.ts";
import {
  countPublicSpeakers,
  countPublicSessions,
  fetchPublicEventFacets,
  fetchPublicSessions,
  fetchPublicSpeaker,
  fetchPublicSpeakers,
} from "../public-queries.ts";

type PublicEnv = { Bindings: CloudflareBindings };

export const publicRoutes = new Hono<PublicEnv>();

function queryParam(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

publicRoutes.get("/cfp/:slug", async (context) => {
  const database = drizzle(context.env.DB);
  const [form] = await database
    .select()
    .from(forms)
    .where(and(eq(forms.publicSlug, context.req.param("slug")), eq(forms.status, "published")));
  if (form === undefined) {
    return context.json({ error: "not_found" }, 404);
  }
  const [event] = await database.select().from(events).where(eq(events.id, form.eventId));
  if (event === undefined) {
    return context.json({ error: "not_found" }, 404);
  }
  const [eventTracks, eventFormats, fields] = await Promise.all([
    database.select({ name: tracks.name }).from(tracks).where(eq(tracks.eventId, event.id)),
    database.select({ name: formats.name }).from(formats).where(eq(formats.eventId, event.id)),
    database.select().from(formFields).where(eq(formFields.formId, form.id)),
  ]);
  return context.json({
    event,
    form,
    tracks: eventTracks.map((track) => track.name),
    formats: eventFormats.map((format) => format.name),
    fields,
  });
});

publicRoutes.get("/events/:eventId/sessions", async (context) => {
  const eventId = context.req.param("eventId");
  const filters = {
    q: queryParam(context.req.query("q")),
    track: queryParam(context.req.query("track")),
    format: queryParam(context.req.query("format")),
    room: queryParam(context.req.query("room")),
    day: queryParam(context.req.query("day")),
  };
  const database = drizzle(context.env.DB);
  const [items, facets, total] = await Promise.all([
    fetchPublicSessions(database, eventId, filters),
    fetchPublicEventFacets(database, eventId),
    countPublicSessions(database, eventId),
  ]);
  if (facets === null) {
    return context.json({ error: "not_found" }, 404);
  }
  return context.json({ items, total, filtered: items.length, facets });
});

publicRoutes.get("/events/:eventId/speakers", async (context) => {
  const eventId = context.req.param("eventId");
  const database = drizzle(context.env.DB);
  const [facets, items, total] = await Promise.all([
    fetchPublicEventFacets(database, eventId),
    fetchPublicSpeakers(database, eventId, { q: queryParam(context.req.query("q")) }),
    countPublicSpeakers(database, eventId),
  ]);
  if (facets === null) {
    return context.json({ error: "not_found" }, 404);
  }
  return context.json({ items, total, filtered: items.length, facets });
});

publicRoutes.get("/events/:eventId/speakers/:speakerId", async (context) => {
  const eventId = context.req.param("eventId");
  const speakerId = context.req.param("speakerId");
  const database = drizzle(context.env.DB);
  const [speaker, facets] = await Promise.all([
    fetchPublicSpeaker(database, eventId, speakerId),
    fetchPublicEventFacets(database, eventId),
  ]);
  if (speaker === null || facets === null) {
    return context.json({ error: "not_found" }, 404);
  }
  return context.json({ speaker, facets });
});

publicRoutes.get("/events/:eventId/agenda", async (context) => {
  const database = drizzle(context.env.DB);
  const items = await fetchPublicSessions(database, context.req.param("eventId"), {
    q: undefined,
    track: undefined,
    format: undefined,
    room: undefined,
    day: undefined,
  });
  return context.json({ items });
});
publicRoutes.get("/events/:eventId/schedule.ics", async (context) => {
  const eventId = context.req.param("eventId");
  const selectedIds = [...new Set((context.req.query("sessions") ?? "").split(",").filter(Boolean))].slice(0, 100);
  const database = drizzle(context.env.DB);
  const [publicItems, facets] = await Promise.all([
    fetchPublicSessions(database, eventId, {
      q: undefined,
      track: undefined,
      format: undefined,
      room: undefined,
      day: undefined,
    }),
    fetchPublicEventFacets(database, eventId),
  ]);
  if (facets === null) {
    return context.json({ error: "not_found" }, 404);
  }

  const selected = publicItems
    .filter((session) => selectedIds.includes(session.id))
    .filter((session) => session.startsAt !== null && session.endsAt !== null)
    .sort((left, right) => (left.startsAt ?? 0) - (right.startsAt ?? 0));
  const calendar = buildScheduleIcs({
    calendarName: `${facets.event.name} personal schedule`,
    organizer: { name: facets.event.name, email: "calendar@greenroom.invalid" },
    dtstamp: new Date(),
    sessions: selected.flatMap((session) => {
      if (session.startsAt === null || session.endsAt === null) {
        return [];
      }
      return [{
        icsUid: session.icsUid,
        sequence: session.icsSequence,
        title: session.title ?? "Untitled session",
        description: session.abstract,
        startsAt: new Date(session.startsAt),
        endsAt: new Date(session.endsAt),
        room: session.room,
      }];
    }),
  });

  return new Response(calendar, {
    headers: {
      "cache-control": "no-cache",
      "content-disposition": 'attachment; filename="my-schedule.ics"',
      "content-type": "text/calendar; charset=utf-8",
    },
  });
});
