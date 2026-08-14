// ABOUTME: Exercises conservative duplicate detection for the cross-event speaker directory.
// ABOUTME: Keeps weak similarities from becoming destructive merge recommendations.
import { describe, expect, it } from "vitest";
import { duplicateReasonsFor, possibleDuplicateGroups } from "../../worker/speaker-directory.ts";

const priya = {
  id: "psn_priya",
  name: "Priya Raman",
  email: "priya@example.com",
  organization: "Northwind Labs",
};

describe("speaker directory duplicate detection", () => {
  it("matches normalized email addresses", () => {
    expect(duplicateReasonsFor(priya, {
      ...priya,
      id: "psn_priya_copy",
      email: "  PRIYA@EXAMPLE.COM ",
      name: "P. Raman",
      organization: null,
    })).toEqual(["same_email"]);
  });

  it("matches a normalized name only when the organization also agrees", () => {
    expect(duplicateReasonsFor(priya, {
      ...priya,
      id: "psn_priya_northwind",
      email: "priya.raman@example.net",
      name: "  PRIYA   RAMAN ",
      organization: " northwind   labs ",
    })).toEqual(["same_name_and_organization"]);

    expect(duplicateReasonsFor(priya, {
      ...priya,
      id: "psn_other_priya",
      email: "other-priya@example.net",
      organization: "Contoso",
    })).toEqual([]);
  });

  it("returns stable groups without comparing a person to themselves", () => {
    expect(possibleDuplicateGroups([
      priya,
      { ...priya, id: "psn_z", email: "priya+z@example.com" },
      { ...priya, id: "psn_a", email: "priya+a@example.com" },
    ])).toEqual([
      {
        personIds: ["psn_a", "psn_priya", "psn_z"],
        reasons: ["same_name_and_organization"],
      },
    ]);
  });
});
