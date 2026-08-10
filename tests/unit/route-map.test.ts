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
});
