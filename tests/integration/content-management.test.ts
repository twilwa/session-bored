// ABOUTME: Verifies organizer deliverable tracking and cross-role file discussion through real HTTP routes.
// ABOUTME: Proves uploads, deadlines, approval state, and speaker ownership remain connected to canonical records.
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

function pdfUpload(name: string): FormData {
  const formData = new FormData();
  formData.append("file", new File([new Uint8Array([1, 2, 3, 4])], name, { type: "application/pdf" }));
  return formData;
}

const eventId = "evt_devflow_conf_2027";
const organizerCredentials = { email: "sbek-organizer@example.com", password: "SbekTest!2027-org" };
const priyaCredentials = { email: "sbek-speaker@example.com", password: "SbekTest!2027-spk" };
const marcusCredentials = { email: "sbek-speaker2@example.com", password: "SbekTest!2027-spk2" };

describe("content management", () => {
  let organizerCookie: string;
  let priyaCookie: string;
  let marcusCookie: string;

  beforeEach(async () => {
    await request("/api/health");
    organizerCookie = await signIn(organizerCredentials.email, organizerCredentials.password);
    priyaCookie = await signIn(priyaCredentials.email, priyaCredentials.password);
    marcusCookie = await signIn(marcusCredentials.email, marcusCredentials.password);
  });

  it("shows requested, overdue, and delivered file work from the canonical assignment and upload records", async () => {
    const overdueAt = "2026-08-01T12:00:00.000Z";
    const deadline = await request(`/api/events/${eventId}/tasks/tsk_fixture_1`, {
      method: "PATCH",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({ dueAt: overdueAt }),
    });
    expect(deadline.status).toBe(200);

    const upload = await request("/api/portal/tasks/tsk_fixture_3/files", {
      method: "POST",
      headers: { cookie: priyaCookie },
      body: pdfUpload("devflow-slides.pdf"),
    });
    expect(upload.status).toBe(201);
    const uploaded = await upload.json<{ fileId: string; version: number }>();

    const response = await request(`/api/events/${eventId}/deliverables`, {
      headers: { cookie: organizerCookie },
    });
    expect(response.status).toBe(200);
    const payload = await response.json<{
      metrics: { total: number; requested: number; overdue: number; delivered: number };
      items: Array<{
        taskId: string;
        speaker: { id: string; name: string; email: string };
        task: { title: string; dueAt: string | null };
        status: "requested" | "overdue" | "delivered";
        file: null | {
          id: string;
          displayName: string;
          version: number;
          sizeBytes: number;
          uploadedAt: string;
          downloadUrl: string;
        };
      }>;
    }>();

    expect(payload.metrics).toMatchObject({ total: 2, requested: 0, overdue: 1, delivered: 1 });
    expect(payload.items.find((item) => item.taskId === "tsk_fixture_1")).toMatchObject({
      speaker: { id: "spk_priya_devflow_2027", name: "Priya Raman", email: "sbek-speaker@example.com" },
      task: { title: "Upload headshot", dueAt: overdueAt },
      status: "overdue",
      file: null,
    });
    expect(payload.items.find((item) => item.taskId === "tsk_fixture_3")).toMatchObject({
      status: "delivered",
      file: {
        id: uploaded.fileId,
        displayName: "devflow-slides.pdf",
        version: uploaded.version,
        sizeBytes: 4,
        downloadUrl: `/api/portal/files/${uploaded.fileId}`,
      },
    });
  });

  it("surfaces session content awaiting approval without changing its status", async () => {
    const accepted = await request(`/api/events/${eventId}/disposition`, {
      method: "PATCH",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({ submissionIds: ["sub_ci_monorepo"], status: "accepted" }),
    });
    expect(accepted.status).toBe(200);
    const acceptedBody = await accepted.json<{ handoffs: Array<{ session: { id: string } }> }>();
    const sessionId = acceptedBody.handoffs[0]?.session.id;
    expect(sessionId).toBeDefined();

    const submittedForApproval = await request(`/api/portal/sessions/${sessionId}`, {
      method: "PATCH",
      headers: { cookie: priyaCookie, "content-type": "application/json" },
      body: JSON.stringify({
        title: "Taming CI in a 500-package monorepo",
        abstract: "Revised speaker copy ready for organizer approval.",
      }),
    });
    expect(submittedForApproval.status).toBe(200);

    const response = await request(`/api/events/${eventId}/deliverables`, {
      headers: { cookie: organizerCookie },
    });
    expect(response.status).toBe(200);
    const payload = await response.json<{
      metrics: { awaitingApproval: number };
      sessionsAwaitingApproval: Array<{
        id: string;
        title: string | null;
        contentStatus: string;
        speakers: Array<{ id: string; name: string }>;
      }>;
    }>();

    expect(payload.metrics.awaitingApproval).toBe(1);
    expect(payload.sessionsAwaitingApproval).toContainEqual({
      id: sessionId,
      title: "Taming CI in a 500-package monorepo",
      contentStatus: "in_review",
      speakers: [{ id: "spk_priya_devflow_2027", name: "Priya Raman" }],
    });
  });

  it("shares attributed file comments with the owner and organizer while refusing another speaker's file and thread", async () => {
    const upload = await request("/api/portal/tasks/tsk_fixture_3/files", {
      method: "POST",
      headers: { cookie: priyaCookie },
      body: pdfUpload("review-copy.pdf"),
    });
    expect(upload.status).toBe(201);
    const { fileId } = await upload.json<{ fileId: string }>();

    const organizerComment = await request(`/api/content/files/${fileId}/comments`, {
      method: "POST",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({ body: "Please add the event title to the opening slide." }),
    });
    expect(organizerComment.status).toBe(201);
    expect(await organizerComment.json()).toMatchObject({
      body: "Please add the event title to the opening slide.",
      author: { name: "Jordan Alvarez", role: "organizer" },
    });

    const speakerComment = await request(`/api/content/files/${fileId}/comments`, {
      method: "POST",
      headers: { cookie: priyaCookie, "content-type": "application/json" },
      body: JSON.stringify({ body: "Updated — the title is now on slide one." }),
    });
    expect(speakerComment.status).toBe(201);

    const ownerThread = await request(`/api/content/files/${fileId}/comments`, {
      headers: { cookie: priyaCookie },
    });
    expect(ownerThread.status).toBe(200);
    const thread = await ownerThread.json<{
      items: Array<{ id: string; body: string; createdAt: string; author: { name: string; role: string } }>;
    }>();
    expect(thread.items).toHaveLength(2);
    expect(thread.items.map((comment) => comment.author)).toEqual([
      { name: "Jordan Alvarez", role: "organizer" },
      { name: "Priya Raman", role: "speaker" },
    ]);
    expect(thread.items.every((comment) => comment.id.startsWith("cmt_") && !Number.isNaN(Date.parse(comment.createdAt)))).toBe(true);

    expect((await request(`/api/portal/files/${fileId}`, { headers: { cookie: marcusCookie } })).status).toBe(403);
    expect((await request(`/api/content/files/${fileId}/comments`, { headers: { cookie: marcusCookie } })).status).toBe(403);
    expect((await request(`/api/content/files/${fileId}/comments`, {
      method: "POST",
      headers: { cookie: marcusCookie, "content-type": "application/json" },
      body: JSON.stringify({ body: "I should never reach this thread." }),
    })).status).toBe(403);
  });
});
