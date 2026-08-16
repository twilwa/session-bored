// ABOUTME: Classifies and plans the ownership references a speaker-directory merge may move.
// ABOUTME: Keeps roster decisions, removals, publication, profile fields, and credentials outside merge writes.
import type {
  SpeakerDirectoryDuplicateReason,
  SpeakerDirectoryMergeConflict,
  SpeakerDirectoryMergePlan,
  SpeakerDirectoryMergeReference,
  SpeakerDirectoryReferenceMove,
  SpeakerDirectoryRetainedReference,
} from "../shared/speaker-directory.ts";
import { chunkIds } from "./d1-limits.ts";

export const speakerMergeReferenceClasses = {
  "person.deleted_at": "identity_record",
  "directory_merge": "identity_record",
  "submission.submitter_person_id": "identity_reference",
  "submission_speaker.person_id": "identity_reference",
  "speaker.person_id": "identity_reference",
  "session_speaker.speaker_id": "identity_reference",
  "task_assignee.speaker_id": "identity_reference",
  "file.speaker_id": "identity_reference",
  "speaker_directory_contact_tag.person_id": "identity_reference",
  "speaker_directory_custom_field.person_id": "identity_reference",
  "speaker_directory_note.person_id": "identity_reference",
  "person.user_id": "credential",
  "person.profile": "profile",
  "speaker.status": "decision",
  "speaker.custom_fields": "decision",
  "speaker.deleted_at": "decision",
  "submission_speaker.role_label": "decision",
  "submission_speaker.sort_order": "decision",
  "submission_speaker.deleted_at": "decision",
  "session_speaker.role_label": "decision",
  "session_speaker.sort_order": "decision",
  "session_speaker.publication_hold_at": "decision",
  "session_speaker.deleted_at": "decision",
  "task_assignee.status": "decision",
  "task_assignee.completed_at": "decision",
  "task_assignee.granted_by_session_id": "decision",
  "task_assignee.deleted_at": "decision",
  "file.deleted_at": "decision",
  "submission.title_at_time": "snapshot",
  "submission.org_at_time": "snapshot",
  "decision_notice.recipient": "communication",
  "decision_batch_item.recipient": "communication",
  "email_dispatch.recipients": "communication",
} as const;

interface PersonOwnedRow {
  id: string;
  personId: string;
}

interface SubmissionSpeakerRow extends PersonOwnedRow {
  submissionId: string;
}

interface SpeakerRow extends PersonOwnedRow {
  eventId: string;
  status: string;
  deletedAt: Date | number | null;
}

interface SpeakerOwnedRow {
  id: string;
  speakerId: string;
}

interface SessionSpeakerRow extends SpeakerOwnedRow {
  sessionId: string;
  roleLabel: string;
  sortOrder: number;
  publicationHoldAt: Date | number | null;
  deletedAt: Date | number | null;
}

interface TaskAssigneeRow extends SpeakerOwnedRow {
  taskId: string;
}

interface FileRow extends SpeakerOwnedRow {
  taskId: string | null;
  deletedAt: Date | number | null;
}

interface ContactTagRow {
  personId: string;
  tagId: string;
}

interface CustomFieldRow extends PersonOwnedRow {
  normalizedName: string;
}

export interface SpeakerMergeReferenceInput {
  keptPersonId: string;
  mergedPersonId: string;
  submissions: PersonOwnedRow[];
  submissionSpeakers: SubmissionSpeakerRow[];
  speakers: SpeakerRow[];
  sessionSpeakers: SessionSpeakerRow[];
  taskAssignees: TaskAssigneeRow[];
  files: FileRow[];
  contactTags: ContactTagRow[];
  customFields: CustomFieldRow[];
  notes: PersonOwnedRow[];
}

function move(
  reference: SpeakerDirectoryMergeReference,
  rowId: string,
  fromId: string,
  toId: string,
): SpeakerDirectoryReferenceMove {
  return { reference, rowId, fromId, toId };
}

function retain(
  reference: SpeakerDirectoryMergeReference,
  rowId: string,
): SpeakerDirectoryRetainedReference {
  return { reference, rowId, reason: "target_reference_exists" };
}

function timestampOf(value: Date | number | null): number | null {
  if (value === null) return null;
  return value instanceof Date ? value.getTime() : value;
}

export function planSpeakerMergeReferences(input: SpeakerMergeReferenceInput): SpeakerDirectoryMergePlan {
  const moves: SpeakerDirectoryReferenceMove[] = input.submissions
    .filter((row) => row.personId === input.mergedPersonId)
    .map((row) => move("submission", row.id, input.mergedPersonId, input.keptPersonId));
  const retained: SpeakerDirectoryRetainedReference[] = [];
  const conflicts: SpeakerDirectoryMergeConflict[] = [];

  const keptSubmissionIds = new Set(input.submissionSpeakers
    .filter((row) => row.personId === input.keptPersonId)
    .map((row) => row.submissionId));
  for (const row of input.submissionSpeakers.filter((candidate) => candidate.personId === input.mergedPersonId)) {
    if (keptSubmissionIds.has(row.submissionId)) retained.push(retain("submission_speaker", row.id));
    else moves.push(move("submission_speaker", row.id, input.mergedPersonId, input.keptPersonId));
  }

  const keptSpeakerByEvent = new Map(input.speakers
    .filter((row) => row.personId === input.keptPersonId)
    .map((row) => [row.eventId, row]));
  for (const row of input.speakers.filter((candidate) => candidate.personId === input.mergedPersonId)) {
    const keptSpeaker = keptSpeakerByEvent.get(row.eventId);
    if (keptSpeaker === undefined) {
      moves.push(move("speaker", row.id, input.mergedPersonId, input.keptPersonId));
      continue;
    }
    retained.push(retain("speaker", row.id));
    conflicts.push({
      reference: "speaker",
      rowId: row.id,
      targetRowId: keptSpeaker.id,
      reason: "event_speaker_collision",
    });
    if (
      row.status !== keptSpeaker.status
      || timestampOf(row.deletedAt) !== timestampOf(keptSpeaker.deletedAt)
    ) {
      conflicts.push({
        reference: "speaker",
        rowId: row.id,
        targetRowId: keptSpeaker.id,
        reason: "standing_differs",
      });
    }

    const keptSessionById = new Map(input.sessionSpeakers
      .filter((candidate) => candidate.speakerId === keptSpeaker.id)
      .map((candidate) => [candidate.sessionId, candidate]));
    for (const sessionSpeaker of input.sessionSpeakers.filter((candidate) => candidate.speakerId === row.id)) {
      const keptSessionSpeaker = keptSessionById.get(sessionSpeaker.sessionId);
      if (keptSessionSpeaker !== undefined) {
        retained.push(retain("session_speaker", sessionSpeaker.id));
        if (
          sessionSpeaker.roleLabel !== keptSessionSpeaker.roleLabel
          || sessionSpeaker.sortOrder !== keptSessionSpeaker.sortOrder
          || timestampOf(sessionSpeaker.publicationHoldAt) !== timestampOf(keptSessionSpeaker.publicationHoldAt)
          || timestampOf(sessionSpeaker.deletedAt) !== timestampOf(keptSessionSpeaker.deletedAt)
        ) {
          conflicts.push({
            reference: "session_speaker",
            rowId: sessionSpeaker.id,
            targetRowId: keptSessionSpeaker.id,
            reason: "participation_differs",
          });
        }
      } else {
        moves.push(move("session_speaker", sessionSpeaker.id, row.id, keptSpeaker.id));
      }
    }

    const keptTaskIds = new Set(input.taskAssignees
      .filter((candidate) => candidate.speakerId === keptSpeaker.id)
      .map((candidate) => candidate.taskId));
    for (const assignment of input.taskAssignees.filter((candidate) => candidate.speakerId === row.id)) {
      if (keptTaskIds.has(assignment.taskId)) retained.push(retain("task_assignee", assignment.id));
      else moves.push(move("task_assignee", assignment.id, row.id, keptSpeaker.id));
    }

    const keptLiveFileTasks = new Set(input.files
      .filter((candidate) => (
        candidate.speakerId === keptSpeaker.id
        && candidate.taskId !== null
        && candidate.deletedAt === null
      ))
      .map((candidate) => candidate.taskId));
    for (const file of input.files.filter((candidate) => candidate.speakerId === row.id)) {
      if (file.deletedAt === null && file.taskId !== null && keptLiveFileTasks.has(file.taskId)) {
        retained.push(retain("file", file.id));
      } else {
        moves.push(move("file", file.id, row.id, keptSpeaker.id));
      }
    }
  }

  const keptTagIds = new Set(input.contactTags
    .filter((row) => row.personId === input.keptPersonId)
    .map((row) => row.tagId));
  for (const row of input.contactTags.filter((candidate) => candidate.personId === input.mergedPersonId)) {
    if (keptTagIds.has(row.tagId)) retained.push(retain("speaker_directory_contact_tag", row.tagId));
    else moves.push(move("speaker_directory_contact_tag", row.tagId, input.mergedPersonId, input.keptPersonId));
  }

  const keptFieldNames = new Set(input.customFields
    .filter((row) => row.personId === input.keptPersonId)
    .map((row) => row.normalizedName));
  for (const row of input.customFields.filter((candidate) => candidate.personId === input.mergedPersonId)) {
    if (keptFieldNames.has(row.normalizedName)) {
      retained.push(retain("speaker_directory_custom_field", row.id));
    } else {
      moves.push(move("speaker_directory_custom_field", row.id, input.mergedPersonId, input.keptPersonId));
    }
  }

  moves.push(...input.notes
    .filter((row) => row.personId === input.mergedPersonId)
    .map((row) => move("speaker_directory_note", row.id, input.mergedPersonId, input.keptPersonId)));

  return { moves, retained, conflicts };
}

const referenceLocations: Record<
  SpeakerDirectoryMergeReference,
  { table: string; rowColumn: string; ownerColumn: string }
> = {
  submission: { table: "submission", rowColumn: "id", ownerColumn: "submitter_person_id" },
  submission_speaker: { table: "submission_speaker", rowColumn: "id", ownerColumn: "person_id" },
  speaker: { table: "speaker", rowColumn: "id", ownerColumn: "person_id" },
  session_speaker: { table: "session_speaker", rowColumn: "id", ownerColumn: "speaker_id" },
  task_assignee: { table: "task_assignee", rowColumn: "id", ownerColumn: "speaker_id" },
  file: { table: "file", rowColumn: "id", ownerColumn: "speaker_id" },
  speaker_directory_contact_tag: {
    table: "speaker_directory_contact_tag",
    rowColumn: "tag_id",
    ownerColumn: "person_id",
  },
  speaker_directory_custom_field: {
    table: "speaker_directory_custom_field",
    rowColumn: "id",
    ownerColumn: "person_id",
  },
  speaker_directory_note: { table: "speaker_directory_note", rowColumn: "id", ownerColumn: "person_id" },
};

const directPersonReferences = [
  "submission",
  "submission_speaker",
  "speaker",
  "speaker_directory_contact_tag",
  "speaker_directory_custom_field",
  "speaker_directory_note",
] as const satisfies readonly SpeakerDirectoryMergeReference[];

export class SpeakerMergePlanStaleError extends Error {
  constructor() {
    super("speaker merge plan is stale");
    this.name = "SpeakerMergePlanStaleError";
  }
}

function expectedDirectReferenceIds(
  plan: SpeakerDirectoryMergePlan,
  reference: typeof directPersonReferences[number],
  mergedPersonId: string,
): string[] {
  return [
    ...plan.moves
      .filter((referenceMove) => (
        referenceMove.reference === reference
        && referenceMove.fromId === mergedPersonId
      ))
      .map((referenceMove) => referenceMove.rowId),
    ...plan.retained
      .filter((retainedReference) => retainedReference.reference === reference)
      .map((retainedReference) => retainedReference.rowId),
  ].sort((left, right) => left.localeCompare(right));
}

function currentPlanPersonQuery(
  plan: SpeakerDirectoryMergePlan,
  mergedPersonId: string,
): { sql: string; bindings: unknown[] } {
  const conditions: string[] = [];
  const bindings: unknown[] = [mergedPersonId];
  for (const reference of directPersonReferences) {
    const location = referenceLocations[reference];
    conditions.push(
      `coalesce((select json_group_array(reference_id) from (select ${location.rowColumn} as reference_id from ${location.table} where ${location.ownerColumn} = ? order by ${location.rowColumn})), '[]') = ?`,
    );
    bindings.push(
      mergedPersonId,
      JSON.stringify(expectedDirectReferenceIds(plan, reference, mergedPersonId)),
    );
  }
  return {
    sql: `select id from person where id = ? and deleted_at is null and user_id is null and ${conditions.join(" and ")}`,
    bindings,
  };
}

async function speakerMergePlanIsCurrent(input: ApplySpeakerMergeInput): Promise<boolean> {
  const currentPerson = currentPlanPersonQuery(input.plan, input.mergedPersonId);
  return await input.database.prepare(currentPerson.sql)
    .bind(...currentPerson.bindings)
    .first<{ id: string }>() !== null;
}

interface ApplySpeakerMergeInput {
  database: D1Database;
  plan: SpeakerDirectoryMergePlan;
  keptPersonId: string;
  mergedPersonId: string;
  mergedByUserId: string;
  reasons: SpeakerDirectoryDuplicateReason[];
  mergedProfile: unknown;
  timestamp: number;
}

export async function applySpeakerMerge(input: ApplySpeakerMergeInput): Promise<void> {
  if (input.plan.conflicts.length > 0) {
    throw new Error("speaker merge plan has unresolved conflicts");
  }
  if (!(await speakerMergePlanIsCurrent(input))) {
    throw new SpeakerMergePlanStaleError();
  }
  const movesByRoute = new Map<string, SpeakerDirectoryReferenceMove[]>();
  for (const referenceMove of input.plan.moves) {
    const route = JSON.stringify([
      referenceMove.reference,
      referenceMove.fromId,
      referenceMove.toId,
    ]);
    const moves = movesByRoute.get(route);
    if (moves === undefined) movesByRoute.set(route, [referenceMove]);
    else moves.push(referenceMove);
  }

  const mergeId = `pmg_${crypto.randomUUID().replaceAll("-", "")}`;
  const currentPerson = currentPlanPersonQuery(input.plan, input.mergedPersonId);
  const statements: D1PreparedStatement[] = [
    input.database.prepare(
      `insert into directory_merge (id, kept_person_id, merged_person_id, merged_by_user_id, reasons, merged_profile, created_at) values (?, (select id from person where id = ? and deleted_at is null), (${currentPerson.sql}), ?, ?, ?, ?)`,
    ).bind(
      mergeId,
      input.keptPersonId,
      ...currentPerson.bindings,
      input.mergedByUserId,
      JSON.stringify(input.reasons),
      JSON.stringify(input.mergedProfile),
      input.timestamp,
    ),
  ];
  for (const moves of movesByRoute.values()) {
    const first = moves[0]!;
    const location = referenceLocations[first.reference];
    for (const rows of chunkIds(moves)) {
      const placeholders = rows.map(() => "?").join(", ");
      statements.push(input.database.prepare(
        `update ${location.table} set ${location.ownerColumn} = ? where ${location.ownerColumn} = ? and ${location.rowColumn} in (${placeholders})`,
      ).bind(first.toId, first.fromId, ...rows.map((row) => row.rowId)));
    }
  }

  statements.push(
    input.database.prepare(
      "update person set deleted_at = ?, updated_at = ? where id = ? and deleted_at is null",
    ).bind(input.timestamp, input.timestamp, input.mergedPersonId),
  );
  try {
    await input.database.batch(statements);
  } catch (error) {
    if (!(await speakerMergePlanIsCurrent(input))) {
      throw new SpeakerMergePlanStaleError();
    }
    throw error;
  }
}
