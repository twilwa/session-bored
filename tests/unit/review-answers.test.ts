// ABOUTME: Locks the default-hidden custom-answer boundary used by human and AI review surfaces.
// ABOUTME: Proves only an explicit pinned-version opt-in can expose an answer in blind review.
import { describe, expect, it } from "vitest";
import { selectReviewProposalAnswers } from "../../worker/review-answers.ts";

const answers = [
  {
    valueId: "val_visible",
    key: "evaluation_outline",
    label: "Evaluation outline",
    value: "Method and evidence",
    visibleInBlindReview: true,
  },
  {
    valueId: "val_hidden",
    key: "private_context",
    label: "Private context",
    value: "Identifying details",
    visibleInBlindReview: false,
  },
  {
    valueId: "val_unspecified",
    key: "unspecified_context",
    label: "Unspecified context",
    value: "Must stay hidden",
    visibleInBlindReview: undefined,
  },
  {
    valueId: "val_title",
    key: "session_title",
    label: "Session title",
    value: "Handled by the built-in review projection",
    visibleInBlindReview: true,
  },
  {
    valueId: null,
    key: "unanswered",
    label: "Unanswered",
    value: null,
    visibleInBlindReview: true,
  },
];

describe("review proposal answer visibility", () => {
  it("shows every populated custom answer in identified review", () => {
    expect(selectReviewProposalAnswers(answers, false).map((answer) => answer.key)).toEqual([
      "evaluation_outline",
      "private_context",
      "unspecified_context",
    ]);
  });

  it("shows only explicit opt-ins in blind review", () => {
    expect(selectReviewProposalAnswers(answers, true)).toEqual([{
      key: "evaluation_outline",
      label: "Evaluation outline",
      value: "Method and evidence",
    }]);
  });
});
