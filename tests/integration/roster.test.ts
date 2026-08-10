// ABOUTME: Verifies organizer roster and onboarding behavior through authenticated Worker requests.
// ABOUTME: Covers roster access, identity adoption, silent status changes, bulk tasks, and missing work.
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

describe("organizer speaker roster", () => {
  let organizerCookie: string;

  beforeEach(async () => {
    await request("/api/health");
    organizerCookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");
  });

  it("lists event speakers only for organizers", async () => {
    const path = "/api/events/evt_devflow_conf_2027/roster";
    expect((await request(path)).status).toBe(401);

    const reviewerCookie = await signIn("sbek-reviewer@example.com", "SbekTest!2027-rev");
    expect((await request(path, { headers: { cookie: reviewerCookie } })).status).toBe(403);

    const speakerCookie = await signIn("sbek-speaker@example.com", "SbekTest!2027-spk");
    expect((await request(path, { headers: { cookie: speakerCookie } })).status).toBe(403);

    const response = await request(path, { headers: { cookie: organizerCookie } });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      items: [
        {
          id: "spk_marcus_devflow_2027",
          name: "Marcus Okafor",
          email: "sbek-speaker2@example.com",
          status: "confirmed",
          profile: { bioComplete: true, headshotComplete: false },
          taskSummary: { total: 0, incomplete: 0 },
        },
        {
          id: "spk_priya_devflow_2027",
          name: "Priya Raman",
          email: "sbek-speaker@example.com",
          status: "onboarding",
          profile: { bioComplete: true, headshotComplete: false },
          taskSummary: { total: 5, incomplete: 5 },
        },
      ],
    });
  });

  it("adopts an existing person without duplicating the event speaker", async () => {
    const response = await request("/api/events/evt_devflow_conf_2027/speakers", {
      method: "POST",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Marcus Okafor",
        email: " SBEK-SPEAKER2@EXAMPLE.COM ",
        status: "onboarding",
      }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: "spk_marcus_devflow_2027",
      personId: "psn_marcus_okafor",
      adoptedExistingPerson: true,
      createdSpeaker: false,
    });

    const roster = await request("/api/events/evt_devflow_conf_2027/roster", {
      headers: { cookie: organizerCookie },
    });
    const payload = await roster.json<{ items: Array<{ id: string; email: string }> }>();
    expect(payload.items.filter((item) => item.email === "sbek-speaker2@example.com")).toEqual([
      expect.objectContaining({ id: "spk_marcus_devflow_2027" }),
    ]);
  });

  it("persists profile and workflow edits without sending notifications", async () => {
    const dispatchesBefore = await env.DB.prepare(
      "select count(*) as count from email_dispatch",
    ).first<{ count: number }>();
    const response = await request(
      "/api/events/evt_devflow_conf_2027/speakers/spk_marcus_devflow_2027",
      {
        method: "PATCH",
        headers: { cookie: organizerCookie, "content-type": "application/json" },
        body: JSON.stringify({
          name: "Marcus Okafor",
          jobTitle: "Principal Developer Advocate",
          organization: "Cloudreach Labs",
          bio: "Marcus helps engineering teams put reliable agents into production.",
          headshotUrl: "https://images.example.test/marcus.jpg",
          status: "ready",
        }),
      },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: "spk_marcus_devflow_2027",
      jobTitle: "Principal Developer Advocate",
      status: "ready",
      notificationSent: false,
    });

    const roster = await request("/api/events/evt_devflow_conf_2027/roster", {
      headers: { cookie: organizerCookie },
    });
    const payload = await roster.json<{
      items: Array<{
        id: string;
        jobTitle: string | null;
        status: string;
        profile: { bioComplete: boolean; headshotComplete: boolean };
      }>;
    }>();
    expect(payload.items.find((item) => item.id === "spk_marcus_devflow_2027")).toMatchObject({
      jobTitle: "Principal Developer Advocate",
      status: "ready",
      profile: { bioComplete: true, headshotComplete: true },
    });
    const dispatchesAfter = await env.DB.prepare(
      "select count(*) as count from email_dispatch",
    ).first<{ count: number }>();
    expect(dispatchesAfter?.count).toBe(dispatchesBefore?.count);
  });

  it("assigns one file request to many speakers at once", async () => {
    const response = await request("/api/events/evt_devflow_conf_2027/tasks", {
      method: "POST",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({
        taskType: "file_request",
        title: "Upload accessibility-ready slides",
        instructions: "Provide a tagged PDF and the source deck.",
        dueAt: "2027-04-20T23:59:59.000Z",
        acceptedFileTypes: ["application/pdf"],
        maximumFileBytes: 25_000_000,
        speakerIds: ["spk_priya_devflow_2027", "spk_marcus_devflow_2027"],
      }),
    });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      taskType: "file_request",
      title: "Upload accessibility-ready slides",
      assignmentCount: 2,
      assignees: [
        { speakerId: "spk_priya_devflow_2027", status: "assigned" },
        { speakerId: "spk_marcus_devflow_2027", status: "assigned" },
      ],
    });
  });

  it("shows every accepted speaker who is missing real onboarding information", async () => {
    const accepted = await request("/api/events/evt_devflow_conf_2027/disposition", {
      method: "PATCH",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({ submissionIds: ["sub_ci_monorepo"], status: "accepted" }),
    });
    expect(accepted.status).toBe(200);
    const profileUpdate = await request(
      "/api/events/evt_devflow_conf_2027/speakers/spk_priya_devflow_2027",
      {
        method: "PATCH",
        headers: { cookie: organizerCookie, "content-type": "application/json" },
        body: JSON.stringify({ bio: null, headshotUrl: null }),
      },
    );
    expect(profileUpdate.status).toBe(200);
    const task = await request("/api/events/evt_devflow_conf_2027/tasks", {
      method: "POST",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({
        taskType: "file_request",
        title: "Upload final accessibility checklist",
        dueAt: "2026-01-15T23:59:59.000Z",
        speakerIds: ["spk_priya_devflow_2027"],
      }),
    });
    expect(task.status).toBe(201);

    const response = await request(
      "/api/events/evt_devflow_conf_2027/missing-information",
      { headers: { cookie: organizerCookie } },
    );
    expect(response.status).toBe(200);
    const payload = await response.json<{
      acceptedSpeakerCount: number;
      incompleteSpeakerCount: number;
      items: Array<{
        speakerId: string;
        name: string;
        mostOverdueDays: number;
        missing: Array<{ kind: string; label: string; overdueDays: number }>;
      }>;
    }>();
    expect(payload.acceptedSpeakerCount).toBe(1);
    expect(payload.incompleteSpeakerCount).toBe(1);
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]).toMatchObject({
      speakerId: "spk_priya_devflow_2027",
      name: "Priya Raman",
      missing: expect.arrayContaining([
        expect.objectContaining({ kind: "bio", label: "Speaker bio" }),
        expect.objectContaining({ kind: "headshot", label: "Headshot" }),
        expect.objectContaining({ kind: "file", label: "Upload final accessibility checklist" }),
        expect.objectContaining({ kind: "form", label: "Sign speaker release form" }),
      ]),
    });
    expect(payload.items[0]?.mostOverdueDays).toBeGreaterThan(0);
    expect(
      payload.items[0]?.missing.find((item) => item.label === "Upload final accessibility checklist")?.overdueDays,
    ).toBeGreaterThan(0);
  });

  it("protects every roster and onboarding operation", async () => {
    const operations: Array<{ path: string; init?: RequestInit }> = [
      { path: "/api/events/evt_devflow_conf_2027/roster" },
      { path: "/api/events/evt_devflow_conf_2027/tasks" },
      { path: "/api/events/evt_devflow_conf_2027/missing-information" },
      {
        path: "/api/events/evt_devflow_conf_2027/speakers",
        init: { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      },
      {
        path: "/api/events/evt_devflow_conf_2027/speakers/spk_priya_devflow_2027",
        init: { method: "PATCH", headers: { "content-type": "application/json" }, body: "{}" },
      },
      {
        path: "/api/events/evt_devflow_conf_2027/tasks",
        init: { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      },
      {
        path: "/api/events/evt_devflow_conf_2027/speakers/spk_priya_devflow_2027/invitation",
        init: { method: "POST" },
      },
    ];

    async function expectStatus(expectedStatus: number, cookie?: string): Promise<void> {
      for (const operation of operations) {
        const headers = new Headers(operation.init?.headers);
        if (cookie !== undefined) headers.set("cookie", cookie);
        expect(
          (await request(operation.path, { ...operation.init, headers })).status,
          `${operation.init?.method ?? "GET"} ${operation.path}`,
        ).toBe(expectedStatus);
      }
    }

    await expectStatus(401);
    await expectStatus(
      403,
      await signIn("sbek-reviewer@example.com", "SbekTest!2027-rev"),
    );
    await expectStatus(
      403,
      await signIn("sbek-speaker@example.com", "SbekTest!2027-spk"),
    );
  });
});
