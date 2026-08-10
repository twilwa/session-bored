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

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
