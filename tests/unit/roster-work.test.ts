// ABOUTME: Verifies roster work totals use the same task-and-profile universe as open counts.
// ABOUTME: Covers accepted-speaker profile requirements and active assignment completion.
import { describe, expect, it } from "vitest";
import { deriveRosterWorkSummary } from "../../worker/roster-work.ts";

describe("roster work summary", () => {
  it("counts five open tasks and two missing profile requirements as seven of seven", () => {
    expect(deriveRosterWorkSummary({
      assignments: Array.from({ length: 5 }, () => ({ assignmentStatus: "assigned" as const, taskStatus: "active" as const })),
      bioComplete: false,
      headshotComplete: false,
      tracksProfile: true,
    })).toEqual({ incomplete: 7, total: 7 });
  });

  it("keeps completed and paused assignments in the total without calling them open", () => {
    expect(deriveRosterWorkSummary({
      assignments: [
        { assignmentStatus: "completed", taskStatus: "active" },
        { assignmentStatus: "assigned", taskStatus: "draft" },
        { assignmentStatus: "assigned", taskStatus: "active" },
      ],
      bioComplete: true,
      headshotComplete: false,
      tracksProfile: true,
    })).toEqual({ incomplete: 2, total: 5 });
  });

  it("does not count profile requirements before a speaker is accepted", () => {
    expect(deriveRosterWorkSummary({
      assignments: [],
      bioComplete: false,
      headshotComplete: false,
      tracksProfile: false,
    })).toEqual({ incomplete: 0, total: 0 });
  });
});
