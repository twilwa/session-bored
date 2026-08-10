# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- The product name is Greenroom; `session-bored` remains the repository and
  Cloudflare Worker name.
- `db/schema.ts` is the cross-lane database contract, and `shared/api.ts` is the
  cross-lane route contract. Coordinate before changing either contract.
- Use the commands and seeded credentials in `README.md`; browser tests migrate
  their local D1 database before starting the Worker.
- OpenSpec and Beads are suspended for this project. Do not create `openspec/`
  or `.beads/`; build directly against the authoritative PRD.
- Disposition uses `submission.status` as the live committee decision. Status
  changes are always silent. `decision_batch` and `decision_batch_item` freeze
  the reviewed preview, while the unique `decision_notice.submission_id` log
  makes queue dispatch once-only and exposes later status divergence. This lane
  queues records only; it does not claim email delivery.
- Accepting adopts each `submission_speaker.person_id` into the event-scoped
  `speaker` row, creates one `program_session` per `submission_id`, links the
  same speakers through `session_speaker`, and assigns the event's configured
  onboarding tasks. Names, emails, bios, job titles, organizations, roles,
  title, abstract, format, and track come from the submission graph without
  re-entry. The roster and portal must consume these rows rather than copy them.
- Un-accepting never deletes the created speaker, session, task, or assignment.
  It returns the session content to `draft`, preserves all schedule fields, and
  pauses session-scoped tasks. Re-accepting reuses the same stable IDs. Agenda
  and public lanes must gate on the live decision and content status.

## CI

Every pull request runs typechecking, unit tests, Workers integration tests, and
the production build in the `CI / Checks` job. Open the failed named step to see
which command failed. The integration test configuration applies checked-in D1
migrations to its isolated test database, so CI does not need a separate
migration step.

For same-repository pull requests, the `Preview` workflow updates one PR comment
with the branch's stable Workers preview URL. Each PR reuses its own
`session-bored-pr-<number>` D1 database across pushes; previews never bind the
production database. Forked pull requests skip deployment because GitHub does
not provide repository secrets to untrusted forks.

Preview deployment requires the `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` GitHub Actions secrets. The token must be able to upload
Workers versions and create, list, and migrate D1 databases.

## CFP submission contract

`submissions` is the record consumed by review and disposition. Its public CFP
lifecycle and relationships are fixed as follows:

- The first draft creates or adopts `people` by normalized email, creates the
  event-scoped `speakers` row, and links the author through both
  `submitterPersonId` and `submissionSpeakers`. `people.userId` stays nullable so
  a later account can claim the same identity without changing submission IDs.
- `formId` and `formVersion` freeze the form contract. `formatId`,
  `submissionTracks`, and `submissionValues` carry taxonomy and answers; built-in
  title, abstract, audience, and reviewer-note columns remain the list/detail
  projection.
- A `draft` may contain incomplete proposal fields. Server validation gates the
  `draft` to `submitted` transition; later review and disposition states use the
  canonical vocabulary in `db/schema.ts`.
- `titleAtTime` and `orgAtTime` are set on the first successful submission and
  never change during later edits.
- `submissionAuthorAccess` stores one hashed private author key per submission.
  Public edits require that key and remain writable only while the form window is
  open; reads remain available after close in a locked state.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
