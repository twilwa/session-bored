// ABOUTME: Serves complete event-program downloads to authenticated organizers.
// ABOUTME: Keeps private operational data behind role checks while preserving portable labels and IDs.
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import {
  comments,
  events,
  formats,
  people,
  reviewAssignments,
  reviewRounds,
  reviews,
  rooms,
  scorecardCriteria,
  sessionSpeakers,
  sessions,
  speakers,
  submissionSpeakers,
  submissionTracks,
  submissions,
  submissionValues,
  tracks,
  users,
  type Role,
} from "../../db/schema.ts";
import { formVersionFields, formVersions } from "../../db/schema/cfp-builder.ts";
import { buildScheduleIcs } from "../email/ics.ts";
import { serializeCsv, type CsvCell } from "../exports/serialize.ts";

type ExportEnvironment = {
  Bindings: CloudflareBindings;
  Variables: {
    authUser: { id: string } | null;
    role: Role | null;
  };
};

const exportRoutes = new Hono<ExportEnvironment>();

const requireOrganizer = createMiddleware<ExportEnvironment>(async (context, next) => {
  if (context.get("role") !== "organizer") {
    const status = context.get("role") === null ? 401 : 403;
    return context.json(
      { error: status === 401 ? "authentication_required" : "forbidden" },
      status,
    );
  }
  await next();
});

exportRoutes.use("/api/events/:eventId/exports/*", requireOrganizer);

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function downloadHeaders(filename: string, contentType: string): HeadersInit {
  return {
    "content-type": contentType,
    "content-disposition": `attachment; filename="${filename}"`,
    "cache-control": "private, no-store",
  };
}

async function readEvent(binding: D1Database, eventId: string) {
  const [event] = await drizzle(binding)
    .select()
    .from(events)
    .where(and(eq(events.id, eventId), isNull(events.deletedAt)));
  return event;
}

function eventDocument(event: NonNullable<Awaited<ReturnType<typeof readEvent>>>) {
  return {
    id: event.id,
    slug: event.slug,
    name: event.name,
    tagline: event.tagline,
    description: event.description,
    startDate: event.startDate,
    endDate: event.endDate,
    venue: event.venue,
    timezone: event.timezone,
  };
}

async function readSubmissionAnswers(binding: D1Database, eventId: string) {
  return drizzle(binding)
    .select({
      submissionId: submissions.id,
      fieldId: formVersionFields.stableFieldId,
      key: formVersionFields.key,
      label: formVersionFields.label,
      fieldType: formVersionFields.fieldType,
      value: submissionValues.value,
    })
    .from(submissionValues)
    .innerJoin(submissions, eq(submissionValues.submissionId, submissions.id))
    .innerJoin(
      formVersions,
      and(
        eq(formVersions.formId, submissions.formId),
        eq(formVersions.version, submissions.formVersion),
      ),
    )
    .innerJoin(
      formVersionFields,
      and(
        eq(formVersionFields.formVersionId, formVersions.id),
        eq(formVersionFields.stableFieldId, submissionValues.fieldId),
      ),
    )
    .where(and(
      eq(submissions.eventId, eventId),
      isNull(submissions.deletedAt),
      isNull(submissionValues.deletedAt),
    ))
    .orderBy(asc(formVersionFields.sortOrder));
}

exportRoutes.get("/api/events/:eventId/exports/sessions.json", async (context) => {
  const eventId = context.req.param("eventId");
  const event = await readEvent(context.env.DB, eventId);
  if (event === undefined) return context.json({ error: "event_not_found" }, 404);
  const database = drizzle(context.env.DB);
  const sessionRows = await database
    .select({
      id: sessions.id,
      submissionId: sessions.submissionId,
      formId: submissions.formId,
      formVersion: submissions.formVersion,
      decision: submissions.status,
      title: sessions.title,
      abstract: sessions.abstract,
      contentStatus: sessions.contentStatus,
      scheduleStatus: sessions.scheduleStatus,
      scheduledDate: sessions.scheduledDate,
      startsAt: sessions.startsAt,
      endsAt: sessions.endsAt,
      directEntry: sessions.directEntry,
      publishedAt: sessions.publishedAt,
      trackId: tracks.id,
      trackName: tracks.name,
      formatId: formats.id,
      formatName: formats.name,
      durationMinutes: formats.durationMinutes,
      roomId: rooms.id,
      roomName: rooms.name,
      icsUid: sessions.icsUid,
      icsSequence: sessions.icsSequence,
      createdAt: sessions.createdAt,
      updatedAt: sessions.updatedAt,
    })
    .from(sessions)
    .leftJoin(submissions, eq(sessions.submissionId, submissions.id))
    .leftJoin(tracks, eq(sessions.trackId, tracks.id))
    .leftJoin(formats, eq(sessions.formatId, formats.id))
    .leftJoin(rooms, eq(sessions.roomId, rooms.id))
    .where(and(eq(sessions.eventId, eventId), isNull(sessions.deletedAt)))
    .orderBy(asc(sessions.createdAt), asc(sessions.id));
  const sessionIds = sessionRows.map((session) => session.id);
  const sourceSubmissionRows = await database
    .select({
      id: submissions.id,
      formId: submissions.formId,
      formVersion: submissions.formVersion,
      submitterPersonId: submissions.submitterPersonId,
      submitterName: people.name,
      submitterEmail: people.email,
      formatId: formats.id,
      formatName: formats.name,
      durationMinutes: formats.durationMinutes,
      status: submissions.status,
      isDraft: submissions.isDraft,
      title: submissions.title,
      abstract: submissions.abstract,
      titleAtTime: submissions.titleAtTime,
      orgAtTime: submissions.orgAtTime,
      audienceLevel: submissions.audienceLevel,
      notesForReviewers: submissions.notesForReviewers,
      submittedAt: submissions.submittedAt,
      createdAt: submissions.createdAt,
      updatedAt: submissions.updatedAt,
    })
    .from(submissions)
    .innerJoin(people, eq(submissions.submitterPersonId, people.id))
    .leftJoin(formats, eq(submissions.formatId, formats.id))
    .where(and(eq(submissions.eventId, eventId), isNull(submissions.deletedAt)))
    .orderBy(asc(submissions.createdAt), asc(submissions.id));
  const sourceSubmissionIds = sourceSubmissionRows.map((submission) => submission.id);
  const [speakerRows, answerRows, sourceSpeakerRows, sourceTrackRows] = await Promise.all([
    sessionIds.length === 0
      ? Promise.resolve([])
      : database
        .select({
          sessionId: sessionSpeakers.sessionId,
          speakerId: speakers.id,
          personId: people.id,
          name: people.name,
          email: people.email,
          role: sessionSpeakers.roleLabel,
          sortOrder: sessionSpeakers.sortOrder,
        })
        .from(sessionSpeakers)
        .innerJoin(speakers, eq(sessionSpeakers.speakerId, speakers.id))
        .innerJoin(people, eq(speakers.personId, people.id))
        .where(and(inArray(sessionSpeakers.sessionId, sessionIds), isNull(sessionSpeakers.deletedAt)))
        .orderBy(asc(sessionSpeakers.sortOrder), asc(people.name)),
    readSubmissionAnswers(context.env.DB, eventId),
    sourceSubmissionIds.length === 0
      ? Promise.resolve([])
      : database
        .select({
          submissionId: submissionSpeakers.submissionId,
          personId: people.id,
          name: people.name,
          email: people.email,
          role: submissionSpeakers.roleLabel,
          sortOrder: submissionSpeakers.sortOrder,
        })
        .from(submissionSpeakers)
        .innerJoin(people, eq(submissionSpeakers.personId, people.id))
        .where(and(
          inArray(submissionSpeakers.submissionId, sourceSubmissionIds),
          isNull(submissionSpeakers.deletedAt),
          isNull(people.deletedAt),
        ))
        .orderBy(asc(submissionSpeakers.sortOrder), asc(people.name)),
    sourceSubmissionIds.length === 0
      ? Promise.resolve([])
      : database
        .select({
          submissionId: submissionTracks.submissionId,
          id: tracks.id,
          name: tracks.name,
        })
        .from(submissionTracks)
        .innerJoin(tracks, eq(submissionTracks.trackId, tracks.id))
        .where(and(
          inArray(submissionTracks.submissionId, sourceSubmissionIds),
          isNull(submissionTracks.deletedAt),
          isNull(tracks.deletedAt),
        ))
        .orderBy(asc(tracks.sortOrder), asc(tracks.name)),
  ]);
  const document = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    event: eventDocument(event),
    sourceSubmissions: sourceSubmissionRows.map((submission) => ({
      id: submission.id,
      formId: submission.formId,
      formVersion: submission.formVersion,
      submitter: {
        personId: submission.submitterPersonId,
        name: submission.submitterName,
        email: submission.submitterEmail,
      },
      format: submission.formatId === null ? null : {
        id: submission.formatId,
        name: submission.formatName,
        durationMinutes: submission.durationMinutes,
      },
      status: submission.status,
      isDraft: submission.isDraft,
      title: submission.title,
      abstract: submission.abstract,
      titleAtTime: submission.titleAtTime,
      orgAtTime: submission.orgAtTime,
      audienceLevel: submission.audienceLevel,
      notesForReviewers: submission.notesForReviewers,
      tracks: sourceTrackRows
        .filter((track) => track.submissionId === submission.id)
        .map(({ submissionId: _submissionId, ...track }) => track),
      speakers: sourceSpeakerRows
        .filter((speaker) => speaker.submissionId === submission.id)
        .map(({ submissionId: _submissionId, sortOrder: _sortOrder, ...speaker }) => speaker),
      customAnswers: answerRows
        .filter((answer) => answer.submissionId === submission.id)
        .map(({ submissionId: _submissionId, ...answer }) => answer),
      submittedAt: iso(submission.submittedAt),
      createdAt: submission.createdAt.toISOString(),
      updatedAt: submission.updatedAt.toISOString(),
    })),
    sessions: sessionRows.map((session) => ({
      id: session.id,
      sourceSubmission: session.submissionId === null ? null : {
        id: session.submissionId,
        formId: session.formId,
        formVersion: session.formVersion,
        decision: session.decision,
        customAnswers: answerRows
          .filter((answer) => answer.submissionId === session.submissionId)
          .map(({ submissionId: _submissionId, ...answer }) => answer),
      },
      title: session.title,
      abstract: session.abstract,
      contentStatus: session.contentStatus,
      scheduleStatus: session.scheduleStatus,
      scheduledDate: session.scheduledDate,
      startsAt: iso(session.startsAt),
      endsAt: iso(session.endsAt),
      directEntry: session.directEntry,
      publishedAt: iso(session.publishedAt),
      track: session.trackId === null ? null : { id: session.trackId, name: session.trackName },
      format: session.formatId === null ? null : {
        id: session.formatId,
        name: session.formatName,
        durationMinutes: session.durationMinutes,
      },
      room: session.roomId === null ? null : { id: session.roomId, name: session.roomName },
      speakers: speakerRows
        .filter((speaker) => speaker.sessionId === session.id)
        .map(({ sessionId: _sessionId, sortOrder: _sortOrder, speakerId: id, ...speaker }) => ({ id, ...speaker })),
      calendar: { uid: session.icsUid, sequence: session.icsSequence },
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
    })),
  };
  return new Response(JSON.stringify(document, null, 2) + "\n", {
    headers: downloadHeaders("sessions.json", "application/json; charset=utf-8"),
  });
});

exportRoutes.get("/api/events/:eventId/exports/speakers.json", async (context) => {
  const eventId = context.req.param("eventId");
  const event = await readEvent(context.env.DB, eventId);
  if (event === undefined) return context.json({ error: "event_not_found" }, 404);
  const database = drizzle(context.env.DB);
  const speakerRows = await database
    .select({
      id: speakers.id,
      personId: people.id,
      name: people.name,
      email: people.email,
      jobTitle: people.jobTitle,
      organization: people.organization,
      bio: people.bio,
      headshotUrl: people.headshotUrl,
      twitter: people.twitter,
      linkedin: people.linkedin,
      socialLinks: people.socialLinks,
      status: speakers.status,
      customFields: speakers.customFields,
      createdAt: speakers.createdAt,
      updatedAt: speakers.updatedAt,
    })
    .from(speakers)
    .innerJoin(people, eq(speakers.personId, people.id))
    .where(and(eq(speakers.eventId, eventId), isNull(speakers.deletedAt), isNull(people.deletedAt)))
    .orderBy(asc(people.name), asc(speakers.id));
  const speakerIds = speakerRows.map((speaker) => speaker.id);
  const personIds = speakerRows.map((speaker) => speaker.personId);
  const [sessionRows, submissionRows] = await Promise.all([
    speakerIds.length === 0
      ? Promise.resolve([])
      : database
        .select({
          speakerId: sessionSpeakers.speakerId,
          id: sessions.id,
          title: sessions.title,
          role: sessionSpeakers.roleLabel,
        })
        .from(sessionSpeakers)
        .innerJoin(sessions, eq(sessionSpeakers.sessionId, sessions.id))
        .where(and(
          inArray(sessionSpeakers.speakerId, speakerIds),
          eq(sessions.eventId, eventId),
          isNull(sessionSpeakers.deletedAt),
          isNull(sessions.deletedAt),
        ))
        .orderBy(asc(sessionSpeakers.sortOrder), asc(sessions.title)),
    personIds.length === 0
      ? Promise.resolve([])
      : database
        .select({
          personId: submissionSpeakers.personId,
          id: submissions.id,
          title: submissions.title,
          decision: submissions.status,
          role: submissionSpeakers.roleLabel,
        })
        .from(submissionSpeakers)
        .innerJoin(submissions, eq(submissionSpeakers.submissionId, submissions.id))
        .where(and(
          inArray(submissionSpeakers.personId, personIds),
          eq(submissions.eventId, eventId),
          isNull(submissionSpeakers.deletedAt),
          isNull(submissions.deletedAt),
        ))
        .orderBy(asc(submissionSpeakers.sortOrder), asc(submissions.title)),
  ]);
  const document = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    event: eventDocument(event),
    speakers: speakerRows.map((speaker) => ({
      ...speaker,
      createdAt: speaker.createdAt.toISOString(),
      updatedAt: speaker.updatedAt.toISOString(),
      sessions: sessionRows
        .filter((session) => session.speakerId === speaker.id)
        .map(({ speakerId: _speakerId, ...session }) => session),
      submissions: submissionRows
        .filter((submission) => submission.personId === speaker.personId)
        .map(({ personId: _personId, ...submission }) => submission),
    })),
  };
  return new Response(JSON.stringify(document, null, 2) + "\n", {
    headers: downloadHeaders("speakers.json", "application/json; charset=utf-8"),
  });
});

const reviewHeaders = [
  "submission_id",
  "submission_title",
  "submission_decision",
  "review_round",
  "reviewer_name",
  "reviewer_email",
  "assignment_status",
  "review_submitted_at",
  "aggregate_score",
  "criterion_id",
  "criterion_label",
  "criterion_type",
  "criterion_score",
  "review_notes",
  "committee_discussion",
];

exportRoutes.get("/api/events/:eventId/exports/reviews.csv", async (context) => {
  const eventId = context.req.param("eventId");
  const event = await readEvent(context.env.DB, eventId);
  if (event === undefined) return context.json({ error: "event_not_found" }, 404);
  const database = drizzle(context.env.DB);
  const [submissionRows, reviewRows, criterionRows, commentRows] = await Promise.all([
    database
      .select({ id: submissions.id, title: submissions.title, decision: submissions.status })
      .from(submissions)
      .where(and(eq(submissions.eventId, eventId), isNull(submissions.deletedAt), eq(submissions.isDraft, false)))
      .orderBy(asc(submissions.createdAt), asc(submissions.id)),
    database
      .select({
        submissionId: reviewAssignments.submissionId,
        roundId: reviewRounds.id,
        roundName: reviewRounds.name,
        reviewerName: users.name,
        reviewerEmail: users.email,
        assignmentStatus: reviewAssignments.status,
        submittedAt: reviews.submittedAt,
        aggregateScore: reviews.aggregateScore,
        scores: reviews.scores,
        notes: reviews.comment,
      })
      .from(reviews)
      .innerJoin(reviewAssignments, eq(reviews.assignmentId, reviewAssignments.id))
      .innerJoin(reviewRounds, eq(reviewAssignments.roundId, reviewRounds.id))
      .innerJoin(submissions, eq(reviewAssignments.submissionId, submissions.id))
      .innerJoin(users, eq(reviews.authorUserId, users.id))
      .where(and(
        eq(submissions.eventId, eventId),
        isNull(submissions.deletedAt),
        isNull(reviewAssignments.deletedAt),
        isNull(reviews.deletedAt),
      ))
      .orderBy(asc(submissions.createdAt), asc(reviewRounds.sortOrder), asc(users.name)),
    database
      .select({
        id: scorecardCriteria.id,
        roundId: scorecardCriteria.roundId,
        label: scorecardCriteria.label,
        criterionType: scorecardCriteria.criterionType,
        sortOrder: scorecardCriteria.sortOrder,
      })
      .from(scorecardCriteria)
      .innerJoin(reviewRounds, eq(scorecardCriteria.roundId, reviewRounds.id))
      .where(eq(reviewRounds.eventId, eventId))
      .orderBy(asc(reviewRounds.sortOrder), asc(scorecardCriteria.sortOrder)),
    database
      .select({
        submissionId: comments.submissionId,
        body: comments.body,
        createdAt: comments.createdAt,
        authorName: users.name,
      })
      .from(comments)
      .innerJoin(submissions, eq(comments.submissionId, submissions.id))
      .innerJoin(users, eq(comments.authorUserId, users.id))
      .where(and(eq(submissions.eventId, eventId), isNull(comments.deletedAt)))
      .orderBy(asc(comments.createdAt)),
  ]);
  const rows: CsvCell[][] = [];
  for (const submission of submissionRows) {
    const submissionReviews = reviewRows.filter((review) => review.submissionId === submission.id);
    const discussion = commentRows
      .filter((comment) => comment.submissionId === submission.id)
      .map((comment) => `${comment.createdAt.toISOString()} ${comment.authorName}: ${comment.body}`)
      .join("\n\n");
    if (submissionReviews.length === 0) {
      rows.push([submission.id, submission.title, submission.decision, "", "", "", "", "", "", "", "", "", "", "", discussion]);
      continue;
    }
    for (const review of submissionReviews) {
      const scores = Object.entries(review.scores ?? {});
      const reviewScores = scores.length === 0 ? [["", ""] as const] : scores;
      for (const [criterionId, score] of reviewScores) {
        const criterion = criterionRows.find((item) => item.id === criterionId && item.roundId === review.roundId);
        rows.push([
          submission.id,
          submission.title,
          submission.decision,
          review.roundName,
          review.reviewerName,
          review.reviewerEmail,
          review.assignmentStatus,
          iso(review.submittedAt),
          review.aggregateScore,
          criterionId,
          criterion?.label ?? criterionId,
          criterion?.criterionType ?? "historical",
          score,
          review.notes,
          discussion,
        ]);
      }
    }
  }
  return new Response(serializeCsv(reviewHeaders, rows), {
    headers: downloadHeaders("reviews.csv", "text/csv; charset=utf-8"),
  });
});

exportRoutes.get("/api/events/:eventId/exports/schedule.ics", async (context) => {
  const eventId = context.req.param("eventId");
  const event = await readEvent(context.env.DB, eventId);
  if (event === undefined) return context.json({ error: "event_not_found" }, 404);
  const rows = await drizzle(context.env.DB)
    .select({
      icsUid: sessions.icsUid,
      sequence: sessions.icsSequence,
      updatedAt: sessions.updatedAt,
      title: sessions.title,
      description: sessions.abstract,
      startsAt: sessions.startsAt,
      endsAt: sessions.endsAt,
      room: rooms.name,
    })
    .from(sessions)
    .leftJoin(submissions, eq(sessions.submissionId, submissions.id))
    .leftJoin(rooms, eq(sessions.roomId, rooms.id))
    .where(and(
      eq(sessions.eventId, eventId),
      isNull(sessions.deletedAt),
      eq(sessions.scheduleStatus, "placed"),
      or(eq(sessions.directEntry, true), eq(submissions.status, "accepted")),
    ))
    .orderBy(asc(sessions.startsAt), asc(sessions.title));
  const calendar = buildScheduleIcs({
    calendarName: `${event.name} schedule`,
    organizer: { name: event.name, email: "calendar@greenroom.invalid" },
    dtstamp: new Date(),
    sessions: rows.flatMap((session) =>
      session.startsAt === null || session.endsAt === null
        ? []
        : [{
          icsUid: session.icsUid,
          sequence: Math.max(session.sequence, Math.floor(session.updatedAt.getTime() / 1000)),
          title: session.title ?? "Untitled session",
          description: session.description,
          startsAt: session.startsAt,
          endsAt: session.endsAt,
          room: session.room,
        }]
    ),
  });
  return new Response(calendar, {
    headers: downloadHeaders("schedule.ics", "text/calendar; charset=utf-8"),
  });
});

export default exportRoutes;
