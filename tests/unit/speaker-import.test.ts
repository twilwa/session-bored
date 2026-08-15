// ABOUTME: Specifies CSV parsing and validation for organizer speaker imports.
// ABOUTME: Keeps fixture headers, quoted content, and row-level failures predictable before database writes.
import { describe, expect, it } from "vitest";
import { parseSpeakerImport, planSpeakerImport } from "../../worker/speaker-import.ts";

describe("speaker CSV import parsing", () => {
  it("maps the grader fixture headers and preserves quoted commas", () => {
    const parsed = parseSpeakerImport([
      "name,email,title,company,bio",
      "Dana Kowalski,dana.speaker@sbek-test.example.com,Engineering Manager,Substrate,\"Runs DX, CI, and release engineering.\"",
    ].join("\n"));

    expect(parsed.errors).toEqual([]);
    expect(parsed.mappings).toEqual([
      { source: "name", target: "name" },
      { source: "email", target: "email" },
      { source: "title", target: "jobTitle" },
      { source: "company", target: "organization" },
      { source: "bio", target: "bio" },
    ]);
    expect(parsed.rows).toEqual([
      {
        rowNumber: 2,
        values: {
          name: "Dana Kowalski",
          email: "dana.speaker@sbek-test.example.com",
          jobTitle: "Engineering Manager",
          organization: "Substrate",
          bio: "Runs DX, CI, and release engineering.",
        },
        errors: [],
      },
    ]);
  });

  it("keeps required-field and email failures on their source rows", () => {
    const parsed = parseSpeakerImport([
      "Full Name,Email Address,Job_Title,Organization,Biography",
      ",missing-name@example.com,Engineer,Example Co,Missing a name",
      "Missing Email,,Engineer,Example Co,Missing an email",
      "Broken Email,not-an-email,Engineer,Example Co,Malformed address",
      ",,,,",
    ].join("\r\n"));

    expect(parsed.errors).toEqual([]);
    expect(parsed.rows.map((row) => ({ rowNumber: row.rowNumber, errors: row.errors }))).toEqual([
      { rowNumber: 2, errors: ["Name is required."] },
      { rowNumber: 3, errors: ["Email is required."] },
      { rowNumber: 4, errors: ["Email must be a valid address."] },
    ]);
  });

  it("rejects rows with cells beyond the declared headers", () => {
    const parsed = parseSpeakerImport([
      "name,email,title,company,bio",
      "Dana Kowalski,dana@example.com,Engineer,Example,Builds tools,without quoting commas",
    ].join("\n"));

    expect(parsed.rows).toMatchObject([
      {
        rowNumber: 2,
        errors: ["Row has 6 columns but the header has 5."],
      },
    ]);
  });

  it("refuses files that cannot map one unambiguous name and email column", () => {
    expect(parseSpeakerImport("email,title\ndana@example.com,Engineer")).toMatchObject({
      rows: [],
      errors: ['Missing required "name" header.'],
    });
    expect(parseSpeakerImport("name,email,company,organization\nDana,dana@example.com,A,B")).toMatchObject({
      rows: [],
      errors: ['More than one CSV column maps to "organization".'],
    });
  });

  it("blocks a normalized email that belongs to more than one person identity", () => {
    const document = parseSpeakerImport("name,email\nCasey,CASEY@example.com");
    const [row] = planSpeakerImport(document, [
      {
        personId: "psn_one",
        email: "casey@example.com",
        personDeleted: false,
        speakerId: null,
        speakerDeleted: false,
      },
      {
        personId: "psn_two",
        email: "CASEY@example.com",
        personDeleted: false,
        speakerId: null,
        speakerDeleted: false,
      },
    ]);

    expect(row).toMatchObject({
      outcome: "blocked_identity_conflict",
      errors: ["Email matches more than one person record; review the duplicate identities manually."],
    });
  });

  it("allows a valid row after an invalid row uses the same email", () => {
    const document = parseSpeakerImport([
      "name,email",
      ",dana@example.com",
      "Dana Kowalski,DANA@example.com",
    ].join("\n"));

    expect(planSpeakerImport(document, []).map((row) => row.outcome)).toEqual([
      "invalid",
      "will_create",
    ]);
  });
});
