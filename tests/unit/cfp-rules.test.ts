// ABOUTME: Specifies CFP submission validation and deadline behavior at the public interface.
// ABOUTME: Protects partial draft saves while enforcing complete final submissions server-side.
import { describe, expect, it } from "vitest";
import { isProposalFieldVisible } from "../../client/pages/cfp/CfpPage.tsx";
import { getCfpAvailability, validateCfpSubmission } from "../../worker/routes/cfp.ts";

const requiredFields = [
  { id: "fld_session_title", key: "session_title", label: "Session title", required: true },
  { id: "fld_abstract", key: "abstract", label: "Abstract", required: true },
  { id: "fld_track", key: "track", label: "Track", required: true },
  { id: "fld_format", key: "format", label: "Format", required: true },
  { id: "fld_key_takeaway", key: "key_takeaway", label: "Key takeaway", required: true },
];

const partialDraft = {
  intent: "draft" as const,
  speaker: { name: "Priya Raman", email: "sbek-speaker@example.com" },
  proposal: { title: "A useful unfinished idea", answers: {} },
};

describe("CFP availability", () => {
  it("keeps writes open until the exact closing instant", () => {
    const form = {
      status: "published",
      openAt: new Date("2026-08-01T00:00:00.000Z"),
      closeAt: new Date("2027-04-30T23:59:59.000Z"),
    } as const;

    expect(getCfpAvailability(form, new Date("2027-04-30T23:59:58.999Z"))).toMatchObject({
      state: "open",
      canWrite: true,
    });
    expect(getCfpAvailability(form, new Date("2027-04-30T23:59:59.000Z"))).toMatchObject({
      state: "closed",
      canWrite: false,
    });
  });

  it("returns a clear explanation when the call is closed", () => {
    const availability = getCfpAvailability(
      { status: "published", openAt: null, closeAt: new Date("2027-04-30T23:59:59.000Z") },
      new Date("2027-05-01T00:00:00.000Z"),
    );

    expect(availability.message).toContain("closed at 2027-04-30T23:59:59.000Z");
    expect(availability.message).toContain("edits are no longer accepted");
  });
});

describe("CFP submission validation", () => {
  it("allows an incomplete proposal to save as a draft", () => {
    expect(validateCfpSubmission(requiredFields, partialDraft)).toEqual({});
  });

  it("reports every missing required field when final submission is requested", () => {
    const errors = validateCfpSubmission(requiredFields, {
      ...partialDraft,
      intent: "submit",
    });

    expect(errors).toEqual({
      abstract: "Abstract is required.",
      format: "Format is required.",
      key_takeaway: "Key takeaway is required.",
      track: "Track is required.",
    });
  });

  it("rejects malformed speaker identity for both drafts and submissions", () => {
    const errors = validateCfpSubmission(requiredFields, {
      ...partialDraft,
      speaker: { name: "", email: "not-an-email" },
    });

    expect(errors).toMatchObject({
      speakerName: "Your name is required to save this proposal.",
      speakerEmail: "Enter a valid email address so you can return to this proposal.",
    });
  });
});

describe("CFP conditional field visibility", () => {
  it("hides a chained dependent when its controlling field is itself hidden", () => {
    const fields = [
      {
        id: "format",
        key: "format",
        label: "Format",
        description: null,
        fieldType: "dropdown" as const,
        required: true,
        sortOrder: 0,
        options: null,
        conditionalFieldId: null,
        conditionalValue: null,
      },
      {
        id: "workshop_kind",
        key: "workshop_kind",
        label: "Workshop kind",
        description: null,
        fieldType: "dropdown" as const,
        required: false,
        sortOrder: 1,
        options: ["Hands-on"],
        conditionalFieldId: "format",
        conditionalValue: "Workshop (120 min)",
      },
      {
        id: "environment",
        key: "environment",
        label: "Environment",
        description: null,
        fieldType: "short_text" as const,
        required: false,
        sortOrder: 2,
        options: null,
        conditionalFieldId: "workshop_kind",
        conditionalValue: "Hands-on",
      },
    ];
    const state = {
      speaker: { name: "", email: "", jobTitle: "", organization: "", bio: "" },
      proposal: {
        title: "",
        abstract: "",
        track: "",
        format: "Talk (30 min)",
        audienceLevel: "",
        notesForReviewers: "",
        answers: { workshop_kind: "Hands-on" },
      },
    };

    expect(isProposalFieldVisible(fields, fields[2]!, state)).toBe(false);
  });
});
