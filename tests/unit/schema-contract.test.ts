// ABOUTME: Specifies stable public identity and workflow vocabulary at the schema interface.
// ABOUTME: Prevents downstream lanes from silently changing M0's shared data contract.
import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  createPublicId,
  domainTables,
  scheduleStatuses,
  sessionContentStatuses,
  speakerStatuses,
  submissionStatuses,
  submissions,
} from "../../db/schema.ts";

describe("domain identity contract", () => {
  it("generates the requested stable public ID prefix", () => {
    expect(createPublicId("evt")).toMatch(/^evt_[0-9a-f]{32}$/);
    expect(createPublicId("ses")).toMatch(/^ses_[0-9a-f]{32}$/);
  });

  it("gives every PRD domain table a public ID primary key", () => {
    for (const [name, table] of Object.entries(domainTables)) {
      const columns = getTableColumns(table);
      expect(columns.id, `missing public id on ${name}`).toBeDefined();
      expect(columns.id?.primary).toBe(true);
    }
  });

  it("preserves exact PRD status vocabularies", () => {
    expect(submissionStatuses).toEqual([
      "draft",
      "submitted",
      "under_review",
      "accepted",
      "maybe",
      "declined",
      "withdrawn",
    ]);
    expect(speakerStatuses).toContain("pending_employer_approval");
    expect(sessionContentStatuses).toEqual(["draft", "in_review", "approved"]);
    expect(scheduleStatuses).toEqual(["unplaced", "tbd", "placed"]);
  });

  it("includes immutable point-in-time submission fields", () => {
    const columns = getTableColumns(submissions);
    expect(columns.titleAtTime).toBeDefined();
    expect(columns.orgAtTime).toBeDefined();
  });
});
