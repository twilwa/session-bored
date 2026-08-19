// ABOUTME: Generates concise public guidance for agents operating Greenroom on a user's behalf.
// ABOUTME: Derives protected workspace paths and access requirements from the deployed page catalog.
import {
  cfpBuilderRouteMap,
  reviewRouteMap,
  rosterRouteMap,
  routeMap,
  type ApiAccess,
} from "../shared/api.ts";
import { protectedPageRoutes } from "./page-routes.ts";

const accessLabels = {
  attendee: "attendee",
  authenticated: "any signed-in account",
  organizer: "organizer",
  public: "public",
  reviewer: "reviewer",
  speaker: "speaker",
} as const satisfies Record<ApiAccess, string>;

type OrganizerOperation = {
  journey: "Event settings" | "CFP" | "Submissions" | "Reviewers and outstanding reviews" | "Agenda" | "Roster";
  summary: string;
  route: { method: string; path: string; access: ApiAccess };
  expects: string;
  returns: string;
};

const reopenCfpRoute = {
  method: "POST",
  path: "/api/cfp-builder/forms/:formId/reopen",
  access: "organizer",
} as const;

export const organizerOperations = [
  {
    journey: "Event settings",
    summary: "Read the active event's identity, dates, venue, timezone, and branding.",
    route: routeMap.event,
    expects: "Path `eventId`; no request body.",
    returns: "The event record, or `404 { error: \"not_found\" }`.",
  },
  {
    journey: "Event settings",
    summary: "Replace the event settings after validating the complete event contract.",
    route: routeMap.updateEvent,
    expects:
      "Path `eventId`; JSON with `name`, `slug`, `startDate`, `endDate`, `timezone`, optional `tagline`, `description`, and `venue`, plus `branding.primaryColor`, `branding.accentColor`, and optional image URLs. Dates use `YYYY-MM-DD`; timezone is an IANA name.",
    returns:
      "The updated event plus `scheduleReviewRequired`. Validation failures include field messages; a timezone change can unpublish placed sessions for human review.",
  },
  {
    journey: "CFP",
    summary: "List the event's CFP forms and their saved versions.",
    route: cfpBuilderRouteMap.listForms,
    expects: "Path `eventId`; no request body.",
    returns: "`{ items }` containing each form, its draft and published versions, and versioned fields.",
  },
  {
    journey: "CFP",
    summary: "Create a CFP form and its first draft version.",
    route: cfpBuilderRouteMap.createForm,
    expects:
      "Path `eventId`; JSON with `name`, `publicSlug`, the version settings described by the save route, and a `fields` array.",
    returns: "`201 { form, version }`, or a JSON validation or slug-conflict error.",
  },
  {
    journey: "CFP",
    summary: "Read one CFP form with its draft and published versions.",
    route: cfpBuilderRouteMap.readForm,
    expects: "Path `formId`; no request body.",
    returns: "The form, draft and published versions, and their versioned fields.",
  },
  {
    journey: "CFP",
    summary: "Save the next CFP draft, including dates and question definitions.",
    route: cfpBuilderRouteMap.saveForm,
    expects:
      "Path `formId`; JSON with nullable ISO `openAt` and `closeAt`, `minimumSpeakers`, nullable `maximumSpeakers`, optional welcome and confirmation copy, and `fields`. Each field has a unique `key`, `label`, `fieldType`, `required`, optional description/options, blind-review visibility, and optional equals condition.",
    returns: "`{ version }` for the saved draft, or a JSON validation error.",
  },
  {
    journey: "CFP",
    summary: "Open the CFP by publishing its current valid draft.",
    route: cfpBuilderRouteMap.publishForm,
    expects: "Path `formId`; no request body. Save a complete draft first.",
    returns: "`{ version, publicUrl }`, or a missing-draft or invalid-contract error.",
  },
  {
    journey: "CFP",
    summary: "Close the currently published CFP version.",
    route: cfpBuilderRouteMap.closeForm,
    expects: "Path `formId`; no request body.",
    returns: "`{ version, publicUrl }` for the closed version.",
  },
  {
    journey: "CFP",
    summary: "Reopen a closed CFP whose saved close time is still in the future.",
    route: reopenCfpRoute,
    expects: "Path `formId`; no request body. Save and publish a later close time if the prior window has elapsed.",
    returns: "`{ version, publicUrl }`, or `409` when the CFP is already open or its close time has passed.",
  },
  {
    journey: "Submissions",
    summary: "List every submission row belonging to an event.",
    route: routeMap.submissions,
    expects: "Path `eventId`; no request body.",
    returns: "`{ items }` containing submission records, including status and form linkage.",
  },
  {
    journey: "Submissions",
    summary: "Read a submission against the exact form version its author answered.",
    route: cfpBuilderRouteMap.readSubmissionForm,
    expects: "Path `submissionId`; no request body.",
    returns: "`{ submission, form, speaker, answers }` with versioned labels and rendered values.",
  },
  {
    journey: "Reviewers and outstanding reviews",
    summary: "Read committee configuration and reviewer progress before assigning or reminding anyone.",
    route: reviewRouteMap.config,
    expects: "Path `eventId`; no request body.",
    returns: "`{ tracks, submissions, reviewers, rounds }`; reviewers include assigned, completed, and recused counts.",
  },
  {
    journey: "Reviewers and outstanding reviews",
    summary: "Assign one reviewer to one or more submissions in an existing review round.",
    route: reviewRouteMap.assignments,
    expects: "Path `roundId`; JSON `{ reviewerUserId, submissionIds }` with at least one submission ID.",
    returns: "`201 { items }` containing the resulting assignment rows.",
  },
  {
    journey: "Reviewers and outstanding reviews",
    summary: "Read coverage, scores, and recusals for every submitted proposal.",
    route: reviewRouteMap.worklist,
    expects: "Path `eventId`; optional query `sort=coverage` or `sort=score`; no request body.",
    returns: "`{ eventId, sort, progress, items }`; each item includes rating count, average score, tracks, and recusals.",
  },
  {
    journey: "Reviewers and outstanding reviews",
    summary: "Prepare unsent reminder drafts only for reviewers who still owe reviews.",
    route: reviewRouteMap.reviewReminders,
    expects: "Path `eventId`; JSON `{ reviewerUserIds }` with at least one account ID.",
    returns: "`{ drafts, skipped }`; status is `201` when drafts were created and `200` when all recipients were skipped.",
  },
  {
    journey: "Agenda",
    summary: "Read the scheduling workbench and its current conflicts.",
    route: routeMap.agenda,
    expects: "Path `eventId`; no request body.",
    returns: "`{ event, days, rooms, tracks, formats, sessions, conflicts, metrics }`.",
  },
  {
    journey: "Agenda",
    summary: "Create an unplaced, directly entered programme session.",
    route: routeMap.createAgendaSession,
    expects: "Path `eventId`; JSON with `title` and optional nullable `abstract`, `trackId`, and `formatId`.",
    returns: "`201 { agenda, session }` with the complete updated agenda.",
  },
  {
    journey: "Agenda",
    summary: "Place, mark TBD, or unplace one session; every edit clears its publication.",
    route: routeMap.updateAgendaSession,
    expects:
      "Paths `eventId` and `sessionId`; JSON `{ scheduleStatus: \"unplaced\" }`, `{ scheduleStatus: \"tbd\", scheduledDate }`, or `{ scheduleStatus: \"placed\", scheduledDate, roomId, startsAt }`. `startsAt` is epoch milliseconds.",
    returns: "The complete updated agenda, including server-calculated conflicts.",
  },
  {
    journey: "Agenda",
    summary: "Edit a session's title or abstract, or approve its current content.",
    route: routeMap.updateAgendaSessionContent,
    expects:
      "Paths `eventId` and `sessionId`; JSON with non-empty `title` and/or `abstract`, or exactly `{ contentStatus: \"approved\" }`.",
    returns: "The complete updated agenda.",
  },
  {
    journey: "Roster",
    summary: "Read speaker identity, workflow standing, outstanding work, and publication holds.",
    route: rosterRouteMap.roster,
    expects: "Path `eventId`; no request body.",
    returns: "`{ items }`; each speaker includes profile completeness, work summary, and pending-publication sessions.",
  },
] as const satisfies readonly OrganizerOperation[];

export const agentReferenceExclusions = [
  {
    method: "GET",
    path: "/api/public/events/:eventId/branding/:asset",
    reason: "Public asset delivery is outside the organizer journeys.",
  },
  {
    method: "POST",
    path: "/api/events/:eventId/branding/:asset",
    reason: "Binary branding upload is outside the described JSON settings journey.",
  },
  {
    method: "POST",
    path: "/api/events/:eventId/rooms",
    reason: "Room administration is outside the delegated journeys.",
  },
  {
    method: "PATCH",
    path: "/api/events/:eventId/rooms/:roomId",
    reason: "Room administration is outside the delegated journeys.",
  },
  {
    method: "DELETE",
    path: "/api/events/:eventId/rooms/:roomId",
    reason: "Destructive actions require a human.",
  },
  {
    method: "POST",
    path: "/api/events/:eventId/tracks",
    reason: "Track administration is outside the delegated journeys.",
  },
  {
    method: "PATCH",
    path: "/api/events/:eventId/tracks/:trackId",
    reason: "Track administration is outside the delegated journeys.",
  },
  {
    method: "DELETE",
    path: "/api/events/:eventId/tracks/:trackId",
    reason: "Destructive actions require a human.",
  },
  {
    method: "GET",
    path: "/api/cfp-builder/forms/:formId/preview",
    reason: "Browser preview rendering is outside the HTTP reference.",
  },
  {
    method: "GET",
    path: "/api/review/queue",
    reason: "This is a reviewer-scoped route, not an organizer route.",
  },
  {
    method: "GET",
    path: "/api/review/submissions/:submissionId",
    reason: "This is a reviewer-scoped route, not an organizer route.",
  },
  {
    method: "POST",
    path: "/api/review/submissions/:submissionId/comments",
    reason: "Committee discussion is outside the delegated organizer journeys.",
  },
  {
    method: "POST",
    path: "/api/review/events/:eventId/rounds",
    reason: "Review-round administration is outside the delegated journeys.",
  },
  {
    method: "POST",
    path: "/api/review/events/:eventId/reviewers",
    reason: "This creates credentials and grants a role, so it is security-sensitive and omitted.",
  },
  {
    method: "PATCH",
    path: "/api/review/events/:eventId/reviewers/:reviewerUserId",
    reason: "This changes a reviewer's access remit, so it is security-sensitive and omitted.",
  },
  {
    method: "POST",
    path: "/api/review/rounds/:roundId/criteria",
    reason: "Scorecard administration is outside the delegated journeys.",
  },
  {
    method: "PATCH",
    path: "/api/review/criteria/:criterionId",
    reason: "Scorecard administration is outside the delegated journeys.",
  },
  {
    method: "DELETE",
    path: "/api/review/criteria/:criterionId",
    reason: "Destructive actions require a human.",
  },
  {
    method: "POST",
    path: "/api/review/rounds/:roundId/assignments/distribute",
    reason: "Automatic review distribution is outside the explicitly described assignment journey.",
  },
  {
    method: "POST",
    path: "/api/review/submissions/:submissionId/reviews",
    reason: "This is a reviewer-scoped route, not an organizer route.",
  },
  {
    method: "POST",
    path: "/api/review/submissions/:submissionId/recusal",
    reason: "This is a reviewer-scoped route, not an organizer route.",
  },
  {
    method: "PATCH",
    path: "/api/review/submissions/:submissionId/status",
    reason: "Committee decisions require a human.",
  },
  {
    method: "POST",
    path: "/api/events/:eventId/agenda/publish",
    reason: "Programme publication requires a human.",
  },
  {
    method: "GET",
    path: "/api/events/:eventId/speakers/import-template.csv",
    reason: "Speaker import is outside the read-only roster journey.",
  },
  {
    method: "POST",
    path: "/api/events/:eventId/speakers/import/preview",
    reason: "Speaker import is outside the read-only roster journey.",
  },
  {
    method: "POST",
    path: "/api/events/:eventId/speakers/import",
    reason: "Speaker import is outside the read-only roster journey.",
  },
  {
    method: "POST",
    path: "/api/events/:eventId/speakers",
    reason: "Roster mutation is outside the read-only roster journey.",
  },
  {
    method: "PATCH",
    path: "/api/events/:eventId/speakers/:speakerId",
    reason: "Roster mutation is outside the read-only roster journey.",
  },
  {
    method: "DELETE",
    path: "/api/events/:eventId/speakers/:speakerId",
    reason: "Destructive actions require a human.",
  },
  {
    method: "POST",
    path: "/api/events/:eventId/tasks",
    reason: "Onboarding-task administration is outside the read-only roster journey.",
  },
  {
    method: "PATCH",
    path: "/api/events/:eventId/tasks/:taskId",
    reason: "Onboarding-task administration is outside the read-only roster journey.",
  },
  {
    method: "DELETE",
    path: "/api/events/:eventId/tasks/:taskId",
    reason: "Destructive actions require a human.",
  },
  {
    method: "PATCH",
    path: "/api/events/:eventId/tasks/:taskId/assignees/:speakerId",
    reason: "Onboarding-task administration is outside the read-only roster journey.",
  },
  {
    method: "GET",
    path: "/api/events/:eventId/tasks",
    reason: "Onboarding-task administration is outside the read-only roster journey.",
  },
  {
    method: "POST",
    path: "/api/events/:eventId/speakers/:speakerId/invitation",
    reason: "Sending mail to speakers requires a human.",
  },
  {
    method: "GET",
    path: "/api/events/:eventId/missing-information",
    reason: "Onboarding follow-up is outside the read-only roster journey.",
  },
] as const;

const journeyIntroductions = {
  "Event settings": "Read before writing because the update route replaces the complete validated settings object.",
  CFP: "Save a draft before publishing it. Publishing a CFP is distinct from publishing the programme.",
  Submissions: "Use the list for IDs and status, then the detail route for version-correct answers.",
  "Reviewers and outstanding reviews":
    "Read configuration and coverage first. Reminder creation prepares drafts and does not send them.",
  Agenda: "Placement and content edits are agent-operable; programme publication remains reserved for a human.",
  Roster: "The roster route is read-only in this reference; speaker removal and other destructive actions are reserved.",
} as const satisfies Record<OrganizerOperation["journey"], string>;

export function conciseAgentGuide(): string {
  const workspaceLines = protectedPageRoutes
    .map(({ path, access }) => `- \`${path}\`: ${accessLabels[access]}`)
    .join("\n");

  return `# Greenroom

Greenroom manages conference calls for proposals, committee review, programmes,
speakers, and organizer communications.

## Access

Open demo: \`GET /demo\` — one GET, no signup, lands signed in on a live review board. Follow it.
The seeded demo reviewer is read-only; use it to inspect the product, not to change data.

For account-specific work, ask the user to sign in in a browser and open Event setup → Agent access.
The browser uses \`${routeMap.issueAgentCredential.method} ${routeMap.issueAgentCredential.path}\`
with JSON \`{ "name": string, "role":
"organizer" | "reviewer" | "speaker" }\`. The token is shown only once. Send it on every request as
\`Authorization: Bearer greenroom_...\`. Verify the identity and role with \`GET /api/session\`.

A credential is pinned to its issued role and the specific grant that authorized it, even when
the account holds broader grants. It stops working when the user revokes it or that originating
grant; granting the role again does not revive it. Credential listing, issuance, and revocation
require the user's browser session; never ask for or retain the user's password.

Main surfaces:

- \`/schedule\` and published CFP pages: public
${workspaceLines}

## Human confirmation required

An agent may prepare changes, but these actions require human confirmation:

- publishing a programme
- sending mail to speakers
- issuing decisions
- deleting anything

## Organizer HTTP reference

Read [/llms-full.txt](/llms-full.txt) for actionable organizer paths, methods,
inputs, outputs, and role requirements.
`;
}

export function fullOrganizerReference(): string {
  const sections = Object.entries(journeyIntroductions).map(([journey, introduction]) => {
    const operations = organizerOperations
      .filter((operation) => operation.journey === journey)
      .map((operation) => `### ${operation.route.method} \`${operation.route.path}\`

${operation.summary}

**Role:** ${accessLabels[operation.route.access]}

**Expects:** ${operation.expects}

**Returns:** ${operation.returns}`)
      .join("\n\n");
    return `## ${journey}

${introduction}

${operations}`;
  });

  return `# Greenroom organizer HTTP reference

This public reference describes organizer journeys that an authorized coding agent
can prepare or complete through Greenroom's existing HTTP routes. It contains no
credentials. The public \`GET /demo\` door signs you into a seeded, read-only reviewer account.
It demonstrates the live product but cannot call these organizer routes.

## Authentication

A human organizer signs in in a browser and manages credentials in Event setup → Agent access.
Those browser-only operations are:

- ${routeMap.agentCredentials.method} \`${routeMap.agentCredentials.path}\` — list the account's active and revoked credentials; secrets are never returned.
- ${routeMap.issueAgentCredential.method} \`${routeMap.issueAgentCredential.path}\` — send \`{ "name": string, "role": "organizer" | "reviewer" | "speaker" }\`; the response contains a \`token\` shown only once.
- ${routeMap.revokeAgentCredential.method} \`${routeMap.revokeAgentCredential.path}\` — revoke one credential without deleting its history.

For delegated organizer work, send \`Authorization: Bearer greenroom_...\` on every request.
Do not use password sign-in. Start with \`GET /api/session\` and verify that \`user.roles\` contains
exactly the role the user intended. A credential is pinned to its issued role and the specific live
grant that authorized it. It becomes invalid immediately when either the credential or that
originating grant is revoked, and granting the same role again does not revive it.

Send JSON with \`content-type: application/json\`, and use only IDs returned by reads from the same
event. Successful timestamps serialize as ISO 8601 strings unless an operation says it expects
epoch milliseconds.

Errors are JSON with an \`error\` key and an appropriate \`4xx\` status. All routes
below require the \`organizer\` role. Routes that publish the programme, send mail to
speakers, issue decisions, or delete records are intentionally omitted because a
human must complete those actions. An agent attempt to make any undescribed mutation returns
\`403 { "error": "human_confirmation_required" }\` before route logic runs.

${sections.join("\n\n")}
`;
}
