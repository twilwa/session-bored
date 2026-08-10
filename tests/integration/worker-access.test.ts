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
});
