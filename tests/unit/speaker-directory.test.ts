// ABOUTME: Exercises identity and filter rules for the private cross-event speaker directory.
// ABOUTME: Keeps weak matches separate while combining organizer filters deterministically.
import { describe, expect, it } from "vitest";
import {
  duplicateReasonsFor,
  filterSpeakerDirectory,
  indexPossibleDuplicates,
  possibleDuplicateGroups,
} from "../../worker/speaker-directory.ts";
import {
  planSpeakerMergeReferences,
  speakerMergeReferenceClasses,
} from "../../worker/speaker-merge.ts";

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

  it("answers the same reasons per pair as comparing that pair directly", () => {
    const directory = [
      priya,
      { ...priya, id: "psn_priya_copy", name: "P. Raman", organization: null },
      { ...priya, id: "psn_priya_northwind", email: "priya.raman@example.net", name: "  PRIYA  RAMAN " },
      { ...priya, id: "psn_other", email: "other@example.net", name: "Marcus Okafor", organization: "Contoso" },
      { ...priya, id: "psn_unstated", email: "unstated@example.net", name: "Ada Lovelace", organization: "  " },
      { ...priya, id: "psn_unstated_twin", email: "twin@example.net", name: "Ada Lovelace", organization: "" },
    ];
    const { reasonsByPersonId } = indexPossibleDuplicates(directory);
    for (const person of directory) {
      for (const other of directory) {
        expect(reasonsByPersonId.get(person.id)?.get(other.id) ?? [])
          .toEqual(duplicateReasonsFor(person, other));
      }
    }
  });

  it("keeps a name and organization apart from the same words split differently", () => {
    const groups = possibleDuplicateGroups([
      { id: "psn_first", name: "Ana Lee", email: "ana@example.com", organization: "Corp" },
      { id: "psn_second", name: "Ana", email: "ana.lee@example.net", organization: "Lee Corp" },
    ]);
    expect(groups).toEqual([]);
  });
});

describe("speaker directory filters", () => {
  it("combines tags and custom fields before sorting and pagination", () => {
    const filtered = filterSpeakerDirectory([
      {
        id: "psn_ada",
        name: "Ada Lovelace",
        email: "ada@example.com",
        organization: "Analytical Engines",
        jobTitle: "Founder",
        events: ["Compute Summit"],
        tags: ["Keynote", "AI"],
        customFields: { Region: "EMEA", Language: "English" },
        eventCount: 2,
        updatedAt: "2026-08-15T12:00:00.000Z",
      },
      {
        id: "psn_grace",
        name: "Grace Hopper",
        email: "grace@example.com",
        organization: "US Navy",
        jobTitle: "Rear admiral",
        events: ["Compiler Week"],
        tags: ["Keynote"],
        customFields: { Region: "North America", Language: "English" },
        eventCount: 3,
        updatedAt: "2026-08-15T13:00:00.000Z",
      },
      {
        id: "psn_margaret",
        name: "Margaret Hamilton",
        email: "margaret@example.com",
        organization: "NASA",
        jobTitle: "Director",
        events: ["Compute Summit"],
        tags: ["Keynote"],
        customFields: { Region: "EMEA", Language: "English" },
        eventCount: 1,
        updatedAt: "2026-08-15T14:00:00.000Z",
      },
    ], {
      search: "",
      tags: ["keynote"],
      customFields: [{ name: "region", value: "emea" }],
      sort: "name",
      direction: "desc",
      page: 1,
      pageSize: 1,
    });

    expect(filtered.total).toBe(2);
    expect(filtered.pageCount).toBe(2);
    expect(filtered.items.map((person) => person.id)).toEqual(["psn_margaret"]);
  });
});

describe("speaker merge ownership", () => {
  it("plans only identity-reference moves and retains colliding decisions", () => {
    expect(speakerMergeReferenceClasses).toMatchObject({
      "submission.submitter_person_id": "identity_reference",
      "submission_speaker.person_id": "identity_reference",
      "speaker.person_id": "identity_reference",
      "session_speaker.speaker_id": "identity_reference",
      "task_assignee.speaker_id": "identity_reference",
      "file.speaker_id": "identity_reference",
      "person.user_id": "credential",
      "speaker.status": "decision",
      "speaker.deleted_at": "decision",
      "session_speaker.publication_hold_at": "decision",
      "task_assignee.granted_by_session_id": "decision",
      "decision_notice.recipient": "communication",
    });

    const plan = planSpeakerMergeReferences({
      keptPersonId: "psn_kept",
      mergedPersonId: "psn_merged",
      submissions: [{ id: "sub_owned", personId: "psn_merged" }],
      submissionSpeakers: [
        { id: "sspk_move", submissionId: "sub_move", personId: "psn_merged" },
        { id: "sspk_kept", submissionId: "sub_collision", personId: "psn_kept" },
        { id: "sspk_retained", submissionId: "sub_collision", personId: "psn_merged" },
      ],
      speakers: [
        { id: "spk_kept", eventId: "evt_collision", personId: "psn_kept", status: "ready", deletedAt: null },
        { id: "spk_move", eventId: "evt_move", personId: "psn_merged", status: "ready", deletedAt: null },
        { id: "spk_retained", eventId: "evt_collision", personId: "psn_merged", status: "ready", deletedAt: null },
      ],
      sessionSpeakers: [
        { id: "ssnr_kept", sessionId: "ses_collision", speakerId: "spk_kept", roleLabel: "speaker", sortOrder: 0, publicationHoldAt: null, deletedAt: null },
        { id: "ssnr_retained", sessionId: "ses_collision", speakerId: "spk_retained", roleLabel: "speaker", sortOrder: 0, publicationHoldAt: null, deletedAt: null },
        { id: "ssnr_move", sessionId: "ses_move", speakerId: "spk_retained", roleLabel: "speaker", sortOrder: 0, publicationHoldAt: null, deletedAt: null },
      ],
      taskAssignees: [
        { id: "tassn_kept", taskId: "tsk_collision", speakerId: "spk_kept" },
        { id: "tassn_retained", taskId: "tsk_collision", speakerId: "spk_retained" },
        { id: "tassn_move", taskId: "tsk_move", speakerId: "spk_retained" },
      ],
      files: [
        { id: "fil_kept", taskId: "tsk_file_collision", speakerId: "spk_kept", deletedAt: null },
        { id: "fil_retained", taskId: "tsk_file_collision", speakerId: "spk_retained", deletedAt: null },
        { id: "fil_move", taskId: "tsk_file_move", speakerId: "spk_retained", deletedAt: null },
      ],
      contactTags: [
        { personId: "psn_kept", tagId: "dtag_collision" },
        { personId: "psn_merged", tagId: "dtag_collision" },
        { personId: "psn_merged", tagId: "dtag_move" },
      ],
      customFields: [
        { id: "dcf_kept", personId: "psn_kept", normalizedName: "region" },
        { id: "dcf_retained", personId: "psn_merged", normalizedName: "region" },
        { id: "dcf_move", personId: "psn_merged", normalizedName: "audience" },
      ],
      notes: [{ id: "dnote_move", personId: "psn_merged" }],
    });

    expect(plan.moves).toEqual([
      { reference: "submission", rowId: "sub_owned", fromId: "psn_merged", toId: "psn_kept" },
      { reference: "submission_speaker", rowId: "sspk_move", fromId: "psn_merged", toId: "psn_kept" },
      { reference: "speaker", rowId: "spk_move", fromId: "psn_merged", toId: "psn_kept" },
      { reference: "session_speaker", rowId: "ssnr_move", fromId: "spk_retained", toId: "spk_kept" },
      { reference: "task_assignee", rowId: "tassn_move", fromId: "spk_retained", toId: "spk_kept" },
      { reference: "file", rowId: "fil_move", fromId: "spk_retained", toId: "spk_kept" },
      { reference: "speaker_directory_contact_tag", rowId: "dtag_move", fromId: "psn_merged", toId: "psn_kept" },
      { reference: "speaker_directory_custom_field", rowId: "dcf_move", fromId: "psn_merged", toId: "psn_kept" },
      { reference: "speaker_directory_note", rowId: "dnote_move", fromId: "psn_merged", toId: "psn_kept" },
    ]);
    expect(plan.retained).toEqual([
      { reference: "submission_speaker", rowId: "sspk_retained", reason: "target_reference_exists" },
      { reference: "speaker", rowId: "spk_retained", reason: "target_reference_exists" },
      { reference: "session_speaker", rowId: "ssnr_retained", reason: "target_reference_exists" },
      { reference: "task_assignee", rowId: "tassn_retained", reason: "target_reference_exists" },
      { reference: "file", rowId: "fil_retained", reason: "target_reference_exists" },
      { reference: "speaker_directory_contact_tag", rowId: "dtag_collision", reason: "target_reference_exists" },
      { reference: "speaker_directory_custom_field", rowId: "dcf_retained", reason: "target_reference_exists" },
    ]);
    expect(plan.conflicts).toEqual([]);
  });
});
