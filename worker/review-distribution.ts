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
    if (livePoolReviewerIds.has(assignment.reviewerUserId) && coverageBySubmission.has(assignment.submissionId)) {
      coverageBySubmission.set(
        assignment.submissionId,
        (coverageBySubmission.get(assignment.submissionId) ?? 0) + 1,
      );
    }
  }

  const assignments: BulkReviewAssignmentResult["assignments"] = [];
  for (let pass = 0; pass < targetReviewsPerSubmission; pass += 1) {
    for (const submission of submissionRows) {
      if ((coverageBySubmission.get(submission.id) ?? 0) >= targetReviewsPerSubmission) {
        continue;
      }
      const reviewerUserId = candidateReviewerIds
        .filter((candidateId) =>
          (reviewerLoads.get(candidateId) ?? 0) < input.maxAssignmentsPerReviewer &&
          !existingPairs.has(`${candidateId}:${submission.id}`)
        )
        .sort((left, right) =>
          (reviewerLoads.get(left) ?? 0) - (reviewerLoads.get(right) ?? 0) || left.localeCompare(right)
        )[0];
      if (reviewerUserId === undefined) {
        continue;
      }
      const [created] = await database
        .insert(reviewAssignments)
        .values({
          id: createPublicId("asn"),
          roundId: input.roundId,
          submissionId: submission.id,
          reviewerUserId,
        })
        .onConflictDoNothing()
        .returning({ id: reviewAssignments.id });
      existingPairs.add(`${reviewerUserId}:${submission.id}`);
      if (created === undefined) {
        continue;
      }
      reviewerLoads.set(reviewerUserId, (reviewerLoads.get(reviewerUserId) ?? 0) + 1);
      coverageBySubmission.set(submission.id, (coverageBySubmission.get(submission.id) ?? 0) + 1);
      assignments.push({ assignmentId: created.id, reviewerUserId, submissionId: submission.id });
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
        assignmentCount: reviewerLoads.get(reviewerUserId) ?? 0,
        cap: input.maxAssignmentsPerReviewer,
      })),
      unfilled: submissionRows.flatMap((submission) => {
        const remainingAssignments = Math.max(
          0,
          targetReviewsPerSubmission - (coverageBySubmission.get(submission.id) ?? 0),
        );
        return remainingAssignments === 0 ? [] : [{ submissionId: submission.id, remainingAssignments }];
      }),
    },
  };
}
