// ABOUTME: Distributes one track's review work across eligible round reviewers under a hard cap.
// ABOUTME: Preserves existing assignments and reports coverage that available reviewer capacity cannot fill.
import { and, asc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  createPublicId,
  reviewAssignments,
  reviewerRoundPools,
  reviewerTracks,
  reviewRounds,
  submissions,
  submissionTracks,
  tracks,
  users,
} from "../db/schema.ts";
import type { BulkReviewAssignmentResult } from "../shared/api.ts";
import { listAccountsHoldingRole } from "./roles.ts";

type ReviewDatabase = ReturnType<typeof drizzle>;

const targetReviewsPerSubmission = 2;

async function claimReviewAssignment(
  database: ReviewDatabase,
  input: { roundId: string; submissionId: string; reviewerUserId: string; cap: number },
): Promise<string | null> {
  const assignmentId = createPublicId("asn");
  const now = Date.now();
  const claimed = await database.$client.prepare(`
    insert into review_assignment (
      id, round_id, submission_id, reviewer_user_id, status,
      assigned_at, created_at, updated_at
    )
    select ?, ?, ?, ?, 'assigned', ?, ?, ?
    where (
      select count(*)
      from review_assignment
      where round_id = ?
        and reviewer_user_id = ?
        and status <> 'recused'
        and deleted_at is null
    ) < ?
    on conflict do nothing
    returning id
  `).bind(
    assignmentId,
    input.roundId,
    input.submissionId,
    input.reviewerUserId,
    now,
    now,
    now,
    input.roundId,
    input.reviewerUserId,
    input.cap,
  ).first<{ id: string }>();
  return claimed?.id ?? null;
}

async function reviewerAssignmentLoad(
  database: ReviewDatabase,
  roundId: string,
  reviewerUserId: string,
): Promise<number> {
  const row = await database.$client.prepare(`
    select count(*) as assignmentCount
    from review_assignment
    where round_id = ?
      and reviewer_user_id = ?
      and status <> 'recused'
      and deleted_at is null
  `).bind(roundId, reviewerUserId).first<{ assignmentCount: number }>();
  return row?.assignmentCount ?? 0;
}

function assignmentCoverage(
  assignment: { reviewerUserId: string; status: string },
  livePoolReviewerIds: Set<string>,
): boolean {
  return assignment.status === "completed" || livePoolReviewerIds.has(assignment.reviewerUserId);
}

export type DistributeReviewAssignmentsResult =
  | { status: "round_not_found" }
  | { status: "track_scope_invalid" }
  | { status: "distributed"; result: BulkReviewAssignmentResult };

/**
 * Adds explicit assignments in breadth-first passes so every proposal gains one read before any
 * proposal gains a second. Existing assigned and completed work counts toward coverage and load;
 * recusals count as neither, while their reviewer/submission pair remains unavailable.
 */
export async function distributeReviewAssignments(
  database: ReviewDatabase,
  input: { roundId: string; trackId: string; maxAssignmentsPerReviewer: number },
): Promise<DistributeReviewAssignmentsResult> {
  const [round] = await database
    .select({ id: reviewRounds.id, eventId: reviewRounds.eventId })
    .from(reviewRounds)
    .where(and(eq(reviewRounds.id, input.roundId), isNull(reviewRounds.deletedAt)));
  if (round === undefined) {
    return { status: "round_not_found" };
  }
  const [track] = await database
    .select({ id: tracks.id })
    .from(tracks)
    .where(and(
      eq(tracks.id, input.trackId),
      eq(tracks.eventId, round.eventId),
      isNull(tracks.deletedAt),
    ));
  if (track === undefined) {
    return { status: "track_scope_invalid" };
  }

  const [submissionRows, poolRows, candidateRows, assignmentRows, liveReviewerRows] = await Promise.all([
    database
      .selectDistinct({ id: submissions.id })
      .from(submissionTracks)
      .innerJoin(submissions, eq(submissionTracks.submissionId, submissions.id))
      .where(and(
        eq(submissionTracks.trackId, input.trackId),
        eq(submissions.eventId, round.eventId),
        eq(submissions.isDraft, false),
        isNull(submissionTracks.deletedAt),
        isNull(submissions.deletedAt),
      ))
      .orderBy(asc(submissions.id)),
    database
      .select({ reviewerUserId: reviewerRoundPools.reviewerUserId })
      .from(reviewerRoundPools)
      .where(and(
        eq(reviewerRoundPools.roundId, input.roundId),
        isNull(reviewerRoundPools.deletedAt),
      )),
    database
      .selectDistinct({ reviewerUserId: users.id })
      .from(reviewerRoundPools)
      .innerJoin(users, eq(reviewerRoundPools.reviewerUserId, users.id))
      .innerJoin(
        reviewerTracks,
        and(
          eq(reviewerTracks.reviewerUserId, reviewerRoundPools.reviewerUserId),
          eq(reviewerTracks.eventId, round.eventId),
        ),
      )
      .where(and(
        eq(reviewerRoundPools.roundId, input.roundId),
        eq(reviewerTracks.trackId, input.trackId),
        isNull(reviewerRoundPools.deletedAt),
        isNull(reviewerTracks.deletedAt),
      ))
      .orderBy(asc(users.id)),
    database
      .select({
        reviewerUserId: reviewAssignments.reviewerUserId,
        submissionId: reviewAssignments.submissionId,
        status: reviewAssignments.status,
      })
      .from(reviewAssignments)
      .where(and(
        eq(reviewAssignments.roundId, input.roundId),
        isNull(reviewAssignments.deletedAt),
      )),
    listAccountsHoldingRole(database, "reviewer"),
  ]);

  const liveReviewerIds = new Set(liveReviewerRows.map((reviewer) => reviewer.id));
  const livePoolReviewerIds = new Set(
    poolRows
      .map((reviewer) => reviewer.reviewerUserId)
      .filter((reviewerUserId) => liveReviewerIds.has(reviewerUserId)),
  );
  const reviewerLoads = new Map<string, number>();
  const candidateReviewerIds = candidateRows
    .map((reviewer) => reviewer.reviewerUserId)
    .filter((reviewerUserId) => liveReviewerIds.has(reviewerUserId));
  for (const reviewerUserId of candidateReviewerIds) {
    reviewerLoads.set(reviewerUserId, 0);
  }

  const existingPairs = new Set<string>();
  const coverageBySubmission = new Map(submissionRows.map((submission) => [submission.id, 0]));
  for (const assignment of assignmentRows) {
    existingPairs.add(`${assignment.reviewerUserId}:${assignment.submissionId}`);
    if (assignment.status === "recused") {
      continue;
    }
    if (reviewerLoads.has(assignment.reviewerUserId)) {
      reviewerLoads.set(assignment.reviewerUserId, (reviewerLoads.get(assignment.reviewerUserId) ?? 0) + 1);
    }
    if (
      assignmentCoverage(assignment, livePoolReviewerIds) &&
      coverageBySubmission.has(assignment.submissionId)
    ) {
      coverageBySubmission.set(
        assignment.submissionId,
        (coverageBySubmission.get(assignment.submissionId) ?? 0) + 1,
      );
    }
  }

  const assignments: BulkReviewAssignmentResult["assignments"] = [];
  for (let pass = 0; pass < targetReviewsPerSubmission; pass += 1) {
    for (const submission of submissionRows) {
      if ((coverageBySubmission.get(submission.id) ?? 0) !== pass) {
        continue;
      }
      const reviewerUserIds = candidateReviewerIds
        .filter((candidateId) =>
          (reviewerLoads.get(candidateId) ?? 0) < input.maxAssignmentsPerReviewer &&
          !existingPairs.has(`${candidateId}:${submission.id}`)
        )
        .sort((left, right) =>
          (reviewerLoads.get(left) ?? 0) - (reviewerLoads.get(right) ?? 0) || left.localeCompare(right)
        );
      for (const reviewerUserId of reviewerUserIds) {
        const pair = `${reviewerUserId}:${submission.id}`;
        const assignmentId = await claimReviewAssignment(database, {
          roundId: input.roundId,
          submissionId: submission.id,
          reviewerUserId,
          cap: input.maxAssignmentsPerReviewer,
        });
        existingPairs.add(pair);
        if (assignmentId === null) {
          reviewerLoads.set(
            reviewerUserId,
            await reviewerAssignmentLoad(database, input.roundId, reviewerUserId),
          );
          continue;
        }
        reviewerLoads.set(reviewerUserId, (reviewerLoads.get(reviewerUserId) ?? 0) + 1);
        coverageBySubmission.set(submission.id, (coverageBySubmission.get(submission.id) ?? 0) + 1);
        assignments.push({ assignmentId, reviewerUserId, submissionId: submission.id });
        break;
      }
    }
  }

  const finalAssignmentRows = await database
    .select({
      reviewerUserId: reviewAssignments.reviewerUserId,
      submissionId: reviewAssignments.submissionId,
      status: reviewAssignments.status,
    })
    .from(reviewAssignments)
    .where(and(
      eq(reviewAssignments.roundId, input.roundId),
      isNull(reviewAssignments.deletedAt),
    ));
  const finalReviewerLoads = new Map(candidateReviewerIds.map((reviewerUserId) => [reviewerUserId, 0]));
  const finalCoverageBySubmission = new Map(submissionRows.map((submission) => [submission.id, 0]));
  for (const assignment of finalAssignmentRows) {
    if (assignment.status === "recused") {
      continue;
    }
    if (finalReviewerLoads.has(assignment.reviewerUserId)) {
      finalReviewerLoads.set(
        assignment.reviewerUserId,
        (finalReviewerLoads.get(assignment.reviewerUserId) ?? 0) + 1,
      );
    }
    if (
      assignmentCoverage(assignment, livePoolReviewerIds) &&
      finalCoverageBySubmission.has(assignment.submissionId)
    ) {
      finalCoverageBySubmission.set(
        assignment.submissionId,
        (finalCoverageBySubmission.get(assignment.submissionId) ?? 0) + 1,
      );
    }
  }

  return {
    status: "distributed",
    result: {
      roundId: input.roundId,
      trackId: input.trackId,
      targetReviewsPerSubmission,
      assignments,
      reviewerLoads: candidateReviewerIds.map((reviewerUserId) => ({
        reviewerUserId,
        assignmentCount: finalReviewerLoads.get(reviewerUserId) ?? 0,
        cap: input.maxAssignmentsPerReviewer,
      })),
      unfilled: submissionRows.flatMap((submission) => {
        const remainingAssignments = Math.max(
          0,
          targetReviewsPerSubmission - (finalCoverageBySubmission.get(submission.id) ?? 0),
        );
        return remainingAssignments === 0 ? [] : [{ submissionId: submission.id, remainingAssignments }];
      }),
    },
  };
}
