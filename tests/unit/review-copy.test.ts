// ABOUTME: Pins the two organizer sentences that describe what a recusal and a removal did.
// ABOUTME: Both once described a plural fact in the singular, or a session that never existed.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ParticipantRemovalOutcome } from "../../shared/api.ts";
import { RemovalNotice } from "../../client/pages/review/SubmissionParticipants.tsx";
import { recusalSummary } from "../../client/pages/review/worklist-copy.ts";

const removedSpeaker: ParticipantRemovalOutcome = {
  name: "Dev Malhotra",
  personId: "psn_dev",
  speakerId: "spk_dev",
  remainsEventSpeaker: true,
  listedPublicly: true,
  speaksElsewhereAtEvent: false,
};

describe("what the worklist row says a recusal costs", () => {
  it("counts the recused assignments, not the reviewers, when one reviewer recused twice", () => {
    // One person, two rounds: two scorecards were owed and neither is coming.
    expect(recusalSummary(["Priya Raman"], 2))
      .toBe("Recused by Priya Raman · those reads will not arrive");
  });

  it("stays singular for one recused assignment", () => {
    expect(recusalSummary(["Priya Raman"], 1))
      .toBe("Recused by Priya Raman · that read will not arrive");
  });

  it("names every reviewer who stepped back", () => {
    expect(recusalSummary(["Ada Byron", "Priya Raman"], 2))
      .toBe("Recused by Ada Byron, Priya Raman · those reads will not arrive");
  });
});

describe("what the removal notice says it took away", () => {
  it("does not claim a session the proposal never had", () => {
    const markup = renderToStaticMarkup(
      createElement(RemovalNotice, { removal: removedSpeaker, hasSession: false }),
    );
    expect(markup).toContain("They lost read and write access to it.");
    expect(markup).not.toContain("its session");
  });

  it("names the session when the accepted proposal has one", () => {
    const markup = renderToStaticMarkup(
      createElement(RemovalNotice, { removal: removedSpeaker, hasSession: true }),
    );
    expect(markup).toContain("They lost read and write access to it and to its session.");
  });

  it("still points at the roster in both cases", () => {
    for (const hasSession of [true, false]) {
      const markup = renderToStaticMarkup(
        createElement(RemovalNotice, { removal: removedSpeaker, hasSession }),
      );
      expect(markup).toContain("/organizer/roster");
      expect(markup).toContain("still a speaker at this event");
    }
  });
});
