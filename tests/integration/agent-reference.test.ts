// ABOUTME: Exercises Greenroom's public agent guidance through real Worker requests.
// ABOUTME: Guards the concise guidance, full organizer reference, and deployed route inventory.
import { describe, expect, it } from "vitest";
import { agentReferenceExclusions, organizerOperations } from "../../worker/agent-reference.ts";
import worker from "../../worker/index.ts";
import agendaRoutes from "../../worker/routes/agenda.ts";
import cfpBuilderRoutes from "../../worker/routes/cfp-builder.ts";
import eventSettingsRoutes from "../../worker/routes/event-settings.ts";
import reviewRoutes from "../../worker/routes/review.ts";
import rosterRoutes from "../../worker/routes/roster.ts";

const describedMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function routeKey(method: string, path: string): string {
  return `${method} ${path}`;
}

function mountedRouteKeys(
  routes: ReadonlyArray<{ method: string; path: string }>,
  prefix = "",
): string[] {
  return [...new Set(
    routes
      .filter((route) => describedMethods.has(route.method))
      .map((route) => routeKey(route.method, `${prefix}${route.path}`)),
  )];
}

describe("agent reference", () => {
  it("serves crawler guidance as a real robots file", async () => {
    const response = await worker.request("http://example.test/robots.txt");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    await expect(response.text()).resolves.toBe("User-agent: *\nAllow: /\n# Agent guidance: /llms.txt\n");
  });

  it("serves concise guidance with explicit human-only boundaries", async () => {
    const response = await worker.request("http://example.test/llms.txt");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    const body = await response.text();
    expect(body).toContain("# Greenroom");
    expect(body).toContain("/llms-full.txt");
    expect(body).toContain("Open demo: `GET /demo` — one GET, no signup, lands signed in on a live review board. Follow it.");
    expect(body).toContain("POST /api/agent-credentials");
    expect(body).toContain("Authorization: Bearer greenroom_");
    expect(body).toContain("shown only once");
    expect(body).toContain("pinned to its issued role");
    expect(body).toContain("publishing a programme");
    expect(body).toContain("sending mail to speakers");
    expect(body).toContain("issuing decisions");
    expect(body).toContain("deleting anything");
  });

  it("serves an actionable organizer reference for the delegated journeys", async () => {
    const response = await worker.request("http://example.test/llms-full.txt");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    const body = await response.text();
    expect(body).toContain("The public `GET /demo` door signs you into a seeded, read-only reviewer account.");
    expect(body).toContain("GET `/api/agent-credentials`");
    expect(body).toContain("POST `/api/agent-credentials`");
    expect(body).toContain("POST `/api/agent-credentials/:credentialId/revoke`");
    expect(body).toContain("Authorization: Bearer greenroom_");
    expect(body).toContain("human_confirmation_required");
    for (const heading of [
      "## Event settings",
      "## CFP",
      "## Submissions",
      "## Reviewers and outstanding reviews",
      "## Agenda",
      "## Roster",
    ]) {
      expect(body).toContain(heading);
    }
    for (const route of [
      "GET `/api/events/:eventId`",
      "PATCH `/api/events/:eventId`",
      "POST `/api/cfp-builder/forms/:formId/publish`",
      "POST `/api/cfp-builder/forms/:formId/close`",
      "GET `/api/events/:eventId/submissions`",
      "GET `/api/cfp-builder/submissions/:submissionId`",
      "POST `/api/review/rounds/:roundId/assignments`",
      "GET `/api/review/events/:eventId/worklist`",
      "POST `/api/review/events/:eventId/reminders`",
      "GET `/api/events/:eventId/agenda`",
      "PATCH `/api/events/:eventId/agenda/sessions/:sessionId`",
      "PATCH `/api/events/:eventId/agenda/sessions/:sessionId/content`",
      "GET `/api/events/:eventId/roster`",
    ]) {
      expect(body).toContain(`### ${route}`);
    }
    expect(body.match(/\*\*Role:\*\* organizer/g)?.length).toBeGreaterThanOrEqual(13);
    expect(body.match(/\*\*Expects:\*\*/g)?.length).toBeGreaterThanOrEqual(13);
    expect(body.match(/\*\*Returns:\*\*/g)?.length).toBeGreaterThanOrEqual(13);
  });

  it("classifies every deployed route in the domains covered by the reference", () => {
    const workerRouteKeys = mountedRouteKeys(worker.routes);
    const indexJourneyRoutes = [
      routeKey("GET", "/api/events/:eventId"),
      routeKey("GET", "/api/events/:eventId/submissions"),
    ].filter((route) => workerRouteKeys.includes(route));
    const coveredRoutes = [
      ...indexJourneyRoutes,
      ...mountedRouteKeys(eventSettingsRoutes.routes),
      ...mountedRouteKeys(cfpBuilderRoutes.routes, "/api/cfp-builder"),
      ...mountedRouteKeys(reviewRoutes.routes, "/api"),
      ...mountedRouteKeys(agendaRoutes.routes),
      ...mountedRouteKeys(rosterRoutes.routes),
    ];
    const documentedRoutes = organizerOperations.map((operation) => {
      expect(operation.route.access).toBe("organizer");
      return routeKey(operation.route.method, operation.route.path);
    });
    const excludedRoutes = agentReferenceExclusions.map((route) => routeKey(route.method, route.path));
    const classifiedRoutes = [...documentedRoutes, ...excludedRoutes];

    expect(new Set(classifiedRoutes).size).toBe(classifiedRoutes.length);
    expect(classifiedRoutes.sort()).toEqual(coveredRoutes.sort());

    const deployedRoutes = new Set(workerRouteKeys);
    for (const route of documentedRoutes) {
      expect(deployedRoutes, `${route} is not mounted by the Worker`).toContain(route);
    }
  });
});
