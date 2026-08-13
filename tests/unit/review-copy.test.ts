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
      .toBe("Recused by Priya Raman · 2 reads will not arrive");
  });

  it("stays singular for one recused assignment", () => {
    expect(recusalSummary(["Priya Raman"], 1))
      .toBe("Recused by Priya Raman · 1 read will not arrive");
  });

  it("names every reviewer who stepped back", () => {
    expect(recusalSummary(["Ada Byron", "Priya Raman"], 2))
      .toBe("Recused by Ada Byron, Priya Raman · 2 reads will not arrive");
  });
});

describe("what the removal notice says it took away", () => {
  it("claims neither a session nor write access the proposal never had", () => {
    const markup = renderToStaticMarkup(
      createElement(RemovalNotice, { removal: removedSpeaker, sessionContentStatus: null }),
    );
    expect(markup).toContain("They lost read access to it.");
    expect(markup).not.toContain("its session");
    expect(markup).not.toContain("write");
  });

  it("names the session and its write access while the speaker could still edit it", () => {
    for (const sessionContentStatus of ["draft", "in_review"] as const) {
      const markup = renderToStaticMarkup(
        createElement(RemovalNotice, { removal: removedSpeaker, sessionContentStatus }),
      );
      expect(markup).toContain(
        "They lost read access to it, and the read and write access they had to its session.",
      );
    }
  });

  it("claims no write access on an approved session, which was already read-only to them", () => {
    const markup = renderToStaticMarkup(
      createElement(RemovalNotice, { removal: removedSpeaker, sessionContentStatus: "approved" }),
    );
    expect(markup).toContain(
      "They lost read access to it, and the read-only access they had to its approved session.",
    );
    expect(markup).not.toContain("write access");
  });

  it("still points at the roster whatever the proposal had", () => {
    for (const sessionContentStatus of [null, "draft", "in_review", "approved"] as const) {
      const markup = renderToStaticMarkup(
        createElement(RemovalNotice, { removal: removedSpeaker, sessionContentStatus }),
      );
      expect(markup).toContain("/organizer/roster");
      expect(markup).toContain("still a speaker at this event");
    }
  });
});
