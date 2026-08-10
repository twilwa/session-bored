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
and suggestions against that round's existing scorecard. The reviewer must
choose **Use as a starting point**, edit the human scorecard, and submit it.
Generated output never changes a review, submission status, comment, email, or
notification.

To make the optional feature available locally, set `ANTHROPIC_API_KEY` in
`.dev.vars`. To make it available in a deployed Worker, add the same binding as
a Wrangler secret:

```sh
npx wrangler secret put ANTHROPIC_API_KEY
```

If the secret is absent, rate-limited, or rejected by the provider, the review
engine remains usable and shows a quiet unavailable state after event opt-in.
Greenroom uses `claude-haiku-4-5-20251001` and caches summaries per submission,
form version, and blind-review visibility.

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
the `FILES` binding when wave-2 file uploads land. Email delivery likewise has
a typed provider-neutral boundary that visibly reports `provider_not_configured`
until the communications lane supplies Resend.

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
