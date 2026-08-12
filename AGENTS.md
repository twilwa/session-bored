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
  makes queue dispatch once-only and exposes later status divergence. Real
  delivery of those letters is filled in by `worker/email/decision-notices.ts`
  (see Communications below) without restructuring the dispatch route itself.
- Accepting adopts each `submission_speaker.person_id` into the event-scoped
  `speaker` row, creates one `program_session` per `submission_id`, links the
  same speakers through `session_speaker`, and assigns the event's configured
  onboarding tasks. Names, emails, bios, job titles, organizations, roles,
  title, abstract, format, and track come from the submission graph without
  re-entry. The roster and portal must consume these rows rather than copy them.
- A sessionless task with no `task_scope` row is an event-wide onboarding
  template assigned by later acceptances. Roster-created bulk tasks use the
  `selected_speakers` scope and must remain limited to their explicit assignees.
- Organizer task edits update the shared task for current and future assignees.
  Reassignment archives removed assignee links so restored speakers retain
  completion history, and a later acceptance restores an archived event-wide
  assignment. A task with any completed assignment cannot change kind. Removing
  a task archives it as complete; active work views ignore it while the portal's
  file history keeps its uploaded file versions discoverable and downloadable.
- Un-accepting never deletes the created speaker, session, task, or assignment.
  It returns the session content to `draft`, preserves all schedule fields, and
  pauses session-scoped tasks. Re-accepting reuses the same stable IDs. Agenda
  and public lanes must gate on the live decision and content status.
- The workspace page routes in `worker/index.ts` (`/organizer`, `/reviewer`,
  `/speaker`, `/submitter`) answer a refused caller in its own language through
  `requirePageAccess`: a document navigation (`Sec-Fetch-Dest`, else `Accept`)
  gets the branded page in `worker/access-page.ts`, everything else keeps the
  JSON error. Both carry the same 401 or 403, so never assert a page route's
  refusal by content type alone. `/login?returnTo=` is honoured only for
  same-origin paths inside the signer-in's own role area or `/submitter`.
- `worker/routes/review.ts` owns the F-4 review contract. It reads submissions
  through `submission`, `submission_track`, and `submission_speaker`; the CFP
  lane must preserve their stable IDs, event ID, title, abstract, status,
  submitter, track links, and speaker role labels.
- A reviewer's readable remit is the union of their event track responsibility
  and explicit per-submission assignments, limited to their per-round pool.
  Provisioning defaults to every event track and the first open round; an empty
  `trackIds` array means no tracks, never all of them.
  `PATCH /review/events/:eventId/reviewers/:reviewerUserId` replaces that remit
  in both directions, so narrowing takes effect on the reviewer's next read. It
  reports `retainedAssignments` because an explicit assignment still grants
  access outside the new track remit. The organizer config route lists a
  reviewer by track responsibility *or* round pool, so a reviewer narrowed to
  zero tracks stays visible and editable.
- Review scores remain in `review.scores`; `review.aggregate_score` is the
  weighted mean of numeric criteria, and the organizer worklist averages those
  review aggregates per submission. Submission comments are one attributed,
  timestamped thread at the stable submission permalink.
- `PATCH /api/review/submissions/:submissionId/status` changes only submission
  status and returns `notificationSent: false`. Disposition and communications
  code must keep status changes separate from deliberate decision dispatch.
- `worker/routes/agenda.ts` owns the F-9 scheduling contract. Publishing marks
  `program_session.published_at` only for approved, placed or `tbd` sessions
  whose submission is still accepted, or that were entered directly. Public
  program routes must also require that marker and the live decision before
  exposing schedule data. Organizers approve accepted session content from the
  agenda before publishing; approval locks speaker edits but never publishes by
  itself. Placement edits clear publication and the agenda tells the organizer
  to publish again. Publishing answers with `AgendaPublishResult`: it names
  every session it published and every one it skipped with the reasons why, so
  the organizer is never told only about its successes. `worker/public-queries.ts`
  is the only written form of the public read; route through it rather than
  growing another copy in the router.
- The organizer board (`client/pages/agenda/`) leads with the grid: a sticky
  command strip, day tabs, then the workbench. `board.ts` holds its pure
  helpers, and `predictDrop` there mirrors the server's room and speaker overlap
  rules so the drop ghost can warn *before* release; the server's `conflicts`
  array stays the only thing rendered as fact afterwards, so the two can never
  disagree. Placement never blocks: warn on the ghost, then offer Undo, which
  replays the previous placement through the same PATCH — publication stays
  cleared and the toast says so. Every placement verb lives on the card's `⋯`
  menu, and dragging a card into the inbox unplaces it. Chrome does not update
  `:hover` during a drag, so drop-target styling must key on
  `onDragEnter`/`onDragLeave` state, never `:hover`.
- `worker/routes/ai-review.ts` owns optional, event-scoped AI reading aids. Its
  caches live in `db/schema/ai-review.ts`; generated output never belongs in a
  human review, comment, decision, email, or notification. Blind and identified
  summaries have separate content-keyed cache entries. Generation requires an
  explicit reviewer request, and `worker/routes/review.ts` rejects an unchanged
  AI score starting point. The Worker secret is `ANTHROPIC_API_KEY`.

## CI

Every pull request runs typechecking, unit tests, Workers integration tests, and
the production build in the `CI / Checks` job. Chromium and WebKit browser tests
run in the parallel `CI / Browser tests` job, which uploads Playwright reports
and traces on failure. Open the failed named step to see which command failed.
The integration test configuration applies checked-in D1 migrations to its
isolated test database, so CI does not need a separate migration step.

For same-repository pull requests, the `Preview` workflow updates one PR comment
with the branch's stable Workers preview URL. Each PR reuses its own
`session-bored-pr-<number>` D1 database across pushes; previews never bind the
production database. Forked pull requests skip deployment because GitHub does
not provide repository secrets to untrusted forks.

Preview deployment requires the `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` GitHub Actions secrets. The token must be able to upload
Workers versions and create, list, and migrate D1 databases.

## Deployment

A push to `main` deploys Greenroom to production only after the `Checks` and
`Browser tests` jobs pass. The deployment applies pending production D1
migrations before it deploys the Worker, queues behind any active production
deployment, and verifies that the [production site](https://session-bored.techwilliams-warren.workers.dev)
returns a successful response. A green `CI / Deploy production` job confirms
that the full deployment sequence completed.

To roll back Worker code, select the last known-good version from
`npx wrangler versions list`, then run `npx wrangler rollback <version-id>`.
Database migrations remain applied, so confirm that the selected Worker version
is compatible with the current production schema.

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
- `forms` owns the stable public slug. A version's copy and field contract are
  immutable once published; editing a published or closed version forks the
  next draft version, and organizers may browse every version. Public reads
  resolve the current published version through the stable slug, while
  submission reads resolve their exact saved version.
- Draft submissions stay pinned to the version they started on. When a newer
  version exists, the author explicitly chooses between continuing the pinned
  draft or starting a separate draft on the current version; neither path
  migrates or discards saved answers.
- Submission validation evaluates conditional visibility on the server. Hidden
  answers are not persisted and hidden required fields do not block submission.
- The form's `track` field is its category-routing control. Submission writes
  resolve it to the event taxonomy in `submissionTracks`; review queues route
  through `reviewerTracks` and must not introduce a parallel routing model.
- A `draft` may contain incomplete proposal fields. Server validation gates the
  `draft` to `submitted` transition; later review and disposition states use the
  canonical vocabulary in `db/schema.ts`.
- `titleAtTime` and `orgAtTime` are set on the first successful submission and
  never change during later edits.
- `submissionAuthorAccess` stores one hashed private author key per submission.
  Public edits require that key and remain writable only while the form window is
  open; reads remain available after close in a locked state.
- Submitter accounts use Better Auth's `speaker` role. A submission created while
  signed in belongs to the account through `submission.submitterPersonId` and
  `person.userId`, receives no anonymous author key, and appears on the submitter
  dashboard with its live status. Dashboard access follows this person-to-user
  ownership link rather than the account's role. Existing anonymous people remain
  unlinked and cannot be claimed by email; their proposals stay accessible only
  through the private author key.

- The agenda (`/agenda`), itinerary (`/schedule`), and speaker gallery (`/gallery`)
  pages read through the same public sessions/speakers endpoints as `/program` and
  `/speakers` — no dedicated worker routes exist for them. `client/pages/public/shared.ts`
  is the single source for session/day/time formatting and for the agenda's
  time-row x room-column layout (`buildAgendaGrid`); extend it rather than
  formatting a session independently in a new component, or cross-surface
  consistency (title/time/room/track reading identically everywhere) breaks.
  `client/pages/public/ScheduleShared.tsx` holds the day-tab control and the
  session detail overlay shared by the agenda and itinerary.
- The shared `Modal` in `client/components/ui.tsx` caps height at `min(85vh, 680px)`
  with internal scroll; any modal with content that can grow long needs this, since
  the backdrop does not scroll on its own.

## Speaker portal contract

`worker/routes/portal.ts` (mounted under `/api`) and `client/pages/portal/PortalPage.tsx`
own F-7.x self-service. It reads and extends the M0 `GET /api/speaker/content`
endpoint rather than duplicating it; that endpoint's `profile` now also carries
`headshotUrl`, `twitter`, `linkedin`, and `socialLinks`, and it returns a new
`sessions` array (`editable` is false once `contentStatus` is `approved`) plus
enriched `tasks` (`taskType`, `instructions`, `acceptedFileTypes`,
`maximumFileBytes`, and a `file` summary when one has been uploaded).

- Uploads write through the existing `file`/`file_version` tables (R2 binding
  `FILES`) rather than a parallel model. `file.kind` (`headshot` | `deliverable`)
  distinguishes a speaker's one profile headshot (`taskId` null, served
  unauthenticated at `GET /api/public/portal/speakers/:speakerId/headshot`, and
  mirrored onto `people.headshotUrl`) from a task-scoped deliverable
  (`taskId` + `speakerId` locate the row). Re-uploading either kind adds a new
  `file_version` or flips `latest`; prior versions stay downloadable via
  `GET /api/portal/files/:fileId?version=N`, and each `files[].versions` entry in
  `GET /api/speaker/content` carries that link. `file.display_name` only tracks the
  newest upload, so a version's own filename comes from its storage key
  (`worker/storage/file-versions.ts`) for both the history list and the download's
  `Content-Disposition`.
- A speaker never sees `submission.status`. `GET /api/speaker/content` returns
  `speakerStatus` from `speakerFacingSubmissionStatus` in `shared/api.ts`, which
  reveals a decision only once it has been communicated - its `decision_notice`
  was dispatched, or the acceptance already produced the session the speaker is
  looking at - and reads as `in_review` otherwise. The submitter dashboard is the
  deliberate exception: it shows the live silent status by design and by test.
- Uploading to a `file_request` task marks that speaker's `task_assignee`
  row `completed` — this is the same row the organizer/roster side must read,
  so no separate completion signal exists. General tasks complete only through
  an explicit `PATCH /api/portal/tasks/:taskId`. As a convenience, saving a
  non-empty bio or uploading a headshot also completes any of the speaker's
  incomplete tasks whose title matches `/bio|profile/i` or `/headshot/i`; this
  is a title-pattern nicety, not something other code should depend on.
- Editing session title/abstract (`PATCH /api/portal/sessions/:sessionId`)
  requires speaker ownership via `session_speaker` and returns `409` once
  `program_session.content_status` is `approved`; editing a `draft` session
  bumps it to `in_review` for organizer review.
- Server-side upload limits default to 5MB/image types for headshots and
  25MB/office-doc types for deliverables (`worker/storage/files.ts`), overridden
  per task by `task.maximumFileBytes` / `task.acceptedFileTypes` when set.

## Communications

`worker/email.ts` is the provider-neutral sending boundary (`EmailMessage` in,
`EmailDeliveryResult` out). `resolveEmailDelivery(env)` picks the real
Resend-backed sender (`worker/email/resend.ts`) when `RESEND_API_KEY` and
`RESEND_FROM_ADDRESS` are set, and the visibly-unconfigured `emailDelivery`
stub otherwise - local dev, CI, and every test run stay in the unconfigured
state unless a `.dev.vars` opts in, so nothing here ever reaches the network
by accident. Every real attempt logs a structured line and, once attempted,
creates or finalizes one `email_dispatch` row per recipient
(`worker/email/send.ts#sendTrackedEmail`); a `provider_not_configured` result
creates nothing and leaves a queued draft unchanged, so unconfigured
environments stay silent. Every sending
function in `worker/email/*` takes an optional `delivery` parameter for this
reason - tests inject a fake one instead of touching the network.

- **Submission confirmation** (F-11.2) fires from `worker/routes/cfp.ts` only
  at the moment a submission's `submittedAt` is first set, and only when the
  submitter has an address - it never invents one.
- **Decision letters** (F-11.3) are sent by
  `worker/email/decision-notices.ts#dispatchDecisionNoticeEmails`, called from
  `worker/routes/disposition.ts`'s dispatch route against only the
  `decision_notice` rows it just newly inserted, so re-dispatching a batch
  never re-sends. A failed notice is retried per-recipient through
  `retryDecisionNotice`, exposed at
  `POST /api/events/:eventId/decision-notices/:submissionId/retry`. Every
  attempt goes through `sendTrackedEmail`, so a configured send also lands in
  the shared `email_dispatch` communications log alongside `decision_notice`.
- **Portal invitation / onboarding email** (F-6.6, F-11.4): call
  `sendPortalInvitationEmail({ env, eventId, speakerId })` from
  `worker/email/portal-invitation.ts`. It owns its own lookup and template
  rendering - the roster lane only needs an event ID and speaker ID, and must
  trigger it from a deliberate organizer action, never a status-change hook.
- **Reminders** (F-11.7) are drafted, never sent, by
  `worker/email/reminders.ts#draftOverdueTaskReminders` into `email_dispatch`
  rows with `status = 'draft'`. An organizer reviews, optionally edits
  (`PATCH /api/events/:eventId/email-dispatches/:id`), and only an explicit
  `POST .../:id/send` (`worker/email/dispatch-queue.ts#sendQueuedDispatch`)
  ever delivers one. Nothing drafts a second time for a speaker who already
  has an unsent draft.
- **Templates** (F-11.6) keep the three runtime-dependent built-ins read-only
  and store organizer-authored event copy in `communication_template`.
  `worker/email/templates.ts` resolves `{{field}}` values, supplies event and
  recipient identity on the server, rejects every unresolved field before
  queueing, and snapshots one personalized `email_dispatch` draft per selected
  event speaker. Preview and queue actions never send. Decision letters remain
  in `worker/routes/disposition.ts` and are not part of this registry.
- **Calendar invites** (F-11.8/F-11.9): `sessions.icsUid` is fixed at session
  creation from the session's durable ID and never changes; `sessions.icsSequence`
  bumps on every regenerate. `worker/email/calendar-invite.ts#sendSessionCalendarInvite`
  builds the `.ics` (`worker/email/ics.ts`, no video-meeting link, room
  included when known) and sends it - a deliberate action at
  `POST /api/events/:eventId/sessions/:sessionId/calendar-invite`, not
  triggered by scheduling itself.
- The one real, network-touching test is opt-in:
  `RUN_REAL_EMAIL_TEST=1 RESEND_API_KEY=... RESEND_FROM_ADDRESS=... npx vitest run tests/unit/email-live.test.ts`,
  sending to Resend's documented safe address `delivered@resend.dev`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
