// ABOUTME: Lets an organizer issue named agent credentials for roles their account currently holds.
// ABOUTME: Requires a browser session so bearer credentials cannot mint further credentials.
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { grantableRoles, type GrantableRole, type Role } from "../../db/schema.ts";
import { routeMap } from "../../shared/api.ts";
import { holdsAccess } from "../access.ts";
import {
  issueAgentCredential,
  listAgentCredentials,
  revokeAgentCredential,
} from "../agent-credentials.ts";
import type { AuthSession } from "../auth.ts";

type AgentCredentialEnvironment = {
  Bindings: CloudflareBindings;
  Variables: {
    authSession: AuthSession["session"] | null;
    authUser: AuthSession["user"] | null;
    roles: Role[] | null;
  };
};

const agentCredentialRoutes = new Hono<AgentCredentialEnvironment>();

const requireOrganizerSession = createMiddleware<AgentCredentialEnvironment>(async (context, next) => {
  const user = context.get("authUser");
  const roles = context.get("roles") ?? [];
  if (user === null) {
    return context.json({ error: "authentication_required" }, 401);
  }
  if (!holdsAccess(roles, "organizer")) {
    return context.json({ error: "forbidden" }, 403);
  }
  if (context.get("authSession") === null) {
    return context.json({ error: "browser_session_required" }, 403);
  }
  await next();
});

agentCredentialRoutes.get(
  routeMap.agentCredentials.path,
  requireOrganizerSession,
  async (context) => {
    context.header("cache-control", "no-store");
    return context.json({
      items: await listAgentCredentials(drizzle(context.env.DB), context.get("authUser")!.id),
      issuableRoles: grantableRoles.filter((role) => context.get("roles")?.includes(role)),
    });
  },
);

agentCredentialRoutes.post(
  routeMap.issueAgentCredential.path,
  requireOrganizerSession,
  async (context) => {
    const payload = await context.req.json<unknown>().catch(() => null);
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return context.json({ error: "validation_error", fields: { form: "Send a JSON object." } }, 400);
    }
    const values = payload as Record<string, unknown>;
    const name = typeof values.name === "string" ? values.name.trim() : "";
    const role = typeof values.role === "string" && grantableRoles.includes(values.role as GrantableRole)
      ? values.role as GrantableRole
      : null;
    if (name.length === 0 || name.length > 80 || role === null) {
      return context.json({
        error: "validation_error",
        fields: {
          ...(name.length === 0 || name.length > 80 ? { name: "Use a name between 1 and 80 characters." } : {}),
          ...(role === null ? { role: "Choose organizer, reviewer, or speaker." } : {}),
        },
      }, 400);
    }
    const issued = await issueAgentCredential(drizzle(context.env.DB), {
      userId: context.get("authUser")!.id,
      name,
      role,
    });
    if (issued === null) {
      return context.json({ error: "issued_role_not_granted" }, 403);
    }
    context.header("cache-control", "no-store");
    return context.json(issued, 201);
  },
);

agentCredentialRoutes.post(
  routeMap.revokeAgentCredential.path,
  requireOrganizerSession,
  async (context) => {
    const credential = await revokeAgentCredential(drizzle(context.env.DB), {
      credentialId: context.req.param("credentialId"),
      userId: context.get("authUser")!.id,
    });
    return credential === null
      ? context.json({ error: "not_found" }, 404)
      : context.json({ credential });
  },
);

export default agentCredentialRoutes;
