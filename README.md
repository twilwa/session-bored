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

R2 is intentionally not bound in M0. The configuration carries a TODO to add
the `FILES` binding when wave-2 file uploads land.

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

## Architecture and contracts

The React SPA, Hono API, Better Auth endpoints, and public widgets share one
Cloudflare Worker origin. D1 is accessed through Drizzle, and static assets are
built by Vite and served by the Worker.

- `db/schema.ts` is the authoritative domain and authentication schema.
- `shared/api.ts` exports the typed route map and shared response summaries.
- `worker/access.ts` owns role and direct-resource access policy.
- `worker/seed.ts` imports `fixtures/sample-data.json` and seeds it idempotently.
- `client/components/ui.tsx` provides the shared M0 UI primitives.

Domain records use immutable, permalinkable public IDs such as `evt_`, `sub_`,
`spk_`, and `ses_`. Submission employment snapshots are frozen in
`title_at_time` and `org_at_time`. Saves accept partial state; validation belongs
at submission boundaries, and `tbd` is a first-class schedule status.

## License

Greenroom is available under the permissive MIT License. See `LICENSE`.
