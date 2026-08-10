// ABOUTME: Verifies organizer roster and onboarding behavior through authenticated Worker requests.
// ABOUTME: Covers roster access, identity adoption, silent edits, task management, and missing work.
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

async function createSubmittedSpeaker(suffix: string, name: string, email: string): Promise<string> {
  const form = await env.DB.prepare(
    "select id from form where event_id = ? limit 1",
  ).bind("evt_devflow_conf_2027").first<{ id: string }>();
  expect(form).not.toBeNull();
  const personId = `psn_${suffix}`;
  const submissionId = `sub_${suffix}`;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "insert into person (id, name, email, created_at, updated_at) values (?, ?, ?, ?, ?)",
    ).bind(personId, name, email, now, now),
    env.DB.prepare(
      "insert into submission (id, event_id, form_id, form_version, submitter_person_id, status, is_draft, title, abstract, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      submissionId,
      "evt_devflow_conf_2027",
      form?.id,
      1,
      personId,
      "submitted",
      0,
      `Proposal by ${name}`,
      "A complete proposal for testing organizer onboarding behavior.",
      now,
      now,
    ),
    env.DB.prepare(
      "insert into submission_speaker (id, submission_id, person_id, role_label, sort_order, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
    ).bind(`sspk_${suffix}`, submissionId, personId, "speaker", 0, now, now),
  ]);
  return submissionId;
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

  it("keeps the worklist aligned with sessionless roster onboarding assignments", async () => {
    const acceptedSpeakerRows = await env.DB.prepare(
      "select distinct ss.speaker_id as speakerId from session_speaker ss inner join program_session ps on ps.id = ss.session_id inner join submission s on s.id = ps.submission_id where ps.event_id = ? and s.status = 'accepted' order by ss.speaker_id",
    ).bind("evt_devflow_conf_2027").all<{ speakerId: string }>();
    expect(acceptedSpeakerRows.results).toEqual([
      { speakerId: "spk_marcus_devflow_2027" },
    ]);

    const rosterResponse = await request("/api/events/evt_devflow_conf_2027/roster", {
      headers: { cookie: organizerCookie },
    });
    const rosterPayload = await rosterResponse.json<{
      items: Array<{
        id: string;
        status: string;
        profile: { bioComplete: boolean; headshotComplete: boolean };
        taskSummary: { total: number; incomplete: number };
      }>;
    }>();
    const priyaRoster = rosterPayload.items.find((speaker) => speaker.id === "spk_priya_devflow_2027");
    expect(priyaRoster).toMatchObject({
      status: "onboarding",
      profile: { bioComplete: true, headshotComplete: true },
      taskSummary: { total: 5, incomplete: 5 },
    });

    const tasksResponse = await request("/api/events/evt_devflow_conf_2027/tasks", {
      headers: { cookie: organizerCookie },
    });
    const tasksPayload = await tasksResponse.json<{
      items: Array<{
        id: string;
        sessionId: string | null;
        status: string;
        title: string;
        assignees: Array<{ speakerId: string; status: string }>;
      }>;
    }>();
    const priyaTasks = tasksPayload.items.filter((task) =>
      task.status === "active" &&
      task.assignees.some((assignee) =>
        assignee.speakerId === "spk_priya_devflow_2027" && assignee.status !== "completed"
      )
    );
    expect(priyaTasks).toHaveLength(5);
    expect(priyaTasks.every((task) => task.sessionId === null)).toBe(true);

    const missingInformation = await request(
      "/api/events/evt_devflow_conf_2027/missing-information",
      { headers: { cookie: organizerCookie } },
    );
    const missingPayload = await missingInformation.json<{
      worklistSpeakerCount: number;
      incompleteSpeakerCount: number;
      items: Array<{
        speakerId: string;
        missingCount: number;
        missing: Array<{ taskId: string | null; label: string }>;
      }>;
    }>();
    expect(missingPayload.worklistSpeakerCount).toBe(2);
    expect(missingPayload.incompleteSpeakerCount).toBe(2);
    expect(missingPayload.items.find((speaker) => speaker.speakerId === "spk_marcus_devflow_2027")?.missing)
      .toEqual([expect.objectContaining({ taskId: null, label: "Headshot" })]);

    const priyaMissing = missingPayload.items.find(
      (speaker) => speaker.speakerId === "spk_priya_devflow_2027",
    );
    expect(priyaMissing?.missingCount).toBe(priyaRoster?.taskSummary.incomplete);
    expect(priyaMissing?.missing.map((item) => item.taskId).sort()).toEqual(
      priyaTasks.map((task) => task.id).sort(),
    );
    expect(priyaMissing?.missing.map((item) => item.label).sort()).toEqual(
      priyaTasks.map((task) => task.title).sort(),
    );
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

  it("edits an onboarding task through the organizer ledger", async () => {
    const createdResponse = await request("/api/events/evt_devflow_conf_2027/tasks", {
      method: "POST",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({
        taskType: "general",
        title: "Review speaker checklist",
        instructions: "Check the event details.",
        speakerIds: ["spk_priya_devflow_2027"],
      }),
    });
    const created = await createdResponse.json<{ id: string }>();

    const response = await request(`/api/events/evt_devflow_conf_2027/tasks/${created.id}`, {
      method: "PATCH",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({
        taskType: "file_request",
        title: "Upload reviewed speaker checklist",
        instructions: "Upload the completed checklist as a PDF.",
        dueAt: "2027-04-30T23:59:59.000Z",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: created.id,
      taskType: "file_request",
      title: "Upload reviewed speaker checklist",
      instructions: "Upload the completed checklist as a PDF.",
      dueAt: "2027-04-30T23:59:59.000Z",
    });

    const taskList = await request("/api/events/evt_devflow_conf_2027/tasks", {
      headers: { cookie: organizerCookie },
    });
    const payload = await taskList.json<{ items: Array<{ id: string; title: string }> }>();
    expect(payload.items).toContainEqual(expect.objectContaining({
      id: created.id,
      title: "Upload reviewed speaker checklist",
    }));
  });

  it("applies event-wide template edits to current and future assignees", async () => {
    const tasksResponse = await request("/api/events/evt_devflow_conf_2027/tasks", {
      headers: { cookie: organizerCookie },
    });
    const tasksPayload = await tasksResponse.json<{
      items: Array<{ id: string; title: string }>;
    }>();
    const template = tasksPayload.items.find((task) => task.title === "Confirm participation");
    expect(template).toBeDefined();

    const updated = await request(`/api/events/evt_devflow_conf_2027/tasks/${template?.id}`, {
      method: "PATCH",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({
        title: "Confirm travel and participation",
        instructions: "Confirm attendance and share arrival details.",
        dueAt: "2027-03-01T23:59:59.000Z",
      }),
    });
    expect(updated.status).toBe(200);

    const speakerCookie = await signIn("sbek-speaker@example.com", "SbekTest!2027-spk");
    const currentContent = await request("/api/speaker/content", {
      headers: { cookie: speakerCookie },
    });
    const currentPayload = await currentContent.json<{
      tasks: Array<{ id: string; title: string; instructions: string | null }>;
    }>();
    expect(currentPayload.tasks.find((task) => task.id === template?.id)).toMatchObject({
      title: "Confirm travel and participation",
      instructions: "Confirm attendance and share arrival details.",
    });

    const form = await env.DB.prepare(
      "select id from form where event_id = ? limit 1",
    ).bind("evt_devflow_conf_2027").first<{ id: string }>();
    expect(form).not.toBeNull();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "insert into person (id, name, email, created_at, updated_at) values (?, ?, ?, ?, ?)",
      ).bind("psn_template_future", "Jordan Lee", "jordan.template@example.test", now, now),
      env.DB.prepare(
        "insert into submission (id, event_id, form_id, form_version, submitter_person_id, status, is_draft, title, abstract, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        "sub_template_future",
        "evt_devflow_conf_2027",
        form?.id,
        1,
        "psn_template_future",
        "submitted",
        0,
        "Reliable event templates",
        "Managing onboarding requirements without duplicate work.",
        now,
        now,
      ),
      env.DB.prepare(
        "insert into submission_speaker (id, submission_id, person_id, role_label, sort_order, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        "sspk_template_future",
        "sub_template_future",
        "psn_template_future",
        "speaker",
        0,
        now,
        now,
      ),
    ]);
    const accepted = await request("/api/events/evt_devflow_conf_2027/disposition", {
      method: "PATCH",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({ submissionIds: ["sub_template_future"], status: "accepted" }),
    });
    expect(accepted.status).toBe(200);
    const acceptedPayload = await accepted.json<{
      handoffs: Array<{ speakers: Array<{ id: string }> }>;
    }>();
    const futureSpeakerId = acceptedPayload.handoffs[0]?.speakers[0]?.id;
    expect(futureSpeakerId).toBeDefined();

    const refreshedTasks = await request("/api/events/evt_devflow_conf_2027/tasks", {
      headers: { cookie: organizerCookie },
    });
    const refreshedPayload = await refreshedTasks.json<{
      items: Array<{ id: string; assignees: Array<{ speakerId: string }> }>;
    }>();
    expect(refreshedPayload.items.find((task) => task.id === template?.id)?.assignees)
      .toContainEqual(expect.objectContaining({ speakerId: futureSpeakerId }));
  });

  it("allows an event to remove every onboarding template without recreating defaults", async () => {
    const eventWideTasks = await env.DB.prepare(
      "select t.id, t.status from task t left join task_scope ts on ts.task_id = t.id where t.event_id = ? and t.session_id is null and ts.task_id is null and t.deleted_at is null",
    ).bind("evt_devflow_conf_2027").all<{ id: string; status: string }>();
    expect(eventWideTasks.results.length).toBeGreaterThan(0);
    try {
      for (const task of eventWideTasks.results) {
        const removed = await request(`/api/events/evt_devflow_conf_2027/tasks/${task.id}`, {
          method: "DELETE",
          headers: { cookie: organizerCookie },
        });
        expect(removed.status).toBe(200);
      }

      const submissionId = await createSubmittedSpeaker(
        "no_onboarding_templates",
        "Taylor Brooks",
        "taylor.no-templates@example.test",
      );
      const accepted = await request("/api/events/evt_devflow_conf_2027/disposition", {
        method: "PATCH",
        headers: { cookie: organizerCookie, "content-type": "application/json" },
        body: JSON.stringify({ submissionIds: [submissionId], status: "accepted" }),
      });
      expect(accepted.status).toBe(200);
      const payload = await accepted.json<{
        handoffs: Array<{ tasks: Array<{ id: string; title: string }> }>;
      }>();
      expect(payload.handoffs[0]?.tasks).toEqual([]);
    } finally {
      await env.DB.batch(eventWideTasks.results.map((task) => env.DB.prepare(
        "update task set status = ?, deleted_at = null where id = ?",
      ).bind(task.status, task.id)));
    }
  });

  it("keeps a completed task's kind stable", async () => {
    const createdResponse = await request("/api/events/evt_devflow_conf_2027/tasks", {
      method: "POST",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({
        taskType: "general",
        title: "Confirm travel details",
        speakerIds: ["spk_priya_devflow_2027"],
      }),
    });
    const created = await createdResponse.json<{ id: string }>();
    const speakerCookie = await signIn("sbek-speaker@example.com", "SbekTest!2027-spk");
    const completed = await request(`/api/portal/tasks/${created.id}`, {
      method: "PATCH",
      headers: { cookie: speakerCookie, "content-type": "application/json" },
      body: JSON.stringify({ status: "completed" }),
    });
    expect(completed.status).toBe(200);
    expect((await request(`/api/events/evt_devflow_conf_2027/tasks/${created.id}`, {
      method: "PATCH",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({ speakerIds: [] }),
    })).status).toBe(200);

    const response = await request(`/api/events/evt_devflow_conf_2027/tasks/${created.id}`, {
      method: "PATCH",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({ taskType: "file_request" }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "task_kind_locked" });
  });

  it("changes assignees without discarding completed work", async () => {
    const createdResponse = await request("/api/events/evt_devflow_conf_2027/tasks", {
      method: "POST",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({
        taskType: "general",
        title: "Confirm arrival window",
        speakerIds: ["spk_priya_devflow_2027", "spk_marcus_devflow_2027"],
      }),
    });
    const created = await createdResponse.json<{ id: string }>();
    const speakerCookie = await signIn("sbek-speaker@example.com", "SbekTest!2027-spk");
    expect((await request(`/api/portal/tasks/${created.id}`, {
      method: "PATCH",
      headers: { cookie: speakerCookie, "content-type": "application/json" },
      body: JSON.stringify({ status: "completed" }),
    })).status).toBe(200);

    const reassigned = await request(`/api/events/evt_devflow_conf_2027/tasks/${created.id}`, {
      method: "PATCH",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({ speakerIds: ["spk_marcus_devflow_2027"] }),
    });
    expect(reassigned.status).toBe(200);
    await expect(reassigned.json()).resolves.toMatchObject({
      assignees: [{ speakerId: "spk_marcus_devflow_2027", status: "assigned" }],
    });

    const restored = await request(`/api/events/evt_devflow_conf_2027/tasks/${created.id}`, {
      method: "PATCH",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({
        speakerIds: ["spk_priya_devflow_2027", "spk_marcus_devflow_2027"],
      }),
    });
    expect(restored.status).toBe(200);
    await expect(restored.json()).resolves.toMatchObject({
      assignees: expect.arrayContaining([
        expect.objectContaining({ speakerId: "spk_priya_devflow_2027", status: "completed" }),
        expect.objectContaining({ speakerId: "spk_marcus_devflow_2027", status: "assigned" }),
      ]),
    });
  });

  it("archives a task without losing completed uploads or leaving open work", async () => {
    const rosterBeforeResponse = await request("/api/events/evt_devflow_conf_2027/roster", {
      headers: { cookie: organizerCookie },
    });
    const rosterBefore = await rosterBeforeResponse.json<{
      items: Array<{ id: string; taskSummary: { total: number; incomplete: number } }>;
    }>();
    const marcusBefore = rosterBefore.items.find((speaker) => speaker.id === "spk_marcus_devflow_2027");

    const createdResponse = await request("/api/events/evt_devflow_conf_2027/tasks", {
      method: "POST",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({
        taskType: "file_request",
        title: "Upload removal-safe slides",
        speakerIds: ["spk_priya_devflow_2027", "spk_marcus_devflow_2027"],
      }),
    });
    const created = await createdResponse.json<{ id: string }>();
    const speakerCookie = await signIn("sbek-speaker@example.com", "SbekTest!2027-spk");
    const upload = await request(`/api/portal/tasks/${created.id}/files`, {
      method: "POST",
      headers: { cookie: speakerCookie },
      body: pdfUpload("removal-safe.pdf"),
    });
    expect(upload.status).toBe(201);
    const uploaded = await upload.json<{ fileId: string }>();

    const removed = await request(`/api/events/evt_devflow_conf_2027/tasks/${created.id}`, {
      method: "DELETE",
      headers: { cookie: organizerCookie },
    });
    expect(removed.status).toBe(200);
    await expect(removed.json()).resolves.toMatchObject({ id: created.id, archived: true });

    const taskList = await request("/api/events/evt_devflow_conf_2027/tasks", {
      headers: { cookie: organizerCookie },
    });
    const taskPayload = await taskList.json<{ items: Array<{ id: string }> }>();
    expect(taskPayload.items).not.toContainEqual(expect.objectContaining({ id: created.id }));

    const rosterAfterResponse = await request("/api/events/evt_devflow_conf_2027/roster", {
      headers: { cookie: organizerCookie },
    });
    const rosterAfter = await rosterAfterResponse.json<{
      items: Array<{ id: string; taskSummary: { total: number; incomplete: number } }>;
    }>();
    expect(rosterAfter.items.find((speaker) => speaker.id === "spk_marcus_devflow_2027")?.taskSummary)
      .toEqual({
        total: (marcusBefore?.taskSummary.total ?? 0),
        incomplete: (marcusBefore?.taskSummary.incomplete ?? 0),
      });

    const missing = await request("/api/events/evt_devflow_conf_2027/missing-information", {
      headers: { cookie: organizerCookie },
    });
    const missingPayload = await missing.json<{
      items: Array<{ missing: Array<{ taskId: string | null }> }>;
    }>();
    expect(missingPayload.items.flatMap((speaker) => speaker.missing))
      .not.toContainEqual(expect.objectContaining({ taskId: created.id }));

    const speakerContent = await request("/api/speaker/content", {
      headers: { cookie: speakerCookie },
    });
    const speakerPayload = await speakerContent.json<{ tasks: Array<{ id: string }> }>();
    expect(speakerPayload.tasks).not.toContainEqual(expect.objectContaining({ id: created.id }));

    const uploadAfterRemoval = await request(`/api/portal/tasks/${created.id}/files`, {
      method: "POST",
      headers: { cookie: speakerCookie },
      body: pdfUpload("should-not-upload.pdf"),
    });
    expect(uploadAfterRemoval.status).toBe(403);

    const completionAfterRemoval = await request(`/api/portal/tasks/${created.id}`, {
      method: "PATCH",
      headers: { cookie: speakerCookie, "content-type": "application/json" },
      body: JSON.stringify({ status: "completed" }),
    });
    expect(completionAfterRemoval.status).toBe(403);

    const download = await request(`/api/portal/files/${uploaded.fileId}`, {
      headers: { cookie: speakerCookie },
    });
    expect(download.status).toBe(200);
    expect([...new Uint8Array(await download.arrayBuffer())]).toEqual([1, 2, 3, 4]);
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
      worklistSpeakerCount: number;
      incompleteSpeakerCount: number;
      items: Array<{
        speakerId: string;
        name: string;
        mostOverdueDays: number;
        missing: Array<{ kind: string; label: string; overdueDays: number }>;
      }>;
    }>();
    expect(payload.worklistSpeakerCount).toBeGreaterThanOrEqual(payload.incompleteSpeakerCount);
    expect(payload.incompleteSpeakerCount).toBe(payload.items.length);
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
        path: "/api/events/evt_devflow_conf_2027/tasks/tsk_fixture_0",
        init: { method: "PATCH", headers: { "content-type": "application/json" }, body: "{}" },
      },
      {
        path: "/api/events/evt_devflow_conf_2027/tasks/tsk_fixture_0",
        init: { method: "DELETE" },
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
