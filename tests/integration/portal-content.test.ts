// ABOUTME: Exercises the speaker portal's self-service round trips against real D1 and R2 bindings.
// ABOUTME: Covers headshot and file upload retrieval, task completion, versioning, and server-side limits.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { pictureRequestFileTypes } from "../../shared/api.ts";
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

/** A real PNG signature, so an upload that claims to be a png can actually be one. */
const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00];

/**
 * A multipart body written by hand, because `FormData` always supplies a part content type
 * and the case worth testing is a caller that supplies none. Pass `null` to omit the part's
 * `Content-Type` header entirely; pass a string to send exactly that value.
 */
function rawFileUpload(
  name: string,
  type: string | null,
  bytes: number[],
): { body: ArrayBuffer; contentType: string } {
  const boundary = "----greenroomtestboundary";
  const typeHeader = type === null ? "" : `Content-Type: ${type}\r\n`;
  const head = new TextEncoder().encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n${typeHeader}\r\n`,
  );
  const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0);
  body.set(new Uint8Array(bytes), head.length);
  body.set(tail, head.length + bytes.length);
  return { body: body.buffer, contentType: `multipart/form-data; boundary=${boundary}` };
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
    await env.DB.prepare("update person set headshot_url = null where id = ?")
      .bind("psn_priya_raman")
      .run();
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
      body: fileUpload("priya.png", "image/png", pngSignature),
    });
    expect(upload.status).toBe(201);
    const uploadBody = await upload.json<{ fileId: string; version: number; headshotUrl: string }>();
    expect(uploadBody.version).toBe(1);
    expect(uploadBody.headshotUrl).toBe("/api/public/portal/speakers/spk_priya_devflow_2027/headshot?version=1");

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
    expect([...new Uint8Array(await publicResponse.arrayBuffer())]).toEqual(pngSignature);

    const privateDownload = await request(`/api/portal/files/${uploadBody.fileId}`, {
      headers: { cookie: priyaCookie },
    });
    expect(privateDownload.status).toBe(200);
    expect(privateDownload.headers.get("content-disposition")).toContain("priya.png");
  });

  it("rejects HTML disguised as a headshot image, and the public endpoint never serves text/html regardless of stored data", async () => {
    const maliciousUpload = await request("/api/portal/profile/headshot", {
      method: "POST",
      headers: { cookie: priyaCookie },
      body: fileUpload("payload.png", "text/html", Array.from(new TextEncoder().encode("<script>evil()</script>"))),
    });
    expect(maliciousUpload.status).toBe(415);
    await expect(maliciousUpload.json()).resolves.toMatchObject({ error: "unsupported_file_type" });

    // Defense in depth: even if a bad mime type ever ended up stored (through some other path,
    // now or in the future), the public endpoint must derive Content-Type from the extension
    // rather than trust the stored value — so simulate that directly, bypassing validation.
    const anyUser = await env.DB.prepare("select id from user limit 1").first<{ id: string }>();
    const key = "portal/evt_devflow_conf_2027/spk_marcus_devflow_2027/fil_bogus_headshot/fver_bogus-payload.png";
    await env.FILES.put(key, new TextEncoder().encode("<script>evil()</script>"), {
      httpMetadata: { contentType: "text/html" },
    });
    const now = Date.now();
    await env.DB.prepare(
      "insert into file (id, event_id, speaker_id, kind, display_name, created_at, updated_at) values (?, ?, ?, 'headshot', ?, ?, ?)",
    ).bind("fil_bogus_headshot", "evt_devflow_conf_2027", "spk_marcus_devflow_2027", "payload.png", now, now).run();
    await env.DB.prepare(
      "insert into file_version (id, file_id, version, storage_key, mime_type, size_bytes, latest, uploaded_by_user_id, created_at, updated_at) values (?, ?, 1, ?, 'text/html', ?, 1, ?, ?, ?)",
    ).bind("fver_bogus_headshot", "fil_bogus_headshot", key, 27, anyUser?.id, now, now).run();

    const publicResponse = await request("/api/public/portal/speakers/spk_marcus_devflow_2027/headshot");
    expect(publicResponse.status).toBe(200);
    expect(publicResponse.headers.get("content-type")).not.toBe("text/html");
    expect(publicResponse.headers.get("content-type")).toBe("image/png");
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

  it("gives the seeded headshot request its picture types on a database seeded before they existed", async () => {
    // The exact state of a database seeded by an earlier build: the fixture marker is already
    // there, so `ensureSeeded` returns early, and the "Upload headshot" request still declares
    // no type - which makes it a document request that refuses the picture its title asks for.
    await env.DB.prepare("update task set accepted_file_types = NULL where id = ?").bind("tsk_fixture_1").run();
    await env.DB.prepare("delete from system_state where key = ?")
      .bind("fixture.devflow-2027.headshot-request.v1").run();

    // Seeding again is the upgrade a deployed environment gets.
    expect((await request("/api/health")).status).toBe(200);

    const [row] = (await env.DB.prepare("select accepted_file_types from task where id = ?")
      .bind("tsk_fixture_1").all<{ accepted_file_types: string | null }>()).results;
    expect(row?.accepted_file_types).not.toBeNull();
    expect(JSON.parse(row?.accepted_file_types ?? "null")).toEqual(pictureRequestFileTypes);

    const content = await request("/api/speaker/content", { headers: { cookie: priyaCookie } });
    const body = await content.json<{ tasks: Array<{ id: string; acceptedFileTypes: string[] | null }> }>();
    expect(body.tasks.find((task) => task.id === "tsk_fixture_1")?.acceptedFileTypes)
      .toEqual(pictureRequestFileTypes);

    // And the request now takes the headshot its title asks for.
    const upload = await request("/api/portal/tasks/tsk_fixture_1/files", {
      method: "POST",
      headers: { cookie: priyaCookie },
      body: fileUpload("seeded-headshot.png", "image/png", pngSignature),
    });
    expect(upload.status).toBe(201);
  });

  it("satisfies an organizer's picture request with a png, states that request's own accepted types, and makes it the speaker's headshot", async () => {
    const organizerCookie = await signIn(organizerCredentials.email, organizerCredentials.password);
    const created = await request("/api/events/evt_devflow_conf_2027/tasks", {
      method: "POST",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({
        taskType: "file_request",
        acceptedFileTypes: pictureRequestFileTypes,
        title: "Send us a speaker picture",
        speakerIds: ["spk_priya_devflow_2027"],
      }),
    });
    expect(created.status).toBe(201);
    const { id: pictureTaskId } = await created.json<{ id: string }>();
    await env.DB.prepare("update person set headshot_url = null where id = ?").bind("psn_priya_raman").run();

    const before = await request("/api/speaker/content", { headers: { cookie: priyaCookie } });
    const beforeBody = await before.json<{
      tasks: Array<{ id: string; acceptedFileTypes: string[] | null; maximumFileBytes: number | null }>;
    }>();
    const pictureTask = beforeBody.tasks.find((task) => task.id === pictureTaskId);
    // The speaker is told what this request takes, not what documents another request takes.
    expect(pictureTask?.acceptedFileTypes).toEqual(pictureRequestFileTypes);
    expect(pictureTask?.maximumFileBytes).toBe(5 * 1024 * 1024);

    const upload = await request(`/api/portal/tasks/${pictureTaskId}/files`, {
      method: "POST",
      headers: { cookie: priyaCookie },
      body: fileUpload("priya.png", "image/png", pngSignature),
    });
    expect(upload.status).toBe(201);
    const uploadBody = await upload.json<{ fileId: string; status: string; headshotUrl: string | null }>();
    expect(uploadBody.status).toBe("completed");
    expect(uploadBody.headshotUrl).toMatch(/^\/api\/public\/portal\/speakers\/spk_priya_devflow_2027\/headshot\?version=\d+$/);

    const after = await request("/api/speaker/content", { headers: { cookie: priyaCookie } });
    const afterBody = await after.json<{
      profile: { headshotUrl: string | null };
      tasks: Array<{ id: string; status: string; file: { displayName: string } | null }>;
    }>();
    // Asking for a headshot through a task lands the same place the headshot picker does.
    expect(afterBody.profile.headshotUrl).toBe(uploadBody.headshotUrl);
    const satisfied = afterBody.tasks.find((task) => task.id === pictureTaskId);
    expect(satisfied?.status).toBe("completed");
    expect(satisfied?.file?.displayName).toBe("priya.png");

    const publicHeadshot = await request(uploadBody.headshotUrl ?? "");
    expect(publicHeadshot.status).toBe(200);
    expect(publicHeadshot.headers.get("content-type")).toBe("image/png");

    // Widening what a request accepts never widens who can read the deliverable itself.
    const unauthenticated = await request(`/api/portal/files/${uploadBody.fileId}`);
    expect(unauthenticated.status).toBe(401);
  });

  it("rejects HTML disguised as a picture on a picture request, the stored-XSS payload this widening could have let back in", async () => {
    const organizerCookie = await signIn(organizerCredentials.email, organizerCredentials.password);
    const created = await request("/api/events/evt_devflow_conf_2027/tasks", {
      method: "POST",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({
        taskType: "file_request",
        acceptedFileTypes: pictureRequestFileTypes,
        title: "Send us a conference picture",
        speakerIds: ["spk_priya_devflow_2027"],
      }),
    });
    const { id: pictureTaskId } = await created.json<{ id: string }>();

    const malicious = await request(`/api/portal/tasks/${pictureTaskId}/files`, {
      method: "POST",
      headers: { cookie: priyaCookie },
      body: fileUpload("payload.png", "text/html", Array.from(new TextEncoder().encode("<script>evil()</script>"))),
    });
    expect(malicious.status).toBe(415);
    await expect(malicious.json()).resolves.toMatchObject({ error: "unsupported_file_type" });

    const assignee = await env.DB.prepare(
      "select status from task_assignee where task_id = ? and speaker_id = ?",
    ).bind(pictureTaskId, "spk_priya_devflow_2027").first<{ status: string }>();
    expect(assignee?.status).not.toBe("completed");
    const stored = await env.DB.prepare("select count(*) as total from file where task_id = ?")
      .bind(pictureTaskId)
      .first<{ total: number }>();
    expect(stored?.total).toBe(0);
  });

  it("refuses a picture upload that declares no content type, on both doors and at every step of the public path", async () => {
    const organizerCookie = await signIn(organizerCredentials.email, organizerCredentials.password);
    const created = await request("/api/events/evt_devflow_conf_2027/tasks", {
      method: "POST",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({
        taskType: "file_request",
        acceptedFileTypes: pictureRequestFileTypes,
        title: "Send us an undeclared picture",
        speakerIds: ["spk_priya_devflow_2027"],
      }),
    });
    const { id: pictureTaskId } = await created.json<{ id: string }>();
    await env.DB.prepare("update person set headshot_url = null where id = ?").bind("psn_priya_raman").run();
    const html = Array.from(new TextEncoder().encode("<html><script>evil()</script></html>"));

    // A caller controls the declared content type, so declining to declare one has to cost
    // exactly what lying about it costs. Both doors a picture can arrive through, and every
    // shape an absent declaration takes.
    const undeclared: Array<[string, string | null]> = [
      ["header omitted entirely", null],
      ["header present but empty", ""],
      ["header whitespace only", "   "],
      ["header not a mime type", "png"],
    ];
    for (const [why, declaredType] of undeclared) {
      for (const path of [`/api/portal/tasks/${pictureTaskId}/files`, "/api/portal/profile/headshot"]) {
        const { body, contentType } = rawFileUpload("payload.png", declaredType, html);
        const response = await request(path, {
          method: "POST",
          headers: { cookie: priyaCookie, "content-type": contentType },
          body,
        });
        expect(response.status, `${path} with ${why}`).toBe(415);
        await expect(response.json()).resolves.toMatchObject({ error: "unsupported_file_type" });
      }
    }

    const assignee = await env.DB.prepare(
      "select status from task_assignee where task_id = ? and speaker_id = ?",
    ).bind(pictureTaskId, "spk_priya_devflow_2027").first<{ status: string }>();
    expect(assignee?.status).not.toBe("completed");
    const stored = await env.DB.prepare("select count(*) as total from file where task_id = ?")
      .bind(pictureTaskId)
      .first<{ total: number }>();
    expect(stored?.total).toBe(0);
    // Nothing reached the unauthenticated endpoint the original stored XSS was served from.
    const headshot = await env.DB.prepare("select headshot_url from person where id = ?")
      .bind("psn_priya_raman")
      .first<{ headshot_url: string | null }>();
    expect(headshot?.headshot_url).toBeNull();

    // And the same refusal for bytes that are not the image both halves truthfully claim.
    const { body, contentType } = rawFileUpload("payload.png", "image/png", html);
    const lyingBytes = await request(`/api/portal/tasks/${pictureTaskId}/files`, {
      method: "POST",
      headers: { cookie: priyaCookie, "content-type": contentType },
      body,
    });
    expect(lyingBytes.status).toBe(415);
  });

  it("serves a public headshot with nosniff, so the declared type is enforced rather than hoped for", async () => {
    const upload = await request("/api/portal/profile/headshot", {
      method: "POST",
      headers: { cookie: priyaCookie },
      body: fileUpload("priya.png", "image/png", pngSignature),
    });
    expect(upload.status).toBe(201);
    const { headshotUrl } = await upload.json<{ headshotUrl: string }>();

    const served = await request(headshotUrl);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(served.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

    // The unversioned form resolves the latest version, so a cache must keep asking.
    const latest = await request("/api/public/portal/speakers/spk_priya_devflow_2027/headshot");
    expect(latest.status).toBe(200);
    expect(latest.headers.get("cache-control")).toBe("public, max-age=300");
  });

  it("answers a malformed version query with not found on both headshot and file routes", async () => {
    const upload = await request("/api/portal/profile/headshot", {
      method: "POST",
      headers: { cookie: priyaCookie },
      body: fileUpload("priya.png", "image/png", pngSignature),
    });
    expect(upload.status).toBe(201);
    const { fileId } = await upload.json<{ fileId: string }>();

    const publicResponse = await request(
      "/api/public/portal/speakers/spk_priya_devflow_2027/headshot?version=abc",
    );
    expect(publicResponse.status).toBe(404);

    const privateResponse = await request(`/api/portal/files/${fileId}?version=abc`, {
      headers: { cookie: priyaCookie },
    });
    expect(privateResponse.status).toBe(404);
  });

  it("gives a replacement its own public URL, so a fresh request cannot return the previous headshot bytes", async () => {
    const first = await request("/api/portal/profile/headshot", {
      method: "POST",
      headers: { cookie: priyaCookie },
      body: fileUpload("priya-first.png", "image/png", pngSignature),
    });
    expect(first.status).toBe(201);
    const firstBody = await first.json<{ headshotUrl: string; version: number }>();

    const replacementBytes = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10];
    const second = await request("/api/portal/profile/headshot", {
      method: "POST",
      headers: { cookie: priyaCookie },
      body: fileUpload("priya-second.jpg", "image/jpeg", replacementBytes),
    });
    expect(second.status).toBe(201);
    const secondBody = await second.json<{ headshotUrl: string; version: number }>();

    expect(secondBody.version).toBe(firstBody.version + 1);
    expect(secondBody.headshotUrl).not.toBe(firstBody.headshotUrl);
    const firstServed = await request(firstBody.headshotUrl);
    // Each version serves under its own format, not the label of whatever replaced it.
    expect(firstServed.headers.get("content-type")).toBe("image/png");
    expect([...new Uint8Array(await firstServed.arrayBuffer())]).toEqual(pngSignature);
    const secondServed = await request(secondBody.headshotUrl);
    expect(secondServed.headers.get("content-type")).toBe("image/jpeg");
    expect([...new Uint8Array(await secondServed.arrayBuffer())]).toEqual(replacementBytes);

    const profile = await request("/api/speaker/content", { headers: { cookie: priyaCookie } });
    await expect(profile.json()).resolves.toMatchObject({ profile: { headshotUrl: secondBody.headshotUrl } });
  });

  it("lets the seeded headshot request take a headshot on a freshly seeded deployment", async () => {
    // The sample event ships the bug report's own task. It has to demonstrate the
    // capability rather than refuse the file its title asks for.
    const content = await request("/api/speaker/content", { headers: { cookie: priyaCookie } });
    const { tasks } = await content.json<{
      tasks: Array<{ id: string; title: string; acceptedFileTypes: string[] | null; maximumFileBytes: number | null }>;
    }>();
    const seededHeadshotTask = tasks.find((task) => task.title === "Upload headshot");
    expect(seededHeadshotTask?.acceptedFileTypes).toEqual(pictureRequestFileTypes);
    expect(seededHeadshotTask?.maximumFileBytes).toBe(5 * 1024 * 1024);

    const upload = await request(`/api/portal/tasks/${seededHeadshotTask?.id}/files`, {
      method: "POST",
      headers: { cookie: priyaCookie },
      body: fileUpload("priya.png", "image/png", pngSignature),
    });
    expect(upload.status).toBe(201);
    await expect(upload.json()).resolves.toMatchObject({
      status: "completed",
      headshotUrl: expect.stringMatching(/^\/api\/public\/portal\/speakers\/spk_priya_devflow_2027\/headshot\?version=\d+$/),
    });
  });

  it("keeps a request that declares nothing a document request, naming its real types when it refuses a picture", async () => {
    const content = await request("/api/speaker/content", { headers: { cookie: priyaCookie } });
    const contentBody = await content.json<{
      tasks: Array<{ id: string; acceptedFileTypes: string[] | null; maximumFileBytes: number | null }>;
    }>();
    const documentTask = contentBody.tasks.find((task) => task.id === "tsk_fixture_3");
    expect(documentTask?.acceptedFileTypes).toEqual(["pdf", "ppt", "pptx", "doc", "docx", "zip", "key"]);
    expect(documentTask?.maximumFileBytes).toBe(25 * 1024 * 1024);

    const refused = await request("/api/portal/tasks/tsk_fixture_3/files", {
      method: "POST",
      headers: { cookie: priyaCookie },
      body: fileUpload("priya.png", "image/png", pngSignature),
    });
    expect(refused.status).toBe(415);
    await expect(refused.json()).resolves.toMatchObject({
      error: "unsupported_file_type",
      acceptedExtensions: ["pdf", "ppt", "pptx", "doc", "docx", "zip", "key"],
    });
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

  it("lists every version of a replaced file with its own name, size, and download link", async () => {
    await request("/api/portal/tasks/tsk_fixture_3/files", {
      method: "POST",
      headers: { cookie: priyaCookie },
      body: pdfUpload("qa-slides-v1.pdf"),
    });
    const replaced = await request("/api/portal/tasks/tsk_fixture_3/files", {
      method: "POST",
      headers: { cookie: priyaCookie },
      body: fileUpload("qa-slides-v2.pdf", "application/pdf", [1, 2, 3, 4, 5, 6]),
    });
    const { fileId } = await replaced.json<{ fileId: string }>();

    const content = await request("/api/speaker/content", { headers: { cookie: priyaCookie } });
    const contentBody = await content.json<{
      files: Array<{
        fileId: string;
        versions: Array<{
          version: number;
          displayName: string;
          sizeBytes: number;
          uploadedAt: string;
          current: boolean;
          downloadUrl: string;
        }>;
      }>;
    }>();
    const versions = contentBody.files.find((file) => file.fileId === fileId)?.versions ?? [];
    const numbers = versions.map((version) => version.version);
    expect(numbers.length).toBeGreaterThanOrEqual(2);
    expect(numbers).toEqual([...numbers].sort((first, second) => second - first));
    expect(versions[0]).toMatchObject({
      displayName: "qa-slides-v2.pdf",
      sizeBytes: 6,
      current: true,
      downloadUrl: `/api/portal/files/${fileId}?version=${numbers[0] ?? 0}`,
    });
    expect(versions[1]).toMatchObject({
      displayName: "qa-slides-v1.pdf",
      sizeBytes: 4,
      current: false,
      downloadUrl: `/api/portal/files/${fileId}?version=${numbers[1] ?? 0}`,
    });
    expect(versions.filter((version) => version.current)).toHaveLength(1);
    expect(Number.isNaN(Date.parse(versions[0]?.uploadedAt ?? ""))).toBe(false);

    // Every link the history offers must actually resolve to that version's own bytes and name.
    for (const version of versions) {
      const download = await request(version.downloadUrl, { headers: { cookie: priyaCookie } });
      expect(download.status).toBe(200);
      expect(download.headers.get("content-disposition")).toContain(version.displayName);
      expect((await download.arrayBuffer()).byteLength).toBe(version.sizeBytes);
    }
  });

  it("tells the speaker their proposal was accepted and never shows the committee's silent status", async () => {
    const content = await request("/api/speaker/content", { headers: { cookie: priyaCookie } });
    const body = await content.json<{
      submissions: Array<{ id: string; title: string | null; speakerStatus: string; status?: string }>;
    }>();

    // The accepted proposal stays on the speaker's own list rather than disappearing from it.
    const accepted = body.submissions.find((submission) => submission.id === "sub_ci_monorepo");
    expect(accepted?.speakerStatus).toBe("accepted");

    // `maybe` is committee vocabulary and never leaves the server for a speaker.
    await env.DB.prepare("update submission set status = 'maybe' where id = ?").bind("sub_ai_verification").run();
    const shortlisted = await request("/api/speaker/content", { headers: { cookie: priyaCookie } });
    const shortlistedBody = await shortlisted.json<{
      submissions: Array<{ id: string; speakerStatus: string }>;
    }>();
    expect(shortlistedBody.submissions.find((submission) => submission.id === "sub_ai_verification")?.speakerStatus)
      .toBe("in_review");
    expect(JSON.stringify(shortlistedBody)).not.toContain("maybe");

    // A decline stays silent until the organizer dispatches its letter.
    await env.DB.prepare("update submission set status = 'declined' where id = ?").bind("sub_ai_verification").run();
    const declined = await request("/api/speaker/content", { headers: { cookie: priyaCookie } });
    const declinedBody = await declined.json<{ submissions: Array<{ id: string; speakerStatus: string }> }>();
    expect(declinedBody.submissions.find((submission) => submission.id === "sub_ai_verification")?.speakerStatus)
      .toBe("in_review");

    const now = Date.now();
    await env.DB.prepare(
      "insert into decision_notice (id, batch_id, submission_id, outcome, recipient_name, recipient_email, subject, body, delivery_status, queued_at, created_at, updated_at) values (?, ?, ?, 'declined', ?, ?, ?, ?, 'sent', ?, ?, ?)",
    ).bind(
      "eml_test_notice",
      "eml_test_batch",
      "sub_ai_verification",
      "Priya Raman",
      "priya@example.test",
      "Your DevFlow proposal",
      "Thank you for submitting.",
      now,
      now,
      now,
    ).run();
    const notified = await request("/api/speaker/content", { headers: { cookie: priyaCookie } });
    const notifiedBody = await notified.json<{ submissions: Array<{ id: string; speakerStatus: string }> }>();
    expect(notifiedBody.submissions.find((submission) => submission.id === "sub_ai_verification")?.speakerStatus)
      .toBe("not_selected");
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
