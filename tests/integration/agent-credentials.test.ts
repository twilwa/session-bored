// ABOUTME: Exercises issued agent credentials through Greenroom's real authentication middleware.
// ABOUTME: Proves bearer access remains revocable, role-pinned, and human-confirmed where required.
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";
import { agentCredentials } from "../../db/schema.ts";
import worker from "../../worker/index.ts";
import { grantRole, revokeRole } from "../../worker/roles.ts";

async function request(path: string, init?: RequestInit): Promise<Response> {
  return worker.request(`http://example.test${path}`, init, env);
}

async function signIn(email: string, password: string): Promise<string> {
  const response = await request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

describe("agent credentials", () => {
  it("issues an organizer credential that authenticates the described HTTP surface", async () => {
    await request("/api/health");
    const cookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");

    const issuedResponse = await request("/api/agent-credentials", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "CFP operations", role: "organizer" }),
    });

    expect(issuedResponse.status).toBe(201);
    expect(issuedResponse.headers.get("cache-control")).toBe("no-store");
    const issued = await issuedResponse.json<{
      credential: { id: string; name: string; role: string };
      token: string;
    }>();
    expect(issued.credential).toMatchObject({
      name: "CFP operations",
      role: "organizer",
      lastUsedAt: null,
      revokedAt: null,
    });
    expect(issued.token).toMatch(/^greenroom_/);
    const [stored] = await drizzle(env.DB)
      .select({ secretDigest: agentCredentials.secretDigest })
      .from(agentCredentials)
      .where(eq(agentCredentials.id, issued.credential.id));
    expect(stored?.secretDigest).not.toBe(issued.token);
    expect(stored?.secretDigest).toMatch(/^[0-9a-f]{64}$/);

    const eventsResponse = await request("/api/events", {
      headers: { authorization: `Bearer ${issued.token}` },
    });
    expect(eventsResponse.status).toBe(200);
    const events = await eventsResponse.json<{ items: Array<{ id: string }> }>();
    expect(events.items.map((event) => event.id)).toContain("evt_devflow_conf_2027");

    const eventResponse = await request("/api/events/evt_devflow_conf_2027", {
      headers: { authorization: `Bearer ${issued.token}` },
    });
    const originalEvent = await eventResponse.json<Record<string, unknown>>();
    try {
      const updateResponse = await request("/api/events/evt_devflow_conf_2027", {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${issued.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ ...originalEvent, tagline: "Updated through an issued agent credential" }),
      });
      expect(updateResponse.status).toBe(200);
      const refreshed = await request("/api/events/evt_devflow_conf_2027", {
        headers: { authorization: `Bearer ${issued.token}` },
      });
      await expect(refreshed.json()).resolves.toMatchObject({
        tagline: "Updated through an issued agent credential",
      });
    } finally {
      const restoreResponse = await request("/api/events/evt_devflow_conf_2027", {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(originalEvent),
      });
      expect(restoreResponse.status).toBe(200);
    }
    const historyResponse = await request("/api/agent-credentials", { headers: { cookie } });
    const history = await historyResponse.json<{
      items: Array<{ id: string; lastUsedAt: string | null }>;
    }>();
    expect(history.items.find(({ id }) => id === issued.credential.id)?.lastUsedAt).toEqual(
      expect.any(String),
    );
  });

  it("pins a reviewer credential to its originating grant below the account's broader live grant union", async () => {
    await request("/api/health");
    const cookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");
    const session = await request("/api/session", { headers: { cookie } });
    const { user } = await session.json<{ user: { id: string } }>();
    const database = drizzle(env.DB);
    let reviewerGrantLive = false;
    await grantRole(database, {
      userId: user.id,
      role: "reviewer",
      source: "organizer",
      grantedByUserId: user.id,
    });
    reviewerGrantLive = true;

    try {
      const issuedResponse = await request("/api/agent-credentials", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Review helper", role: "reviewer" }),
      });
      expect(issuedResponse.status).toBe(201);
      const { token } = await issuedResponse.json<{ token: string }>();
      const headers = { authorization: `Bearer ${token}` };

      const agentSession = await request("/api/session", { headers });
      expect(agentSession.status).toBe(200);
      const agentIdentity = await agentSession.json<{ user: { role: string; roles: string[] } }>();
      expect(agentIdentity.user).toMatchObject({ role: "reviewer", roles: ["reviewer"] });
      expect((await request("/api/review/queue", { headers })).status).toBe(200);
      expect((await request("/api/events", { headers })).status).toBe(403);
      expect((await request("/api/events", { headers: { cookie } })).status).toBe(200);
      await revokeRole(database, { userId: user.id, role: "reviewer", revokedByUserId: user.id });
      reviewerGrantLive = false;
      expect((await request("/api/session", { headers })).status).toBe(401);
      await grantRole(database, {
        userId: user.id,
        role: "reviewer",
        source: "organizer",
        grantedByUserId: user.id,
      });
      reviewerGrantLive = true;
      expect((await request("/api/session", { headers })).status).toBe(401);
      expect((await request("/api/events", { headers: { cookie } })).status).toBe(200);
    } finally {
      if (reviewerGrantLive) {
        await revokeRole(database, { userId: user.id, role: "reviewer", revokedByUserId: user.id });
      }
    }
  });

  it("revokes an issued credential without deleting its record", async () => {
    await request("/api/health");
    const cookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");
    const issuedResponse = await request("/api/agent-credentials", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Temporary automation", role: "organizer" }),
    });
    const { credential, token } = await issuedResponse.json<{
      credential: { id: string };
      token: string;
    }>();
    expect((await request("/api/events", {
      headers: { authorization: `Bearer ${token}` },
    })).status).toBe(200);

    const revokeResponse = await request(`/api/agent-credentials/${credential.id}/revoke`, {
      method: "POST",
      headers: { cookie },
    });

    expect(revokeResponse.status).toBe(200);
    await expect(revokeResponse.json()).resolves.toMatchObject({
      credential: { id: credential.id, revokedAt: expect.any(String) },
    });
    expect((await request("/api/events", {
      headers: { authorization: `Bearer ${token}` },
    })).status).toBe(401);
    const history = await request("/api/agent-credentials", { headers: { cookie } });
    const historyBody = await history.json<{
      items: Array<{ id: string; revokedAt: string | null }>;
    }>();
    expect(historyBody.items).toContainEqual(expect.objectContaining({
      id: credential.id,
      revokedAt: expect.any(String),
    }));
  });

  it("requires a human browser session for irreversible organizer actions", async () => {
    await request("/api/health");
    const cookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");
    const issuedResponse = await request("/api/agent-credentials", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Bounded organizer", role: "organizer" }),
    });
    const { token } = await issuedResponse.json<{ token: string }>();
    const operations = [
      { method: "POST", path: "/api/events/evt_devflow_conf_2027/agenda/publish" },
      { method: "PATCH", path: "/api/events/evt_devflow_conf_2027/disposition" },
      { method: "POST", path: "/api/events/evt_devflow_conf_2027/decision-batches/batch_example/dispatch" },
      { method: "POST", path: "/api/events/evt_devflow_conf_2027/email-dispatches/eml_example/send" },
      { method: "DELETE", path: "/api/events/evt_devflow_conf_2027/speakers/spk_priya_devflow_2027" },
    ];

    for (const operation of operations) {
      const response = await request(operation.path, {
        method: operation.method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ status: "accepted" }),
      });
      expect(response.status, `${operation.method} ${operation.path}`).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: "human_confirmation_required" });
    }
  });

  it("lists credential history for its owner without re-exposing secrets", async () => {
    await request("/api/health");
    const cookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");
    const issuedResponse = await request("/api/agent-credentials", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Visible history", role: "organizer" }),
    });
    const issued = await issuedResponse.json<{ credential: { id: string }; token: string }>();

    const listResponse = await request("/api/agent-credentials", { headers: { cookie } });

    expect(listResponse.status).toBe(200);
    expect(listResponse.headers.get("cache-control")).toBe("no-store");
    const body = await listResponse.text();
    expect(body).not.toContain(issued.token);
    expect(body).not.toContain("secretDigest");
    const { items } = JSON.parse(body) as {
      items: Array<{ id: string; name: string; role: string; revokedAt: string | null }>;
    };
    expect(items).toContainEqual(expect.objectContaining({
      id: issued.credential.id,
      name: "Visible history",
      role: "organizer",
      revokedAt: null,
    }));

    const bearerResponse = await request("/api/agent-credentials", {
      headers: { authorization: `Bearer ${issued.token}` },
    });
    expect(bearerResponse.status).toBe(403);
    await expect(bearerResponse.json()).resolves.toEqual({ error: "browser_session_required" });
  });

  it("never falls back to a broader browser session when a bearer credential is presented", async () => {
    await request("/api/health");
    const cookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");

    const response = await request("/api/events", {
      headers: {
        authorization: "Bearer greenroom_invalid",
        cookie,
      },
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "authentication_required" });
    expect((await request("/api/events", { headers: { cookie } })).status).toBe(200);
  });

  it("refuses to issue a credential for a role the account does not hold", async () => {
    await request("/api/health");
    const cookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");

    const response = await request("/api/agent-credentials", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Escalation attempt", role: "speaker" }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "issued_role_not_granted" });
  });
});
