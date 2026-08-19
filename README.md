# Greenroom

Greenroom is an open-source event program platform for the complete speaker
workflow: call for speakers, review, acceptance, onboarding, scheduling, and
publishing. This repository retains the working name `session-bored`.

The M0 foundation is live and seeded at
[session-bored.techwilliams-warren.workers.dev](https://session-bored.techwilliams-warren.workers.dev).

## Local setup

Node.js 22 or newer is required. The following single command installs the
dependencies, creates the local secret file, migrates D1, and starts Greenroom:

```sh
npm install && cp .dev.vars.example .dev.vars && npm run db:migrate:local && npm run dev
```

Open <http://127.0.0.1:8787>. The idempotent fixture seed runs on the first API
request, so the app opens with DevFlow Conf 2027 rather than an empty state.

## Optional AI-assisted review

AI-assisted review is off by default for every event. When an organizer enables
it in committee setup, reviewers can request an AI-generated proposal summary
and suggestions against that round's existing scorecard. Opening a proposal
doesn't generate assistance or send proposal content to the provider. The
reviewer must choose **Generate AI reading aid**, choose **Use as a starting
point**, change at least one suggested value, and submit the human scorecard.
The review route rejects an unchanged AI starting point. Generated output never
changes a review, submission status, comment, email, or notification.

To make the optional feature available locally, set `ANTHROPIC_API_KEY` in
`.dev.vars`. To make it available in a deployed Worker, add the same binding as
a Wrangler secret:

```sh
npx wrangler secret put ANTHROPIC_API_KEY
```

If the secret is absent, rate-limited, or rejected by the provider, the review
engine remains usable and shows a quiet unavailable state after event opt-in.
Greenroom uses `claude-haiku-4-5-20251001` and caches summaries per submission,
form version, content fingerprint, and blind-review visibility. Suggested scores
are also scoped to the round's current criteria.

## Seeded credentials

Password login is available for every authenticated role. These accounts are
safe fixture identities intended for local development and automated review.

| Role | Email | Password |
| --- | --- | --- |
| Organizer | `sbek-organizer@example.com` | `SbekTest!2027-org` |
| Reviewer | `sbek-reviewer@example.com` | `SbekTest!2027-rev` |
| Speaker | `sbek-speaker@example.com` | `SbekTest!2027-spk` |
| Speaker 2 | `sbek-speaker2@example.com` | `SbekTest!2027-spk2` |

Public CFP, program, speaker, agenda, and embed endpoints do not require an
account. Protected browser and API routes enforce organizer, reviewer, and
speaker boundaries with deny-by-default middleware.

## Accounts and roles

Anyone can create an account at `/signup`. New accounts are **attendees**: they
keep their own schedule and their own proposals, and reach no speaker, reviewer,
or organizer area. Only an organizer opens those, from **People** in the
organizer workspace, where each grant records who made it and can be taken back.

An account can hold more than one of these. When it does, the signed-in header
carries an **Area** switcher naming every area those grants open, on public pages
and inside every workspace, so a second grant is reachable from wherever the
person happens to be. An account with a single area keeps the plain link to it.
Signing in from a page that turned you away returns you to that page whenever it
sits inside an area your account reaches; anything else lands you on your home
area.

An organizer can also invite a reviewer by email. The invitation is sent through
Communications and becomes reviewer access once that person creates an account
and confirms the invited address, so knowing that address is never enough to claim
it. The emailed link is one page for every case: it starts a sign-up for a new
address, asks an account that has not confirmed its address to do that first, and
for an address with a confirmed account opens reviewer access from the page once
that person is signed in as it. If the invited address already has a confirmed
account, People tells the organizer and can open the access immediately - naming
what the reviewer may read, exactly as a direct grant does - which for an
existing reviewer extends their remit to the event rather than granting them
anything new. Invitation mail needs an email sender; without one, People says
delivery was not attempted and the invitation remains pending. Whenever an
invitation reached nobody, People offers **Resend invitation** on its row, so a
failed send or one made before a sender was connected goes out without
withdrawing and re-inviting.

Granting reviewer from People asks in the same step what that reviewer may read:
at least one track and one open review round, so a new reviewer signs in to a
queue with work in it. **Committee setup** in the review workspace lists every
granted reviewer, including one who still has no remit, and is where an existing
remit is changed.

## Event setup

**Event setup** in the organizer workspace edits the active event: its name,
tagline, and description, dates, venue, timezone, public slug, brand colors,
logo, and background image. The timezone saved here is the one every agenda and
public schedule time is read in, so changing it takes the placed sessions off
the public schedule and asks the organizer to review and publish them again. Dates
that would leave a scheduled session outside the event, and a public slug
another event already uses, are refused on the field rather than saved.

## Speaker directory

Organizers can open **Speaker directory** at `/organizer/directory` to search
the private, cross-event record of everyone who has submitted or spoken. The
paginated index combines text, tag, and custom-field filters, supports stable
sorting, and lets an organizer save the current criteria as a named segment to
run again. Its overview keeps people, event, session, and curated-contact counts
visible even while the result set is filtered.

Each person's detail page shows their proposals, sessions, and event history,
alongside organizer-only tags, custom fields, and attributed internal notes.
Those directory details do not change the event-specific roster and are never
included in public speaker, session, schedule, or embed responses.

Greenroom flags conservative duplicate candidates when normalized email
addresses match, or when both normalized name and organization match. A merge
requires the organizer to choose the record to keep and confirm the choice. The
other record is archived with an attributed merge log. Greenroom first plans
each ownership-reference move, then applies only those moves. References that
already exist on the kept side stay on their original rows and appear in the
merge result.

A merge never combines profile fields, accounts, roster status, removals,
publication state, task progress, or assignment provenance. It refuses when
archiving either record would require choosing between conflicting same-event
standing or session participation. It also refuses whenever the merge would
adopt the archived record's account. Resolve those facts in their owning
workflow before merging the identity records.

The existing **Speakers** roster remains the workflow view for the active event,
including its event-scoped CSV import. Staged sourcing, pushing a directory
contact into an event, and segment outreach remain separate follow-up work;
outreach must reuse Communications and its tracked dispatch log rather than
introducing another sender.

## Commands

The standard project commands cover database evolution, verification, and
deployment.

```sh
npm run build
npm test
npm run test:integration
npm run test:e2e
npm run db:generate
npm run db:migrate:local
npm run db:migrate:remote
npm run deploy
```

For a new Cloudflare environment, create a D1 database, place its ID in
`wrangler.jsonc`, and add the two Better Auth secrets before deploying:

```sh
openssl rand -base64 48 | npx wrangler secret put BETTER_AUTH_SECRET
printf '%s' 'https://your-worker.example' | npx wrangler secret put BETTER_AUTH_URL
npm run db:migrate:remote && npm run deploy
```

Speaker file uploads (headshots and task deliverables) and event branding images
store in the R2 bucket bound as `FILES` in `wrangler.jsonc`; create that bucket
in the new environment before deploying.

## Connecting an email sender

Greenroom sends no email until a sender is connected, and says so on the
Disposition and Communications pages. Until then it drafts, previews, and
records everything normally: a dispatched decision letter is kept, shown in
Communications as waiting to send, and delivered once a sender is connected.

Delivery goes through [Resend](https://resend.com), and its credentials are
**Cloudflare Worker secrets set at deploy time, not settings inside the app**.
An organizer cannot enter them from a Greenroom page. Whoever operates the
deployment sets both secrets against the Worker and redeploys:

```sh
printf '%s' 're_your_api_key' | npx wrangler secret put RESEND_API_KEY
printf '%s' 'Greenroom <program@your-verified-domain.example>' | npx wrangler secret put RESEND_FROM_ADDRESS
npm run deploy
```

`RESEND_FROM_ADDRESS` must use a domain already verified in the Resend account,
otherwise Resend rejects every send. Greenroom treats the sender as connected
only when both secrets are present; either one alone keeps it unconfigured.

For local development, set the same two names in `.dev.vars`. Leave them unset
to keep local runs, CI, and the test suites in the network-free unconfigured
state, which is the default.

Once a sender is connected, an organizer sends the letters that were waiting
from **Communications → decision letters that have not gone out**. A letter
already delivered is never re-sent.

## Traffic observability

Every production request passes through the Worker and emits one structured
`http_request` event to Workers Logs. The event records `method`, `path`,
`status`, `userAgent`, `referer`, `country`, and `asn`. Dynamic API paths use
their route templates, referrers are reduced to their origin, and query strings
aren't recorded. The event never includes cookies, authorization headers,
request bodies, or IP addresses.

To query traffic in the dashboard, open **Cloudflare dashboard → Workers &
Pages → session-bored → Observability**. Filter `event` to `http_request`,
then filter or group by `userAgent`, `path`, `status`, `country`, or `asn`. For
an immediate stream during a verification run, use
`npx wrangler tail session-bored`.

For programmatic queries, send a `POST` request to the
[Workers Observability telemetry query API](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/)
at
`/accounts/{account_id}/workers/observability/telemetry/query`. Use the
`events` view, filter `$metadata.service` to `session-bored`, and filter `event`
to `http_request`; add a `userAgent` filter to isolate crawlers such as GPTBot,
ChatGPT-User, or Python-urllib. This endpoint requires a scoped Cloudflare API
token with access to the account's Workers observability data. A Wrangler OAuth
token isn't accepted for this API.

## Architecture and contracts

The React SPA, Hono API, Better Auth endpoints, and public widgets share one
Cloudflare Worker origin. D1 is accessed through Drizzle, and static assets are
built by Vite and served by the Worker.

- `db/schema.ts` is the authoritative domain and authentication schema.
- `shared/api.ts` exports the typed route map and shared response summaries.
- `shared/speaker-directory.ts` defines the private cross-event directory
  contract.
- `worker/access.ts` owns role and direct-resource access policy.
- `worker/seed.ts` imports `fixtures/sample-data.json` and seeds it idempotently.
- `client/components/ui.tsx` provides the shared M0 UI primitives.

Domain records use immutable, permalinkable public IDs such as `evt_`, `sub_`,
`spk_`, and `ses_`. Submission employment snapshots are frozen in
`title_at_time` and `org_at_time`. Saves accept partial state; validation belongs
at submission boundaries, and `tbd` is a first-class schedule status.

## License

Greenroom is available under the permissive MIT License. See `LICENSE`.
