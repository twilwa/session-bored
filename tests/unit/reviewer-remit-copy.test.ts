// ABOUTME: Pins the organizer confirmation after narrowing a reviewer's committee remit.
// ABOUTME: Removed scope, retained access, and durable recusals stay distinct in the sentence.
import { describe, expect, it } from "vitest";
import { reviewerRemitSummary } from "../../client/pages/review/reviewer-remit-copy.ts";

describe("reviewer remit confirmation", () => {
  it("distinguishes removed remit, retained access, and a durable recusal", () => {
    expect(reviewerRemitSummary("Jules Ferrand", {
      removedTrackIds: ["track_one", "track_two"],
      removedRoundIds: ["round_one"],
      retainedAssignments: [{
        submissionId: "submission_retained",
        title: "A proposal still assigned",
        roundId: "round_two",
      }],
      recusedAssignments: [{
        submissionId: "submission_recused",
        title: "A proposal declined",
        roundId: "round_two",
        roundName: "Second round",
      }],
    })).toBe(
      "Jules Ferrand’s remit saved — 3 removed. They lose that access immediately. " +
      "They can still read A proposal still assigned through an explicit assignment. " +
      "Their recusal from A proposal declined (Second round) remains recorded.",
    );
  });

  it("keeps two rounds of recusal distinct for the same proposal", () => {
    expect(reviewerRemitSummary("Jules Ferrand", {
      removedTrackIds: [],
      removedRoundIds: ["round_one", "round_two"],
      retainedAssignments: [],
      recusedAssignments: [
        {
          submissionId: "submission_recused",
          title: "A proposal declined",
          roundId: "round_one",
          roundName: "Initial review",
        },
        {
          submissionId: "submission_recused",
          title: "A proposal declined",
          roundId: "round_two",
          roundName: "Second round",
        },
      ],
    })).toBe(
      "Jules Ferrand’s remit saved — 2 removed. They lose that access immediately. " +
      "Their recusals from A proposal declined (Initial review), " +
      "A proposal declined (Second round) remain recorded.",
    );
  });
});
