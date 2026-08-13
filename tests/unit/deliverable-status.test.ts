// ABOUTME: Verifies deliverable status follows assignment completion, file presence, and deadlines.
// ABOUTME: Keeps completed fileless requests distinct from uploaded deliverables and outstanding work.
import { describe, expect, it } from "vitest";
import { deriveDeliverableStatus } from "../../worker/deliverable-status.ts";

describe("deliverable status", () => {
  const now = new Date("2026-08-12T12:00:00.000Z").getTime();

  it("reports a completed fileless assignment as completed regardless of its deadline", () => {
    expect(deriveDeliverableStatus({
      assignmentStatus: "completed",
      dueAt: new Date("2026-01-15T23:59:59.000Z"),
      hasFile: false,
      now,
    })).toBe("completed");
  });

  it("reports a stored task file as delivered", () => {
    expect(deriveDeliverableStatus({
      assignmentStatus: "completed",
      dueAt: null,
      hasFile: true,
      now,
    })).toBe("delivered");
  });

  it("uses the deadline only for incomplete fileless assignments", () => {
    expect(deriveDeliverableStatus({
      assignmentStatus: "assigned",
      dueAt: new Date("2026-01-15T23:59:59.000Z"),
      hasFile: false,
      now,
    })).toBe("overdue");
    expect(deriveDeliverableStatus({
      assignmentStatus: "in_progress",
      dueAt: new Date("2027-01-15T23:59:59.000Z"),
      hasFile: false,
      now,
    })).toBe("requested");
  });
});
