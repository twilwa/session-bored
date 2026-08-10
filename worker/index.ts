// ABOUTME: Serves Greenroom's same-origin Hono routes, Better Auth, and protected React assets.
// ABOUTME: Seeds fixture data and enforces role plus ownership scoping before resource access.
import { and, eq, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import {
  events,
  formFields,
  formats,
  forms,
  people,
  reviewAssignments,
  rooms,
  sessionSpeakers,
  sessions,
  speakers,
  submissionSpeakers,
  submissions,
  submissionTracks,
  taskAssignees,
  tasks,
  tracks,
  type Role,
  roles,
} from "../db/schema.ts";
import type { ApiAccess } from "../shared/api.ts";
import { authorizeAccess } from "./access.ts";
import { createAuth, type AuthSession } from "./auth.ts";
import cfpRoutes from "./routes/cfp.ts";
import reviewRoutes from "./routes/review.ts";
import { publicRoutes } from "./routes/public.ts";
import { ensureSeeded, fixtureIds } from "./seed.ts";
import dispositionRoutes from "./routes/disposition.ts";

type SessionUser = AuthSession["user"];
type AppEnvironment = {
  Bindings: CloudflareBindings;
  Variables: {
    authSession: AuthSession["session"] | null;
    authUser: SessionUser | null;
    role: Role | null;
  };
};

const app = new Hono<AppEnvironment>();

function parseRole(value: unknown): Role | null {
  for (const role of roles) {
    if (value === role) {
      return role;
    }
  }
  return null;
}

const prepareRequest = createMiddleware<AppEnvironment>(async (context, next) => {
  await ensureSeeded(context.env);
  const authSession = await createAuth(context.env).api.getSession({ headers: context.req.raw.headers });
  context.set("authSession", authSession?.session ?? null);
  context.set("authUser", authSession?.user ?? null);
  context.set("role", parseRole(authSession?.user.role));
  await next();
});

function requireAccess(access: ApiAccess) {
  return createMiddleware<AppEnvironment>(async (context, next) => {
    const role = context.get("role");
    const decision = authorizeAccess(role === null ? null : { role }, access);
    if (!decision.allowed) {
      return context.json(
        { error: decision.status === 401 ? "authentication_required" : "forbidden" },
        decision.status,
      );
    }
    await next();
  });
}

app.onError((error, context) => {
  console.error(
    JSON.stringify({
      message: "request failed",
      error: error.message,
      path: context.req.path,
    }),
  );
  return context.json({ error: "internal_server_error" }, 500);
});

app.use("/api/*", prepareRequest);
app.route("/", dispositionRoutes);
app.on(["GET", "POST"], "/api/auth/*", (context) => createAuth(context.env).handler(context.req.raw));
app.route("/api/public/cfp", cfpRoutes);

app.get("/api/health", (context) =>
  context.json({ status: "healthy", service: "greenroom", seededEventId: fixtureIds.event }),
);

app.get("/api/session", requireAccess("authenticated"), (context) =>
  context.json({ user: context.get("authUser"), session: context.get("authSession") }),
);

app.route("/api", reviewRoutes);
app.route("/api/public", publicRoutes);

app.get("/api/public/cfp/:slug", async (context) => {
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

app.get("/api/public/events/:eventId/sessions", async (context) => {
  const database = drizzle(context.env.DB);
  const items = await database
    .select({
      id: sessions.id,
      title: sessions.title,
      abstract: sessions.abstract,
      contentStatus: sessions.contentStatus,
      scheduleStatus: sessions.scheduleStatus,
      scheduledDate: sessions.scheduledDate,
      startsAt: sessions.startsAt,
      endsAt: sessions.endsAt,
      track: tracks.name,
      format: formats.name,
      room: rooms.name,
    })
    .from(sessions)
    .leftJoin(tracks, eq(sessions.trackId, tracks.id))
    .leftJoin(formats, eq(sessions.formatId, formats.id))
    .leftJoin(rooms, eq(sessions.roomId, rooms.id))
    .where(and(eq(sessions.eventId, context.req.param("eventId")), eq(sessions.contentStatus, "approved")));
  return context.json({ items });
});

app.get("/api/public/events/:eventId/speakers", async (context) => {
  const database = drizzle(context.env.DB);
  const items = await database
    .select({
      id: speakers.id,
      name: people.name,
      jobTitle: people.jobTitle,
      organization: people.organization,
      bio: people.bio,
      headshotUrl: people.headshotUrl,
    })
    .from(speakers)
    .innerJoin(people, eq(speakers.personId, people.id))
    .where(and(eq(speakers.eventId, context.req.param("eventId")), ne(speakers.status, "withdrawn")));
  return context.json({ items });
});

app.get("/api/public/events/:eventId/agenda", async (context) => {
  const database = drizzle(context.env.DB);
  const items = await database
    .select({
      id: sessions.id,
      title: sessions.title,
      scheduledDate: sessions.scheduledDate,
      startsAt: sessions.startsAt,
      endsAt: sessions.endsAt,
      scheduleStatus: sessions.scheduleStatus,
      room: rooms.name,
    })
    .from(sessions)
    .leftJoin(rooms, eq(sessions.roomId, rooms.id))
    .where(and(eq(sessions.eventId, context.req.param("eventId")), eq(sessions.contentStatus, "approved")));
  return context.json({ items });
});

app.get("/api/public/embeds/:token", (context) =>
  context.json({ status: "foundation_stub", module: "embeds", token: context.req.param("token"), items: [] }),
);

app.get("/api/events", requireAccess("organizer"), async (context) => {
  const items = await drizzle(context.env.DB).select().from(events);
  return context.json({ items });
});

app.get("/api/events/:eventId", requireAccess("organizer"), async (context) => {
  const [event] = await drizzle(context.env.DB)
    .select()
    .from(events)
    .where(eq(events.id, context.req.param("eventId")));
  return event === undefined ? context.json({ error: "not_found" }, 404) : context.json(event);
});

app.get("/api/events/:eventId/tracks", requireAccess("organizer"), async (context) => {
  const items = await drizzle(context.env.DB).select().from(tracks).where(eq(tracks.eventId, context.req.param("eventId")));
  return context.json({ items });
});

app.get("/api/events/:eventId/formats", requireAccess("organizer"), async (context) => {
  const items = await drizzle(context.env.DB).select().from(formats).where(eq(formats.eventId, context.req.param("eventId")));
  return context.json({ items });
});

app.get("/api/events/:eventId/rooms", requireAccess("organizer"), async (context) => {
  const items = await drizzle(context.env.DB).select().from(rooms).where(eq(rooms.eventId, context.req.param("eventId")));
  return context.json({ items });
});

app.get("/api/events/:eventId/forms", requireAccess("organizer"), async (context) => {
  const items = await drizzle(context.env.DB).select().from(forms).where(eq(forms.eventId, context.req.param("eventId")));
  return context.json({ items });
});

app.get("/api/forms/:formId", requireAccess("organizer"), async (context) => {
  const database = drizzle(context.env.DB);
  const [form] = await database.select().from(forms).where(eq(forms.id, context.req.param("formId")));
  if (form === undefined) {
    return context.json({ error: "not_found" }, 404);
  }
  const fields = await database.select().from(formFields).where(eq(formFields.formId, form.id));
  return context.json({ ...form, fields });
});

app.get("/api/events/:eventId/submissions", requireAccess("organizer"), async (context) => {
  const items = await drizzle(context.env.DB)
    .select()
    .from(submissions)
    .where(eq(submissions.eventId, context.req.param("eventId")));
  return context.json({ items });
});

app.get("/api/submissions/:submissionId", requireAccess("organizer"), async (context) => {
  const [submission] = await drizzle(context.env.DB)
    .select()
    .from(submissions)
    .where(eq(submissions.id, context.req.param("submissionId")));
  return submission === undefined ? context.json({ error: "not_found" }, 404) : context.json(submission);
});

app.get("/api/reviewer/assignments", requireAccess("reviewer"), async (context) => {
  const user = context.get("authUser");
  if (user === null) {
    return context.json({ error: "authentication_required" }, 401);
  }
  const items = await drizzle(context.env.DB)
    .select({
      id: reviewAssignments.id,
      submissionId: reviewAssignments.submissionId,
      status: reviewAssignments.status,
      title: submissions.title,
    })
    .from(reviewAssignments)
    .innerJoin(submissions, eq(reviewAssignments.submissionId, submissions.id))
    .where(eq(reviewAssignments.reviewerUserId, user.id));
  return context.json({ items });
});

app.get("/api/reviewer/submissions/:submissionId", requireAccess("reviewer"), async (context) => {
  const user = context.get("authUser");
  if (user === null) {
    return context.json({ error: "authentication_required" }, 401);
  }
  const [item] = await drizzle(context.env.DB)
    .select({
      assignmentId: reviewAssignments.id,
      submissionId: submissions.id,
      title: submissions.title,
      abstract: submissions.abstract,
      status: submissions.status,
    })
    .from(reviewAssignments)
    .innerJoin(submissions, eq(reviewAssignments.submissionId, submissions.id))
    .where(
      and(
        eq(reviewAssignments.reviewerUserId, user.id),
        eq(reviewAssignments.submissionId, context.req.param("submissionId")),
      ),
    );
  return item === undefined ? context.json({ error: "forbidden" }, 403) : context.json(item);
});

app.get("/api/speaker/submissions/:submissionId", requireAccess("speaker"), async (context) => {
  const user = context.get("authUser");
  if (user === null) {
    return context.json({ error: "authentication_required" }, 401);
  }
  const [item] = await drizzle(context.env.DB)
    .select({ id: submissions.id, title: submissions.title, abstract: submissions.abstract, status: submissions.status })
    .from(submissions)
    .innerJoin(submissionSpeakers, eq(submissionSpeakers.submissionId, submissions.id))
    .innerJoin(people, eq(submissionSpeakers.personId, people.id))
    .where(and(eq(people.userId, user.id), eq(submissions.id, context.req.param("submissionId"))));
  return item === undefined ? context.json({ error: "forbidden" }, 403) : context.json(item);
});

app.get("/api/speaker/content", requireAccess("speaker"), async (context) => {
  const user = context.get("authUser");
  if (user === null) {
    return context.json({ error: "authentication_required" }, 401);
  }
  const database = drizzle(context.env.DB);
  const [profile] = await database
    .select({
      speakerId: speakers.id,
      personId: people.id,
      name: people.name,
      email: people.email,
      jobTitle: people.jobTitle,
      organization: people.organization,
      bio: people.bio,
      status: speakers.status,
    })
    .from(people)
    .innerJoin(speakers, eq(speakers.personId, people.id))
    .where(eq(people.userId, user.id));
  if (profile === undefined) {
    return context.json({ profile: null, submissions: [], tasks: [] });
  }
  const ownSubmissions = await database
    .select({ id: submissions.id, title: submissions.title, status: submissions.status })
    .from(submissions)
    .innerJoin(submissionSpeakers, eq(submissionSpeakers.submissionId, submissions.id))
    .where(eq(submissionSpeakers.personId, profile.personId));
  const ownTasks = await database
    .select({ id: tasks.id, title: tasks.title, dueAt: tasks.dueAt, status: taskAssignees.status })
    .from(taskAssignees)
    .innerJoin(tasks, eq(taskAssignees.taskId, tasks.id))
    .where(eq(taskAssignees.speakerId, profile.speakerId));
  return context.json({ profile, submissions: ownSubmissions, tasks: ownTasks });
});

app.get("/api/events/:eventId/reviews", requireAccess("organizer"), (context) =>
  context.json({ status: "foundation_stub", module: "reviews", eventId: context.req.param("eventId"), items: [] }),
);

app.get("/api/events/:eventId/speakers", requireAccess("organizer"), async (context) => {
  const items = await drizzle(context.env.DB)
    .select({
      id: speakers.id,
      name: people.name,
      email: people.email,
      jobTitle: people.jobTitle,
      organization: people.organization,
      status: speakers.status,
    })
    .from(speakers)
    .innerJoin(people, eq(speakers.personId, people.id))
    .where(eq(speakers.eventId, context.req.param("eventId")));
  return context.json({ items });
});

app.get("/api/events/:eventId/sessions", requireAccess("organizer"), async (context) => {
  const items = await drizzle(context.env.DB).select().from(sessions).where(eq(sessions.eventId, context.req.param("eventId")));
  return context.json({ items });
});

app.get("/api/events/:eventId/tasks", requireAccess("organizer"), async (context) => {
  const items = await drizzle(context.env.DB).select().from(tasks).where(eq(tasks.eventId, context.req.param("eventId")));
  return context.json({ items });
});

for (const path of [
  "/api/events/:eventId/files",
  "/api/events/:eventId/email-dispatches",
  "/api/events/:eventId/agenda",
  "/api/events/:eventId/embeds",
] as const) {
  app.get(path, requireAccess("organizer"), (context) =>
    context.json({ status: "foundation_stub", eventId: context.req.param("eventId"), items: [] }),
  );
}

for (const [prefix, access] of [
  ["/organizer", "organizer"],
  ["/reviewer", "reviewer"],
  ["/speaker", "speaker"],
] as const) {
  app.get(prefix, prepareRequest, requireAccess(access), (context) => context.env.ASSETS.fetch(context.req.raw));
  app.get(`${prefix}/*`, prepareRequest, requireAccess(access), (context) => context.env.ASSETS.fetch(context.req.raw));
}

export type AppType = typeof app;
export default app;
