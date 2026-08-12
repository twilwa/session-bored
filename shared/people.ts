// ABOUTME: Reads an account summary into the role and evidence the People surface displays.
// ABOUTME: Pure so the organizer view and its tests agree on what a grant and its evidence mean.
import type { PersonAccountSummary } from "./api.ts";

/** Matches the server's precedence in `worker/roles.ts`: the widest live grant answers. */
const rolePrecedence = ["organizer", "reviewer", "speaker"] as const;

export type EffectiveRole = (typeof rolePrecedence)[number] | "attendee";

export function effectiveRoleOf(person: PersonAccountSummary): EffectiveRole {
  for (const role of rolePrecedence) {
    if (person.grants.some((grant) => grant.role === role)) {
      return role;
    }
  }
  return "attendee";
}

export interface EvidenceSummary {
  text: string;
  detail: string;
  tone: "neutral" | "good" | "signal";
}

/**
 * What this account has actually done here. A speaker record alone is not evidence of
 * presenting - the CFP mints one at first draft - so a proposal-only account is called out
 * rather than blended in with the programme.
 */
export function evidenceSummary(person: PersonAccountSummary): EvidenceSummary {
  const { evidence } = person;
  if (evidence.kind === "programmed") {
    return {
      text: "Programmed",
      detail: `${evidence.programmedSessions} session${evidence.programmedSessions === 1 ? "" : "s"} in the programme`,
      tone: "good",
    };
  }
  if (evidence.kind === "proposals") {
    return {
      text: "Proposal only",
      detail: `${evidence.proposals} proposal${evidence.proposals === 1 ? "" : "s"}, nothing accepted`,
      tone: "signal",
    };
  }
  return { text: "No records", detail: "No proposal, no session", tone: "neutral" };
}
