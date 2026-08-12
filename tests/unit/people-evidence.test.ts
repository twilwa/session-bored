// ABOUTME: Specifies how the People surface reads an account's evidence and effective role.
// ABOUTME: Keeps "attendee means no grant" and the grant precedence honest without a database.
import { describe, expect, it } from "vitest";
import type { PersonAccountSummary } from "../../shared/api.ts";
import { effectiveRoleOf, evidenceSummary } from "../../shared/people.ts";

function account(overrides: Partial<PersonAccountSummary> = {}): PersonAccountSummary {
  return {
    id: "usr_1",
    name: "Rowan Ellis",
    email: "rowan@example.com",
    emailVerified: false,
    joinedAt: new Date("2026-08-12T10:00:00Z").toISOString(),
    signInMethods: ["password"],
    evidence: { kind: "none", programmedSessions: 0, proposals: 0 },
    grants: [],
    ...overrides,
  };
}

describe("effective role", () => {
  it("reads an account with no grant as an attendee", () => {
    expect(effectiveRoleOf(account())).toBe("attendee");
  });

  it("takes the widest grant when an account holds more than one", () => {
    expect(
      effectiveRoleOf(
        account({
          grants: [
            { role: "speaker", source: "acceptance", note: null, grantedAt: "", grantedByName: null },
            { role: "organizer", source: "organizer", note: null, grantedAt: "", grantedByName: null },
          ],
        }),
      ),
    ).toBe("organizer");
  });

  it("keeps a reviewer above a speaker", () => {
    expect(
      effectiveRoleOf(
        account({
          grants: [
            { role: "speaker", source: "acceptance", note: null, grantedAt: "", grantedByName: null },
            { role: "reviewer", source: "reviewer_invite", note: null, grantedAt: "", grantedByName: null },
          ],
        }),
      ),
    ).toBe("reviewer");
  });
});

describe("evidence summary", () => {
  it("calls out an account that is actually in the programme", () => {
    expect(
      evidenceSummary(account({ evidence: { kind: "programmed", programmedSessions: 2, proposals: 3 } })),
    ).toMatchObject({ text: "Programmed", tone: "good" });
  });

  it("flags a proposal-only account, which is what a draft-minted speaker row looks like", () => {
    const summary = evidenceSummary(
      account({ evidence: { kind: "proposals", programmedSessions: 0, proposals: 1 } }),
    );
    expect(summary.text).toBe("Proposal only");
    expect(summary.detail).toBe("1 proposal, nothing accepted");
  });

  it("says plainly when an account has done nothing here", () => {
    expect(evidenceSummary(account())).toMatchObject({ text: "No records", tone: "neutral" });
  });
});
