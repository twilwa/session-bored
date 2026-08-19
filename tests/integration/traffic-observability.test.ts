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
});
