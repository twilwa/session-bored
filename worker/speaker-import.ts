// ABOUTME: Parses organizer speaker CSV files into a stable import preview.
// ABOUTME: Maps supported headers and keeps validation errors attached to their source rows.
import {
  speakerImportRowLimit,
  type SpeakerImportField,
  type SpeakerImportOutcome,
  type SpeakerImportValues,
} from "../shared/api.ts";

export interface ParsedSpeakerImportRow {
  rowNumber: number;
  values: SpeakerImportValues;
  errors: string[];
}

export interface SpeakerImportDocument {
  mappings: Array<{ source: string; target: SpeakerImportField }>;
  rows: ParsedSpeakerImportRow[];
  errors: string[];
}

export type SpeakerImportPreviewOutcome = Exclude<SpeakerImportOutcome, "created" | "added_existing" | "restored">;

export interface SpeakerImportIdentity {
  personId: string;
  email: string;
  personDeleted: boolean;
  speakerId: string | null;
  speakerDeleted: boolean;
}

export interface SpeakerImportPlanRow extends ParsedSpeakerImportRow {
  outcome: SpeakerImportPreviewOutcome;
  personId: string | null;
  speakerId: string | null;
}

const supportedHeaders = new Map<string, SpeakerImportField>([
  ["name", "name"],
  ["full name", "name"],
  ["speaker name", "name"],
  ["email", "email"],
  ["email address", "email"],
  ["title", "jobTitle"],
  ["job title", "jobTitle"],
  ["company", "organization"],
  ["organization", "organization"],
  ["bio", "bio"],
  ["biography", "bio"],
]);

function normalizedHeader(value: string): string {
  return value.replace(/^\uFEFF/, "").trim().toLowerCase().replaceAll(/[_-]+/g, " ").replaceAll(/\s+/g, " ");
}

function parseCsvRecords(csv: string): { records: string[][]; error: string | null } {
  const records: string[][] = [];
  let record: string[] = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    if (character === '"') {
      if (quoted && csv[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (character === "," && !quoted) {
      record.push(value);
      value = "";
      continue;
    }
    if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && csv[index + 1] === "\n") index += 1;
      record.push(value);
      records.push(record);
      record = [];
      value = "";
      continue;
    }
    value += character;
  }

  if (quoted) {
    return { records: [], error: "CSV contains an unclosed quoted field." };
  }
  record.push(value);
  if (record.some((cell) => cell.trim().length > 0)) records.push(record);
  return { records, error: null };
}

export function parseSpeakerImport(csv: string): SpeakerImportDocument {
  const parsed = parseCsvRecords(csv);
  if (parsed.error !== null) return { mappings: [], rows: [], errors: [parsed.error] };
  const [headerRow, ...dataRows] = parsed.records;
  if (headerRow === undefined) return { mappings: [], rows: [], errors: ["CSV is empty."] };

  const mappings: SpeakerImportDocument["mappings"] = [];
  const mappedIndexes = new Map<SpeakerImportField, number>();
  const duplicateTargets = new Set<SpeakerImportField>();
  for (const [index, source] of headerRow.entries()) {
    const target = supportedHeaders.get(normalizedHeader(source));
    if (target !== undefined && !mappedIndexes.has(target)) {
      mappings.push({ source: source.replace(/^\uFEFF/, "").trim(), target });
      mappedIndexes.set(target, index);
    } else if (target !== undefined) {
      duplicateTargets.add(target);
    }
  }

  const errors = [...duplicateTargets].map((target) => `More than one CSV column maps to "${target}".`);
  if (!mappedIndexes.has("name")) errors.push('Missing required "name" header.');
  if (!mappedIndexes.has("email")) errors.push('Missing required "email" header.');
  if (errors.length > 0) return { mappings, rows: [], errors };

  const valueAt = (record: string[], field: SpeakerImportField): string => {
    const index = mappedIndexes.get(field);
    return index === undefined ? "" : (record[index] ?? "").trim();
  };
  const rows = dataRows
    .map((record, index): ParsedSpeakerImportRow | null => {
      if (record.every((cell) => cell.trim().length === 0)) return null;
      const name = valueAt(record, "name");
      const email = valueAt(record, "email").toLowerCase();
      const rowErrors = record.length > headerRow.length
        ? [`Row has ${record.length} columns but the header has ${headerRow.length}.`]
        : [];
      if (name.length === 0) rowErrors.push("Name is required.");
      if (email.length === 0) {
        rowErrors.push("Email is required.");
      } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        rowErrors.push("Email must be a valid address.");
      }
      return {
        rowNumber: index + 2,
        values: {
          name,
          email,
          jobTitle: valueAt(record, "jobTitle"),
          organization: valueAt(record, "organization"),
          bio: valueAt(record, "bio"),
        },
        errors: rowErrors,
      };
    })
    .filter((row): row is ParsedSpeakerImportRow => row !== null);

  if (rows.length > speakerImportRowLimit) {
    return {
      mappings,
      rows: [],
      errors: [`CSV has ${rows.length} speaker rows; import at most ${speakerImportRowLimit} rows at a time.`],
    };
  }

  return { mappings, rows, errors };
}

export function planSpeakerImport(
  document: SpeakerImportDocument,
  identities: readonly SpeakerImportIdentity[],
): SpeakerImportPlanRow[] {
  const identitiesByEmail = new Map<string, SpeakerImportIdentity[]>();
  for (const identity of identities) {
    const email = identity.email.toLowerCase();
    identitiesByEmail.set(email, [...(identitiesByEmail.get(email) ?? []), identity]);
  }
  const seenEmails = new Set<string>();
  return document.rows.map((row) => {
    const matchingIdentities = identitiesByEmail.get(row.values.email) ?? [];
    const identity = matchingIdentities.length === 1 ? matchingIdentities[0] : undefined;
    let outcome: SpeakerImportPreviewOutcome;
    const errors = [...row.errors];
    if (errors.length > 0) {
      outcome = "invalid";
    } else if (seenEmails.has(row.values.email)) {
      outcome = "skipped_duplicate_file";
    } else if (matchingIdentities.length > 1) {
      outcome = "blocked_identity_conflict";
      errors.push("Email matches more than one person record; review the duplicate identities manually.");
    } else if (identity?.personDeleted === true) {
      outcome = "blocked_archived_identity";
      errors.push("Email belongs to an archived person record; review it manually.");
    } else if (identity?.speakerId !== null && identity?.speakerId !== undefined) {
      outcome = identity.speakerDeleted ? "will_restore" : "skipped_existing";
    } else if (identity !== undefined) {
      outcome = "will_add_existing";
    } else {
      outcome = "will_create";
    }
    const blocked = outcome === "invalid" ||
      outcome === "blocked_identity_conflict" ||
      outcome === "blocked_archived_identity";
    if (!blocked && row.values.email.length > 0) seenEmails.add(row.values.email);
    return {
      ...row,
      errors,
      outcome,
      personId: identity?.personId ?? null,
      speakerId: identity?.speakerId ?? null,
    };
  });
}
