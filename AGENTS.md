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

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
