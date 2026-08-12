// ABOUTME: Specifies the public header destination for each authenticated account context.
// ABOUTME: Keeps proposal-only submitters distinct from speakers with active portal work.
import { describe, expect, it } from "vitest";
import { accountAreaFor } from "../../client/lib.tsx";

describe("public header account area", () => {
  it("maps staff roles to their own work areas", () => {
    expect(accountAreaFor("organizer", false, false)).toEqual({
      href: "/organizer",
      label: "Organizer area",
    });
    expect(accountAreaFor("reviewer", false, false)).toEqual({
      href: "/reviewer",
      label: "Reviewer area",
    });
  });

  it("keeps a speaker with portal work in the speaker area", () => {
    expect(accountAreaFor("speaker", true, true)).toEqual({
      href: "/speaker",
      label: "Speaker area",
    });
  });

  it("routes a proposal-only speaker account to the submitter area", () => {
    expect(accountAreaFor("speaker", false, true)).toEqual({
      href: "/submitter",
      label: "Submitter area",
    });
  });

  it("lands an attendee on their schedule whether or not they own proposals", () => {
    // The destination must not move with state the person cannot see. Proposals stay
    // reachable, but by deliberate navigation rather than by changing where they land.
    for (const hasProposals of [false, true]) {
      expect(accountAreaFor("attendee", false, hasProposals)).toEqual({
        href: "/schedule/mine",
        label: "My schedule",
      });
    }
  });
});
