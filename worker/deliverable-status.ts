// ABOUTME: Derives the organizer-facing state of a requested deliverable.
// ABOUTME: Keeps assignment completion, uploaded files, and deadlines in one precedence rule.
import type { DeliverableStatus } from "../shared/api.ts";

type DeliverableAssignmentStatus = "assigned" | "in_progress" | "completed";

export function deriveDeliverableStatus(input: {
  assignmentStatus: DeliverableAssignmentStatus;
  dueAt: Date | null;
  hasFile: boolean;
  now: number;
}): DeliverableStatus {
  if (input.hasFile) return "delivered";
  if (input.assignmentStatus === "completed") return "completed";
  if (input.dueAt !== null && input.dueAt.getTime() < input.now) return "overdue";
  return "requested";
}
