// ABOUTME: Specifies the shared typed route catalog consumed by independent feature lanes.
// ABOUTME: Ensures every PRD module declares its method, path, and access requirement.
import { describe, expect, it } from "vitest";
import { peopleRouteMap, reviewRouteMap, routeMap } from "../../shared/api.ts";

describe("typed route map", () => {
  it("covers every planned product module", () => {
    const modules = new Set(
      [...Object.values(routeMap), ...Object.values(peopleRouteMap)].map((route) => route.module),
    );
    expect(modules).toEqual(
      new Set([
        "agenda",
        "auth",
        "communications",
        "embeds",
        "events",
        "exports",
        "files",
        "forms",
        "people",
        "public",
        "reviews",
        "sessions",
        "speakers",
        "submissions",
        "tasks",
      ]),
    );
  });

  it("declares every organizer export as a typed route", () => {
    expect([
      routeMap.exportSessions,
      routeMap.exportSpeakers,
      routeMap.exportReviews,
      routeMap.exportSchedule,
    ]).toEqual([
      { method: "GET", path: "/api/events/:eventId/exports/sessions.json", module: "exports", access: "organizer" },
      { method: "GET", path: "/api/events/:eventId/exports/speakers.json", module: "exports", access: "organizer" },
      { method: "GET", path: "/api/events/:eventId/exports/reviews.csv", module: "exports", access: "organizer" },
      { method: "GET", path: "/api/events/:eventId/exports/schedule.ics", module: "exports", access: "organizer" },
    ]);
  });

  it("makes public and scoped access explicit", () => {
    expect(routeMap.publicCfp.access).toBe("public");
    expect(routeMap.reviewerAssignments.access).toBe("reviewer");
    expect(routeMap.speakerContent.access).toBe("speaker");
    expect(routeMap.submitterSubmissions.access).toBe("authenticated");
    expect(routeMap.events.access).toBe("organizer");
    expect(routeMap.deliverables).toMatchObject({ method: "GET", module: "files", access: "organizer" });
    expect(routeMap.fileComments).toMatchObject({ method: "GET", module: "files", access: "authenticated" });
    expect(routeMap.createFileComment).toMatchObject({ method: "POST", module: "files", access: "authenticated" });
    expect(routeMap.embeds).toMatchObject({ method: "GET", module: "embeds", access: "organizer" });
    expect(routeMap.createEmbed).toMatchObject({ method: "POST", module: "embeds", access: "organizer" });
    expect(routeMap.publicEmbed).toMatchObject({ method: "GET", module: "public", access: "public" });
    expect(routeMap.updateAgendaSessionContent).toMatchObject({
      method: "PATCH",
      path: "/api/events/:eventId/agenda/sessions/:sessionId/content",
      module: "agenda",
      access: "organizer",
    });
  });

  it("publishes every reviewer invitation door with its actual access", () => {
    expect([
      peopleRouteMap.reviewerInvite,
      peopleRouteMap.acceptReviewerInvite,
      peopleRouteMap.upgradeReviewerInvite,
    ]).toEqual([
      {
        method: "GET",
        path: "/api/reviewer-invites/:inviteId",
        module: "people",
        access: "public",
      },
      {
        method: "POST",
        path: "/api/reviewer-invites/:inviteId/accept",
        module: "people",
        access: "authenticated",
      },
      {
        method: "POST",
        path: "/api/events/:eventId/reviewer-invites/:inviteId/upgrade",
        module: "people",
        access: "organizer",
      },
    ]);
  });

  it("publishes the complete organizer communication-template contract", () => {
    expect([
      routeMap.commsRecipients,
      routeMap.createCommsTemplate,
      routeMap.updateCommsTemplate,
      routeMap.removeCommsTemplate,
      routeMap.queueCommsTemplateDrafts,
    ]).toEqual([
      {
        method: "GET",
        path: "/api/events/:eventId/comms/recipients",
        module: "communications",
        access: "organizer",
      },
      {
        method: "POST",
        path: "/api/events/:eventId/comms/templates",
        module: "communications",
        access: "organizer",
      },
      {
        method: "PATCH",
        path: "/api/events/:eventId/comms/templates/:key",
        module: "communications",
        access: "organizer",
      },
      {
        method: "DELETE",
        path: "/api/events/:eventId/comms/templates/:key",
        module: "communications",
        access: "organizer",
      },
      {
        method: "POST",
        path: "/api/events/:eventId/comms/templates/:key/drafts",
        module: "communications",
        access: "organizer",
      },
    ]);
  });

  it("keeps recusal a reviewer's own action, separate from an organizer decision", () => {
    expect(reviewRouteMap.recusal).toEqual({
      method: "POST",
      path: "/api/review/submissions/:submissionId/recusal",
      module: "reviews",
      access: "reviewer",
    });
    expect(reviewRouteMap.status.access).toBe("organizer");
  });
});
