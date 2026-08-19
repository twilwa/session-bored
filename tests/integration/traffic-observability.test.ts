// ABOUTME: Exercises request traffic logging through the real Worker and static asset binding.
// ABOUTME: Verifies public responses stay unchanged while safe request metadata is recorded once.
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../../worker/index.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

function trafficLogLines(calls: unknown[][]): string[] {
  return calls
    .map(([entry]) => entry)
    .filter((entry): entry is string =>
      typeof entry === "string" && entry.startsWith('{"event":"http_request",')
    );
}

describe("traffic observability", () => {
  it("logs the homepage once while preserving the static asset response", async () => {
    const url = "http://example.test/";
    const headers = {
      referer: "https://judge.example/results?token=secret",
      "user-agent": "Python-urllib/3.14",
    };
    const expected = await env.ASSETS.fetch(url, { headers });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const response = await worker.request(url, { headers }, env);

    expect(response.status).toBe(expected.status);
    expect(response.headers.get("content-type")).toBe(expected.headers.get("content-type"));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array(await expected.arrayBuffer()),
    );
    expect(trafficLogLines(log.mock.calls)).toEqual([JSON.stringify({
      event: "http_request",
      method: "GET",
      path: "/",
      status: 200,
      actorUserId: null,
      agentCredentialId: null,
      userAgent: "Python-urllib/3.14",
      referer: "https://judge.example",
      country: null,
      asn: null,
    })]);
  });

  it("logs a built asset once while preserving its bytes and content type", async () => {
    const homepage = await env.ASSETS.fetch("http://example.test/");
    const assetPath = (await homepage.text()).match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
    expect(assetPath).toBeDefined();
    const url = `http://example.test${assetPath}`;
    const headers = { "user-agent": "GPTBot/1.2" };
    const expected = await env.ASSETS.fetch(url, { headers });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const response = await worker.request(url, { headers }, env);

    expect(response.status).toBe(expected.status);
    expect(response.headers.get("content-type")).toBe(expected.headers.get("content-type"));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array(await expected.arrayBuffer()),
    );
    expect(trafficLogLines(log.mock.calls)).toEqual([JSON.stringify({
      event: "http_request",
      method: "GET",
      path: assetPath,
      status: 200,
      actorUserId: null,
      agentCredentialId: null,
      userAgent: "GPTBot/1.2",
      referer: null,
      country: null,
      asn: null,
    })]);
  });

  it("logs the Worker-owned robots.txt response once", async () => {
    const url = "http://example.test/robots.txt";
    const headers = { "user-agent": "ChatGPT-User/1.0" };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const response = await worker.request(url, { headers }, env);

    expect(response.status).toBe(200);
    expect(trafficLogLines(log.mock.calls)).toEqual([JSON.stringify({
      event: "http_request",
      method: "GET",
      path: "/robots.txt",
      status: 200,
      actorUserId: null,
      agentCredentialId: null,
      userAgent: "ChatGPT-User/1.0",
      referer: null,
      country: null,
      asn: null,
    })]);
  });

  it("logs an API response once without recording its query string", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const response = await worker.request(
      "http://example.test/api/health?access_token=do-not-log",
      { headers: { "user-agent": "Mozilla/5.0" } },
      env,
    );

    expect(response.status).toBe(200);
    expect(trafficLogLines(log.mock.calls)).toEqual([JSON.stringify({
      event: "http_request",
      method: "GET",
      path: "/api/health",
      status: 200,
      actorUserId: null,
      agentCredentialId: null,
      userAgent: "Mozilla/5.0",
      referer: null,
      country: null,
      asn: null,
    })]);
  });

  it("uses the route template instead of logging a token-bearing path", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const response = await worker.request(
      "http://example.test/api/reviewer-invites/private-token?authorization=do-not-log",
      { headers: { "user-agent": "Mozilla/5.0" } },
      env,
    );

    expect(response.status).toBe(404);
    const requestLogs = trafficLogLines(log.mock.calls);
    expect(requestLogs).toEqual([JSON.stringify({
      event: "http_request",
      method: "GET",
      path: "/api/reviewer-invites/:inviteId",
      status: 404,
      actorUserId: null,
      agentCredentialId: null,
      userAgent: "Mozilla/5.0",
      referer: null,
      country: null,
      asn: null,
    })]);
    expect(requestLogs[0]).not.toContain("private-token");
    expect(requestLogs[0]).not.toContain("do-not-log");
  });

  it("uses route templates for capability-bearing SPA paths", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const requests = [
      ["/invitations/private-invite-capability", "/invitations/:inviteId"],
      ["/cfp/devflow-conf-2027/submissions/private-submission-capability", "/cfp/:slug/submissions/:accessKey"],
    ] as const;

    for (const [path] of requests) {
      await worker.request(`http://example.test${path}`, undefined, env);
    }

    const requestLogs = trafficLogLines(log.mock.calls);
    expect(requestLogs.map((entry) => JSON.parse(entry).path)).toEqual(
      requests.map(([, routeTemplate]) => routeTemplate),
    );
    expect(requestLogs.join("\n")).not.toContain("private-");
  });

  it("attributes bearer requests without logging their secret", async () => {
    await worker.request("http://example.test/api/health", undefined, env);
    const signIn = await worker.request("http://example.test/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "sbek-organizer@example.com",
        password: "SbekTest!2027-org",
      }),
    }, env);
    const cookie = signIn.headers.get("set-cookie")?.split(";")[0] ?? "";
    const session = await worker.request("http://example.test/api/session", {
      headers: { cookie },
    }, env);
    const { user } = await session.json<{ user: { id: string } }>();
    const issuedResponse = await worker.request("http://example.test/api/agent-credentials", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Observable agent", role: "organizer" }),
    }, env);
    const issued = await issuedResponse.json<{ credential: { id: string }; token: string }>();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const response = await worker.request("http://example.test/api/events", {
      headers: { authorization: `Bearer ${issued.token}` },
    }, env);

    expect(response.status).toBe(200);
    const requestLogs = trafficLogLines(log.mock.calls);
    expect(requestLogs).toHaveLength(1);
    expect(JSON.parse(requestLogs[0]!)).toMatchObject({
      event: "http_request",
      method: "GET",
      path: "/api/events",
      status: 200,
      actorUserId: user.id,
      agentCredentialId: issued.credential.id,
    });
    expect(requestLogs[0]).not.toContain(issued.token);
  });
});
