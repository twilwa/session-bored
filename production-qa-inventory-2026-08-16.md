# Production QA artifact inventory — 2026-08-16

Inventory source: authenticated, read-only production API responses from
`https://session-bored.techwilliams-warren.workers.dev` before any production
write. No production record had been changed when this report was written.

## Definite artifacts

### `person` — `psn_c9ce6a59e1c54d9f937296c5841f95a1`

```json
{
  "id": "psn_c9ce6a59e1c54d9f937296c5841f95a1",
  "name": "QA Journey Tester",
  "email": "qa-journey-2026@example.com",
  "jobTitle": "QA Engineer",
  "organization": "Firstmate QA",
  "bio": "QA Journey Tester is a synthetic identity used for end-to-end verification of Greenroom.",
  "headshotUrl": null,
  "twitter": null,
  "linkedin": null,
  "socialLinks": null,
  "updatedAt": "2026-08-10T23:43:08.394Z"
}
```

Linked roster record, which must retain its status and relationship:

```json
{
  "table": "speaker",
  "id": "spk_b201aa8616034bc3a8ea127b4d7017a3",
  "personId": "psn_c9ce6a59e1c54d9f937296c5841f95a1",
  "status": "invited"
}
```

### `person` — `psn_e37d449549034f4a9c0b4c0cac70c4d5`

```json
{
  "id": "psn_e37d449549034f4a9c0b4c0cac70c4d5",
  "name": "Warren Williams (QA send target)",
  "email": "techwilliams.warren@gmail.com",
  "jobTitle": null,
  "organization": null,
  "bio": null,
  "headshotUrl": null,
  "twitter": null,
  "linkedin": null,
  "socialLinks": null,
  "updatedAt": "2026-08-11T05:13:10.953Z"
}
```

Linked roster record, which must retain its status and relationship:

```json
{
  "table": "speaker",
  "id": "spk_432ad5572a984cbc9ed4c36802e5a202",
  "personId": "psn_e37d449549034f4a9c0b4c0cac70c4d5",
  "status": "withdrawn"
}
```

### `person` — `psn_priya_raman`

The profile is legitimate demo content, but its final bio token is an obvious
QA marker.

```json
{
  "id": "psn_priya_raman",
  "name": "Priya Raman",
  "email": "sbek-speaker@example.com",
  "jobTitle": "Principal Engineer",
  "organization": "Latticework Systems",
  "bio": "Priya Raman is a Principal Engineer at Latticework Systems where she leads the build-tooling platform team. She previously maintained the open-source task runner 'gantry' and has spoken at over a dozen developer conferences on build systems, CI reliability, and developer productivity metrics. SBEK-PORTAL-BIO-01",
  "headshotUrl": "/api/public/portal/speakers/spk_priya_devflow_2027/headshot?version=1",
  "twitter": "@priyabuilds",
  "linkedin": "https://www.linkedin.com/in/priya-raman-example",
  "socialLinks": {
    "twitter": "@priyabuilds",
    "linkedin": "https://www.linkedin.com/in/priya-raman-example"
  },
  "updatedAt": "2026-08-15T06:03:27.079Z"
}
```

Linked roster record, which must retain its status and relationship:

```json
{
  "table": "speaker",
  "id": "spk_priya_devflow_2027",
  "personId": "psn_priya_raman",
  "status": "confirmed"
}
```

### `task` — `tsk_b40c043fc5874c688f8fc2532d300792`

```json
{
  "id": "tsk_b40c043fc5874c688f8fc2532d300792",
  "eventId": "evt_devflow_conf_2027",
  "sessionId": null,
  "taskType": "file_request",
  "title": "test",
  "instructions": "testing",
  "dueAt": "2026-08-13T23:59:59.000Z",
  "status": "active",
  "acceptedFileTypes": null,
  "maximumFileBytes": null,
  "createdAt": "2026-08-10T22:43:19.012Z",
  "updatedAt": "2026-08-10T22:43:19.012Z",
  "deletedAt": null,
  "assignees": [
    {
      "id": "tassn_aa293cdc20e74169bca9a264c649c689",
      "taskId": "tsk_b40c043fc5874c688f8fc2532d300792",
      "speakerId": "spk_marcus_devflow_2027",
      "speakerName": "Marcus Okafor",
      "status": "assigned"
    }
  ]
}
```

### `submission` — `sub_a7c97c952923478d85e88457290f9fa9`

```json
{
  "id": "sub_a7c97c952923478d85e88457290f9fa9",
  "eventId": "evt_devflow_conf_2027",
  "formId": "frm_devflow_cfp_2027",
  "formVersion": 1,
  "submitterPersonId": "psn_c9ce6a59e1c54d9f937296c5841f95a1",
  "formatId": "fmt_workshop_120",
  "status": "declined",
  "isDraft": false,
  "title": "QA TEST — Debugging the seams between features",
  "abstract": "QA test abstract typed by keyboard on 2026-08-10 to verify persistence of the abstract field.",
  "titleAtTime": "QA Engineer",
  "orgAtTime": "Firstmate QA",
  "audienceLevel": null,
  "notesForReviewers": null,
  "submittedAt": "2026-08-10T23:43:08.451Z",
  "createdAt": "2026-08-10T23:41:48.179Z",
  "updatedAt": "2026-08-11T05:03:47.273Z",
  "deletedAt": null
}
```

### `program_session` — `ses_d4c3f53d60684086bbb96439af0f90d7`

The agenda correctly omits the retained session because its linked submission
is declined. Direct D1 inventory exposed the complete row verbatim:

```json
{
  "id": "ses_d4c3f53d60684086bbb96439af0f90d7",
  "event_id": "evt_devflow_conf_2027",
  "submission_id": "sub_a7c97c952923478d85e88457290f9fa9",
  "track_id": "trk_developer_experience",
  "format_id": "fmt_workshop_120",
  "room_id": "rm_main_stage",
  "title": "QA TEST — Debugging the seams between features",
  "abstract": "QA test abstract typed by keyboard on 2026-08-10 to verify persistence of the abstract field.",
  "content_status": "draft",
  "schedule_status": "placed",
  "scheduled_date": "2027-05-12",
  "starts_at": 1810141200000,
  "ends_at": 1810148400000,
  "direct_entry": 0,
  "ics_uid": "sub_a7c97c952923478d85e88457290f9fa9@greenroom",
  "published_at": 1786424041423,
  "created_at": 1786405832474,
  "updated_at": 1786424627203,
  "deleted_at": null,
  "ics_sequence": 0,
  "approved_content": null
}
```

### `user` — `K2ur98gpsVely8wx9btv5onb90jhR4hq`

```json
{
  "id": "K2ur98gpsVely8wx9btv5onb90jhR4hq",
  "name": "test",
  "email": "test@teest.com",
  "email_verified": 0,
  "image": null,
  "role": "reviewer",
  "created_at": 1786403121775,
  "updated_at": 1786403121987,
  "signInMethods": [
    "password"
  ],
  "evidence": {
    "kind": "none",
    "programmedSessions": 0,
    "proposals": 0
  },
  "grants": [
    {
      "role": "reviewer",
      "source": "backfill",
      "note": "Carried over from the role this account already held.",
      "grantedAt": "2026-08-12T23:47:46.000Z",
      "grantedByName": null
    }
  ]
}
```

The live authorization relationship is recorded separately and will not be
changed:

```json
{
  "table": "role_grant",
  "id": "rgrant_b7a30af0a405c01255b86a1f0ae435ff",
  "user_id": "K2ur98gpsVely8wx9btv5onb90jhR4hq",
  "role": "reviewer",
  "source": "backfill",
  "granted_by_user_id": null,
  "granted_at": 1786578466000,
  "note": "Carried over from the role this account already held.",
  "revoked_at": null,
  "revoked_by_user_id": null,
  "created_at": 1786578466000,
  "updated_at": 1786578466000
}
```

## Before/after plan frozen before production write

Only the columns shown below will change. Primary keys, foreign keys, status,
publication, scheduling, assignment, authorization, visibility, timestamps, and
soft-deletion fields will remain byte-for-byte unchanged.

| Table | Primary key | Before | After |
| --- | --- | --- | --- |
| `person` | `psn_c9ce6a59e1c54d9f937296c5841f95a1` | name: `QA Journey Tester`<br>email: `qa-journey-2026@example.com`<br>job_title: `QA Engineer`<br>organization: `Firstmate QA`<br>bio: `QA Journey Tester is a synthetic identity used for end-to-end verification of Greenroom.` | name: `Elena Marquez`<br>email: `elena.marquez@example.com`<br>job_title: `Staff Site Reliability Engineer`<br>organization: `Solstice Systems`<br>bio: `Elena Marquez is a Staff Site Reliability Engineer at Solstice Systems, where she helps platform teams make delivery pipelines observable and dependable.` |
| `person` | `psn_e37d449549034f4a9c0b4c0cac70c4d5` | name: `Warren Williams (QA send target)`<br>email: `techwilliams.warren@gmail.com`<br>job_title: `null`<br>organization: `null`<br>bio: `null` | name: `Warren Williams`<br>email: `warren.williams@example.com`<br>job_title: `Engineering Manager`<br>organization: `Northstar Labs`<br>bio: `Warren Williams is an Engineering Manager at Northstar Labs, where he helps teams build reliable developer platforms and sustainable delivery practices.` |
| `person` | `psn_priya_raman` | bio: `Priya Raman is a Principal Engineer at Latticework Systems where she leads the build-tooling platform team. She previously maintained the open-source task runner 'gantry' and has spoken at over a dozen developer conferences on build systems, CI reliability, and developer productivity metrics. SBEK-PORTAL-BIO-01` | bio: `Priya Raman is a Principal Engineer at Latticework Systems where she leads the build-tooling platform team. She previously maintained the open-source task runner 'gantry' and has spoken at over a dozen developer conferences on build systems, CI reliability, and developer productivity metrics.` |
| `task` | `tsk_b40c043fc5874c688f8fc2532d300792` | title: `test`<br>instructions: `testing` | title: `Upload accessibility review notes`<br>instructions: `Share the completed accessibility review notes as a PDF.` |
| `submission` | `sub_a7c97c952923478d85e88457290f9fa9` | title: `QA TEST — Debugging the seams between features`<br>abstract: `QA test abstract typed by keyboard on 2026-08-10 to verify persistence of the abstract field.`<br>title_at_time: `QA Engineer`<br>org_at_time: `Firstmate QA` | title: `Debugging the Seams Between Platform Services`<br>abstract: `A hands-on workshop for tracing failures across service boundaries. Attendees will practice validating contracts, correlating telemetry, and turning intermittent incidents into reproducible cases.`<br>title_at_time: `Staff Site Reliability Engineer`<br>org_at_time: `Solstice Systems` |
| `program_session` | `ses_d4c3f53d60684086bbb96439af0f90d7` | title: `QA TEST — Debugging the seams between features`<br>abstract: `QA test abstract typed by keyboard on 2026-08-10 to verify persistence of the abstract field.` | title: `Debugging the Seams Between Platform Services`<br>abstract: `A hands-on workshop for tracing failures across service boundaries. Attendees will practice validating contracts, correlating telemetry, and turning intermittent incidents into reproducible cases.` |
| `user` | `K2ur98gpsVely8wx9btv5onb90jhR4hq` | name: `test`<br>email: `test@teest.com` | name: `Avery Chen`<br>email: `avery.chen@example.com` |

## Ambiguous records left untouched

- `submission.sub_5cf9fa60d1604f1ca593dd4ff747b161` and its session
  `program_session.ses_c004a8c3611c4590a95a55d8559d0d9e` were created during
  the grader window, but their title and abstract are plausible conference demo
  content and contain no test marker. They are not safe to classify as QA data.
- `submission.sub_4fdade796a2a43a4b4d74d2a7c9e8b8b` was created during the
  grader window and duplicates a plausible seeded title, but it contains no
  test marker. It is not safe to classify as QA data.
- Legitimate session abstracts containing the ordinary English word `tests`
  are not QA artifacts.

## Source search

AST searches found no seed, fixture, or helper that creates these production
records. `qa-journey-2026@example.com` appears only as a reserved-domain email
example in email guard tests; those tests do not create seed or production data.
No source occurrence was found for either fake roster name, the fake account,
the QA submission/session title, the `testing` task description, or the
`SBEK-PORTAL-BIO-01` marker.

## Production write authority

The captain confirmed direct, rename-only D1 authority. A final read-only scan
of every production `person`, `user`, `task`, `program_session`, and `submission`
row found no additional unambiguous artifact. Proposed replacement emails were
also confirmed unused before the write.

## Applied and verified

Every guarded production `UPDATE` matched and returned exactly one row. A
direct D1 re-read then confirmed the after-state in the table above and returned
zero rows for all original markers.

The control rows were re-read after the update and remained unchanged:

- `speaker.spk_b201aa8616034bc3a8ea127b4d7017a3` still links the renamed
  `person` to `evt_devflow_conf_2027` with status `invited`.
- `speaker.spk_432ad5572a984cbc9ed4c36802e5a202` still links Warren Williams
  to the same event with status `withdrawn`.
- `speaker.spk_priya_devflow_2027` remains `confirmed` with its custom fields
  unchanged.
- `task_assignee.tassn_aa293cdc20e74169bca9a264c649c689` remains assigned to
  `spk_marcus_devflow_2027`; its status, timestamps, deletion state, and
  provenance are unchanged.
- `role_grant.rgrant_b7a30af0a405c01255b86a1f0ae435ff` remains the same live
  reviewer grant for `user.K2ur98gpsVely8wx9btv5onb90jhR4hq`.
- The declined proposal remains `declined`; the retained session remains
  `draft`, `placed`, and carries its original publication and schedule values.

Authenticated production browser verification confirmed:

- `/organizer/roster` renders Elena Marquez and Warren Williams normally at
  both desktop and phone width, with their original `invited` and `withdrawn`
  workflow statuses.
- `/organizer/roster/tasks` renders **Upload accessibility review notes** and
  its description; `test` and `testing` are absent.
- `/organizer/people` renders Avery Chen with the existing reviewer grant;
  the fake name and email are absent.
- `/organizer/directory` renders Elena Marquez and Warren Williams, and Elena's
  detail renders **Debugging the Seams Between Platform Services** with no QA
  title, synthetic-identity copy, or Firstmate QA marker.
