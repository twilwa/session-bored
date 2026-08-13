// ABOUTME: Serves Greenroom's scoped committee review queues and submission permalinks.
// ABOUTME: Keeps discourse available by remit while reserving organizer-only review controls.
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import {
  aiScoreSuggestions,
  comments,
  createPublicId,
  events,
  formats,
  people,
  reviewAssignments,
  reviewerRoundPools,
  reviewerTracks,
  reviewRounds,
  reviews,
  scorecardCriteria,
  submissions,
  submissionSpeakers,
  submissionTracks,
  tracks,
  type Role,
  users,
} from "../../db/schema.ts";
import { holdsAccess } from "../access.ts";
import type { ReviewAssignmentStatus } from "../../shared/api.ts";
import type { AuthSession } from "../auth.ts";
import { createAuth } from "../auth.ts";
import { reviewProposalAnswers } from "../review-answers.ts";
import { grantRole, hasLiveGrant, listAccountsHoldingRole } from "../roles.ts";
import { applyReviewerRemit } from "../reviewer-invites.ts";
import { changeSubmissionStatuses } from "../submission-decision.ts";

type ReviewEnvironment = {
  Bindings: CloudflareBindings;
  Variables: {
    authSession: AuthSession["session"] | null;
    authUser: AuthSession["user"] | null;
    roles: Role[] | null;
  };
};

const reviewRoutes = new Hono<ReviewEnvironment>();

function requireRole(requiredRole: "organizer" | "reviewer") {
  return createMiddleware<ReviewEnvironment>(async (context, next) => {
    const roles = context.get("roles") ?? null;
    if (roles === null) {
      return context.json({ error: "authentication_required" }, 401);
    }
    if (!holdsAccess(roles, requiredRole)) {
      return context.json({ error: "forbidden" }, 403);
    }
    await next();
  });
}

function hasUnconfirmedSuggestedScores(
  scores: Record<string, string | number>,
  suggestedScores: Record<string, string | number>,
  confirmedCriterionIds: Set<string>,
): boolean {
  return Object.entries(suggestedScores).some(
    ([criterionId, suggestion]) =>
      scores[criterionId] === suggestion && !confirmedCriterionIds.has(criterionId),
  );
}

interface ReviewQueueItem {
  assignmentId: string | null;
  assignmentStatus: ReviewAssignmentStatus;
  roundId: string;
  roundName: string;
  eventId: string;
  anonymized: boolean;
  submissionId: string;
  title: string | null;
  status: string;
}

interface AggregateCriterion {
  id: string;
  criterionType: "numeric" | "dropdown" | "free_text";
  weight: number | null;
}

export function computeAggregateScore(
  scores: Record<string, string | number>,
  criteria: AggregateCriterion[],
): number | null {
  let weightedTotal = 0;
  let totalWeight = 0;
  for (const criterion of criteria) {
    const value = scores[criterion.id];
    if (criterion.criterionType !== "numeric" || typeof value !== "number" || !Number.isFinite(value)) {
      continue;
    }
    const weight = criterion.weight ?? 1;
    weightedTotal += value * weight;
    totalWeight += weight;
  }
  return totalWeight === 0 ? null : weightedTotal / totalWeight;
}

async function recomputeRoundReviewAggregates(
  database: ReturnType<typeof drizzle>,
  roundId: string,
): Promise<number> {
  const [criteria, reviewRows] = await Promise.all([
    database
      .select()
      .from(scorecardCriteria)
      .where(eq(scorecardCriteria.roundId, roundId)),
    database
      .select({ id: reviews.id, scores: reviews.scores })
      .from(reviews)
      .innerJoin(reviewAssignments, eq(reviews.assignmentId, reviewAssignments.id))
      .where(eq(reviewAssignments.roundId, roundId)),
  ]);
  for (const review of reviewRows) {
    await database
      .update(reviews)
      .set({ aggregateScore: computeAggregateScore(review.scores ?? {}, criteria) })
      .where(eq(reviews.id, review.id));
  }
  return reviewRows.length;
}

async function reviewerQueue(database: ReturnType<typeof drizzle>, reviewerUserId: string) {
  const [poolRows, trackRows, assignmentRows] = await Promise.all([
    database
      .select({
        roundId: reviewRounds.id,
        roundName: reviewRounds.name,
        eventId: reviewRounds.eventId,
        anonymized: reviewRounds.anonymized,
      })
      .from(reviewerRoundPools)
      .innerJoin(reviewRounds, eq(reviewerRoundPools.roundId, reviewRounds.id))
      .where(eq(reviewerRoundPools.reviewerUserId, reviewerUserId)),
    database
      .select({ eventId: reviewerTracks.eventId, trackId: reviewerTracks.trackId })
      .from(reviewerTracks)
      .where(eq(reviewerTracks.reviewerUserId, reviewerUserId)),
    database
      .select({
        assignmentId: reviewAssignments.id,
        assignmentStatus: reviewAssignments.status,
        roundId: reviewRounds.id,
        roundName: reviewRounds.name,
        eventId: reviewRounds.eventId,
        anonymized: reviewRounds.anonymized,
        submissionId: submissions.id,
        title: submissions.title,
        status: submissions.status,
      })
      .from(reviewAssignments)
      .innerJoin(reviewRounds, eq(reviewAssignments.roundId, reviewRounds.id))
      .innerJoin(
        reviewerRoundPools,
        and(
          eq(reviewerRoundPools.roundId, reviewAssignments.roundId),
          eq(reviewerRoundPools.reviewerUserId, reviewAssignments.reviewerUserId),
        ),
      )
      .innerJoin(submissions, eq(reviewAssignments.submissionId, submissions.id))
      .where(
        and(
          eq(reviewAssignments.reviewerUserId, reviewerUserId),
          eq(submissions.isDraft, false),
        ),
      ),
  ]);

  const items = new Map<string, ReviewQueueItem>(
    assignmentRows.map((row) => [
      `${row.roundId}:${row.submissionId}`,
      row,
    ]),
  );

  for (const pool of poolRows) {
    const trackIds = trackRows
      .filter((track) => track.eventId === pool.eventId)
      .map((track) => track.trackId);
    if (trackIds.length === 0) {
      continue;
    }
    const trackSubmissions = await database
      .selectDistinct({
        submissionId: submissions.id,
        title: submissions.title,
        status: submissions.status,
      })
      .from(submissions)
      .innerJoin(submissionTracks, eq(submissionTracks.submissionId, submissions.id))
      .where(
        and(
          eq(submissions.eventId, pool.eventId),
          eq(submissions.isDraft, false),
          inArray(submissionTracks.trackId, trackIds),
        ),
      );
    for (const submission of trackSubmissions) {
      const key = `${pool.roundId}:${submission.submissionId}`;
      if (!items.has(key)) {
        items.set(key, {
          assignmentId: null,
          assignmentStatus: "unreviewed" as const,
          ...pool,
          ...submission,
        });
      }
    }
  }

  return [...items.values()].sort((left, right) =>
    (left.title ?? "").localeCompare(right.title ?? ""),
  );
}

reviewRoutes.get("/review/queue", requireRole("reviewer"), async (context) => {
  const user = context.get("authUser");
  if (user === null) {
    return context.json({ error: "authentication_required" }, 401);
  }
  const items = await reviewerQueue(drizzle(context.env.DB), user.id);
  return context.json({ items });
});

export async function reviewerSubmission(
  database: ReturnType<typeof drizzle>,
  reviewerUserId: string,
  submissionId: string,
  roundId?: string,
) {
  const items = await reviewerQueue(database, reviewerUserId);
  return items.find((item) =>
    item.submissionId === submissionId && (roundId === undefined || item.roundId === roundId),
  );
}

reviewRoutes.get("/review/submissions/:submissionId", async (context) => {
  const user = context.get("authUser");
  if (user === null) {
    return context.json({ error: "authentication_required" }, 401);
  }
  const roles = context.get("roles") ?? [];
  if (!holdsAccess(roles, "organizer") && !holdsAccess(roles, "reviewer")) {
    return context.json({ error: "forbidden" }, 403);
  }
  const database = drizzle(context.env.DB);
  const submissionId = context.req.param("submissionId");
  const requestedRoundId = context.req.query("roundId");
  // An organizer reads any proposal; a reviewer only their own remit. Somebody granted both
  // keeps the wider reach rather than being narrowed by the second grant.
  const scopedItem = holdsAccess(roles, "organizer")
    ? undefined
    : await reviewerSubmission(database, user.id, submissionId, requestedRoundId);
  if (!holdsAccess(roles, "organizer") && scopedItem === undefined) {
    return context.json({ error: "forbidden" }, 403);
  }

  const [submission] = await database
    .select({
      id: submissions.id,
      eventId: submissions.eventId,
      formId: submissions.formId,
      formVersion: submissions.formVersion,
      title: submissions.title,
      abstract: submissions.abstract,
      status: submissions.status,
      audienceLevel: submissions.audienceLevel,
      notesForReviewers: submissions.notesForReviewers,
      formatId: formats.id,
      formatName: formats.name,
    })
    .from(submissions)
    .leftJoin(formats, eq(submissions.formatId, formats.id))
    .where(eq(submissions.id, submissionId));
  if (submission === undefined) {
    return context.json({ error: "not_found" }, 404);
  }

  const roundId = scopedItem?.roundId ?? requestedRoundId;
  // Blind review hides identities from the committee reading through a remit, never from an
  // organizer - so somebody granted both reads it identified, as they did before.
  const anonymized = !holdsAccess(roles, "organizer") && scopedItem?.anonymized === true;
  const [commentRows, trackRows, proposalAnswerRows, criteria, reviewRows] = await Promise.all([
    database
      .select({
        id: comments.id,
        body: comments.body,
        createdAt: comments.createdAt,
        authorId: users.id,
        authorName: users.name,
      })
      .from(comments)
      .innerJoin(users, eq(comments.authorUserId, users.id))
      .where(eq(comments.submissionId, submissionId))
      .orderBy(asc(comments.createdAt)),
    database
      .select({ id: tracks.id, name: tracks.name })
      .from(submissionTracks)
      .innerJoin(tracks, eq(submissionTracks.trackId, tracks.id))
      .where(eq(submissionTracks.submissionId, submissionId))
      .orderBy(asc(tracks.sortOrder)),
    reviewProposalAnswers(database, submission, anonymized),
    roundId === undefined
      ? Promise.resolve([])
      : database
        .select()
        .from(scorecardCriteria)
        .where(eq(scorecardCriteria.roundId, roundId))
        .orderBy(asc(scorecardCriteria.sortOrder)),
    database
      .select({
        id: reviews.id,
        scores: reviews.scores,
        comment: reviews.comment,
        aggregateScore: reviews.aggregateScore,
        submittedAt: reviews.submittedAt,
        authorId: users.id,
        authorName: users.name,
        roundId: reviewRounds.id,
        roundName: reviewRounds.name,
      })
      .from(reviews)
      .innerJoin(reviewAssignments, eq(reviews.assignmentId, reviewAssignments.id))
      .innerJoin(reviewRounds, eq(reviewAssignments.roundId, reviewRounds.id))
      .innerJoin(users, eq(reviews.authorUserId, users.id))
      .where(eq(reviewAssignments.submissionId, submissionId))
      .orderBy(asc(reviews.submittedAt)),
  ]);
  const participants = anonymized
    ? []
    : await database
      .select({
        id: people.id,
        name: people.name,
        jobTitle: people.jobTitle,
        organization: people.organization,
        roleLabel: submissionSpeakers.roleLabel,
      })
      .from(submissionSpeakers)
      .innerJoin(people, eq(submissionSpeakers.personId, people.id))
      // A reviewer declares a conflict of interest against this list, so it has to be the
      // proposal's live one. Somebody the program team removed is nobody's conflict.
      .where(and(eq(submissionSpeakers.submissionId, submissionId), isNull(submissionSpeakers.deletedAt)));

  return context.json({
    id: submission.id,
    eventId: submission.eventId,
    title: submission.title,
    abstract: submission.abstract,
    status: submission.status,
    audienceLevel: submission.audienceLevel,
    notesForReviewers: submission.notesForReviewers,
    format: submission.formatId === null
      ? null
      : { id: submission.formatId, name: submission.formatName },
    round: scopedItem === undefined
      ? null
      : { id: scopedItem.roundId, name: scopedItem.roundName, anonymized: scopedItem.anonymized },
    assignmentStatus: scopedItem?.assignmentStatus ?? null,
    tracks: trackRows,
    answers: proposalAnswerRows,
    participants,
    criteria,
    reviews: reviewRows
      .filter((review) => (roundId === undefined || review.roundId === roundId))
      .filter((review) => holdsAccess(roles, "organizer") || review.authorId === user.id)
      .map((review) => ({
        id: review.id,
        scores: review.scores,
        comment: review.comment,
        aggregateScore: review.aggregateScore,
        submittedAt: review.submittedAt,
        author: { id: review.authorId, name: review.authorName },
        round: { id: review.roundId, name: review.roundName },
      })),
    comments: commentRows.map((comment) => ({
      id: comment.id,
      body: comment.body,
      createdAt: comment.createdAt,
      author: { id: comment.authorId, name: comment.authorName },
    })),
  });
});

reviewRoutes.post("/review/submissions/:submissionId/comments", async (context) => {
  const user = context.get("authUser");
  if (user === null) {
    return context.json({ error: "authentication_required" }, 401);
  }
  const roles = context.get("roles") ?? [];
  if (!holdsAccess(roles, "organizer") && !holdsAccess(roles, "reviewer")) {
    return context.json({ error: "forbidden" }, 403);
  }
  const database = drizzle(context.env.DB);
  const submissionId = context.req.param("submissionId");
  // Same reach as reading it: an organizer may comment on any proposal, a reviewer only on
  // one inside their remit.
  if (
    !holdsAccess(roles, "organizer") &&
    (await reviewerSubmission(database, user.id, submissionId)) === undefined
  ) {
    return context.json({ error: "forbidden" }, 403);
  }
  const [submission] = await database
    .select({ id: submissions.id })
    .from(submissions)
    .where(eq(submissions.id, submissionId));
  if (submission === undefined) {
    return context.json({ error: "not_found" }, 404);
  }
  const payload = await context.req.json<{ body?: unknown }>();
  if (typeof payload.body !== "string" || payload.body.trim().length === 0) {
    return context.json({ error: "comment_required" }, 400);
  }
  const id = createPublicId("cmt");
  await database.insert(comments).values({
    id,
    submissionId,
    authorUserId: user.id,
    body: payload.body.trim(),
  });
  const [comment] = await database
    .select({ id: comments.id, body: comments.body, createdAt: comments.createdAt })
    .from(comments)
    .where(eq(comments.id, id));
  return context.json({
    ...comment,
    author: { id: user.id, name: user.name },
  }, 201);
});

reviewRoutes.post(
  "/review/events/:eventId/rounds",
  requireRole("organizer"),
  async (context) => {
    const payload = await context.req.json<{
      name?: unknown;
      opensAt?: unknown;
      closesAt?: unknown;
      anonymized?: unknown;
      status?: unknown;
    }>();
    if (typeof payload.name !== "string" || payload.name.trim().length === 0) {
      return context.json({ error: "round_name_required" }, 400);
    }
    const statuses = ["draft", "open", "closed"] as const;
    const status = statuses.find((item) => item === payload.status) ?? "draft";
    const parseDate = (value: unknown): Date | null | undefined => {
      if (value === null || value === undefined || value === "") return null;
      if (typeof value !== "string") return undefined;
      const parsed = new Date(value);
      return Number.isNaN(parsed.valueOf()) ? undefined : parsed;
    };
    const opensAt = parseDate(payload.opensAt);
    const closesAt = parseDate(payload.closesAt);
    if (opensAt === undefined || closesAt === undefined) {
      return context.json({ error: "invalid_round_window" }, 400);
    }
    const database = drizzle(context.env.DB);
    const eventId = context.req.param("eventId");
    const [event] = await database
      .select({ id: events.id })
      .from(events)
      .where(eq(events.id, eventId));
    if (event === undefined) {
      return context.json({ error: "not_found" }, 404);
    }
    const existingRounds = await database
      .select({ id: reviewRounds.id })
      .from(reviewRounds)
      .where(eq(reviewRounds.eventId, eventId));
    const id = createPublicId("rnd");
    await database.insert(reviewRounds).values({
      id,
      eventId,
      name: payload.name.trim(),
      opensAt,
      closesAt,
      anonymized: payload.anonymized === true,
      status,
      sortOrder: existingRounds.length,
    });
    const [round] = await database
      .select()
      .from(reviewRounds)
      .where(eq(reviewRounds.id, id));
    return context.json(round, 201);
  },
);

reviewRoutes.get(
  "/review/events/:eventId/config",
  requireRole("organizer"),
  async (context) => {
    const database = drizzle(context.env.DB);
    const eventId = context.req.param("eventId");
    const [eventTracks, roundRows, trackReviewers, submissionRows, recusalRows] = await Promise.all([
      database
        .select({ id: tracks.id, name: tracks.name })
        .from(tracks)
        .where(eq(tracks.eventId, eventId))
        .orderBy(asc(tracks.sortOrder)),
      database
        .select()
        .from(reviewRounds)
        .where(eq(reviewRounds.eventId, eventId))
        .orderBy(asc(reviewRounds.sortOrder)),
      database
        .selectDistinct({ id: users.id, name: users.name, email: users.email })
        .from(reviewerTracks)
        .innerJoin(users, eq(reviewerTracks.reviewerUserId, users.id))
        .where(eq(reviewerTracks.eventId, eventId)),
      database
        .select({ id: submissions.id, title: submissions.title, status: submissions.status })
        .from(submissions)
        .where(and(eq(submissions.eventId, eventId), eq(submissions.isDraft, false))),
      // A recusal is a settled fact about an assignment, not about who is in a round pool now,
      // so it is read from the assignment rows the worklist reads. Narrowing a remit deletes
      // pool rows; the read still is not coming, and the card must keep saying so.
      database
        .select({
          reviewerUserId: reviewAssignments.reviewerUserId,
          roundId: reviewRounds.id,
          roundName: reviewRounds.name,
          submissionId: submissions.id,
          title: submissions.title,
        })
        .from(reviewAssignments)
        .innerJoin(reviewRounds, eq(reviewAssignments.roundId, reviewRounds.id))
        .innerJoin(submissions, eq(reviewAssignments.submissionId, submissions.id))
        .where(and(
          eq(submissions.eventId, eventId),
          eq(submissions.isDraft, false),
          eq(reviewAssignments.status, "recused"),
        )),
    ]);
    const roundIds = roundRows.map((round) => round.id);
    // A reviewer narrowed to no tracks still belongs to the committee through their round pool.
    const poolReviewers = roundIds.length === 0
      ? []
      : await database
        .selectDistinct({ id: users.id, name: users.name, email: users.email })
        .from(reviewerRoundPools)
        .innerJoin(users, eq(reviewerRoundPools.reviewerUserId, users.id))
        .where(inArray(reviewerRoundPools.roundId, roundIds));
    // And a reviewer with neither still belongs here. Granting reviewer from People opens the
    // area without writing a track or a round, so this is the only screen that can complete
    // the grant - leaving them off it would ship a role no organizer can make work (#147).
    const grantedReviewers = await listAccountsHoldingRole(database, "reviewer");
    const eventReviewers = [...new Map(
      [...trackReviewers, ...poolReviewers, ...grantedReviewers].map((reviewer) => [reviewer.id, reviewer]),
    ).values()];
    const [criteriaRows, poolRows, reviewerTrackRows] = roundIds.length === 0
      ? [[], [], []]
      : await Promise.all([
        database
          .select()
          .from(scorecardCriteria)
          .where(inArray(scorecardCriteria.roundId, roundIds))
          .orderBy(asc(scorecardCriteria.sortOrder)),
        database
          .select({
            roundId: reviewerRoundPools.roundId,
            id: users.id,
            name: users.name,
            email: users.email,
          })
          .from(reviewerRoundPools)
          .innerJoin(users, eq(reviewerRoundPools.reviewerUserId, users.id))
          .where(inArray(reviewerRoundPools.roundId, roundIds)),
        database
          .select({ reviewerUserId: reviewerTracks.reviewerUserId, trackId: reviewerTracks.trackId })
          .from(reviewerTracks)
          .where(eq(reviewerTracks.eventId, eventId)),
      ]);
    const reviewersWithProgress = await Promise.all(eventReviewers.map(async (reviewer) => {
      const queue = (await reviewerQueue(database, reviewer.id))
        .filter((item) => item.eventId === eventId);
      const recusals = recusalRows.filter((row) => row.reviewerUserId === reviewer.id);
      return {
        ...reviewer,
        trackIds: reviewerTrackRows
          .filter((item) => item.reviewerUserId === reviewer.id)
          .map((item) => item.trackId),
        // Recused work is neither completed nor still owed, so it leaves the assigned count
        // and is reported on its own instead.
        assignedCount: queue.filter((item) => item.assignmentStatus !== "recused").length,
        completedCount: queue.filter((item) => item.assignmentStatus === "completed").length,
        recusedCount: recusals.length,
        // The count is only useful if it names the proposals it stands for, and it counts
        // assignments, so a proposal recused in two rounds keeps one entry per round.
        recusals: recusals.map(({ reviewerUserId: _reviewerUserId, ...recusal }) => recusal),
      };
    }));
    return context.json({
      tracks: eventTracks,
      submissions: submissionRows,
      reviewers: reviewersWithProgress,
      rounds: roundRows.map((round) => ({
        ...round,
        criteria: criteriaRows.filter((criterion) => criterion.roundId === round.id),
        reviewerPool: poolRows
          .filter((reviewer) => reviewer.roundId === round.id)
          .map(({ roundId: _roundId, ...reviewer }) => reviewer),
      })),
    });
  },
);

reviewRoutes.post(
  "/review/events/:eventId/reviewers",
  requireRole("organizer"),
  async (context) => {
    const payload = await context.req.json<{
      name?: unknown;
      email?: unknown;
      password?: unknown;
      trackIds?: unknown;
      roundIds?: unknown;
    }>();
    if (
      typeof payload.name !== "string" ||
      payload.name.trim().length === 0 ||
      typeof payload.email !== "string" ||
      typeof payload.password !== "string" ||
      payload.password.length < 8
    ) {
      return context.json({ error: "invalid_reviewer" }, 400);
    }
    const database = drizzle(context.env.DB);
    const eventId = context.req.param("eventId");
    const [eventTracks, eventRounds] = await Promise.all([
      database
        .select({ id: tracks.id })
        .from(tracks)
        .where(eq(tracks.eventId, eventId))
        .orderBy(asc(tracks.sortOrder)),
      database
        .select({ id: reviewRounds.id })
        .from(reviewRounds)
        .where(and(eq(reviewRounds.eventId, eventId), eq(reviewRounds.status, "open")))
        .orderBy(asc(reviewRounds.sortOrder)),
    ]);
    const defaultRound = eventRounds[0];
    if (defaultRound === undefined) {
      return context.json({ error: "open_round_required" }, 409);
    }
    const availableTrackIds = new Set(eventTracks.map((track) => track.id));
    const trackIds = Array.isArray(payload.trackIds)
      ? payload.trackIds.filter((trackId): trackId is string => typeof trackId === "string")
      : [...availableTrackIds];
    if (trackIds.some((trackId) => !availableTrackIds.has(trackId))) {
      return context.json({ error: "invalid_reviewer_tracks" }, 400);
    }
    const availableRoundIds = new Set(eventRounds.map((round) => round.id));
    const requestedRoundIds = Array.isArray(payload.roundIds)
      ? payload.roundIds.filter((roundId): roundId is string => typeof roundId === "string")
      : [];
    const roundIds = requestedRoundIds.length === 0 ? [defaultRound.id] : requestedRoundIds;
    if (roundIds.some((roundId) => !availableRoundIds.has(roundId))) {
      return context.json({ error: "invalid_reviewer_rounds" }, 400);
    }

    let authResult: Awaited<ReturnType<ReturnType<typeof createAuth>["api"]["signUpEmail"]>>;
    try {
      authResult = await createAuth(context.env).api.signUpEmail({
        body: {
          name: payload.name.trim(),
          email: payload.email.trim().toLowerCase(),
          password: payload.password,
          rememberMe: false,
        },
      });
    } catch {
      return context.json({ error: "reviewer_account_unavailable" }, 409);
    }
    // The organizer set this account's password themselves, so the account is theirs to
    // vouch for and the grant lands immediately. An invitation, where the organizer never
    // sees the password, has to wait for the address to be confirmed instead.
    await grantRole(database, {
      userId: authResult.user.id,
      role: "reviewer",
      source: "organizer",
      grantedByUserId: context.get("authUser")?.id ?? null,
      note: "Added to the review committee.",
    });
    await applyReviewerRemit(database, {
      eventId,
      reviewerUserId: authResult.user.id,
      trackIds,
      roundIds,
    });
    return context.json({
      reviewer: {
        id: authResult.user.id,
        name: authResult.user.name,
        email: authResult.user.email,
      },
      remit: { mode: remitMode(trackIds, availableTrackIds.size), trackIds },
      roundIds,
    }, 201);
  },
);

function remitMode(trackIds: string[], availableTrackCount: number): "no_tracks" | "all_submissions" | "tracks" {
  if (trackIds.length === 0) return "no_tracks";
  return trackIds.length === availableTrackCount ? "all_submissions" : "tracks";
}

reviewRoutes.patch(
  "/review/events/:eventId/reviewers/:reviewerUserId",
  requireRole("organizer"),
  async (context) => {
    const payload = await context.req.json<{ trackIds?: unknown; roundIds?: unknown }>();
    const readIdList = (value: unknown): string[] | undefined =>
      Array.isArray(value)
        ? [...new Set(value.filter((id): id is string => typeof id === "string"))]
        : undefined;
    const requestedTrackIds = readIdList(payload.trackIds);
    const requestedRoundIds = readIdList(payload.roundIds);
    if (requestedTrackIds === undefined && requestedRoundIds === undefined) {
      return context.json({ error: "invalid_reviewer_scope" }, 400);
    }
    const database = drizzle(context.env.DB);
    const eventId = context.req.param("eventId");
    const reviewerUserId = context.req.param("reviewerUserId");
    const [eventTracks, eventRounds, reviewer] = await Promise.all([
      database
        .select({ id: tracks.id })
        .from(tracks)
        .where(eq(tracks.eventId, eventId))
        .orderBy(asc(tracks.sortOrder)),
      database
        .select({ id: reviewRounds.id })
        .from(reviewRounds)
        .where(eq(reviewRounds.eventId, eventId))
        .orderBy(asc(reviewRounds.sortOrder)),
      database
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, reviewerUserId))
        .then((rows) => rows[0]),
    ]);
    if (reviewer === undefined || !(await hasLiveGrant(database, reviewerUserId, "reviewer"))) {
      return context.json({ error: "not_found" }, 404);
    }
    const eventRoundIds = eventRounds.map((round) => round.id);
    const [currentTrackRows, currentPoolRows] = await Promise.all([
      database
        .select({ id: reviewerTracks.id, trackId: reviewerTracks.trackId })
        .from(reviewerTracks)
        .where(
          and(eq(reviewerTracks.eventId, eventId), eq(reviewerTracks.reviewerUserId, reviewerUserId)),
        ),
      eventRoundIds.length === 0
        ? Promise.resolve([])
        : database
          .select({ id: reviewerRoundPools.id, roundId: reviewerRoundPools.roundId })
          .from(reviewerRoundPools)
          .where(
            and(
              eq(reviewerRoundPools.reviewerUserId, reviewerUserId),
              inArray(reviewerRoundPools.roundId, eventRoundIds),
            ),
          ),
    ]);
    const availableTrackIds = new Set(eventTracks.map((track) => track.id));
    const trackIds = requestedTrackIds ?? currentTrackRows.map((row) => row.trackId);
    if (trackIds.some((trackId) => !availableTrackIds.has(trackId))) {
      return context.json({ error: "invalid_reviewer_tracks" }, 400);
    }
    const availableRoundIds = new Set(eventRoundIds);
    const roundIds = requestedRoundIds ?? currentPoolRows.map((row) => row.roundId);
    if (roundIds.some((roundId) => !availableRoundIds.has(roundId))) {
      return context.json({ error: "invalid_reviewer_rounds" }, 400);
    }

    const keptTrackIds = new Set(trackIds);
    const removedTrackRows = currentTrackRows.filter((row) => !keptTrackIds.has(row.trackId));
    if (removedTrackRows.length > 0) {
      await database
        .delete(reviewerTracks)
        .where(inArray(reviewerTracks.id, removedTrackRows.map((row) => row.id)));
    }
    const heldTrackIds = new Set(currentTrackRows.map((row) => row.trackId));
    for (const trackId of trackIds.filter((trackId) => !heldTrackIds.has(trackId))) {
      await database.insert(reviewerTracks).values({
        id: createPublicId("rtrk"),
        eventId,
        reviewerUserId,
        trackId,
      });
    }

    const keptRoundIds = new Set(roundIds);
    const removedPoolRows = currentPoolRows.filter((row) => !keptRoundIds.has(row.roundId));
    if (removedPoolRows.length > 0) {
      await database
        .delete(reviewerRoundPools)
        .where(inArray(reviewerRoundPools.id, removedPoolRows.map((row) => row.id)));
    }
    const heldRoundIds = new Set(currentPoolRows.map((row) => row.roundId));
    for (const roundId of roundIds.filter((roundId) => !heldRoundIds.has(roundId))) {
      await database.insert(reviewerRoundPools).values({
        id: createPublicId("rpool"),
        roundId,
        reviewerUserId,
      });
    }

    const [queue, recusedAssignments, readableTrackSubmissionIds] = await Promise.all([
      reviewerQueue(database, reviewerUserId)
        .then((items) => items.filter((item) => item.eventId === eventId)),
      database
        .select({
          submissionId: submissions.id,
          title: submissions.title,
          roundId: reviewRounds.id,
        })
        .from(reviewAssignments)
        .innerJoin(reviewRounds, eq(reviewAssignments.roundId, reviewRounds.id))
        .innerJoin(submissions, eq(reviewAssignments.submissionId, submissions.id))
        .where(and(
          eq(reviewAssignments.reviewerUserId, reviewerUserId),
          eq(reviewAssignments.status, "recused"),
          eq(reviewRounds.eventId, eventId),
          eq(submissions.isDraft, false),
        )),
      trackIds.length === 0
        ? Promise.resolve(new Set<string>())
        : database
          .selectDistinct({ submissionId: submissions.id })
          .from(submissions)
          .innerJoin(submissionTracks, eq(submissionTracks.submissionId, submissions.id))
          .where(
            and(
              eq(submissions.eventId, eventId),
              eq(submissions.isDraft, false),
              inArray(submissionTracks.trackId, trackIds),
            ),
          )
          .then((rows) => new Set(rows.map((row) => row.submissionId))),
    ]);

    return context.json({
      reviewer: { id: reviewer.id, name: reviewer.name, email: reviewer.email },
      remit: { mode: remitMode(trackIds, availableTrackIds.size), trackIds },
      roundIds,
      removedTrackIds: removedTrackRows.map((row) => row.trackId),
      removedRoundIds: removedPoolRows.map((row) => row.roundId),
      retainedAssignments: queue
        .filter((item) =>
          item.assignmentId !== null &&
          item.assignmentStatus !== "recused" &&
          !readableTrackSubmissionIds.has(item.submissionId)
        )
        .map((item) => ({
          submissionId: item.submissionId,
          title: item.title,
          roundId: item.roundId,
        })),
      recusedAssignments,
    });
  },
);

reviewRoutes.post(
  "/review/rounds/:roundId/criteria",
  requireRole("organizer"),
  async (context) => {
    const payload = await context.req.json<{
      label?: unknown;
      criterionType?: unknown;
      options?: unknown;
      weight?: unknown;
      required?: unknown;
    }>();
    const criterionTypes = ["numeric", "dropdown", "free_text"] as const;
    const criterionType = criterionTypes.find((item) => item === payload.criterionType);
    if (typeof payload.label !== "string" || payload.label.trim().length === 0 || criterionType === undefined) {
      return context.json({ error: "invalid_criterion" }, 400);
    }
    const database = drizzle(context.env.DB);
    const roundId = context.req.param("roundId");
    const [round] = await database
      .select({ id: reviewRounds.id })
      .from(reviewRounds)
      .where(eq(reviewRounds.id, roundId));
    if (round === undefined) {
      return context.json({ error: "not_found" }, 404);
    }
    const id = createPublicId("crt");
    await database.insert(scorecardCriteria).values({
      id,
      roundId,
      label: payload.label.trim(),
      criterionType,
      options: Array.isArray(payload.options)
        ? payload.options.filter((option): option is string => typeof option === "string")
        : null,
      weight: typeof payload.weight === "number" ? payload.weight : null,
      required: payload.required === true,
    });
    const [criterion] = await database
      .select()
      .from(scorecardCriteria)
      .where(eq(scorecardCriteria.id, id));
    return context.json(criterion, 201);
  },
);

reviewRoutes.patch(
  "/review/criteria/:criterionId",
  requireRole("organizer"),
  async (context) => {
    const payload = await context.req.json<{
      label?: unknown;
      criterionType?: unknown;
      options?: unknown;
      weight?: unknown;
      required?: unknown;
    }>();
    if (Object.values(payload).every((value) => value === undefined)) {
      return context.json({ error: "invalid_criterion" }, 400);
    }
    const database = drizzle(context.env.DB);
    const criterionId = context.req.param("criterionId");
    const [criterion] = await database
      .select()
      .from(scorecardCriteria)
      .where(eq(scorecardCriteria.id, criterionId));
    if (criterion === undefined) {
      return context.json({ error: "not_found" }, 404);
    }

    const criterionTypes = ["numeric", "dropdown", "free_text"] as const;
    const criterionType = payload.criterionType === undefined
      ? criterion.criterionType
      : criterionTypes.find((item) => item === payload.criterionType);
    const label = payload.label === undefined
      ? criterion.label
      : typeof payload.label === "string" ? payload.label.trim() : "";
    const options = payload.options === undefined
      ? criterion.options
      : payload.options === null
        ? null
        : Array.isArray(payload.options)
          ? payload.options
            .filter((option): option is string => typeof option === "string")
            .map((option) => option.trim())
            .filter(Boolean)
          : undefined;
    const weight = payload.weight === undefined
      ? criterion.weight
      : payload.weight === null
        ? null
        : typeof payload.weight === "number" && Number.isFinite(payload.weight) && payload.weight > 0
          ? payload.weight
          : undefined;
    const required = payload.required === undefined
      ? criterion.required
      : typeof payload.required === "boolean" ? payload.required : undefined;
    if (
      criterionType === undefined ||
      label.length === 0 ||
      options === undefined ||
      weight === undefined ||
      required === undefined ||
      (criterionType === "dropdown" && (options?.length ?? 0) === 0)
    ) {
      return context.json({ error: "invalid_criterion" }, 400);
    }

    const siblingCriteria = await database
      .select({ id: scorecardCriteria.id, label: scorecardCriteria.label })
      .from(scorecardCriteria)
      .where(eq(scorecardCriteria.roundId, criterion.roundId));
    if (siblingCriteria.some((item) => item.id !== criterionId && item.label === label)) {
      return context.json({ error: "criterion_label_conflict" }, 409);
    }
    if (criterionType !== criterion.criterionType) {
      const [recordedReview] = await database
        .select({ id: reviews.id })
        .from(reviews)
        .innerJoin(reviewAssignments, eq(reviews.assignmentId, reviewAssignments.id))
        .where(eq(reviewAssignments.roundId, criterion.roundId))
        .limit(1);
      if (recordedReview !== undefined) {
        return context.json({ error: "criterion_type_locked" }, 409);
      }
    }

    await database
      .update(scorecardCriteria)
      .set({ label, criterionType, options, weight, required })
      .where(eq(scorecardCriteria.id, criterionId));
    const [savedCriterion] = await database
      .select()
      .from(scorecardCriteria)
      .where(eq(scorecardCriteria.id, criterionId));
    const recomputedReviews = criterionType !== criterion.criterionType || weight !== criterion.weight
      ? await recomputeRoundReviewAggregates(database, criterion.roundId)
      : 0;
    return context.json({ criterion: savedCriterion, recomputedReviews });
  },
);

reviewRoutes.delete(
  "/review/criteria/:criterionId",
  requireRole("organizer"),
  async (context) => {
    const database = drizzle(context.env.DB);
    const criterionId = context.req.param("criterionId");
    const [criterion] = await database
      .select({ id: scorecardCriteria.id, roundId: scorecardCriteria.roundId })
      .from(scorecardCriteria)
      .where(eq(scorecardCriteria.id, criterionId));
    if (criterion === undefined) {
      return context.json({ error: "not_found" }, 404);
    }
    await database.delete(scorecardCriteria).where(eq(scorecardCriteria.id, criterionId));
    return context.json({
      removedCriterionId: criterionId,
      recomputedReviews: await recomputeRoundReviewAggregates(database, criterion.roundId),
    });
  },
);

reviewRoutes.post(
  "/review/rounds/:roundId/assignments",
  requireRole("organizer"),
  async (context) => {
    const payload = await context.req.json<{
      reviewerUserId?: unknown;
      submissionIds?: unknown;
    }>();
    const submissionIds = Array.isArray(payload.submissionIds)
      ? [...new Set(payload.submissionIds.filter((id): id is string => typeof id === "string"))]
      : [];
    if (typeof payload.reviewerUserId !== "string" || submissionIds.length === 0) {
      return context.json({ error: "invalid_assignment" }, 400);
    }
    const database = drizzle(context.env.DB);
    const roundId = context.req.param("roundId");
    const [round, reviewer, pool, submissionRows] = await Promise.all([
      database
        .select({ id: reviewRounds.id, eventId: reviewRounds.eventId })
        .from(reviewRounds)
        .where(eq(reviewRounds.id, roundId))
        .then((rows) => rows[0]),
      database
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, payload.reviewerUserId))
        .then((rows) => rows[0]),
      database
        .select({ id: reviewerRoundPools.id })
        .from(reviewerRoundPools)
        .where(
          and(
            eq(reviewerRoundPools.roundId, roundId),
            eq(reviewerRoundPools.reviewerUserId, payload.reviewerUserId),
          ),
        )
        .then((rows) => rows[0]),
      database
        .select({ id: submissions.id, eventId: submissions.eventId })
        .from(submissions)
        .where(and(inArray(submissions.id, submissionIds), eq(submissions.isDraft, false))),
    ]);
    if (
      round === undefined ||
      reviewer === undefined ||
      pool === undefined ||
      !(await hasLiveGrant(database, payload.reviewerUserId, "reviewer"))
    ) {
      return context.json({ error: "assignment_scope_invalid" }, 400);
    }
    if (
      submissionRows.length !== submissionIds.length ||
      submissionRows.some((submission) => submission.eventId !== round.eventId)
    ) {
      return context.json({ error: "assignment_submission_invalid" }, 400);
    }
    for (const submissionId of submissionIds) {
      await database
        .insert(reviewAssignments)
        .values({
          id: createPublicId("asn"),
          roundId,
          submissionId,
          reviewerUserId: payload.reviewerUserId,
        })
        .onConflictDoNothing();
    }
    const assignments = await database
      .select()
      .from(reviewAssignments)
      .where(
        and(
          eq(reviewAssignments.roundId, roundId),
          eq(reviewAssignments.reviewerUserId, payload.reviewerUserId),
          inArray(reviewAssignments.submissionId, submissionIds),
        ),
      );
    return context.json({ items: assignments }, 201);
  },
);

function validCriterionValue(
  value: unknown,
  criterion: typeof scorecardCriteria.$inferSelect,
): value is string | number {
  if (criterion.criterionType === "numeric") {
    return typeof value === "number" && Number.isFinite(value);
  }
  if (criterion.criterionType === "dropdown") {
    return typeof value === "string" && (criterion.options ?? []).includes(value);
  }
  return typeof value === "string";
}

reviewRoutes.post(
  "/review/submissions/:submissionId/reviews",
  requireRole("reviewer"),
  async (context) => {
    const user = context.get("authUser");
    if (user === null) {
      return context.json({ error: "authentication_required" }, 401);
    }
    const payload = await context.req.json<{
      roundId?: unknown;
      scores?: unknown;
      comment?: unknown;
      aiSuggestionId?: unknown;
      confirmedAiScoreCriterionIds?: unknown;
    }>();
    if (
      typeof payload.roundId !== "string" ||
      typeof payload.scores !== "object" ||
      payload.scores === null ||
      Array.isArray(payload.scores)
    ) {
      return context.json({ error: "invalid_review" }, 400);
    }
    const database = drizzle(context.env.DB);
    const submissionId = context.req.param("submissionId");
    const scopedItems = await reviewerQueue(database, user.id);
    const scopedItem = scopedItems.find(
      (item) => item.submissionId === submissionId && item.roundId === payload.roundId,
    );
    if (scopedItem === undefined) {
      return context.json({ error: "forbidden" }, 403);
    }
    if (scopedItem.assignmentStatus === "recused") {
      return context.json({ error: "recused_from_submission" }, 409);
    }
    const criteria = await database
      .select()
      .from(scorecardCriteria)
      .where(eq(scorecardCriteria.roundId, payload.roundId));
    const rawScores = payload.scores as Record<string, unknown>;
    const scores: Record<string, string | number> = {};
    for (const criterion of criteria) {
      const value = rawScores[criterion.id];
      if (value === undefined && !criterion.required) {
        continue;
      }
      if (!validCriterionValue(value, criterion)) {
        return context.json({ error: "invalid_score", criterionId: criterion.id }, 400);
      }
      scores[criterion.id] = value;
    }
    if (typeof payload.aiSuggestionId === "string") {
      const [startingPoint] = await database
        .select({ scores: aiScoreSuggestions.scores })
        .from(aiScoreSuggestions)
        .where(and(
          eq(aiScoreSuggestions.id, payload.aiSuggestionId),
          eq(aiScoreSuggestions.submissionId, submissionId),
          eq(aiScoreSuggestions.roundId, payload.roundId),
        ));
      if (startingPoint === undefined) {
        return context.json({ error: "invalid_ai_starting_point" }, 400);
      }
      const confirmedCriterionIds = new Set(
        Array.isArray(payload.confirmedAiScoreCriterionIds)
          ? payload.confirmedAiScoreCriterionIds.filter(
            (criterionId): criterionId is string => typeof criterionId === "string",
          )
          : [],
      );
      if (hasUnconfirmedSuggestedScores(scores, startingPoint.scores, confirmedCriterionIds)) {
        return context.json({ error: "human_score_choice_required" }, 422);
      }
    }
    let assignmentId = scopedItem.assignmentId;
    if (assignmentId === null) {
      assignmentId = createPublicId("asn");
      await database
        .insert(reviewAssignments)
        .values({
          id: assignmentId,
          roundId: payload.roundId,
          submissionId,
          reviewerUserId: user.id,
        })
        .onConflictDoNothing();
      const [assignment] = await database
        .select({ id: reviewAssignments.id })
        .from(reviewAssignments)
        .where(
          and(
            eq(reviewAssignments.roundId, payload.roundId),
            eq(reviewAssignments.submissionId, submissionId),
            eq(reviewAssignments.reviewerUserId, user.id),
          ),
        );
      if (assignment === undefined) {
        return context.json({ error: "assignment_unavailable" }, 409);
      }
      assignmentId = assignment.id;
    }
    const [existingReview] = await database
      .select({ scores: reviews.scores })
      .from(reviews)
      .where(eq(reviews.assignmentId, assignmentId));
    const currentCriterionIds = new Set(criteria.map((criterion) => criterion.id));
    const historicalScores = Object.fromEntries(
      Object.entries(existingReview?.scores ?? {}).filter(
        ([criterionId]) => !currentCriterionIds.has(criterionId),
      ),
    );
    const savedScores = { ...historicalScores, ...scores };
    const aggregateScore = computeAggregateScore(savedScores, criteria);
    const reviewId = createPublicId("rev");
    const submittedAt = new Date();
    await database
      .insert(reviews)
      .values({
        id: reviewId,
        assignmentId,
        authorUserId: user.id,
        scores: savedScores,
        comment: typeof payload.comment === "string" ? payload.comment.trim() : null,
        aggregateScore,
        submittedAt,
      })
      .onConflictDoUpdate({
        target: reviews.assignmentId,
        set: {
          scores: savedScores,
          comment: typeof payload.comment === "string" ? payload.comment.trim() : null,
          aggregateScore,
          submittedAt,
        },
      });
    await database
      .update(reviewAssignments)
      .set({ status: "completed", completedAt: submittedAt })
      .where(eq(reviewAssignments.id, assignmentId));
    const [savedReview] = await database
      .select()
      .from(reviews)
      .where(eq(reviews.assignmentId, assignmentId));
    return context.json(savedReview);
  },
);

// Recusal records a conflict on the reviewer's own assignment and nothing else: no review,
// no score, no submission status change, and no communication.
reviewRoutes.post(
  "/review/submissions/:submissionId/recusal",
  requireRole("reviewer"),
  async (context) => {
    const user = context.get("authUser");
    if (user === null) {
      return context.json({ error: "authentication_required" }, 401);
    }
    const payload: { roundId?: unknown } = await context.req
      .json<{ roundId?: unknown }>()
      .catch(() => ({}));
    const roundId = payload.roundId;
    if (typeof roundId !== "string") {
      return context.json({ error: "invalid_recusal" }, 400);
    }
    const database = drizzle(context.env.DB);
    const submissionId = context.req.param("submissionId");
    const scopedItem = await reviewerSubmission(database, user.id, submissionId, roundId);
    if (scopedItem === undefined) {
      return context.json({ error: "forbidden" }, 403);
    }

    const recusal = (assignmentId: string) =>
      context.json({
        submissionId,
        roundId,
        assignmentId,
        assignmentStatus: "recused" as const,
        reviewCreated: false,
        notificationSent: false,
      });

    if (scopedItem.assignmentId !== null) {
      const [recordedReview] = await database
        .select({ id: reviews.id })
        .from(reviews)
        .where(eq(reviews.assignmentId, scopedItem.assignmentId));
      if (recordedReview !== undefined) {
        return context.json({ error: "review_already_recorded" }, 409);
      }
      // A repeated recusal is the same recusal.
      if (scopedItem.assignmentStatus !== "recused") {
        await database
          .update(reviewAssignments)
          .set({ status: "recused" })
          .where(eq(reviewAssignments.id, scopedItem.assignmentId));
      }
      return recusal(scopedItem.assignmentId);
    }

    // A proposal readable only through track remit still occupies the reviewer's queue,
    // so recusing it records the same assignment the scorecard path would have created.
    const assignmentId = createPublicId("asn");
    await database
      .insert(reviewAssignments)
      .values({
        id: assignmentId,
        roundId,
        submissionId,
        reviewerUserId: user.id,
        status: "recused",
      })
      .onConflictDoNothing();
    const [assignment] = await database
      .select({ id: reviewAssignments.id })
      .from(reviewAssignments)
      .where(
        and(
          eq(reviewAssignments.roundId, roundId),
          eq(reviewAssignments.submissionId, submissionId),
          eq(reviewAssignments.reviewerUserId, user.id),
        ),
      );
    if (assignment === undefined) {
      return context.json({ error: "assignment_unavailable" }, 409);
    }
    return recusal(assignment.id);
  },
);

reviewRoutes.patch(
  "/review/submissions/:submissionId/status",
  requireRole("organizer"),
  async (context) => {
    const payload = await context.req.json<{ status?: unknown }>();
    const reviewStatuses = [
      "submitted",
      "under_review",
      "accepted",
      "maybe",
      "declined",
    ] as const;
    const status = reviewStatuses.find((item) => item === payload.status);
    if (status === undefined) {
      return context.json({ error: "invalid_review_status" }, 400);
    }
    const submissionId = context.req.param("submissionId");
    const result = await changeSubmissionStatuses(context.env.DB, [submissionId], status);
    if (result === null) {
      return context.json({ error: "not_found" }, 404);
    }
    const [submission] = result.updated;
    if (submission === undefined) {
      throw new Error(`Submission ${submissionId} status was not updated`);
    }
    return context.json({ ...submission, notificationSent: false });
  },
);

reviewRoutes.get(
  "/review/events/:eventId/worklist",
  requireRole("organizer"),
  async (context) => {
    const database = drizzle(context.env.DB);
    const eventId = context.req.param("eventId");
    const [submissionRows, reviewRows, trackRows, recusalRows] = await Promise.all([
      database
        .select({
          submissionId: submissions.id,
          title: submissions.title,
          status: submissions.status,
          submittedAt: submissions.submittedAt,
        })
        .from(submissions)
        .where(and(eq(submissions.eventId, eventId), eq(submissions.isDraft, false))),
      database
        .select({
          submissionId: reviewAssignments.submissionId,
          aggregateScore: reviews.aggregateScore,
        })
        .from(reviews)
        .innerJoin(reviewAssignments, eq(reviews.assignmentId, reviewAssignments.id))
        .innerJoin(submissions, eq(reviewAssignments.submissionId, submissions.id))
        .where(eq(submissions.eventId, eventId)),
      database
        .select({ submissionId: submissionTracks.submissionId, name: tracks.name })
        .from(submissionTracks)
        .innerJoin(tracks, eq(submissionTracks.trackId, tracks.id)),
      // A recusal is the reason a proposal can sit at zero ratings, so the worklist carries it.
      database
        .select({
          submissionId: reviewAssignments.submissionId,
          reviewerUserId: reviewAssignments.reviewerUserId,
          reviewerName: users.name,
        })
        .from(reviewAssignments)
        .innerJoin(submissions, eq(reviewAssignments.submissionId, submissions.id))
        .innerJoin(users, eq(reviewAssignments.reviewerUserId, users.id))
        .where(and(eq(submissions.eventId, eventId), eq(reviewAssignments.status, "recused"))),
    ]);
    const items = submissionRows.map((submission) => {
      const submissionReviews = reviewRows.filter(
        (review) => review.submissionId === submission.submissionId,
      );
      const numericScores = submissionReviews
        .map((review) => review.aggregateScore)
        .filter((score): score is number => score !== null);
      const submissionRecusals = recusalRows.filter(
        (recusal) => recusal.submissionId === submission.submissionId,
      );
      return {
        ...submission,
        tracks: trackRows
          .filter((track) => track.submissionId === submission.submissionId)
          .map((track) => track.name),
        ratingCount: submissionReviews.length,
        averageScore: numericScores.length === 0
          ? null
          : numericScores.reduce((total, score) => total + score, 0) / numericScores.length,
        // The row speaks about the proposal, so it names each reviewer once however many
        // rounds they stepped back in. Two accounts can share a display name, so the one
        // that identifies them is the account, and the name is only what it is shown as.
        recusedBy: [...new Map(
          submissionRecusals.map((recusal) => [recusal.reviewerUserId, recusal.reviewerName]),
        ).values()].sort((left, right) => left.localeCompare(right)),
        // Each recused assignment is one scorecard that is not coming, and a reviewer in two
        // rounds owes two, so the missing reads are counted separately from the people.
        recusedAssignments: submissionRecusals.length,
      };
    });
    const sort = context.req.query("sort") === "score" ? "score" : "coverage";
    items.sort((left, right) => {
      if (sort === "coverage") {
        return left.ratingCount - right.ratingCount || (left.title ?? "").localeCompare(right.title ?? "");
      }
      if (left.averageScore === null && right.averageScore !== null) return 1;
      if (left.averageScore !== null && right.averageScore === null) return -1;
      return (right.averageScore ?? 0) - (left.averageScore ?? 0) ||
        (left.title ?? "").localeCompare(right.title ?? "");
    });
    const targetReviews = 2;
    const completedReadSlots = items.reduce(
      (total, item) => total + Math.min(item.ratingCount, targetReviews),
      0,
    );
    return context.json({
      eventId,
      sort,
      progress: {
        completedReadSlots,
        totalReadSlots: items.length * targetReviews,
        targetReviews,
      },
      items,
    });
  },
);

export default reviewRoutes;
