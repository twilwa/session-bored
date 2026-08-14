// ABOUTME: Lets the program team name, amend, and remove the participants on a proposal.
// ABOUTME: Writes the same submission_speaker rows the submitter wrote and keeps an accepted session in step.
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import {
  createPublicId,
  people,
  sessionSpeakers,
  sessions,
  speakers,
  submissions,
  submissionSpeakers,
  type Role,
} from "../../db/schema.ts";
import type { ParticipantRemovalOutcome } from "../../shared/api.ts";
import { holdsAccess } from "../access.ts";
import { PUBLIC_SPEAKER_STATUSES } from "../public-queries.ts";
import { resolvePersonByEmail } from "../speaker-directory.ts";
import {
  carryParticipantIntoSession,
  releaseParticipantFromSession,
  speaksElsewhereAtEvent,
} from "../submission-decision.ts";

type ParticipantEnvironment = {
  Bindings: CloudflareBindings;
  Variables: {
    authUser: { id: string } | null;
    roles: Role[] | null;
  };
};

const participantRoutes = new Hono<ParticipantEnvironment>();

const requireOrganizer = createMiddleware<ParticipantEnvironment>(async (context, next) => {
  if (!holdsAccess(context.get("roles") ?? [], "organizer")) {
    const status = context.get("roles") === null ? 401 : 403;
    return context.json({ error: status === 401 ? "authentication_required" : "forbidden" }, status);
  }
  await next();
});

participantRoutes.use("/api/events/:eventId/submissions/:submissionId/participants", requireOrganizer);
participantRoutes.use("/api/events/:eventId/submissions/:submissionId/participants/*", requireOrganizer);

type ParticipantDatabase = ReturnType<typeof drizzle>;

type SubmissionContext = NonNullable<Awaited<ReturnType<typeof readSubmissionContext>>>;

const emailPattern = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function readSubmissionContext(
  database: ParticipantDatabase,
  eventId: string,
  submissionId: string,
) {
  const [submission] = await database
    .select({ id: submissions.id, submitterPersonId: submissions.submitterPersonId })
    .from(submissions)
    .where(and(eq(submissions.id, submissionId), eq(submissions.eventId, eventId)));
  if (submission === undefined) {
    return null;
  }
  const [session] = await database
    .select({ id: sessions.id, contentStatus: sessions.contentStatus })
    .from(sessions)
    .where(and(eq(sessions.submissionId, submissionId), eq(sessions.eventId, eventId)));
  return {
    submission,
    sessionId: session?.id ?? null,
    sessionContentStatus: session?.contentStatus ?? null,
  };
}

/**
 * Whether this person could actually reach the session, asked while the link is still live.
 * A participant is named, not admitted: the public CFP edit adds a collaborator to the
 * proposal without carrying them onto its session, so a session-bearing proposal can hold a
 * participant who never had session access for removal to take away.
 */
async function holdsSessionAccess(
  database: ParticipantDatabase,
  eventId: string,
  sessionId: string,
  personId: string,
): Promise<boolean> {
  const [link] = await database
    .select({ id: sessionSpeakers.id })
    .from(sessionSpeakers)
    .innerJoin(speakers, eq(sessionSpeakers.speakerId, speakers.id))
    .where(and(
      eq(sessionSpeakers.sessionId, sessionId),
      eq(speakers.personId, personId),
      eq(speakers.eventId, eventId),
      isNull(sessionSpeakers.deletedAt),
    ))
    .limit(1);
  return link !== undefined;
}

/**
 * Reads what removing this person leaves standing at the event. The event-scoped `speaker`
 * row is deliberately untouched by removal, so the organizer is told it is still there, and
 * whether it is still on the public directory, rather than assuming removal withdrew them.
 * Every fact is read from the event after the removal, so a proposal that never had a session
 * still reports the programme the person speaks on elsewhere. `heldSessionAccess` is the one
 * exception, and has to be: the session link it speaks about is gone by the time this runs.
 */
async function removalOutcome(
  database: ParticipantDatabase,
  eventId: string,
  personId: string,
  heldSessionAccess: boolean,
  withdrawnOnboarding: ParticipantRemovalOutcome["withdrawnOnboarding"],
): Promise<ParticipantRemovalOutcome> {
  const [person] = await database
    .select({ id: people.id, name: people.name })
    .from(people)
    .where(eq(people.id, personId));
  const [speaker] = await database
    .select({ id: speakers.id, status: speakers.status, deletedAt: speakers.deletedAt })
    .from(speakers)
    .where(and(eq(speakers.personId, personId), eq(speakers.eventId, eventId)));
  const remainsEventSpeaker = speaker !== undefined && speaker.deletedAt === null;
  const stillSpeaking = remainsEventSpeaker
    && await speaksElsewhereAtEvent(database, eventId, speaker.id);
  return {
    name: person?.name ?? "That participant",
    personId: personId as `psn_${string}`,
    speakerId: remainsEventSpeaker ? (speaker.id as `spk_${string}`) : null,
    remainsEventSpeaker,
    listedPublicly: remainsEventSpeaker
      && (PUBLIC_SPEAKER_STATUSES as readonly string[]).includes(speaker.status),
    speaksElsewhereAtEvent: stillSpeaking,
    withdrawnOnboarding,
    heldSessionAccess,
  };
}

async function participantsResponse(
  database: ParticipantDatabase,
  eventId: string,
  submissionId: string,
  scope: SubmissionContext,
) {
  const { sessionId, sessionContentStatus } = scope;
  const submitterPersonId = scope.submission.submitterPersonId;
  const rows = await database
    .select({
      id: submissionSpeakers.id,
      personId: people.id,
      name: people.name,
      email: people.email,
      jobTitle: people.jobTitle,
      organization: people.organization,
      roleLabel: submissionSpeakers.roleLabel,
      sortOrder: submissionSpeakers.sortOrder,
    })
    .from(submissionSpeakers)
    .innerJoin(people, eq(submissionSpeakers.personId, people.id))
    .where(and(eq(submissionSpeakers.submissionId, submissionId), isNull(submissionSpeakers.deletedAt)))
    .orderBy(asc(submissionSpeakers.sortOrder), asc(submissionSpeakers.id));
  const onSessionPersonIds = sessionId === null ? [] : await database
    .select({ personId: speakers.personId })
    .from(sessionSpeakers)
    .innerJoin(speakers, eq(sessionSpeakers.speakerId, speakers.id))
    .where(and(eq(sessionSpeakers.sessionId, sessionId), isNull(sessionSpeakers.deletedAt)));
  const carried = new Set(onSessionPersonIds.map((row) => row.personId));
  return {
    submissionId,
    sessionId,
    sessionContentStatus,
    participants: rows.map((row) => ({
      ...row,
      isSubmitter: row.personId === submitterPersonId,
      onSession: carried.has(row.personId),
    })),
  };
}

participantRoutes.get("/api/events/:eventId/submissions/:submissionId/participants", async (context) => {
  const database = drizzle(context.env.DB);
  const eventId = context.req.param("eventId");
  const submissionId = context.req.param("submissionId");
  const scope = await readSubmissionContext(database, eventId, submissionId);
  if (scope === null) {
    return context.json({ error: "submission_not_found" }, 404);
  }
  return context.json(
    await participantsResponse(database, eventId, submissionId, scope),
  );
});

participantRoutes.post("/api/events/:eventId/submissions/:submissionId/participants", async (context) => {
  const database = drizzle(context.env.DB);
  const eventId = context.req.param("eventId");
  const submissionId = context.req.param("submissionId");
  const scope = await readSubmissionContext(database, eventId, submissionId);
  if (scope === null) {
    return context.json({ error: "submission_not_found" }, 404);
  }
  type ParticipantPayload = {
    name?: unknown;
    email?: unknown;
    roleLabel?: unknown;
    jobTitle?: unknown;
    organization?: unknown;
  };
  const payload = await context.req.json<ParticipantPayload>()
    .catch((): ParticipantPayload => ({}));
  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  const roleLabel = typeof payload.roleLabel === "string" && payload.roleLabel.trim() !== ""
    ? payload.roleLabel.trim()
    : "speaker";
  if (name === "" || !emailPattern.test(email)) {
    return context.json({ error: "invalid_participant" }, 400);
  }

  let person: { id: string } | undefined = await resolvePersonByEmail(database, email);
  if (person === undefined) {
    const personId = createPublicId("psn");
    await database.insert(people).values({
      id: personId,
      name,
      email,
      jobTitle: typeof payload.jobTitle === "string" && payload.jobTitle.trim() !== "" ? payload.jobTitle.trim() : null,
      organization: typeof payload.organization === "string" && payload.organization.trim() !== ""
        ? payload.organization.trim()
        : null,
    });
    [person] = await database.select({ id: people.id }).from(people).where(eq(people.id, personId));
  }
  if (person === undefined) {
    return context.json({ error: "invalid_participant" }, 400);
  }

  const [existingLink] = await database
    .select({ id: submissionSpeakers.id, deletedAt: submissionSpeakers.deletedAt })
    .from(submissionSpeakers)
    .where(and(eq(submissionSpeakers.submissionId, submissionId), eq(submissionSpeakers.personId, person.id)));
  if (existingLink !== undefined && existingLink.deletedAt === null) {
    return context.json({ error: "participant_already_named" }, 409);
  }
  const [last] = await database
    .select({ sortOrder: submissionSpeakers.sortOrder })
    .from(submissionSpeakers)
    .where(and(eq(submissionSpeakers.submissionId, submissionId), isNull(submissionSpeakers.deletedAt)))
    .orderBy(desc(submissionSpeakers.sortOrder))
    .limit(1);
  const sortOrder = (last?.sortOrder ?? -1) + 1;
  if (existingLink === undefined) {
    await database.insert(submissionSpeakers).values({
      id: createPublicId("sspk"),
      submissionId,
      personId: person.id,
      roleLabel,
      sortOrder,
    });
  } else {
    await database
      .update(submissionSpeakers)
      .set({ roleLabel, sortOrder, deletedAt: null })
      .where(eq(submissionSpeakers.id, existingLink.id));
  }
  if (scope.sessionId !== null) {
    await carryParticipantIntoSession(context.env.DB, eventId, scope.sessionId, {
      personId: person.id,
      roleLabel,
      sortOrder,
    });
  }
  return context.json(
    await participantsResponse(database, eventId, submissionId, scope),
    201,
  );
});

participantRoutes.patch(
  "/api/events/:eventId/submissions/:submissionId/participants/:participantId",
  async (context) => {
    const database = drizzle(context.env.DB);
    const eventId = context.req.param("eventId");
    const submissionId = context.req.param("submissionId");
    const scope = await readSubmissionContext(database, eventId, submissionId);
    if (scope === null) {
      return context.json({ error: "submission_not_found" }, 404);
    }
    const [participant] = await database
      .select({ id: submissionSpeakers.id, personId: submissionSpeakers.personId })
      .from(submissionSpeakers)
      .where(and(
        eq(submissionSpeakers.id, context.req.param("participantId")),
        eq(submissionSpeakers.submissionId, submissionId),
        isNull(submissionSpeakers.deletedAt),
      ));
    if (participant === undefined) {
      return context.json({ error: "participant_not_found" }, 404);
    }
    const payload = await context.req.json<{ roleLabel?: unknown }>()
      .catch((): { roleLabel?: unknown } => ({}));
    if (typeof payload.roleLabel !== "string" || payload.roleLabel.trim() === "") {
      return context.json({ error: "invalid_participant" }, 400);
    }
    const roleLabel = payload.roleLabel.trim();
    await database
      .update(submissionSpeakers)
      .set({ roleLabel })
      .where(eq(submissionSpeakers.id, participant.id));
    if (scope.sessionId !== null) {
      const [speaker] = await database
        .select({ id: speakers.id })
        .from(speakers)
        .where(and(eq(speakers.personId, participant.personId), eq(speakers.eventId, eventId)));
      if (speaker !== undefined) {
        await database
          .update(sessionSpeakers)
          .set({ roleLabel })
          .where(and(
            eq(sessionSpeakers.sessionId, scope.sessionId),
            eq(sessionSpeakers.speakerId, speaker.id),
          ));
      }
    }
    return context.json(
      await participantsResponse(database, eventId, submissionId, scope),
    );
  },
);

participantRoutes.delete(
  "/api/events/:eventId/submissions/:submissionId/participants/:participantId",
  async (context) => {
    const database = drizzle(context.env.DB);
    const eventId = context.req.param("eventId");
    const submissionId = context.req.param("submissionId");
    const scope = await readSubmissionContext(database, eventId, submissionId);
    if (scope === null) {
      return context.json({ error: "submission_not_found" }, 404);
    }
    const [participant] = await database
      .select({ id: submissionSpeakers.id, personId: submissionSpeakers.personId })
      .from(submissionSpeakers)
      .where(and(
        eq(submissionSpeakers.id, context.req.param("participantId")),
        eq(submissionSpeakers.submissionId, submissionId),
        isNull(submissionSpeakers.deletedAt),
      ));
    if (participant === undefined) {
      return context.json({ error: "participant_not_found" }, 404);
    }
    // ABOUTME: The submitter is the proposal's owner of record, so removing them would orphan
    // the private author link and the account dashboard that reach it.
    if (participant.personId === scope.submission.submitterPersonId) {
      return context.json({ error: "submitter_cannot_be_removed" }, 409);
    }
    const heldSessionAccess = scope.sessionId !== null
      && await holdsSessionAccess(database, eventId, scope.sessionId, participant.personId);
    await database
      .update(submissionSpeakers)
      .set({ deletedAt: new Date() })
      .where(eq(submissionSpeakers.id, participant.id));
    const release = scope.sessionId === null
      ? { withdrawnOnboarding: [] }
      : await releaseParticipantFromSession(context.env.DB, eventId, scope.sessionId, participant.personId);
    return context.json({
      ...await participantsResponse(database, eventId, submissionId, scope),
      removal: await removalOutcome(
        database,
        eventId,
        participant.personId,
        heldSessionAccess,
        release.withdrawnOnboarding.map((task) => ({
          taskId: task.id as `tsk_${string}`,
          title: task.title,
        })),
      ),
    });
  },
);

export default participantRoutes;
