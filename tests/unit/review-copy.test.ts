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
  withdrawnOnboarding: [],
  heldSessionAccess: true,
};

const neverOnTheSession: ParticipantRemovalOutcome = { ...removedSpeaker, heldSessionAccess: false };

const removalWithWithdrawals = {
  ...removedSpeaker,
  withdrawnOnboarding: [
    { taskId: "tsk_bio", title: "Complete bio and profile" },
    { taskId: "tsk_release", title: "Sign speaker release form" },
  ],
} satisfies ParticipantRemovalOutcome;

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
      createElement(RemovalNotice, { removal: neverOnTheSession, sessionContentStatus: null }),
    );
    expect(markup).toContain("They lost read access to it.");
    expect(markup).not.toContain("its session");
    expect(markup).not.toContain("write");
  });

  it("claims no session access from somebody the proposal's session never carried", () => {
    // Named on an accepted proposal through the public CFP edit, so never on its session.
    for (const sessionContentStatus of ["draft", "in_review", "approved"] as const) {
      const markup = renderToStaticMarkup(
        createElement(RemovalNotice, { removal: neverOnTheSession, sessionContentStatus }),
      );
      expect(markup).toContain("They lost read access to it.");
      expect(markup).not.toContain("its session");
      expect(markup).not.toContain("write");
    }
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

  it("names every onboarding item the removal withdrew and how to restore it", () => {
    const markup = renderToStaticMarkup(
      createElement(RemovalNotice, {
        removal: removalWithWithdrawals,
        sessionContentStatus: "approved",
      }),
    );
    expect(markup).toContain("They no longer owe this onboarding work:");
    expect(markup).toContain("Complete bio and profile");
    expect(markup).toContain("Sign speaker release form");
    expect(markup).toContain("Naming them on this proposal again restores this work and its history.");
  });

  it("does not contradict a withdrawal when the event speaker record is no longer live", () => {
    const markup = renderToStaticMarkup(
      createElement(RemovalNotice, {
        removal: { ...removalWithWithdrawals, remainsEventSpeaker: false, speakerId: null },
        sessionContentStatus: "approved",
      }),
    );
    expect(markup).toContain("Complete bio and profile");
    expect(markup).not.toContain("nothing else is left to undo");
  });

  it("still points at the roster whatever the proposal had", () => {
    for (const removal of [removedSpeaker, neverOnTheSession]) {
      for (const sessionContentStatus of [null, "draft", "in_review", "approved"] as const) {
        const markup = renderToStaticMarkup(
          createElement(RemovalNotice, { removal, sessionContentStatus }),
        );
        expect(markup).toContain("/organizer/roster");
        expect(markup).toContain("still a speaker at this event");
      }
    }
  });
});
