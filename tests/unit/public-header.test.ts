// ABOUTME: Specifies the public header destination for each authenticated account context.
// ABOUTME: Keeps proposal-only submitters distinct from speakers with active portal work.
import { describe, expect, it } from "vitest";
import {
  accountAreaFor,
  accountAreasFor,
  signedInDestination,
  switchableAreasFor,
} from "../../client/lib.tsx";

function twoHatsDestination(returnTo: string | null): string {
  return signedInDestination({ role: "reviewer", roles: ["reviewer", "speaker"] }, returnTo);
}

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

  it("maps every granted role to a reachable area", () => {
    expect(accountAreasFor(["reviewer", "speaker"], false, false)).toEqual([
      { href: "/reviewer", label: "Reviewer area" },
      { href: "/speaker", label: "Speaker area" },
    ]);
  });

  it("keeps offering the speaker area to a multi-grant account that owns proposals", () => {
    // The submitter dashboard is reachable by every authenticated account rather than
    // granted, so it never stands in for the speaker area a live grant opens.
    expect(accountAreasFor(["reviewer", "speaker"], false, true)).toEqual([
      { href: "/reviewer", label: "Reviewer area" },
      { href: "/speaker", label: "Speaker area" },
    ]);
  });

  it("keeps a single-area proposal-only speaker on their submitter dashboard", () => {
    expect(accountAreasFor(["speaker"], false, true)).toEqual([
      { href: "/submitter", label: "Submitter area" },
    ]);
  });

  it("offers a switcher only to an account with more than one area", () => {
    expect(switchableAreasFor(["reviewer", "speaker"])).toEqual([
      { href: "/reviewer", label: "Reviewer area" },
      { href: "/speaker", label: "Speaker area" },
    ]);
    expect(switchableAreasFor(["speaker"])).toEqual([]);
    expect(switchableAreasFor(["attendee"])).toEqual([]);
  });

  it("returns a multi-grant account to the granted area it asked for", () => {
    expect(twoHatsDestination("/speaker#tasks")).toBe("/speaker#tasks");
  });

  it("falls back to the landing area for a return path outside the grant union", () => {
    expect(twoHatsDestination("/organizer/people")).toBe("/reviewer");
    expect(twoHatsDestination(null)).toBe("/reviewer");
  });

  it("refuses a return path that only shares a prefix with a granted area", () => {
    // The public speaker directory is not the speaker workspace, and no granted root ends
    // mid-segment, so a prefix match alone must not open a return.
    expect(twoHatsDestination("/speakers/ada-lovelace")).toBe("/reviewer");
    expect(twoHatsDestination("/speaker")).toBe("/speaker");
    expect(twoHatsDestination("/speaker/files?version=2")).toBe("/speaker/files?version=2");
  });

  it("refuses a return path that leaves this origin", () => {
    for (const hostile of [
      "//evil.example/speaker",
      "https://evil.example/speaker",
      "/\\evil.example/speaker",
      "speaker",
    ]) {
      expect(twoHatsDestination(hostile)).toBe("/reviewer");
    }
  });

  it("falls back to the landing area for a return path that will not resolve", () => {
    // Sign-in has already succeeded by the time this is asked, so an unparseable authority
    // has to answer with a destination rather than throw the person back onto the form.
    for (const malformed of ["//%", "//[", "//]", "/\\[", "//a%2"]) {
      expect(twoHatsDestination(malformed)).toBe("/reviewer");
    }
  });

  it("judges the area a return path resolves to, not the one it spells", () => {
    // The browser removes dot segments when it navigates, so a path that reads as a
    // granted area but lands outside one must be refused on where it actually lands.
    for (const crafted of [
      "/submitter/../organizer",
      "/speaker/%2e%2e/organizer",
      "/reviewer/../../organizer/people",
    ]) {
      expect(twoHatsDestination(crafted)).toBe("/reviewer");
    }
  });

  it("returns the resolved form of a return path it accepts", () => {
    expect(twoHatsDestination("/organizer/../speaker")).toBe("/speaker");
    expect(twoHatsDestination("/speaker/./files#latest")).toBe("/speaker/files#latest");
  });

  it("keeps the submitter dashboard a valid return for any authenticated account", () => {
    expect(signedInDestination({ role: "attendee", roles: ["attendee"] }, "/submitter")).toBe("/submitter");
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
