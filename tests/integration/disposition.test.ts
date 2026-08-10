// ABOUTME: Verifies disposition behavior through authenticated Worker requests and real D1 state.
// ABOUTME: Protects silent decisions, deliberate dispatch, and idempotent acceptance handoffs.
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
    body: JSON.stringify({
      email,
      password,
    }),
  });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

const protectedDecisionOperations: Array<{
  name: string;
  path: string;
  init: RequestInit;
}> = [
  {
    name: "set a single decision",
    path: "/api/events/evt_devflow_conf_2027/disposition",
    init: {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        submissionIds: ["sub_ci_monorepo"],
        status: "accepted",
      }),
    },
  },
  {
    name: "set decisions in bulk",
    path: "/api/events/evt_devflow_conf_2027/disposition",
    init: {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        submissionIds: ["sub_ci_monorepo", "sub_ai_verification"],
        status: "declined",
      }),
    },
  },
  {
    name: "preview a decision batch",
    path: "/api/events/evt_devflow_conf_2027/decision-batches",
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ submissionIds: ["sub_ci_monorepo"] }),
    },
  },
  {
    name: "dispatch a decision batch",
    path: "/api/events/evt_devflow_conf_2027/decision-batches/eml_missing/dispatch",
    init: { method: "POST" },
  },
];

async function expectDecisionOperationStatus(
  expectedStatus: number,
  cookie?: string,
): Promise<void> {
  for (const operation of protectedDecisionOperations) {
    const headers = new Headers(operation.init.headers);
    if (cookie !== undefined) {
      headers.set("cookie", cookie);
    }
    expect(
      (await request(operation.path, { ...operation.init, headers })).status,
      operation.name,
    ).toBe(expectedStatus);
  }
}

describe("submission disposition", () => {
  let cookie: string;

  beforeEach(async () => {
    await request("/api/health");
    cookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");
  });

  it("requires authentication for every decision operation", async () => {
    await expectDecisionOperationStatus(401);
  });

  it("blocks reviewers from every decision operation", async () => {
    const reviewerCookie = await signIn(
      "sbek-reviewer@example.com",
      "SbekTest!2027-rev",
    );
    await expectDecisionOperationStatus(403, reviewerCookie);
  });

  it("blocks speakers from every decision operation", async () => {
    const speakerCookie = await signIn(
      "sbek-speaker@example.com",
      "SbekTest!2027-spk",
    );
    await expectDecisionOperationStatus(403, speakerCookie);
  });

  it("rejects invalid disposition and decision-batch inputs", async () => {
    const organizerHeaders = { cookie, "content-type": "application/json" };
    const invalidDispositionPayloads = [
      { submissionIds: [], status: "accepted" },
      { submissionIds: ["sub_ci_monorepo"], status: "rejected" },
      { submissionIds: ["not-a-submission"], status: "accepted" },
    ];
    for (const payload of invalidDispositionPayloads) {
      const response = await request("/api/events/evt_devflow_conf_2027/disposition", {
        method: "PATCH",
        headers: organizerHeaders,
        body: JSON.stringify(payload),
      });
      expect(response.status).toBe(400);
    }
    expect((await request("/api/events/evt_devflow_conf_2027/disposition", {
      method: "PATCH",
      headers: organizerHeaders,
      body: "{",
    })).status).toBe(400);

    for (const submissionIds of [[], ["not-a-submission"]]) {
      const response = await request(
        "/api/events/evt_devflow_conf_2027/decision-batches",
        {
          method: "POST",
          headers: organizerHeaders,
          body: JSON.stringify({ submissionIds }),
        },
      );
      expect(response.status).toBe(400);
    }
    expect((await request(
      "/api/events/evt_devflow_conf_2027/decision-batches",
      {
        method: "POST",
        headers: organizerHeaders,
        body: "{",
      },
    )).status).toBe(400);
    expect((await request(
      "/api/events/evt_devflow_conf_2027/decision-batches/eml_missing/dispatch",
      { method: "POST", headers: { cookie } },
    )).status).toBe(404);
  });

  it("changes individual and bulk decisions without creating notification side effects", async () => {
    const before = await env.DB.prepare("select count(*) as count from email_dispatch").first<{
      count: number;
    }>();
    const noticesBefore = await env.DB.prepare(
      "select count(*) as count from decision_notice",
    ).first<{ count: number }>();

    const individual = await request("/api/events/evt_devflow_conf_2027/disposition", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ submissionIds: ["sub_ci_monorepo"], status: "maybe" }),
    });
    expect(individual.status).toBe(200);
    await expect(individual.json()).resolves.toMatchObject({
      notificationMode: "silent",
      updated: [{ id: "sub_ci_monorepo", status: "maybe" }],
    });

    const bulk = await request("/api/events/evt_devflow_conf_2027/disposition", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        submissionIds: ["sub_ai_verification", "sub_docs_retrieval"],
        status: "accepted",
      }),
    });
    expect(bulk.status).toBe(200);
    await expect(bulk.json()).resolves.toMatchObject({
      notificationMode: "silent",
      updated: [
        { id: "sub_ai_verification", status: "accepted" },
        { id: "sub_docs_retrieval", status: "accepted" },
      ],
    });

    const after = await env.DB.prepare("select count(*) as count from email_dispatch").first<{
      count: number;
    }>();
    expect(after?.count).toBe(before?.count);
    const noticesAfter = await env.DB.prepare(
      "select count(*) as count from decision_notice",
    ).first<{ count: number }>();
    expect(noticesAfter?.count).toBe(noticesBefore?.count);
  });

  it("previews every decision recipient and queues the same batch only once", async () => {
    await request("/api/events/evt_devflow_conf_2027/disposition", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ submissionIds: ["sub_ci_monorepo"], status: "accepted" }),
    });
    await request("/api/events/evt_devflow_conf_2027/disposition", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ submissionIds: ["sub_ai_verification"], status: "declined" }),
    });

    const previewResponse = await request(
      "/api/events/evt_devflow_conf_2027/decision-batches",
      {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          submissionIds: ["sub_ci_monorepo", "sub_ai_verification"],
        }),
      },
    );
    expect(previewResponse.status).toBe(201);
    const preview = await previewResponse.json<{
      id: string;
      status: string;
      items: Array<{
        submissionId: string;
        recipientEmail: string;
        recipientName: string;
        outcome: string;
        subject: string;
        body: string;
      }>;
    }>();
    expect(preview.status).toBe("draft");
    expect(preview.items).toEqual([
      expect.objectContaining({
        submissionId: "sub_ci_monorepo",
        recipientEmail: "sbek-speaker@example.com",
        recipientName: "Priya Raman",
        outcome: "accepted",
      }),
      expect.objectContaining({
        submissionId: "sub_ai_verification",
        recipientEmail: "sbek-speaker@example.com",
        recipientName: "Priya Raman",
        outcome: "declined",
      }),
    ]);
    expect(preview.items.every((item) => item.subject.length > 0 && item.body.length > 0)).toBe(true);

    const firstDispatch = await request(
      `/api/events/evt_devflow_conf_2027/decision-batches/${preview.id}/dispatch`,
      { method: "POST", headers: { cookie } },
    );
    expect(firstDispatch.status).toBe(200);
    await expect(firstDispatch.json()).resolves.toMatchObject({
      status: "queued",
      queuedCount: 2,
      skippedCount: 0,
      emailDelivery: "not_configured",
    });

    const secondDispatch = await request(
      `/api/events/evt_devflow_conf_2027/decision-batches/${preview.id}/dispatch`,
      { method: "POST", headers: { cookie } },
    );
    expect(secondDispatch.status).toBe(200);
    await expect(secondDispatch.json()).resolves.toMatchObject({
      status: "queued",
      queuedCount: 0,
      skippedCount: 2,
      emailDelivery: "not_configured",
    });

    const notices = await env.DB.prepare(
      "select count(*) as count from decision_notice where batch_id = ?",
    ).bind(preview.id).first<{ count: number }>();
    expect(notices?.count).toBe(2);
  });

  it("accepts without re-entry and reuses the same speaker, session, and onboarding tasks", async () => {
    async function accept() {
      const response = await request("/api/events/evt_devflow_conf_2027/disposition", {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ submissionIds: ["sub_ci_monorepo"], status: "accepted" }),
      });
      expect(response.status).toBe(200);
      return response.json<{
        handoffs: Array<{
          submissionId: string;
          active: boolean;
          session: {
            id: string;
            title: string;
            abstract: string;
            trackId: string;
            formatId: string;
          };
          speakers: Array<{
            id: string;
            name: string;
            email: string;
            jobTitle: string;
            organization: string;
            bio: string;
          }>;
          tasks: Array<{ id: string; title: string }>;
        }>;
      }>();
    }

    const first = await accept();
    expect(first.handoffs).toHaveLength(1);
    expect(first.handoffs[0]).toMatchObject({
      submissionId: "sub_ci_monorepo",
      active: true,
      session: {
        title: "Taming 40-Minute CI: Incremental Builds at Monorepo Scale",
        trackId: "trk_platform_infra",
        formatId: "fmt_talk_30",
      },
      speakers: [
        {
          id: "spk_priya_devflow_2027",
          name: "Priya Raman",
          email: "sbek-speaker@example.com",
          jobTitle: "Principal Engineer",
          organization: "Latticework Systems",
        },
      ],
    });
    expect(first.handoffs[0]?.session.abstract).toContain("Our monorepo CI took 40 minutes");
    expect(first.handoffs[0]?.speakers[0]?.bio).toContain("build-tooling platform team");
    expect(first.handoffs[0]?.tasks.map((task) => task.title)).toEqual([
      "Confirm participation",
      "Upload headshot",
      "Complete bio and profile",
      "Upload final slides by 2027-05-01",
      "Sign speaker release form",
    ]);

    const second = await accept();
    expect(second.handoffs[0]?.session.id).toBe(first.handoffs[0]?.session.id);
    expect(second.handoffs[0]?.speakers.map((speaker) => speaker.id)).toEqual(
      first.handoffs[0]?.speakers.map((speaker) => speaker.id),
    );
    expect(second.handoffs[0]?.tasks.map((task) => task.id)).toEqual(
      first.handoffs[0]?.tasks.map((task) => task.id),
    );
  });

  it("un-accepts by retaining downstream records and restores the same handoff on re-accept", async () => {
    const acceptResponse = await request("/api/events/evt_devflow_conf_2027/disposition", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ submissionIds: ["sub_ci_monorepo"], status: "accepted" }),
    });
    const accepted = await acceptResponse.json<{
      handoffs: Array<{
        session: { id: string };
        speakers: Array<{ id: string }>;
        tasks: Array<{ id: string }>;
      }>;
    }>();

    const reverseResponse = await request("/api/events/evt_devflow_conf_2027/disposition", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ submissionIds: ["sub_ci_monorepo"], status: "maybe" }),
    });
    expect(reverseResponse.status).toBe(200);
    await expect(reverseResponse.json()).resolves.toMatchObject({
      notificationMode: "silent",
      retainedHandoffs: [
        {
          submissionId: "sub_ci_monorepo",
          active: false,
          retained: true,
          sessionId: accepted.handoffs[0]?.session.id,
          contentStatus: "draft",
          schedulePreserved: true,
        },
      ],
    });

    const sessionsResponse = await request(
      "/api/events/evt_devflow_conf_2027/sessions",
      { headers: { cookie } },
    );
    const sessionRows = await sessionsResponse.json<{
      items: Array<{ id: string; submissionId: string; contentStatus: string }>;
    }>();
    expect(sessionRows.items.filter((session) => session.submissionId === "sub_ci_monorepo")).toEqual([
      expect.objectContaining({
        id: accepted.handoffs[0]?.session.id,
        contentStatus: "draft",
      }),
    ]);

    const speakersResponse = await request(
      "/api/events/evt_devflow_conf_2027/speakers",
      { headers: { cookie } },
    );
    const speakerRows = await speakersResponse.json<{ items: Array<{ id: string }> }>();
    expect(speakerRows.items.filter((speaker) =>
      accepted.handoffs[0]?.speakers.some((acceptedSpeaker) => acceptedSpeaker.id === speaker.id)
    )).toHaveLength(accepted.handoffs[0]?.speakers.length ?? 0);

    const reacceptResponse = await request("/api/events/evt_devflow_conf_2027/disposition", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ submissionIds: ["sub_ci_monorepo"], status: "accepted" }),
    });
    const reaccepted = await reacceptResponse.json<typeof accepted>();
    expect(reaccepted.handoffs[0]?.session.id).toBe(accepted.handoffs[0]?.session.id);
    expect(reaccepted.handoffs[0]?.speakers.map((speaker) => speaker.id)).toEqual(
      accepted.handoffs[0]?.speakers.map((speaker) => speaker.id),
    );
    expect(reaccepted.handoffs[0]?.tasks.map((task) => task.id)).toEqual(
      accepted.handoffs[0]?.tasks.map((task) => task.id),
    );
  });

  it("flags a submission whose decision diverges after dispatch", async () => {
    await request("/api/events/evt_devflow_conf_2027/disposition", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ submissionIds: ["sub_docs_retrieval"], status: "accepted" }),
    });
    const previewResponse = await request(
      "/api/events/evt_devflow_conf_2027/decision-batches",
      {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ submissionIds: ["sub_docs_retrieval"] }),
      },
    );
    const preview = await previewResponse.json<{ id: string }>();
    await request(
      `/api/events/evt_devflow_conf_2027/decision-batches/${preview.id}/dispatch`,
      { method: "POST", headers: { cookie } },
    );

    await request("/api/events/evt_devflow_conf_2027/disposition", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ submissionIds: ["sub_docs_retrieval"], status: "maybe" }),
    });
    const listResponse = await request(
      "/api/events/evt_devflow_conf_2027/disposition",
      { headers: { cookie } },
    );
    expect(listResponse.status).toBe(200);
    const list = await listResponse.json<{
      items: Array<{
        id: string;
        status: string;
        diverged: boolean;
        notice: null | { outcome: string; deliveryStatus: string; queuedAt: string };
      }>;
    }>();
    expect(list.items.find((item) => item.id === "sub_docs_retrieval")).toMatchObject({
      status: "maybe",
      diverged: true,
      notice: {
        outcome: "accepted",
        deliveryStatus: "queued",
      },
    });
  });
});
