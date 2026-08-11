// ABOUTME: Specifies the shared typed route catalog consumed by independent feature lanes.
// ABOUTME: Ensures every PRD module declares its method, path, and access requirement.
import { describe, expect, it } from "vitest";
import { routeMap } from "../../shared/api.ts";

describe("typed route map", () => {
  it("covers every planned product module", () => {
    const modules = new Set(Object.values(routeMap).map((route) => route.module));
    expect(modules).toEqual(
      new Set([
        "agenda",
        "auth",
        "communications",
        "embeds",
        "events",
        "files",
        "forms",
        "public",
        "reviews",
        "sessions",
        "speakers",
        "submissions",
        "tasks",
      ]),
    );
  });

  it("makes public and scoped access explicit", () => {
    expect(routeMap.publicCfp.access).toBe("public");
    expect(routeMap.reviewerAssignments.access).toBe("reviewer");
    expect(routeMap.speakerContent.access).toBe("speaker");
    expect(routeMap.submitterSubmissions.access).toBe("authenticated");
    expect(routeMap.events.access).toBe("organizer");
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
});
