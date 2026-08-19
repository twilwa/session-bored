// ABOUTME: Checks the agent mutation gate against Greenroom's generated organizer reference.
// ABOUTME: Keeps documented operations available while reserving hidden or irreversible writes.
import { describe, expect, it } from "vitest";
import { agentOperationIsDescribed } from "../../worker/agent-access.ts";
import { organizerOperations } from "../../worker/agent-reference.ts";

function examplePath(template: string): string {
  return template
    .split("/")
    .map((segment) => segment.startsWith(":") ? `example-${segment.slice(1)}` : segment)
    .join("/");
}

describe("agent operation access", () => {
  it("allows every mutation in the organizer reference", () => {
    for (const operation of organizerOperations.filter(({ route }) => route.method !== "GET")) {
      expect(
        agentOperationIsDescribed(operation.route.method, examplePath(operation.route.path)),
        `${operation.route.method} ${operation.route.path}`,
      ).toBe(true);
    }
  });

  it("keeps reads role-gated and reserves undescribed mutations for a human", () => {
    expect(agentOperationIsDescribed("GET", "/api/events/example")).toBe(true);
    expect(agentOperationIsDescribed("HEAD", "/api/events/example")).toBe(true);
    expect(agentOperationIsDescribed("OPTIONS", "/api/cfp-builder/forms/example")).toBe(true);
    expect(agentOperationIsDescribed("POST", "/api/events/example/agenda/publish")).toBe(false);
    expect(agentOperationIsDescribed("POST", "/api/people/example/grants")).toBe(false);
    expect(agentOperationIsDescribed("DELETE", "/api/events/example/tracks/example")).toBe(false);
  });

  it("requires mutation paths to match the complete documented template", () => {
    expect(agentOperationIsDescribed("PATCH", "/api/events/example")).toBe(true);
    expect(agentOperationIsDescribed("PATCH", "/api/events")).toBe(false);
    expect(agentOperationIsDescribed("PATCH", "/api/events/example/settings")).toBe(false);
    expect(agentOperationIsDescribed("PATCH", "/api/event/example")).toBe(false);
    expect(agentOperationIsDescribed("PATCH", "/api/events-settings/example")).toBe(false);
  });
});
