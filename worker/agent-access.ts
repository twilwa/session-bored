// ABOUTME: Limits bearer-authenticated mutations to the organizer operations Greenroom documents for agents.
// ABOUTME: Leaves reads role-gated while reserving every undescribed mutation for a browser session.
import { organizerOperations } from "./agent-reference.ts";

const readMethods = new Set(["GET", "HEAD", "OPTIONS"]);

function matchesPath(path: string, template: string): boolean {
  const pathSegments = path.split("/").filter(Boolean);
  const templateSegments = template.split("/").filter(Boolean);
  return pathSegments.length === templateSegments.length && templateSegments.every(
    (segment, index) => segment.startsWith(":") || segment === pathSegments[index],
  );
}

export function agentOperationIsDescribed(method: string, path: string): boolean {
  if (readMethods.has(method)) {
    return true;
  }
  return organizerOperations.some(
    (operation) => operation.route.method === method
      && matchesPath(path, operation.route.path),
  );
}
