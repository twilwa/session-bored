// ABOUTME: Writes the coverage worklist's sentence about a proposal nobody is scoring.
// ABOUTME: Reviewers are named once each, while the reads counted are the recused assignments.
/**
 * A recusal belongs to a round, so one reviewer can recuse the same proposal in several and
 * owe several scorecards. The names say who stepped back; the count says how many reads are
 * missing, and the two are not the same number.
 */
export function recusalSummary(recusedBy: string[], recusedAssignments: number): string {
  const reads = recusedAssignments === 1 ? "1 read" : `${recusedAssignments} reads`;
  return `Recused by ${recusedBy.join(", ")} · ${reads} will not arrive`;
}
