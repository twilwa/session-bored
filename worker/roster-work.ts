// ABOUTME: Derives roster work totals from assigned tasks and accepted-speaker profile requirements.
// ABOUTME: Ensures the open count and total always describe the same set of tracked work.
type AssignmentWork = {
  assignmentStatus: "assigned" | "in_progress" | "completed";
  taskStatus: "draft" | "active" | "complete";
};

export function deriveRosterWorkSummary(input: {
  assignments: readonly AssignmentWork[];
  bioComplete: boolean;
  headshotComplete: boolean;
  tracksProfile: boolean;
}): { incomplete: number; total: number } {
  const incompleteAssignments = input.assignments.filter((assignment) =>
    assignment.assignmentStatus !== "completed" && assignment.taskStatus === "active"
  ).length;
  const profileRequirements = input.tracksProfile ? 2 : 0;
  const incompleteProfileItems = input.tracksProfile
    ? Number(!input.bioComplete) + Number(!input.headshotComplete)
    : 0;
  return {
    incomplete: incompleteAssignments + incompleteProfileItems,
    total: input.assignments.length + profileRequirements,
  };
}
