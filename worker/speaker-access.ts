// ABOUTME: Holds the one rule the speaker lane joins on: an archived participant is not a participant.
// ABOUTME: Every speaker-facing read and ownership check joins through these, so none can drift apart.
import { and, eq, isNull } from "drizzle-orm";
import { decisionNotices, sessions, sessionSpeakers, submissions, submissionSpeakers } from "../db/schema.ts";

/**
 * Joins a submission to the people still named on it. Removing a participant archives their
 * `submission_speaker` row, so a join that skips this condition keeps answering somebody the
 * organizer or the author has already taken off the proposal.
 */
export function livingSubmissionParticipants() {
  return and(eq(submissionSpeakers.submissionId, submissions.id), isNull(submissionSpeakers.deletedAt));
}

/**
 * Joins a session to the speakers still on it, on the same terms and for the same reason.
 */
export function livingSessionSpeakers() {
  return and(eq(sessionSpeakers.sessionId, sessions.id), isNull(sessionSpeakers.deletedAt));
}

/**
 * Narrows `decision_notice` to the letters that actually reached a recipient. A decision is the
 * committee's until it is communicated, and it is communicated by the letter arriving - not by
 * an organizer queueing one. A queued letter is still under review, a failed one reached nobody,
 * and a cancelled one was retired before it could. Every speaker-facing read of the notice log
 * goes through this, or one of them starts announcing outcomes the speaker was never told.
 */
export function sentDecisionLetter() {
  return and(eq(decisionNotices.deliveryStatus, "sent"), isNull(decisionNotices.cancelledAt));
}
