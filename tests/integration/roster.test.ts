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
          profile: { bioComplete: true, headshotComplete: true },
          taskSummary: { total: 5, incomplete: 5 },
        },
      ],
    });
  });

  it("does not count paused onboarding tasks as open work", async () => {
    await env.DB.prepare(
      "update task set status = 'draft' where id in (select task_id from task_assignee where speaker_id = ?)",
    ).bind("spk_priya_devflow_2027").run();

    const response = await request("/api/events/evt_devflow_conf_2027/roster", {
      headers: { cookie: organizerCookie },
    });
    const payload = await response.json<{
      items: Array<{ id: string; taskSummary: { total: number; incomplete: number } }>;
    }>();
    await env.DB.prepare(
      "update task set status = 'active' where id in (select task_id from task_assignee where speaker_id = ?)",
    ).bind("spk_priya_devflow_2027").run();
    expect(payload.items.find((speaker) => speaker.id === "spk_priya_devflow_2027")?.taskSummary).toEqual({
      total: 5,
      incomplete: 0,
    });
  });

  it("reports five active roster tasks when no accepted speakers are in the missing-information scope", async () => {
    await env.DB.batch([
      env.DB.prepare("update submission set status = 'declined' where event_id = ?")
        .bind("evt_devflow_conf_2027"),
      env.DB.prepare("update task set status = 'active' where event_id = ?")
        .bind("evt_devflow_conf_2027"),
      env.DB.prepare(
        "update task_assignee set status = 'assigned' where speaker_id = ?",
      ).bind("spk_priya_devflow_2027"),
    ]);

    const roster = await request("/api/events/evt_devflow_conf_2027/roster", {
      headers: { cookie: organizerCookie },
    });
    const rosterPayload = await roster.json<{
      items: Array<{
        id: string;
        status: string;
        taskSummary: { total: number; incomplete: number };
      }>;
    }>();
    expect(rosterPayload.items.find((speaker) => speaker.id === "spk_priya_devflow_2027")).toMatchObject({
      status: "onboarding",
      taskSummary: { total: 5, incomplete: 5 },
    });

    const missingInformation = await request(
      "/api/events/evt_devflow_conf_2027/missing-information",
      { headers: { cookie: organizerCookie } },
    );
    await expect(missingInformation.json()).resolves.toMatchObject({
      acceptedSpeakerCount: 0,
      incompleteSpeakerCount: 0,
      items: [],
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

  it("assigns a task above D1's per-statement parameter limit", async () => {
    const now = Date.now();
    const speakerIds = Array.from({ length: 40 }, (_, index) => `spk_bulk_${index}`);
    await env.DB.batch(speakerIds.flatMap((speakerId, index) => {
      const personId = `psn_bulk_${index}`;
      return [
        env.DB.prepare(
          "insert into person (id, name, email, created_at, updated_at) values (?, ?, ?, ?, ?)",
        ).bind(personId, `Bulk Speaker ${index}`, `bulk-${index}@example.test`, now, now),
        env.DB.prepare(
          "insert into speaker (id, person_id, event_id, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
        ).bind(speakerId, personId, "evt_devflow_conf_2027", "onboarding", now, now),
      ];
    }));

    const response = await request("/api/events/evt_devflow_conf_2027/tasks", {
      method: "POST",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({
        taskType: "general",
        title: "Complete high-cardinality onboarding",
        speakerIds,
      }),
    });
    expect(response.status).toBe(201);
    const payload = await response.json<{
      assignmentCount: number;
      assignees: Array<{ speakerId: string }>;
    }>();
    expect(payload.assignmentCount).toBe(40);
    expect(payload.assignees.map((assignee) => assignee.speakerId).sort()).toEqual([...speakerIds].sort());
  });

  it("does not turn a selected-speaker task into onboarding for later acceptances", async () => {
    const form = await env.DB.prepare(
      "select id from form where event_id = ? limit 1",
    ).bind("evt_devflow_conf_2027").first<{ id: string }>();
    expect(form).not.toBeNull();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "insert into person (id, name, email, created_at, updated_at) values (?, ?, ?, ?, ?)",
      ).bind("psn_future_roster_speaker", "Avery Chen", "avery.roster@example.test", now, now),
      env.DB.prepare(
        "insert into submission (id, event_id, form_id, form_version, submitter_person_id, status, is_draft, title, abstract, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        "sub_future_roster_speaker",
        "evt_devflow_conf_2027",
        form?.id,
        1,
        "psn_future_roster_speaker",
        "submitted",
        0,
        "Durable event workflows",
        "How to keep handoffs visible and reliable.",
        now,
        now,
      ),
      env.DB.prepare(
        "insert into submission_speaker (id, submission_id, person_id, role_label, sort_order, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        "sspk_future_roster_speaker",
        "sub_future_roster_speaker",
        "psn_future_roster_speaker",
        "speaker",
        0,
        now,
        now,
      ),
    ]);

    const taskResponse = await request("/api/events/evt_devflow_conf_2027/tasks", {
      method: "POST",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({
        taskType: "general",
        title: "Confirm private rehearsal slot",
        speakerIds: ["spk_priya_devflow_2027"],
      }),
    });
    expect(taskResponse.status).toBe(201);

    const accepted = await request("/api/events/evt_devflow_conf_2027/disposition", {
      method: "PATCH",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({ submissionIds: ["sub_future_roster_speaker"], status: "accepted" }),
    });
    expect(accepted.status).toBe(200);

    const tasksResponse = await request("/api/events/evt_devflow_conf_2027/tasks", {
      headers: { cookie: organizerCookie },
    });
    const payload = await tasksResponse.json<{
      items: Array<{ title: string; assignees: Array<{ speakerId: string }> }>;
    }>();
    const declined = await request("/api/events/evt_devflow_conf_2027/disposition", {
      method: "PATCH",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({ submissionIds: ["sub_future_roster_speaker"], status: "declined" }),
    });
    expect(declined.status).toBe(200);
    expect(payload.items.find((task) => task.title === "Confirm private rehearsal slot")?.assignees).toEqual([
      expect.objectContaining({ speakerId: "spk_priya_devflow_2027" }),
    ]);
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
    expect(payload.acceptedSpeakerCount).toBe(2);
    expect(payload.incompleteSpeakerCount).toBe(2);
    expect(payload.items).toHaveLength(2);
    const priya = payload.items.find((item) => item.speakerId === "spk_priya_devflow_2027");
    expect(priya).toMatchObject({
      speakerId: "spk_priya_devflow_2027",
      name: "Priya Raman",
      missing: expect.arrayContaining([
        expect.objectContaining({ kind: "bio", label: "Speaker bio" }),
        expect.objectContaining({ kind: "headshot", label: "Headshot" }),
        expect.objectContaining({ kind: "file", label: "Upload final accessibility checklist" }),
        expect.objectContaining({ kind: "form", label: "Sign speaker release form" }),
      ]),
    });
    expect(payload.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ speakerId: "spk_marcus_devflow_2027", name: "Marcus Okafor" }),
    ]));
    expect(priya?.mostOverdueDays).toBeGreaterThan(0);
    expect(
      priya?.missing.find((item) => item.label === "Upload final accessibility checklist")?.overdueDays,
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
