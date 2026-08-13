// ABOUTME: Proves the speaker portal is scoped strictly to the signed-in speaker's own records.
// ABOUTME: Covers unauthenticated 401s, role-boundary 403s, and cross-speaker ownership denial.
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
  formData.append("displayedRequestKind", "document");
  return formData;
}

const priyaCredentials = { email: "sbek-speaker@example.com", password: "SbekTest!2027-spk" };
const marcusCredentials = { email: "sbek-speaker2@example.com", password: "SbekTest!2027-spk2" };
const organizerCredentials = { email: "sbek-organizer@example.com", password: "SbekTest!2027-org" };
const reviewerCredentials = { email: "sbek-reviewer@example.com", password: "SbekTest!2027-rev" };

describe("speaker portal authorization", () => {
  let priyaCookie: string;
  let marcusCookie: string;
  let organizerCookie: string;
  let reviewerCookie: string;
  let priyaSessionId: string;

  beforeEach(async () => {
    await request("/api/health");
    priyaCookie = await signIn(priyaCredentials.email, priyaCredentials.password);
    marcusCookie = await signIn(marcusCredentials.email, marcusCredentials.password);
    organizerCookie = await signIn(organizerCredentials.email, organizerCredentials.password);
    reviewerCookie = await signIn(reviewerCredentials.email, reviewerCredentials.password);

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

  it("requires authentication for every portal mutation and the private download", async () => {
    const operations: Array<{ path: string; init: RequestInit }> = [
      {
        path: "/api/portal/profile",
        init: { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ bio: "x" }) },
      },
      { path: "/api/portal/profile/headshot", init: { method: "POST", body: pdfUpload("headshot.png") } },
      {
        path: "/api/portal/sessions/ses_docs_retrieval",
        init: { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "x" }) },
      },
      {
        path: "/api/portal/tasks/tsk_fixture_0",
        init: { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "completed" }) },
      },
      { path: "/api/portal/tasks/tsk_fixture_1/files", init: { method: "POST", body: pdfUpload("slides.pdf") } },
      { path: "/api/portal/files/fil_missing", init: { method: "GET" } },
    ];
    for (const operation of operations) {
      const response = await request(operation.path, operation.init);
      expect(response.status, operation.path).toBe(401);
    }
  });

  it("blocks organizers and reviewers from every speaker-only portal mutation", async () => {
    for (const cookie of [organizerCookie, reviewerCookie]) {
      expect((await request("/api/portal/profile", {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ bio: "x" }),
      })).status).toBe(403);
      expect((await request("/api/portal/profile/headshot", {
        method: "POST",
        headers: { cookie },
        body: pdfUpload("headshot.png"),
      })).status).toBe(403);
      expect((await request(`/api/portal/sessions/${priyaSessionId}`, {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ title: "x" }),
      })).status).toBe(403);
      expect((await request("/api/portal/tasks/tsk_fixture_0", {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ status: "completed" }),
      })).status).toBe(403);
      expect((await request("/api/portal/tasks/tsk_fixture_1/files", {
        method: "POST",
        headers: { cookie },
        body: pdfUpload("slides.pdf"),
      })).status).toBe(403);
    }
  });

  it("blocks a speaker from reading or writing another speaker's session", async () => {
    const crossSpeaker = await request(`/api/portal/sessions/${priyaSessionId}`, {
      method: "PATCH",
      headers: { cookie: marcusCookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "Hijacked title" }),
    });
    expect(crossSpeaker.status).toBe(403);

    const own = await request(`/api/portal/sessions/${priyaSessionId}`, {
      method: "PATCH",
      headers: { cookie: priyaCookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "Taming CI, revised" }),
    });
    expect(own.status).toBe(200);
  });

  it("blocks a speaker from completing or uploading to another speaker's task", async () => {
    const complete = await request("/api/portal/tasks/tsk_fixture_0", {
      method: "PATCH",
      headers: { cookie: marcusCookie, "content-type": "application/json" },
      body: JSON.stringify({ status: "completed" }),
    });
    expect(complete.status).toBe(403);

    const upload = await request("/api/portal/tasks/tsk_fixture_1/files", {
      method: "POST",
      headers: { cookie: marcusCookie },
      body: pdfUpload("headshot.png"),
    });
    expect(upload.status).toBe(403);

    const own = await request("/api/portal/tasks/tsk_fixture_0", {
      method: "PATCH",
      headers: { cookie: priyaCookie, "content-type": "application/json" },
      body: JSON.stringify({ status: "completed" }),
    });
    expect(own.status).toBe(200);
  });

  it("blocks a speaker from downloading another speaker's file, while the owner and any organizer can", async () => {
    const upload = await request("/api/portal/tasks/tsk_fixture_3/files", {
      method: "POST",
      headers: { cookie: priyaCookie },
      body: pdfUpload("slides.pdf"),
    });
    expect(upload.status).toBe(201);
    const { fileId } = await upload.json<{ fileId: string }>();

    const blocked = await request(`/api/portal/files/${fileId}`, { headers: { cookie: marcusCookie } });
    expect(blocked.status).toBe(403);

    const ownerAllowed = await request(`/api/portal/files/${fileId}`, { headers: { cookie: priyaCookie } });
    expect(ownerAllowed.status).toBe(200);

    const organizerAllowed = await request(`/api/portal/files/${fileId}`, { headers: { cookie: organizerCookie } });
    expect(organizerAllowed.status).toBe(200);

    const reviewerBlocked = await request(`/api/portal/files/${fileId}`, { headers: { cookie: reviewerCookie } });
    expect(reviewerBlocked.status).toBe(403);
  });

  it("scopes a superseded version to the same owners as the newest one", async () => {
    await request("/api/portal/tasks/tsk_fixture_3/files", {
      method: "POST",
      headers: { cookie: priyaCookie },
      body: pdfUpload("slides-v1.pdf"),
    });
    const replaced = await request("/api/portal/tasks/tsk_fixture_3/files", {
      method: "POST",
      headers: { cookie: priyaCookie },
      body: pdfUpload("slides-v2.pdf"),
    });
    const { fileId, version } = await replaced.json<{ fileId: string; version: number }>();
    const supersededUrl = `/api/portal/files/${fileId}?version=${version - 1}`;

    expect((await request(supersededUrl)).status).toBe(401);
    expect((await request(supersededUrl, { headers: { cookie: marcusCookie } })).status).toBe(403);
    expect((await request(supersededUrl, { headers: { cookie: reviewerCookie } })).status).toBe(403);
    expect((await request(supersededUrl, { headers: { cookie: priyaCookie } })).status).toBe(200);
    expect((await request(supersededUrl, { headers: { cookie: organizerCookie } })).status).toBe(200);
  });
});
