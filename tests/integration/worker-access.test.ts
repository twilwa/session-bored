// ABOUTME: Exercises seeded password login and role/resource scoping through real Worker requests.
// ABOUTME: Verifies public access, exact reviewer assignments, speaker ownership, and seed idempotence.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../../worker/index.ts";

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
  const cookie = response.headers.get("set-cookie");
  expect(cookie).toBeTruthy();
  return cookie?.split(";")[0] ?? "";
}

describe("Worker foundation", () => {
  it("opens a seeded, signed-in review board through one public GET", async () => {
    const demoResponse = await request("/demo", { redirect: "manual" });

    expect(demoResponse.status).toBe(302);
    expect(demoResponse.headers.get("location")).toBe("/reviewer");
    const cookie = demoResponse.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect(cookie).not.toBe("");

    const sessionResponse = await request("/api/session", { headers: { cookie } });
    expect(sessionResponse.status).toBe(200);
    const session = await sessionResponse.json<{ user: { name: string; role: string } }>();
    expect(session.user).toMatchObject({ name: "Sam Whitfield", role: "reviewer" });

    const queueResponse = await request("/api/review/queue", { headers: { cookie } });
    expect(queueResponse.status).toBe(200);
    const queue = await queueResponse.json<{ items: Array<{ title: string }> }>();
    expect(queue.items.map((item) => item.title)).toContain(
      "Taming 40-Minute CI: Incremental Builds at Monorepo Scale",
    );

    const landing = await request("/reviewer", {
      headers: { cookie, accept: "text/html", "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" },
    });
    expect(landing.status).toBe(200);
    expect(await landing.text()).not.toContain("Sign in to your account");
  });

  it("refuses product mutations made through the demo session", async () => {
    const demoResponse = await request("/demo", { redirect: "manual" });
    const cookie = demoResponse.headers.get("set-cookie")?.split(";")[0] ?? "";
    const mutations = [
      { method: "POST", path: "/api/review/submissions/sub_ci_monorepo/comments" },
      { method: "DELETE", path: "/api/events/evt_devflow_conf_2027/speakers/spk_priya_devflow_2027" },
      { method: "POST", path: "/api/events/evt_devflow_conf_2027/agenda/publish" },
      { method: "PATCH", path: "/api/events/evt_devflow_conf_2027/disposition" },
      { method: "POST", path: "/api/events/evt_devflow_conf_2027/decision-batches/example/dispatch" },
      { method: "POST", path: "/api/events/evt_devflow_conf_2027/email-dispatches/example/send" },
    ];

    for (const mutation of mutations) {
      const response = await request(mutation.path, {
        method: mutation.method,
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ body: "A demo crawler must not persist this request." }),
      });

      expect(response.status, `${mutation.method} ${mutation.path}`).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: "demo_read_only" });
    }
  });

  it("lets a visitor leave the read-only demo session", async () => {
    const demoResponse = await request("/demo", { redirect: "manual" });
    const cookie = demoResponse.headers.get("set-cookie")?.split(";")[0] ?? "";

    const response = await request("/api/auth/sign-out", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("greenroom_demo=");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("seeds once and serves the CFP without authentication", async () => {
    expect((await request("/api/health")).status).toBe(200);
    expect((await request("/api/health")).status).toBe(200);

    const response = await request("/api/public/cfp/devflow-conf-2027");
    expect(response.status).toBe(200);
    const body = await response.json<{
      event: { name: string };
      tracks: string[];
      formats: string[];
    }>();
    expect(body.event.name).toBe("DevFlow Conf 2027");
    expect(body.tracks).toHaveLength(3);
    expect(body.formats).toHaveLength(5);

    const sessionsResponse = await request("/api/public/events/evt_devflow_conf_2027/sessions");
    expect(sessionsResponse.status).toBe(200);
    const sessions = await sessionsResponse.json<{ items: Array<{ title: string }> }>();
    expect(sessions.items.map((item) => item.title)).toContain(
      "Docs That Answer Back: Retrieval-Grounded Documentation Sites",
    );

    const count = await env.DB.prepare("select count(*) as count from event").first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it("blocks a reviewer from organizer routes and unassigned submissions", async () => {
    await request("/api/health");
    const cookie = await signIn("sbek-reviewer@example.com", "SbekTest!2027-rev");
    const headers = { cookie };

    expect((await request("/api/events", { headers })).status).toBe(403);
    const assignments = await request("/api/reviewer/assignments", { headers });
    expect(assignments.status).toBe(200);
    const body = await assignments.json<{ items: Array<{ submissionId: string }> }>();
    expect(body.items.map((item) => item.submissionId)).toEqual(["sub_ci_monorepo"]);
    expect((await request("/api/reviewer/submissions/sub_ci_monorepo", { headers })).status).toBe(200);
    expect((await request("/api/reviewer/submissions/sub_ai_verification", { headers })).status).toBe(403);
  });

  it("limits a speaker to their own submissions", async () => {
    await request("/api/health");
    const cookie = await signIn("sbek-speaker@example.com", "SbekTest!2027-spk");
    const headers = { cookie };

    expect((await request("/api/speaker/submissions/sub_ci_monorepo", { headers })).status).toBe(200);
    expect((await request("/api/speaker/submissions/sub_docs_retrieval", { headers })).status).toBe(403);
    expect((await request("/api/reviewer/assignments", { headers })).status).toBe(403);
  });

  it("accepts the seeded organizer password", async () => {
    await request("/api/health");
    const cookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");
    expect((await request("/api/events", { headers: { cookie } })).status).toBe(200);
  });

  it("answers a browser navigation to a signed-out workspace with a readable page, not a JSON body", async () => {
    await request("/api/health");
    for (const path of ["/organizer", "/reviewer", "/speaker", "/organizer/agenda", "/submitter"]) {
      const response = await request(path, {
        headers: {
          accept: "text/html,application/xhtml+xml",
          "sec-fetch-dest": "document",
          "sec-fetch-mode": "navigate",
        },
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("content-type")).toContain("text/html");
      const body = await response.text();
      expect(body).toContain("<!doctype html>");
      expect(body).toContain("Greenroom");
      expect(body).toContain(`href="/login?returnTo=${encodeURIComponent(path)}"`);
      expect(body).not.toContain('{"error"');
    }
  });

  it("keeps the JSON error body for API and XHR callers on the same protected paths", async () => {
    await request("/api/health");
    const xhr = await request("/organizer", {
      headers: { accept: "application/json", "sec-fetch-dest": "empty", "sec-fetch-mode": "cors" },
    });
    expect(xhr.status).toBe(401);
    expect(xhr.headers.get("content-type")).toContain("application/json");
    await expect(xhr.json()).resolves.toEqual({ error: "authentication_required" });

    const bare = await request("/speaker");
    expect(bare.status).toBe(401);
    await expect(bare.json()).resolves.toEqual({ error: "authentication_required" });
  });

  it("tells a signed-in visitor which workspace they landed in and where their own one is", async () => {
    await request("/api/health");
    const cookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");
    const response = await request("/reviewer", {
      headers: { cookie, accept: "text/html", "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" },
    });

    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain("text/html");
    const body = await response.text();
    expect(body).toContain("reviewer");
    expect(body).toContain("Jordan Alvarez");
    expect(body).toContain('href="/organizer"');
    expect(body).not.toContain('{"error"');

    const apiCall = await request("/reviewer", { headers: { cookie, "sec-fetch-dest": "empty" } });
    expect(apiCall.status).toBe(403);
    await expect(apiCall.json()).resolves.toEqual({ error: "forbidden" });
  });

  it("invalidates the current session on sign-out", async () => {
    await request("/api/health");
    const cookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");
    expect((await request("/api/session", { headers: { cookie } })).status).toBe(200);

    const response = await request("/api/auth/sign-out", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: "http://example.test" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);
    expect((await request("/api/session", { headers: { cookie } })).status).toBe(401);
  });
});
