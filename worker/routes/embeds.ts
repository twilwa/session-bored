// ABOUTME: Manages organizer embed definitions and resolves their public iframe, JSON, and iCal delivery.
// ABOUTME: Every public payload composes the existing gated audience queries so filters can only narrow visibility.
import { and, desc, eq, isNull } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { embeds, events, tracks, type Role } from "../../db/schema.ts";
import type { EmbedConfig, EmbedStatus, EmbedWidgetType } from "../../shared/api.ts";
import { buildScheduleIcs } from "../email/ics.ts";
import {
  countPublicSpeakers,
  countPublicSessions,
  fetchPublicEventFacets,
  fetchPublicSessions,
  fetchPublicSpeakers,
} from "../public-queries.ts";

type EmbedEnvironment = {
  Bindings: CloudflareBindings;
  Variables: {
    authUser: { id: string } | null;
    role: Role | null;
  };
};

const embedRoutes = new Hono<EmbedEnvironment>();
const widgetTypes = ["sessions", "speakers", "agenda", "itinerary", "gallery"] as const;
const statuses = ["draft", "published"] as const;
const publicHeaders = {
  "access-control-allow-origin": "*",
  "cache-control": "public, max-age=60",
};

const requireOrganizer = createMiddleware<EmbedEnvironment>(async (context, next) => {
  if (context.get("role") !== "organizer") {
    return context.json(
      { error: context.get("role") === null ? "authentication_required" : "forbidden" },
      context.get("role") === null ? 401 : 403,
    );
  }
  await next();
});

embedRoutes.use("/api/events/:eventId/embeds", requireOrganizer);
embedRoutes.use("/api/events/:eventId/embeds/*", requireOrganizer);

function isWidgetType(value: unknown): value is EmbedWidgetType {
  return typeof value === "string" && (widgetTypes as readonly string[]).includes(value);
}

function isStatus(value: unknown): value is EmbedStatus {
  return typeof value === "string" && (statuses as readonly string[]).includes(value);
}

type EmbedInput = {
  name: string;
  widgetType: EmbedWidgetType;
  status: EmbedStatus;
  config: EmbedConfig;
};

function readEmbedInput(payload: unknown): EmbedInput | null {
  if (typeof payload !== "object" || payload === null) return null;
  const input = payload as Record<string, unknown>;
  if (typeof input.name !== "string" || input.name.trim() === "" || !isWidgetType(input.widgetType)) {
    return null;
  }
  if (input.status !== undefined && !isStatus(input.status)) return null;
  if (input.track !== undefined && typeof input.track !== "string") return null;
  const track = typeof input.track === "string" ? input.track.trim() : "";
  return {
    name: input.name.trim(),
    widgetType: input.widgetType,
    status: input.status ?? "draft",
    config: track === "" ? {} : { track },
  };
}

async function eventAcceptsTrack(
  database: DrizzleD1Database,
  eventId: string,
  track: string | undefined,
): Promise<boolean> {
  const [event] = await database
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.id, eventId), isNull(events.deletedAt)));
  if (event === undefined) return false;
  if (track === undefined) return true;
  const [match] = await database
    .select({ id: tracks.id })
    .from(tracks)
    .where(and(eq(tracks.eventId, eventId), eq(tracks.name, track)));
  return match !== undefined;
}

embedRoutes.get("/api/events/:eventId/embeds", async (context) => {
  const items = await drizzle(context.env.DB)
    .select()
    .from(embeds)
    .where(and(eq(embeds.eventId, context.req.param("eventId")), isNull(embeds.deletedAt)))
    .orderBy(desc(embeds.createdAt));
  return context.json({ items });
});

embedRoutes.post("/api/events/:eventId/embeds", async (context) => {
  const input = readEmbedInput(await context.req.json().catch(() => null));
  if (input === null) return context.json({ error: "invalid_embed" }, 400);
  const database = drizzle(context.env.DB);
  const eventId = context.req.param("eventId");
  if (!await eventAcceptsTrack(database, eventId, input.config.track)) {
    return context.json({ error: "invalid_event_or_track" }, 400);
  }
  const publicToken = `emb_${crypto.randomUUID().replaceAll("-", "")}`;
  const [created] = await database
    .insert(embeds)
    .values({
      eventId,
      publicToken,
      name: input.name,
      widgetType: input.widgetType,
      status: input.status,
      config: input.config as Record<string, string | number | boolean>,
    })
    .returning();
  return context.json(created!, 201);
});

embedRoutes.patch("/api/events/:eventId/embeds/:embedId", async (context) => {
  const input = readEmbedInput(await context.req.json().catch(() => null));
  if (input === null) return context.json({ error: "invalid_embed" }, 400);
  const database = drizzle(context.env.DB);
  const eventId = context.req.param("eventId");
  if (!await eventAcceptsTrack(database, eventId, input.config.track)) {
    return context.json({ error: "invalid_event_or_track" }, 400);
  }
  const [updated] = await database
    .update(embeds)
    .set({
      name: input.name,
      widgetType: input.widgetType,
      status: input.status,
      config: input.config as Record<string, string | number | boolean>,
      updatedAt: new Date(),
    })
    .where(and(
      eq(embeds.id, context.req.param("embedId")),
      eq(embeds.eventId, eventId),
      isNull(embeds.deletedAt),
    ))
    .returning();
  return updated === undefined ? context.json({ error: "not_found" }, 404) : context.json(updated);
});

embedRoutes.delete("/api/events/:eventId/embeds/:embedId", async (context) => {
  const [removed] = await drizzle(context.env.DB)
    .update(embeds)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(embeds.id, context.req.param("embedId")),
      eq(embeds.eventId, context.req.param("eventId")),
      isNull(embeds.deletedAt),
    ))
    .returning({ id: embeds.id });
  return removed === undefined ? context.json({ error: "not_found" }, 404) : context.body(null, 204);
});

async function findPublishedEmbed(database: DrizzleD1Database, publicToken: string) {
  const [embed] = await database
    .select()
    .from(embeds)
    .where(and(
      eq(embeds.publicToken, publicToken),
      eq(embeds.status, "published"),
      isNull(embeds.deletedAt),
    ));
  return embed ?? null;
}

async function readPublicEmbed(database: DrizzleD1Database, publicToken: string) {
  const embed = await findPublishedEmbed(database, publicToken);
  if (embed === null) return null;
  const track = typeof embed.config?.track === "string" ? embed.config.track : undefined;
  const facets = await fetchPublicEventFacets(database, embed.eventId);
  if (facets === null) return null;

  if (embed.widgetType === "speakers" || embed.widgetType === "gallery") {
    const [allSpeakers, total] = await Promise.all([
      fetchPublicSpeakers(database, embed.eventId, { q: undefined }),
      countPublicSpeakers(database, embed.eventId),
    ]);
    if (track === undefined) {
      return { embed, items: allSpeakers, total, filtered: allSpeakers.length, facets };
    }
    const trackSessions = await fetchPublicSessions(database, embed.eventId, {
      q: undefined,
      track,
      format: undefined,
      room: undefined,
      day: undefined,
    });
    const visibleSpeakerIds = new Set(trackSessions.flatMap((session) => session.speakers.map((speaker) => speaker.id)));
    const items = allSpeakers.filter((speaker) => visibleSpeakerIds.has(speaker.id));
    return { embed, items, total, filtered: items.length, facets };
  }

  const [items, total] = await Promise.all([
    fetchPublicSessions(database, embed.eventId, {
      q: undefined,
      track,
      format: undefined,
      room: undefined,
      day: undefined,
    }),
    countPublicSessions(database, embed.eventId),
  ]);
  return { embed, items, total, filtered: items.length, facets };
}

function parseDelivery(value: string): { publicToken: string; format: "json" | "ics" } {
  if (value.endsWith(".ics")) return { publicToken: value.slice(0, -4), format: "ics" };
  if (value.endsWith(".json")) return { publicToken: value.slice(0, -5), format: "json" };
  return { publicToken: value, format: "json" };
}

embedRoutes.options("/api/public/embeds/:delivery", (context) => context.body(null, 204, {
  ...publicHeaders,
  "access-control-allow-methods": "GET, OPTIONS",
}));

embedRoutes.get("/api/public/embeds/:delivery", async (context) => {
  const database = drizzle(context.env.DB);
  const { publicToken, format } = parseDelivery(context.req.param("delivery"));
  const payload = await readPublicEmbed(database, publicToken);
  if (payload === null) return context.json({ error: "not_found" }, 404);
  if (format === "json") return context.json(payload, 200, publicHeaders);
  if (payload.embed.widgetType === "speakers" || payload.embed.widgetType === "gallery") {
    return context.json({ error: "not_found" }, 404);
  }

  const sessions = await fetchPublicSessions(database, payload.embed.eventId, {
    q: undefined,
    track: typeof payload.embed.config?.track === "string" ? payload.embed.config.track : undefined,
    format: undefined,
    room: undefined,
    day: undefined,
  });
  const calendar = buildScheduleIcs({
    calendarName: `${payload.facets.event.name} programme`,
    organizer: { name: payload.facets.event.name, email: "calendar@session-bored.invalid" },
    sessions: sessions.flatMap((session) =>
      session.startsAt === null || session.endsAt === null
        ? []
        : [{
            icsUid: session.icsUid,
            sequence: session.icsSequence,
            title: session.title ?? "Untitled session",
            description: session.abstract,
            startsAt: new Date(session.startsAt),
            endsAt: new Date(session.endsAt),
            room: session.room,
          }],
    ),
    dtstamp: new Date(),
  });
  return context.body(calendar, 200, {
    ...publicHeaders,
    "content-type": "text/calendar; charset=utf-8",
    "content-disposition": `attachment; filename="${publicToken}.ics"`,
  });
});

function iframeLoader(origin: string, publicToken: string, name: string): string {
  const targetId = `greenroom-${publicToken}`;
  return `(() => {
  const target = document.getElementById(${JSON.stringify(targetId)});
  if (!target) return;
  const iframe = document.createElement("iframe");
  iframe.src = ${JSON.stringify(`${origin}/embed/${publicToken}`)};
  iframe.title = ${JSON.stringify(`Greenroom ${name}`)};
  iframe.loading = "lazy";
  iframe.style.width = "100%";
  iframe.style.height = "480px";
  iframe.style.border = "0";
  iframe.style.display = "block";
  window.addEventListener("message", (event) => {
    if (event.origin !== ${JSON.stringify(origin)} || event.source !== iframe.contentWindow) return;
    if (event.data?.type === "greenroom:embed-height" && event.data.token === ${JSON.stringify(publicToken)}) {
      iframe.style.height = Math.max(240, Number(event.data.height) || 0) + "px";
    }
  });
  target.replaceChildren(iframe);
})();`;
}

embedRoutes.get("/embed/:delivery", async (context) => {
  const delivery = context.req.param("delivery");
  if (!delivery.endsWith(".js")) return context.notFound();
  const publicToken = delivery.slice(0, -3);
  const embed = await findPublishedEmbed(drizzle(context.env.DB), publicToken);
  if (embed === null) return context.json({ error: "not_found" }, 404);
  return context.body(iframeLoader(new URL(context.req.url).origin, publicToken, embed.name), 200, {
    "content-type": "text/javascript; charset=utf-8",
    "cache-control": "public, max-age=300",
  });
});

export default embedRoutes;
