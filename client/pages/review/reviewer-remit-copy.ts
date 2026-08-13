// ABOUTME: Describes what changed when an organizer saves a reviewer's committee remit.
// ABOUTME: Separates removed scope, retained assignment access, and durable recusals.
export interface ReviewerRemitChange {
  removedTrackIds: string[];
  removedRoundIds: string[];
  retainedAssignments: Array<{ submissionId: string; title: string | null; roundId: string }>;
  recusedAssignments: Array<{
    submissionId: string;
    title: string | null;
    roundId: string;
    roundName: string;
  }>;
}

function recusalNames(assignments: ReviewerRemitChange["recusedAssignments"]): string {
  return assignments.map((item) =>
    `${item.title ?? item.submissionId} (${item.roundName})`
  ).join(", ");
}

function proposalNames(
  assignments: Array<{ submissionId: string; title: string | null }>,
): string {
  return [...new Map(assignments.map((item) => [
    item.submissionId,
    item.title ?? item.submissionId,
  ])).values()].join(", ");
}

export function reviewerRemitSummary(
  reviewerName: string,
  change: ReviewerRemitChange,
): string {
  const removed = change.removedTrackIds.length + change.removedRoundIds.length;
  const sentences = [
    `${reviewerName}’s remit saved${
      removed === 0 ? "." : ` — ${removed} removed. They lose that access immediately.`
    }`,
  ];
  if (change.retainedAssignments.length > 0) {
    sentences.push(
      `They can still read ${proposalNames(change.retainedAssignments)} through an explicit assignment.`,
    );
  }
  if (change.recusedAssignments.length > 0) {
    const recusals = change.recusedAssignments.length;
    sentences.push(
      `Their ${recusals === 1 ? "recusal" : "recusals"} from ${
        recusalNames(change.recusedAssignments)
      } ${recusals === 1 ? "remains" : "remain"} recorded.`,
    );
  }
  return sentences.join(" ");
}
