// ABOUTME: Exercises the speaker portal's self-service round trips against real D1 and R2 bindings.
// ABOUTME: Covers headshot and file upload retrieval, task completion, versioning, and server-side limits.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
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
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

function fileUpload(name: string, type: string, bytes: number[]): FormData {
  const formData = new FormData();
  formData.append("file", new File([new Uint8Array(bytes)], name, { type }));
  return formData;
}

function pdfUpload(name: string): FormData {
  return fileUpload(name, "application/pdf", [1, 2, 3, 4]);
}

const priyaCredentials = { email: "sbek-speaker@example.com", password: "SbekTest!2027-spk" };
const organizerCredentials = { email: "sbek-organizer@example.com", password: "SbekTest!2027-org" };

describe("speaker portal content", () => {
  let priyaCookie: string;
  let priyaSessionId: string;

  beforeEach(async () => {
    await request("/api/health");
    priyaCookie = await signIn(priyaCredentials.email, priyaCredentials.password);
    const organizerCookie = await signIn(organizerCredentials.email, organizerCredentials.password);
    const accept = await request("/api/events/evt_devflow_conf_2027/disposition", {
      method: "PATCH",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({ submissionIds: ["sub_ci_monorepo"], status: "accepted" }),
    });
    const body = await accept.json<{ handoffs: Array<{ session: { id: string } }> }>();
    const sessionId = body.handoffs[0]?.session.id;
    if (sessionId === undefined) {
      throw new Error("Priya's onboarding session was not created by disposition");
    }
    priyaSessionId = sessionId;
  });

  it("uploads a headshot, marks the matching onboarding task complete, and serves it publicly and privately", async () => {
    const before = await request("/api/speaker/content", { headers: { cookie: priyaCookie } });
    const beforeBody = await before.json<{
      profile: { headshotUrl: string | null };
      tasks: Array<{ id: string; status: string }>;
    }>();
    expect(beforeBody.profile.headshotUrl).toBeNull();
    expect(beforeBody.tasks.find((task) => task.id === "tsk_fixture_1")?.status).not.toBe("completed");

    const missingPublic = await request("/api/public/portal/speakers/spk_priya_devflow_2027/headshot");
    expect(missingPublic.status).toBe(404);

    const upload = await request("/api/portal/profile/headshot", {
      method: "POST",
      headers: { cookie: priyaCookie },
      body: fileUpload("priya.png", "image/png", [137, 80, 78, 71]),
    });
    expect(upload.status).toBe(201);
    const uploadBody = await upload.json<{ fileId: string; version: number; headshotUrl: string }>();
    expect(uploadBody.version).toBe(1);

    const after = await request("/api/speaker/content", { headers: { cookie: priyaCookie } });
    const afterBody = await after.json<{
      profile: { headshotUrl: string | null };
      tasks: Array<{ id: string; status: string }>;
    }>();
    expect(afterBody.profile.headshotUrl).toBe(uploadBody.headshotUrl);
    expect(afterBody.tasks.find((task) => task.id === "tsk_fixture_1")?.status).toBe("completed");

    const publicResponse = await request(uploadBody.headshotUrl);
    expect(publicResponse.status).toBe(200);
    expect(publicResponse.headers.get("content-type")).toBe("image/png");
    expect([...new Uint8Array(await publicResponse.arrayBuffer())]).toEqual([137, 80, 78, 71]);

    const privateDownload = await request(`/api/portal/files/${uploadBody.fileId}`, {
      headers: { cookie: priyaCookie },
    });
    expect(privateDownload.status).toBe(200);
    expect(privateDownload.headers.get("content-disposition")).toContain("priya.png");
  });

  it("rejects a missing file, an oversized file, and a disallowed file type, all server-side with a human message", async () => {
    const missing = await request("/api/portal/tasks/tsk_fixture_3/files", {
      method: "POST",
      headers: { cookie: priyaCookie },
      body: new FormData(),
    });
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toMatchObject({ error: "file_required" });

    await env.DB.prepare("update task set maximum_file_bytes = ? where id = ?").bind(10, "tsk_fixture_3").run();
    const tooLarge = await request("/api/portal/tasks/tsk_fixture_3/files", {
      method: "POST",
      headers: { cookie: priyaCookie },
      body: fileUpload("slides.pdf", "application/pdf", new Array(20).fill(1)),
    });
    expect(tooLarge.status).toBe(413);
    const tooLargeBody = await tooLarge.json<{ error: string; message: string; maxBytes: number }>();
    expect(tooLargeBody).toMatchObject({ error: "file_too_large", maxBytes: 10 });
    expect(tooLargeBody.message.length).toBeGreaterThan(0);
    await env.DB.prepare("update task set maximum_file_bytes = NULL where id = ?").bind("tsk_fixture_3").run();

    await env.DB.prepare("update task set accepted_file_types = ? where id = ?")
      .bind(JSON.stringify(["pdf"]), "tsk_fixture_3")
      .run();
    const wrongType = await request("/api/portal/tasks/tsk_fixture_3/files", {
      method: "POST",
      headers: { cookie: priyaCookie },
      body: fileUpload("notes.exe", "application/x-msdownload", [1, 2, 3]),
    });
    expect(wrongType.status).toBe(415);
    const wrongTypeBody = await wrongType.json<{ error: string; message: string }>();
    expect(wrongTypeBody.error).toBe("unsupported_file_type");
    expect(wrongTypeBody.message.length).toBeGreaterThan(0);
    await env.DB.prepare("update task set accepted_file_types = NULL where id = ?").bind("tsk_fixture_3").run();
  });

  it("rejects a file upload against a general (non file-request) task", async () => {
    const response = await request("/api/portal/tasks/tsk_fixture_0/files", {
      method: "POST",
      headers: { cookie: priyaCookie },
      body: pdfUpload("notes.pdf"),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "task_not_file_request" });
  });

  it("uploads a slide deck, completes the task for the organizer-shared table, and keeps prior versions on replace", async () => {
    const first = await request("/api/portal/tasks/tsk_fixture_3/files", {
      method: "POST",
      headers: { cookie: priyaCookie },
      body: pdfUpload("slides-v1.pdf"),
    });
    expect(first.status).toBe(201);
    const firstBody = await first.json<{ fileId: string; version: number; status: string }>();
    expect(firstBody).toMatchObject({ version: 1, status: "completed" });

    const content = await request("/api/speaker/content", { headers: { cookie: priyaCookie } });
    const contentBody = await content.json<{
      tasks: Array<{ id: string; status: string; file: { fileId: string; displayName: string; version: number } | null }>;
    }>();
    const slidesTask = contentBody.tasks.find((task) => task.id === "tsk_fixture_3");
    expect(slidesTask?.status).toBe("completed");
    expect(slidesTask?.file).toMatchObject({ fileId: firstBody.fileId, displayName: "slides-v1.pdf", version: 1 });

    const assigneeRow = await env.DB.prepare(
      "select status from task_assignee where task_id = ? and speaker_id = ?",
    ).bind("tsk_fixture_3", "spk_priya_devflow_2027").first<{ status: string }>();
    expect(assigneeRow?.status).toBe("completed");

    const second = await request("/api/portal/tasks/tsk_fixture_3/files", {
      method: "POST",
      headers: { cookie: priyaCookie },
      body: pdfUpload("slides-v2.pdf"),
    });
    const secondBody = await second.json<{ fileId: string; version: number }>();
    expect(secondBody.fileId).toBe(firstBody.fileId);
    expect(secondBody.version).toBe(2);

    const latestDownload = await request(`/api/portal/files/${firstBody.fileId}`, {
      headers: { cookie: priyaCookie },
    });
    expect(latestDownload.headers.get("content-disposition")).toContain("slides-v2.pdf");

    const previousDownload = await request(`/api/portal/files/${firstBody.fileId}?version=1`, {
      headers: { cookie: priyaCookie },
    });
    expect(previousDownload.status).toBe(200);

    const versions = await env.DB.prepare(
      "select version, latest from file_version where file_id = ? order by version",
    ).bind(firstBody.fileId).all<{ version: number; latest: number }>();
    expect(versions.results).toEqual([
      { version: 1, latest: 0 },
      { version: 2, latest: 1 },
    ]);
  });

  it("saves the speaker's own bio and social links, and completes the matching profile task", async () => {
    const before = await request("/api/speaker/content", { headers: { cookie: priyaCookie } });
    const beforeBody = await before.json<{ tasks: Array<{ id: string; status: string }> }>();
    expect(beforeBody.tasks.find((task) => task.id === "tsk_fixture_2")?.status).not.toBe("completed");

    const response = await request("/api/portal/profile", {
      method: "PATCH",
      headers: { cookie: priyaCookie, "content-type": "application/json" },
      body: JSON.stringify({
        bio: "Updated bio for DevFlow.",
        twitter: "@priyabuilds2",
        socialLinks: { mastodon: "https://example.social/@priya" },
      }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      bio: "Updated bio for DevFlow.",
      twitter: "@priyabuilds2",
      socialLinks: { mastodon: "https://example.social/@priya" },
    });

    const after = await request("/api/speaker/content", { headers: { cookie: priyaCookie } });
    const afterBody = await after.json<{ tasks: Array<{ id: string; status: string }> }>();
    expect(afterBody.tasks.find((task) => task.id === "tsk_fixture_2")?.status).toBe("completed");
  });

  it("rejects an invalid profile update payload", async () => {
    const response = await request("/api/portal/profile", {
      method: "PATCH",
      headers: { cookie: priyaCookie, "content-type": "application/json" },
      body: JSON.stringify({ bio: 42 }),
    });
    expect(response.status).toBe(400);
  });

  it("edits the speaker's own session content while editable, and locks it once approved", async () => {
    const invalid = await request(`/api/portal/sessions/${priyaSessionId}`, {
      method: "PATCH",
      headers: { cookie: priyaCookie, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(invalid.status).toBe(400);

    const updated = await request(`/api/portal/sessions/${priyaSessionId}`, {
      method: "PATCH",
      headers: { cookie: priyaCookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "Taming 40-Minute CI (revised)", abstract: "An updated abstract." }),
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      title: "Taming 40-Minute CI (revised)",
      contentStatus: "in_review",
    });

    await env.DB.prepare("update program_session set content_status = 'approved' where id = ?")
      .bind(priyaSessionId)
      .run();
    const locked = await request(`/api/portal/sessions/${priyaSessionId}`, {
      method: "PATCH",
      headers: { cookie: priyaCookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "Should fail" }),
    });
    expect(locked.status).toBe(409);
  });
});
