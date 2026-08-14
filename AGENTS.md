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
  the reviewed preview, while the `decision_notice.submission_id` log makes
  queue dispatch once-only and exposes later status divergence. That uniqueness
  is partial (`where cancelled_at is null`), so it constrains the *live* letter:
  one per submission. Real delivery of those letters is filled in by
  `worker/email/decision-notices.ts` (see Communications below) without
  restructuring the dispatch route itself.
- **A queued letter is never edited; it is cancelled and replaced.**
  `worker/email/decision-notices.ts#cancelDecisionNotice` retires a letter that
  has not reached anyone, and the replacement is an ordinary new batch the
  organizer reviews and dispatches, so the approval a letter carries always
  describes the letter that was sent. What a cancellation may correct is the
  *person's* address - the same field the roster edits - never the frozen letter.
  A cancelled letter keeps its recipient, outcome, and copy, stays in the
  Communications log marked `cancelled` with who retired it and why, and is
  refused by every send door. Readers of `decision_notice` outside that write
  path filter `cancelled_at`, or a retired letter keeps counting:
  `worker/routes/disposition.ts` would list a submission once per letter it ever
  had, and dispatch would send one nobody stands behind.
- **Cancelling opens three windows in which the approved letter and the sent
  letter could differ. All three are closed, and must stay closed** - that
  difference is the exact thing cancel-and-replace exists to prevent.
  - *A send in flight.* `delivery_status = 'sending'` is a claim taken
    atomically before the provider call and released by its outcome, so a send
    and a cancellation resolve to one winner instead of both proceeding.
    Cancelling a claimed letter is refused. A claim older than
    `staleSendClaimMs` is treated as abandoned and may be retaken, because a
    Worker that dies mid-send would otherwise strand the letter forever.
    A send also conditions its final write on the `sending_claim_token` it took,
    so an attempt that outran its lease cannot restate itself over whoever
    legitimately took the letter over. It answers `delivery_unconfirmed`;
    `email_dispatch` remains the durable account of what reached the provider.
  - *A stale page.* Both per-letter doors take a **required** notice id -
    `retryDecisionNotice` and `cancelDecisionNotice` - and refuse when it is not
    the live letter. Required, not optional: an opt-in guard silently falls back
    to submission-scoped selection for any caller that forgets, and sending or
    retiring a letter nobody reviewed is the fault this exists to stop.
  - *A stale preview.* Cancelling stamps `decision_batch_item.superseded_at` on
    every outstanding item for that submission, and dispatch **claims** items
    with a conditional update that returns what it won, rather than filtering
    rows it read a moment earlier. A cancellation landing inside that gap would
    otherwise leave the filter holding a pre-cancellation row while the released
    partial index let the insert through.
- Accepting adopts each `submission_speaker.person_id` into the event-scoped
  `speaker` row, creates one `program_session` per `submission_id`, links the
  same speakers through `session_speaker`, and assigns the event's configured
  onboarding tasks. Names, emails, bios, job titles, organizations, roles,
  title, abstract, format, and track come from the submission graph without
  re-entry. The roster and portal must consume these rows rather than copy them.
- A proposal names as many participants as it has. `submission_speaker` is the
  one list: the CFP write path rewrites it from the author's `collaborators`
  input, and organizers amend the same rows through `worker/routes/participants.ts`.
  Removal archives the link so a restored participant keeps their row and their
  completion history, and archived means gone: every reader of `submission_speaker`
  and `session_speaker` outside those two write paths filters `deleted_at`, or a
  removed participant keeps the access, the committee listing, and the agenda
  lineup that removal claims to take away. Join through
  `worker/speaker-access.ts` in the speaker lane rather than restating it.
  `worker/submission-decision.ts#carryParticipantIntoSession` is the single
  participant handoff — acceptance runs it per participant, and a late organizer
  addition runs it once — so it also promotes an `invited` speaker to
  `onboarding`. Without that promotion the CFP author, who already had an
  `invited` row from their first draft, is the one name missing from the roster's
  onboarding work and from every public surface. `releaseParticipantFromSession`
  beside it is its exact inverse: both removal doors call it, and it archives the
  session link plus the onboarding work the handoff created. Those two kinds of
  work part company here. Work scoped to the session (`task.session_id`) goes back
  on **every** removal, because a later removal only ever looks at its own session
  and would strand work from a session left earlier; the event's sessionless,
  unscoped onboarding templates belong to the person, so an assignment goes back
  only once they speak nowhere else at the event — which is the only thing the
  release's `speaksElsewhereAtEvent` decides — **and** only if a handoff is what
  created it. `task_assignee.granted_by_session_id` records that: the handoff
  stamps it when it inserts a row and never when it restores one, so work the
  person already owed the event, or that an organizer handed them from the roster
  (which clears the stamp when it restores an assignment), survives a removal
  intact. Without that, the smallest correction round-trip — name somebody, unname
  them — emptied their whole event checklist (issue #148). The event `speaker` row — which drives the
  public speaker directory, the roster row, and mail eligibility — deliberately
  stands after removal (issue #127, settled: no automatic withdrawal). What removal owes
  instead is candour: the DELETE answers with `ParticipantRemovalOutcome`, and
  the panel says the person remains an event speaker and points at the roster,
  which owns withdrawal. That outcome reads the person's standing from the event
  after the removal rather than from the release result, because a proposal with
  no session still has to report the programme its participant speaks on
  elsewhere. The
  notice names the access the person actually held: the outcome carries
  `heldSessionAccess`, read from the live `session_speaker` row *before* removal
  archives it, and the payload carries `sessionContentStatus` beside `sessionId`.
  The release also returns the exact live task assignments it archived; the
  organizer outcome carries their IDs and titles as `withdrawnOnboarding`, and
  the same notice names every one. The author-side CFP edit uses the release but
  sends no notice or mail.
  A proposal is read-only to a named participant; naming somebody on an accepted
  proposal through the CFP edit never carries them onto its session, so a session
  the person never reached was never theirs to lose; and an `approved` session is
  read-only to the speakers who are on it.
  `PUBLIC_SPEAKER_STATUSES` in `worker/public-queries.ts`
  is the one rule for whether an event speaker is publicly listed, and the
  outcome's `listedPublicly` reads it; read it rather than restating the
  statuses. A collaborator is named, not
  admitted: naming somebody mints no author key, grants no dashboard, and never
  overwrites the profile an existing person already has.
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
- `worker/page-routes.ts#protectedPageRoutes` is the one table of gated
  workspace pages (`/organizer`, `/reviewer`, `/speaker`, `/submitter`);
  `worker/index.ts` mounts each entry and its subtree. A page in that table must
  also appear, root and `/*`, in `assets.run_worker_first` in `wrangler.jsonc`,
  or assets serve it before the Worker and its gate never runs (issue #151);
  `tests/unit/workspace-page-registration.test.ts` enforces the parity. The
  routes answer a refused caller in its own language through
  `requirePageAccess`: a document navigation (`Sec-Fetch-Dest`, else `Accept`)
  gets the branded page in `worker/access-page.ts`, everything else keeps the
  JSON error. Both carry the same 401 or 403, so never assert a page route's
  refusal by content type alone. `/login?returnTo=` is honoured only for
  same-origin paths inside an area opened by the signer-in's full live grant
  union or `/submitter`.
- `worker/routes/review.ts` owns the F-4 review contract. It reads submissions
  through `submission`, `submission_track`, and `submission_speaker`; the CFP
  lane must preserve their stable IDs, event ID, title, abstract, status,
  submitter, track links, and speaker role labels.
- A reviewer's readable remit is the union of their event track responsibility
  and explicit per-submission assignments, limited to their per-round pool.
  Both doors into the committee - direct provisioning in `worker/routes/review.ts`
  and an invitation in `worker/routes/people.ts` - resolve the same default when
  the organizer names no remit: every event track and the first open round, and
  no open round refuses with `open_round_required`. An *explicitly* empty
  `trackIds` array means no tracks, never all of them. An invitation stores the
  resolved ids, so redemption opens a queue with work in it.
  `PATCH /review/events/:eventId/reviewers/:reviewerUserId` replaces that remit
  in both directions, so narrowing takes effect on the reviewer's next read. It
  reports `retainedAssignments` because an explicit assignment still grants
  access outside the new track remit — but never a recused one, which grants
  nothing to retain: those answer separately as `recusedAssignments`, read from
  the recused `review_assignment` rows themselves like the worklist and card
  (never `reviewerQueue`), so a remit narrowed to nothing still reports the
  recusals it preserves. `client/pages/review/reviewer-remit-copy.ts` writes
  the removed, retained, and recused outcomes into the organizer's
  confirmation message. The organizer config route lists a
  reviewer by track responsibility, round pool, **or a live reviewer
  `role_grant`** (`listAccountsHoldingRole` in `worker/roles.ts`), so a reviewer
  narrowed to zero tracks — and one granted from People, which resolves no remit
  at all — stays visible and editable. That third door is deliberately not given
  a default remit: the grant is platform-wide (#120) and the default is
  event-scoped, so refusing or guessing an event would make a role grant hostage
  to one event's rounds. Committee setup completes it instead, and its card says
  the reviewer is in no review round while their round pool is empty, because a
  queue is built from that pool and tracks alone earn nothing (issue #147).
- `POST /api/review/submissions/:submissionId/recusal` is the reviewer's own action
  and the only writer of `review_assignment.status = 'recused'`. It keeps the same
  assignment row, creating one first if the proposal was readable through track
  remit alone, and creates nothing else - no review, score, decision, email, or
  notification, and no submission status change. It refuses once a review exists,
  and the score route refuses a recused assignment. Recused work leaves the
  reviewer's actionable queue and the organizer's `assignedCount`, and is reported
  separately as `recusedCount`. Because it produces no rating, the organizer's
  coverage worklist carries `recusedBy` and the row says so — a recused proposal
  must never read as one nobody has opened — and each reviewer card's count links
  to the proposals it stands for (`recusals`). A recusal belongs to a round, so
  `recusedCount` and `recusals` stay per assignment and each entry names its round;
  the worklist row speaks about the proposal, so `recusedBy` names each reviewer
  account once — deduplicated on `reviewer_user_id`, never on the display name,
  because two accounts may share one — while `recusedAssignments` beside it counts
  the reads that are not coming and so is not `recusedBy.length`. That pair is
  written into one sentence by `client/pages/review/worklist-copy.ts`. Both
  surfaces read the recused `review_assignment` rows
  themselves, never `reviewerQueue`, which inner-joins `reviewer_round_pool`: a
  recusal is a settled fact about an assignment, so taking the reviewer out of the
  round must not make the read that is not coming disappear from their card.
  Surfacing the fact is the whole feature: no reassignment prompt, no queue,
  nothing sent (issue #130).
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

## Accounts and access

`role_grant` decides what an account may reach, and **an account with no live
grant is an attendee** - `attendee` is never a stored value. `worker/roles.ts`
is the only reader, `grantRole` and `revokeRole` are the only writers, and
revoking sets `revoked_at` rather than deleting, so who decided what survives.
**What an account may reach is the union of its live grants, never one of
them.** `resolveGrantedRoles` answers that union, widest first
(organizer > reviewer > speaker), and `prepareRequest` puts it in the `roles`
context variable - **the only role state a request carries.** There is
deliberately no single-role context variable beside it: one existed, half the
gates were migrated off it and half were not, and the half left behind refused
callers that carried only the union. Every gate, in a route file or a
middleware, asks `holdsAccess` in `worker/access.ts`, so granting a second area
really opens it and no role implies another. Where a handler branches on *how
much* a caller may see - unscoped versus own-remit, identified versus blind -
branch on `holdsAccess(roles, "organizer")`, never on which role happens to be
widest. `describingRole` names the union's first entry for screens and for the
landing area; it decides nothing, and a gate must never call it. `GET /api/session`
carries both - the whole union as `roles`, the describing one as `role` - and the
union is what the signed-in header reads: `switchableAreasFor` in `client/lib.tsx`
maps it through `roleAreas` for the area switcher on `PublicHeader` and the
submitter dashboard, so a new area appears everywhere by gaining a `roleAreas`
entry and nothing else. That client copy still decides nothing; `worker/page-routes.ts`
and `holdsAccess` remain the gate. A harness that
mounts routes with an injected caller sets `roles` and nothing else -
`tests/integration/account-access.test.ts` mounts the review routes that way on
purpose, so a handler that reads anything else fails there. Never read
`user.role`: it keeps its original three-value CHECK
because D1 refuses the rebuild that changing it needs (`user` has ten inbound
foreign keys and does not honour `PRAGMA foreign_keys=OFF`), and Better Auth no
longer projects it into the session at all.

- Sign-up is a public front door at `/signup`, and it writes no grant. That is
  the whole guarantee: no self-service path can yield more than an attendee,
  because no self-service path touches `role_grant`. An attendee lands on
  `/schedule/mine`, keeps `/submitter` (gated on `authenticated` and scoped by
  `person.user_id`, so they see only their own proposals), and is refused every
  role-scoped area.
- `worker/routes/people.ts` is the organizer's gate at `/organizer/people`. It
  shows each account's **evidence** - programmed, proposal only, or no records -
  because a `speaker` row is minted at first CFP draft, not at acceptance, so a
  speaker record alone is not evidence of presenting. Neither is a live
  `session_speaker` row: un-accepting keeps the session on purpose, so
  *Programmed* counts a submission-backed session only while its submission is
  still accepted, and a directly entered session (no `submission_id`) always.
  Granting is attributed and silent; the notify checkbox defaults to off.
- **A reviewer invitation is redeemed only by confirming the address.** Signing
  up as an invited address grants nothing. `worker/reviewer-invites.ts#redeemReviewerInvites`
  runs from Better Auth's `afterEmailVerification` and nowhere else; redeeming at
  sign-up would hand reviewer access to anyone who guessed an invited address.
  `tests/integration/account-access.test.ts` runs that exact attack - keep it.
- `emailVerification.sendOnSignUp` is on and never blocks signing in. Account
  mail carries `eventId: "platform"` and goes straight to the delivery rather
  than `sendTrackedEmail`, because `email_dispatch.event_id` references a real
  event and an account confirmation belongs to none.
- Roles are platform-wide for now and the People surface says so. Scoping a
  grant to an event is issue #120: add `event_id` to `role_grant`, widen
  `role_grant_live_unique`, and thread the filter through `worker/roles.ts`.
  Nothing should assume one grant per account.

## Running the browser tests locally

`npm run test:e2e` runs against the **persistent** local D1 in
`.wrangler/state/v3/d1`, not a fresh one. Specs that accept a proposal create a
`program_session` that survives the run - `submission-participants.spec.ts`
leaves one titled `What a panel owes its audience <timestamp>` every time - and
`agenda.spec.ts` asserts exact counts (`3 unplaced`). So the suite passes the
first time and then fails on a second local run with a count that keeps climbing
(`5 unplaced`, then 7). **This is accumulated local state, not a regression and
not an environment quirk**; it has been misdiagnosed as one before. Reset and
re-run:

```sh
rm -rf .wrangler/state/v3/d1 && npm run db:migrate:local && npm run test:e2e
```

CI never sees this because each job starts from an empty database. Playwright
also defaults to port 8787; pass `PLAYWRIGHT_PORT` to run somewhere else.

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
- Each save rewrites the whole participant list from `collaborators`, author
  first. A blank collaborator row is an unused slot, not an error. The form
  version's `minimumSpeakers`/`maximumSpeakers` are enforced on submit only.
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
  `client/components/Headshot.tsx` is likewise the one headshot renderer —
  roster row and expanded profile, public directory/detail/gallery, the
  speaker-gallery embed, and the portal preview all render through it, so a
  missing or broken image falls back to the same initials everywhere; render
  through it rather than hand-rolling a headshot `<img>` (issue #133).
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
  distinguishes a speaker's one profile headshot (`taskId` null) from a
  task-scoped deliverable (`taskId` + `speakerId` locate the row). The headshot
  serves unauthenticated at `GET /api/public/portal/speakers/:speakerId/headshot`,
  which answers the whole-number `?version=` the URL names (404 otherwise),
  resolves a version-less URL to the latest, and caches only a versioned
  response immutably. `storeSpeakerHeadshot` mirrors the versioned URL onto
  `people.headshotUrl`, so a replacement names new bytes and shows immediately
  on every surface (issue #152). Re-uploading either kind adds a new
  `file_version` or flips `latest`; prior versions stay downloadable via
  `GET /api/portal/files/:fileId?version=N`, and each `files[].versions` entry in
  `GET /api/speaker/content` carries that link. `file.display_name` only tracks the
  newest upload, so a version's own filename comes from its storage key
  (`worker/storage/file-versions.ts`) for the history list, the download's
  `Content-Disposition`, and the public headshot's per-version content type.
- A speaker never sees `submission.status`. Both speaker doors -
  `GET /api/speaker/content` and `GET /api/speaker/submissions/:submissionId` -
  answer with `speakerStatus` from `speakerFacingSubmissionStatus` in
  `shared/api.ts`, and read `in_review` otherwise. **A decision is communicated by
  the letter arriving, not by an organizer queueing one**: join the notice log
  through `worker/speaker-access.ts#sentDecisionLetter`, which is `sent` and not
  cancelled. A queued letter is organizer-only, a failed one reached nobody, and a
  cancelled one never will; showing any of them tells the speaker an outcome the
  product has not sent, which is the whole point of deciding freely and sending
  once. An acceptance that already produced the speaker's own session still reads
  as accepted - they are working on it. The submitter dashboard is the deliberate
  exception: it shows the live silent status by design and by test.
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
- What a file request wants *is* its `task.acceptedFileTypes` list - there is no
  second flag. `fileRequestKindOf` in `shared/api.ts` reads that list as the
  organizer's picture-or-document choice, and a request that declares nothing
  stays a document request, which is what every request predating the choice
  meant. `limitsForTask` resolves the list against the extensions the app knows,
  dropping any it does not, and takes the image ceiling for a picture-only
  request. `GET /api/speaker/content` answers with those resolved limits, so the
  speaker's hint and every rejection name that request's own types; never
  restate a type list in client copy.
- A picture request is the organizer asking for the speaker's headshot, so
  `worker/routes/portal.ts#storeSpeakerHeadshot` runs for both doors: the
  dedicated picker and a picture-request upload. The deliverable itself stays a
  task file behind the same authentication as any other; only the headshot serves
  publicly, from the extension-derived content type.
- Upload validation is AND-style across extension and declared content type
  (`validateUpload`), and an image must additionally start with its format's
  signature. `payload.png` claiming `text/html` must stay rejected - that pairing
  was a stored XSS (PR #14) - and so must `payload.png` claiming *nothing*: the
  declared type is caller-supplied, so an absent, empty, or malformed one names
  no type and is a refusal, not a pass on the extension alone. Never accept a
  file because one half matches. `validateUpload` takes the bytes as a required
  argument so a new upload route cannot silently skip the signature check, and
  the two speaker upload routes in `worker/routes/portal.ts` are the only callers
  - the headshot picker and the file request, which is a picture request or a
  document request depending only on its `acceptedFileTypes`. Both serving
  routes answer `X-Content-Type-Options: nosniff`, so the public headshot's
  extension-derived type is enforced rather than hoped for. Keep the regression
  tests in `tests/unit/portal-uploads.test.ts` and
  `tests/integration/portal-content.test.ts` alive when widening types, and give
  any test fixture claiming to be an image a real signature.

## Communications

`worker/email.ts` is the provider-neutral sending boundary (`EmailMessage` in,
`EmailDeliveryResult` out). `resolveEmailDelivery(env)` picks the real
Resend-backed sender (`worker/email/resend.ts`) when `RESEND_API_KEY` and
`RESEND_FROM_ADDRESS` are set, and the visibly-unconfigured `emailDelivery`
stub otherwise - local dev, CI, and every test run stay in the unconfigured
state unless a `.dev.vars` opts in, so nothing here ever reaches the network
by accident. `resolveEmailDelivery` also wraps the real sender in
`refuseUndeliverableRecipients` (`worker/email/reserved-domains.ts`), so a
recipient at a domain the RFCs reserve - `example.com`/`.net`/`.org` and the
`.invalid`, `.test`, `.example`, and `.localhost` TLDs, subdomains included -
fails before the provider call rather than hard-bouncing off a verified sending
domain. It guards what cannot receive mail and nothing more: no allow lists, no
per-event settings. The refusal is an ordinary `failed` result, so it lands on
the same `email_dispatch` and `decision_notice` rows, with the same reason
field, as any provider rejection. It sits around the resolved sender rather than
inside `sendTrackedEmail` so an unconfigured environment still reports
`provider_not_configured`, writes nothing, and leaves a queued letter queued.
Seeded fixture speakers are deliberately at `example.com`, so a test that must
prove real delivery re-points its own recipient at a registrable domain and
restores it afterwards rather than changing the seed. Every real attempt logs a structured line and, once attempted,
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
- Whether a sender exists is deployment state, never page copy. Organizer
  surfaces read `GET /api/email-sender` (organizer-only, in `worker/routes/comms.ts`)
  for `connected` plus the names of the missing secrets, and render both the
  connected and the unconnected-with-recourse states through the single
  `client/components/email-sender.tsx`. Its recourse text points at README's
  "Connecting an email sender"; keep the two in step.
- A `decision_notice` stays `queued` until it actually reaches the provider, and
  `worker/routes/comms.ts` projects those queued rows into the Communications
  dispatch log so a recorded decision stays visible without inventing an
  `email_dispatch` attempt. Both the batch dispatch route and
  `retryDecisionNotice` send anything still `queued`; only a `sent` notice is
  refused, and that refusal - not the insert - is what prevents a double send.
  So the promise that a waiting letter goes out once a sender is connected is
  real, and the organizer sends it from Communications.
- The one real, network-touching test is opt-in:
  `RUN_REAL_EMAIL_TEST=1 RESEND_API_KEY=... RESEND_FROM_ADDRESS=... npx vitest run tests/unit/email-live.test.ts`,
  sending to Resend's documented safe address `delivered@resend.dev`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
