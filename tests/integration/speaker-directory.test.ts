// ABOUTME: Exercises the private cross-event speaker directory and its merge boundary.
// ABOUTME: Verifies organizer access, event history, atomic relationship transfer, and account safety.
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { and, eq, isNull } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  directoryMerges,
  events,
  files,
  fileVersions,
  people,
  sessions,
  sessionSpeakers,
  speakers,
  submissions,
  submissionSpeakers,
  taskAssignees,
  tasks,
  users,
} from "../../db/schema.ts";
import type { SpeakerDirectoryDetailResponse, SpeakerDirectoryListResponse } from "../../shared/speaker-directory.ts";
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

async function organizerCookie(): Promise<string> {
  return signIn("sbek-organizer@example.com", "SbekTest!2027-org");
}

describe("speaker directory", () => {
  it("is private to organizers and excludes accounts with no speaker history", async () => {
    await request("/api/health");
    expect((await request("/api/speaker-directory")).status).toBe(401);

    const speakerCookie = await signIn("sbek-speaker@example.com", "SbekTest!2027-spk");
    expect((await request("/api/speaker-directory", { headers: { cookie: speakerCookie } })).status).toBe(403);

    const response = await request("/api/speaker-directory", { headers: { cookie: await organizerCookie() } });
    expect(response.status).toBe(200);
    const payload = await response.json<SpeakerDirectoryListResponse>();
    expect(payload.items.map((person) => person.email)).toEqual(expect.arrayContaining([
      "sbek-speaker@example.com",
      "sbek-speaker2@example.com",
    ]));
    expect(payload.items.map((person) => person.email)).not.toContain("sbek-organizer@example.com");
    expect(payload.items.every((person) => person.eventCount > 0 || person.proposalCount > 0)).toBe(true);
  });

  it("shows one person's events and sessions across event boundaries", async () => {
    await request("/api/health");
    const database = drizzle(env.DB);
    const now = new Date();
    await database.insert(events).values({
      id: "evt_directory_second",
      name: "Directory Summit 2028",
      slug: "directory-summit-2028",
      timezone: "America/Los_Angeles",
      createdAt: now,
      updatedAt: now,
    });
    await database.insert(speakers).values({
      id: "spk_priya_directory_second",
      personId: "psn_priya_raman",
      eventId: "evt_directory_second",
      status: "ready",
      createdAt: now,
      updatedAt: now,
    });
    await database.insert(sessions).values({
      id: "ses_priya_directory_second",
      eventId: "evt_directory_second",
      title: "Designing durable communities",
      contentStatus: "approved",
      scheduleStatus: "tbd",
      directEntry: true,
      icsUid: "ses_priya_directory_second@session-bored",
      createdAt: now,
      updatedAt: now,
    });
    await database.insert(sessionSpeakers).values({
      id: "ssnr_priya_directory_second",
      sessionId: "ses_priya_directory_second",
      speakerId: "spk_priya_directory_second",
      createdAt: now,
      updatedAt: now,
    });

    const cookie = await organizerCookie();
    const listResponse = await request("/api/speaker-directory", { headers: { cookie } });
    const list = await listResponse.json<SpeakerDirectoryListResponse>();
    expect(list.items.find((person) => person.id === "psn_priya_raman")).toMatchObject({
      eventCount: 2,
      events: expect.arrayContaining(["DevFlow Conf 2027", "Directory Summit 2028"]),
    });

    const detailResponse = await request("/api/speaker-directory/psn_priya_raman", { headers: { cookie } });
    expect(detailResponse.status).toBe(200);
    const detail = await detailResponse.json<SpeakerDirectoryDetailResponse>();
    expect(detail.person.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "evt_directory_second",
        name: "Directory Summit 2028",
        sessions: [expect.objectContaining({ title: "Designing durable communities" })],
      }),
    ]));
  });

  it("merges a detected duplicate without losing programme, proposal, task, or file links", async () => {
    await request("/api/health");
    const database = drizzle(env.DB);
    const [kept] = await database.select().from(people).where(eq(people.id, "psn_priya_raman"));
    expect(kept).toBeDefined();
    const now = Date.now();
    const duplicatePersonId = "psn_directory_duplicate";
    const duplicateSpeakerId = "spk_directory_duplicate";
    const submissionId = "sub_directory_duplicate";
    const archivedSubmissionId = "sub_directory_archived";
    const sessionId = "ses_directory_duplicate";
    const taskId = "tsk_directory_duplicate";
    const fileId = "fil_directory_duplicate";
    const releasedSessionId = "ses_directory_released";
    const releasedTaskId = "tsk_directory_released";
    await env.DB.batch([
      env.DB.prepare(
        "insert into person (id, name, email, job_title, organization, bio, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        duplicatePersonId,
        kept!.name,
        "priya.directory.duplicate@example.com",
        "Principal Engineer",
        kept!.organization,
        "Profile detail retained on the archived record.",
        now,
        now,
      ),
      env.DB.prepare(
        "insert into speaker (id, person_id, event_id, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
      ).bind(duplicateSpeakerId, duplicatePersonId, "evt_devflow_conf_2027", "ready", now, now),
      env.DB.prepare(
        "insert into submission (id, event_id, form_id, form_version, submitter_person_id, status, is_draft, title, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        submissionId,
        "evt_devflow_conf_2027",
        "frm_devflow_cfp_2027",
        1,
        duplicatePersonId,
        "submitted",
        0,
        "A duplicate person's proposal",
        now,
        now,
      ),
      env.DB.prepare(
        "insert into submission_speaker (id, submission_id, person_id, role_label, sort_order, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
      ).bind("sspk_directory_duplicate", submissionId, duplicatePersonId, "speaker", 0, now, now),
      env.DB.prepare(
        "insert into submission (id, event_id, form_id, form_version, submitter_person_id, status, is_draft, title, created_at, updated_at, deleted_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        archivedSubmissionId,
        "evt_devflow_conf_2027",
        "frm_devflow_cfp_2027",
        1,
        duplicatePersonId,
        "withdrawn",
        0,
        "An archived duplicate proposal",
        now,
        now,
        now,
      ),
      env.DB.prepare(
        "insert into submission_speaker (id, submission_id, person_id, role_label, sort_order, created_at, updated_at, deleted_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind("sspk_directory_archived", archivedSubmissionId, duplicatePersonId, "speaker", 0, now, now, now),
      env.DB.prepare(
        "insert into program_session (id, event_id, title, content_status, schedule_status, direct_entry, ics_uid, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        sessionId,
        "evt_devflow_conf_2027",
        "A duplicate person's session",
        "draft",
        "tbd",
        1,
        "ses_directory_duplicate@session-bored",
        now,
        now,
      ),
      env.DB.prepare(
        "insert into session_speaker (id, session_id, speaker_id, role_label, sort_order, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
      ).bind("ssnr_directory_duplicate", sessionId, duplicateSpeakerId, "speaker", 0, now, now),
      env.DB.prepare(
        "insert into task (id, event_id, title, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
      ).bind(taskId, "evt_devflow_conf_2027", "Duplicate profile task", "active", now, now),
      env.DB.prepare(
        "insert into task_assignee (id, task_id, speaker_id, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
      ).bind("tassn_directory_duplicate", taskId, duplicateSpeakerId, "in_progress", now, now),
      env.DB.prepare(
        "insert into file (id, event_id, task_id, speaker_id, kind, display_name, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(fileId, "evt_devflow_conf_2027", taskId, duplicateSpeakerId, "deliverable", "slides.pdf", now, now),
      // A session the duplicate was removed from after finishing its onboarding work. Removal
      // archives both links precisely so the completion survives being restored later.
      env.DB.prepare(
        "insert into program_session (id, event_id, title, content_status, schedule_status, direct_entry, ics_uid, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        releasedSessionId,
        "evt_devflow_conf_2027",
        "A session the duplicate was removed from",
        "draft",
        "tbd",
        1,
        "ses_directory_released@session-bored",
        now,
        now,
      ),
      env.DB.prepare(
        "insert into session_speaker (id, session_id, speaker_id, role_label, sort_order, created_at, updated_at, deleted_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind("ssnr_directory_released", releasedSessionId, duplicateSpeakerId, "speaker", 0, now, now, now),
      env.DB.prepare(
        "insert into task (id, event_id, session_id, title, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
      ).bind(releasedTaskId, "evt_devflow_conf_2027", releasedSessionId, "Released session task", "active", now, now),
      env.DB.prepare(
        "insert into task_assignee (id, task_id, speaker_id, granted_by_session_id, status, completed_at, created_at, updated_at, deleted_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        "tassn_directory_released",
        releasedTaskId,
        duplicateSpeakerId,
        releasedSessionId,
        "completed",
        now,
        now,
        now,
        now,
      ),
    ]);

    const cookie = await organizerCookie();
    const before = await request(`/api/speaker-directory/${duplicatePersonId}`, { headers: { cookie } });
    expect(before.status).toBe(200);
    expect((await before.json<SpeakerDirectoryDetailResponse>()).possibleDuplicates).toEqual([
      expect.objectContaining({ id: "psn_priya_raman", reasons: ["same_name_and_organization"] }),
    ]);

    const merged = await request("/api/speaker-directory/psn_priya_raman/merge", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ duplicatePersonId }),
    });
    expect(merged.status).toBe(200);
    expect(await merged.json()).toMatchObject({ keptPersonId: "psn_priya_raman", mergedPersonId: duplicatePersonId });

    const [archivedPerson] = await database.select().from(people).where(eq(people.id, duplicatePersonId));
    expect(archivedPerson?.deletedAt).not.toBeNull();
    expect((await database.select().from(submissions).where(eq(submissions.id, submissionId)))[0]?.submitterPersonId)
      .toBe("psn_priya_raman");
    expect((await database.select().from(submissionSpeakers).where(eq(submissionSpeakers.submissionId, submissionId)))[0]?.personId)
      .toBe("psn_priya_raman");
    const [archivedSubmission] = await database.select().from(submissions)
      .where(eq(submissions.id, archivedSubmissionId));
    expect(archivedSubmission).toMatchObject({
      submitterPersonId: "psn_priya_raman",
      deletedAt: expect.any(Date),
    });
    const [archivedParticipant] = await database.select().from(submissionSpeakers)
      .where(eq(submissionSpeakers.submissionId, archivedSubmissionId));
    expect(archivedParticipant).toMatchObject({
      personId: "psn_priya_raman",
      deletedAt: expect.any(Date),
    });
    const [archivedSpeaker] = await database.select().from(speakers).where(eq(speakers.id, duplicateSpeakerId));
    expect(archivedSpeaker?.deletedAt).not.toBeNull();
    expect((await database.select().from(sessionSpeakers).where(eq(sessionSpeakers.sessionId, sessionId)))[0]?.speakerId)
      .toBe("spk_priya_devflow_2027");
    expect((await database.select().from(taskAssignees).where(eq(taskAssignees.taskId, taskId)))[0]?.speakerId)
      .toBe("spk_priya_devflow_2027");
    expect((await database.select().from(files).where(eq(files.id, fileId)))[0]?.speakerId)
      .toBe("spk_priya_devflow_2027");
    const [releasedSessionLink] = await database.select().from(sessionSpeakers)
      .where(eq(sessionSpeakers.id, "ssnr_directory_released"));
    expect(releasedSessionLink).toMatchObject({
      speakerId: "spk_priya_devflow_2027",
      deletedAt: expect.any(Date),
    });
    const [releasedAssignment] = await database.select().from(taskAssignees)
      .where(eq(taskAssignees.id, "tassn_directory_released"));
    expect(releasedAssignment).toMatchObject({
      speakerId: "spk_priya_devflow_2027",
      status: "completed",
      completedAt: expect.any(Date),
      deletedAt: expect.any(Date),
    });
    expect(await database.select().from(directoryMerges).where(and(
      eq(directoryMerges.keptPersonId, "psn_priya_raman"),
      eq(directoryMerges.mergedPersonId, duplicatePersonId),
    ))).toHaveLength(1);
    expect(await database.select().from(people).where(and(eq(people.id, duplicatePersonId), isNull(people.deletedAt))))
      .toHaveLength(0);
  });

  it("attaches work adopted through a merged person's email to the person the organizer kept", async () => {
    await request("/api/health");
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "insert into person (id, name, email, organization, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
      ).bind("psn_directory_adopt_kept", "Rowan Adopt", "rowan.kept@example.com", "Adopt Systems", now, now),
      env.DB.prepare(
        "insert into person (id, name, email, organization, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
      ).bind("psn_directory_adopt_merged", "Rowan Adopt", "rowan.duplicate@example.com", "Adopt Systems", now, now),
    ]);
    const cookie = await organizerCookie();
    const merged = await request("/api/speaker-directory/psn_directory_adopt_kept/merge", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ duplicatePersonId: "psn_directory_adopt_merged" }),
    });
    expect(merged.status).toBe(200);

    const createResponse = await request("/api/public/cfp/devflow-conf-2027/submissions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        intent: "draft",
        speaker: { name: "Rowan Adopt", email: "rowan.duplicate@example.com", organization: "Adopt Systems" },
        proposal: { title: "Adopted after a merge", answers: {} },
      }),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json<{ submission: { id: string; speaker: { id: string } } }>();
    expect(created.submission.speaker.id).toBe("psn_directory_adopt_kept");

    const organizerDoor = await request(
      `/api/events/evt_devflow_conf_2027/submissions/${created.submission.id}/participants`,
      {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Rowan Adopt", email: "rowan.duplicate@example.com" }),
      },
    );
    expect(organizerDoor.status).toBe(409);
    await expect(organizerDoor.json()).resolves.toMatchObject({ error: "participant_already_named" });
  });

  it("carries a merged speaker's only headshot to the kept speaker with a URL that still serves", async () => {
    await request("/api/health");
    const database = drizzle(env.DB);
    const now = Date.now();
    const anyUser = await env.DB.prepare("select id from user limit 1").first<{ id: string }>();
    const storageKey =
      "portal/evt_devflow_conf_2027/spk_directory_photo_merged/fil_directory_photo_merged/fver_directory_photo_merged-headshot.png";
    await env.FILES.put(storageKey, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
    await env.DB.batch([
      env.DB.prepare(
        "insert into person (id, name, email, organization, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
      ).bind("psn_directory_photo_kept", "Devon Photo", "devon.kept@example.com", "Photo Systems", now, now),
      env.DB.prepare(
        "insert into person (id, name, email, organization, headshot_url, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        "psn_directory_photo_merged",
        "Devon Photo",
        "devon.duplicate@example.com",
        "Photo Systems",
        "/api/public/portal/speakers/spk_directory_photo_merged/headshot?version=1",
        now,
        now,
      ),
      env.DB.prepare(
        "insert into speaker (id, person_id, event_id, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
      ).bind("spk_directory_photo_kept", "psn_directory_photo_kept", "evt_devflow_conf_2027", "confirmed", now, now),
      env.DB.prepare(
        "insert into speaker (id, person_id, event_id, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
      ).bind("spk_directory_photo_merged", "psn_directory_photo_merged", "evt_devflow_conf_2027", "ready", now, now),
      env.DB.prepare(
        "insert into file (id, event_id, speaker_id, kind, display_name, created_at, updated_at) values (?, ?, ?, 'headshot', ?, ?, ?)",
      ).bind("fil_directory_photo_merged", "evt_devflow_conf_2027", "spk_directory_photo_merged", "headshot.png", now, now),
      env.DB.prepare(
        "insert into file_version (id, file_id, version, storage_key, mime_type, size_bytes, latest, uploaded_by_user_id, created_at, updated_at) values (?, ?, 1, ?, 'image/png', 11, 1, ?, ?, ?)",
      ).bind("fver_directory_photo_merged", "fil_directory_photo_merged", storageKey, anyUser?.id, now, now),
    ]);

    const merged = await request("/api/speaker-directory/psn_directory_photo_kept/merge", {
      method: "POST",
      headers: { cookie: await organizerCookie(), "content-type": "application/json" },
      body: JSON.stringify({ duplicatePersonId: "psn_directory_photo_merged" }),
    });
    expect(merged.status).toBe(200);

    const [keptPerson] = await database.select().from(people).where(eq(people.id, "psn_directory_photo_kept"));
    expect(keptPerson?.headshotUrl).toBe("/api/public/portal/speakers/spk_directory_photo_kept/headshot?version=1");
    expect((await database.select().from(files).where(eq(files.id, "fil_directory_photo_merged")))[0]?.speakerId)
      .toBe("spk_directory_photo_kept");
    const served = await request(keptPerson!.headshotUrl!);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
  });

  it("keeps the kept speaker's own headshot when both merge sides have one", async () => {
    await request("/api/health");
    const database = drizzle(env.DB);
    const now = Date.now();
    const keptUrl = "/api/public/portal/speakers/spk_directory_photo2_kept/headshot?version=1";
    await env.DB.batch([
      env.DB.prepare(
        "insert into person (id, name, email, organization, headshot_url, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
      ).bind("psn_directory_photo2_kept", "Sasha Frames", "sasha.kept@example.com", "Frame Works", keptUrl, now, now),
      env.DB.prepare(
        "insert into person (id, name, email, organization, headshot_url, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        "psn_directory_photo2_merged",
        "Sasha Frames",
        "sasha.duplicate@example.com",
        "Frame Works",
        "/api/public/portal/speakers/spk_directory_photo2_merged/headshot?version=1",
        now,
        now,
      ),
      env.DB.prepare(
        "insert into speaker (id, person_id, event_id, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
      ).bind("spk_directory_photo2_kept", "psn_directory_photo2_kept", "evt_devflow_conf_2027", "confirmed", now, now),
      env.DB.prepare(
        "insert into speaker (id, person_id, event_id, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
      ).bind("spk_directory_photo2_merged", "psn_directory_photo2_merged", "evt_devflow_conf_2027", "ready", now, now),
      env.DB.prepare(
        "insert into file (id, event_id, speaker_id, kind, display_name, created_at, updated_at) values (?, ?, ?, 'headshot', ?, ?, ?)",
      ).bind("fil_directory_photo2_kept", "evt_devflow_conf_2027", "spk_directory_photo2_kept", "kept.png", now, now),
      env.DB.prepare(
        "insert into file (id, event_id, speaker_id, kind, display_name, created_at, updated_at) values (?, ?, ?, 'headshot', ?, ?, ?)",
      ).bind("fil_directory_photo2_merged", "evt_devflow_conf_2027", "spk_directory_photo2_merged", "merged.png", now, now),
      env.DB.prepare(
        "insert into file (id, event_id, speaker_id, kind, display_name, created_at, updated_at) values (?, ?, ?, 'deliverable', ?, ?, ?)",
      ).bind("fil_directory_photo2_slides", "evt_devflow_conf_2027", "spk_directory_photo2_merged", "slides.pdf", now, now),
    ]);

    const merged = await request("/api/speaker-directory/psn_directory_photo2_kept/merge", {
      method: "POST",
      headers: { cookie: await organizerCookie(), "content-type": "application/json" },
      body: JSON.stringify({ duplicatePersonId: "psn_directory_photo2_merged" }),
    });
    expect(merged.status).toBe(200);

    const keptHeadshots = await database.select().from(files).where(and(
      eq(files.speakerId, "spk_directory_photo2_kept"),
      eq(files.kind, "headshot"),
    ));
    expect(keptHeadshots.map((file) => file.id)).toEqual(["fil_directory_photo2_kept"]);
    expect((await database.select().from(files).where(eq(files.id, "fil_directory_photo2_merged")))[0]?.speakerId)
      .toBe("spk_directory_photo2_merged");
    expect((await database.select().from(files).where(eq(files.id, "fil_directory_photo2_slides")))[0]?.speakerId)
      .toBe("spk_directory_photo2_kept");
    expect((await database.select().from(people).where(eq(people.id, "psn_directory_photo2_kept")))[0]?.headshotUrl)
      .toBe(keptUrl);
  });

  it("refuses to collapse two distinct accounts", async () => {
    await request("/api/health");
    const accountCookie = await request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Priya Raman",
        email: "directory-account-conflict@example.com",
        password: "Greenroom!2027",
      }),
    });
    expect(accountCookie.status).toBe(200);
    const database = drizzle(env.DB);
    const [account] = await database.select({ id: users.id }).from(users)
      .where(eq(users.email, "directory-account-conflict@example.com"));
    const [kept] = await database.select().from(people).where(eq(people.id, "psn_priya_raman"));
    await database.insert(people).values({
      id: "psn_directory_account_conflict",
      userId: account!.id,
      name: kept!.name,
      email: "directory-account-conflict@example.com",
      organization: kept!.organization,
    });
    await database.insert(speakers).values({
      id: "spk_directory_account_conflict",
      personId: "psn_directory_account_conflict",
      eventId: "evt_devflow_conf_2027",
      status: "invited",
    });

    const response = await request("/api/speaker-directory/psn_priya_raman/merge", {
      method: "POST",
      headers: { cookie: await organizerCookie(), "content-type": "application/json" },
      body: JSON.stringify({ duplicatePersonId: "psn_directory_account_conflict" }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "account_conflict" });
    expect((await database.select().from(people).where(eq(people.id, "psn_directory_account_conflict")))[0]?.deletedAt)
      .toBeNull();
  });
  it("keeps a withdrawn speaker withdrawn when the duplicate's live record would promote them", async () => {
    await request("/api/health");
    const database = drizzle(env.DB);
    const now = Date.now();
    const withdrawnAt = now - 60_000;
    await env.DB.batch([
      env.DB.prepare(
        "insert into person (id, name, email, organization, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
      ).bind("psn_probe_withdrawn_kept", "Wren Terminal", "wren.kept@example.com", "Terminal Labs", now, now),
      env.DB.prepare(
        "insert into person (id, name, email, organization, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
      ).bind("psn_probe_withdrawn_dupe", "Wren Terminal", "wren.duplicate@example.com", "Terminal Labs", now, now),
      // Withdrawing on the roster sets the status and archives the row together.
      env.DB.prepare(
        "insert into speaker (id, person_id, event_id, status, created_at, updated_at, deleted_at) values (?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        "spk_probe_withdrawn_kept",
        "psn_probe_withdrawn_kept",
        "evt_devflow_conf_2027",
        "withdrawn",
        now,
        now,
        withdrawnAt,
      ),
      env.DB.prepare(
        "insert into speaker (id, person_id, event_id, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
      ).bind("spk_probe_withdrawn_dupe", "psn_probe_withdrawn_dupe", "evt_devflow_conf_2027", "ready", now, now),
    ]);

    const merged = await request("/api/speaker-directory/psn_probe_withdrawn_kept/merge", {
      method: "POST",
      headers: { cookie: await organizerCookie(), "content-type": "application/json" },
      body: JSON.stringify({ duplicatePersonId: "psn_probe_withdrawn_dupe" }),
    });
    expect(merged.status).toBe(200);

    const [keptSpeaker] = await database.select().from(speakers)
      .where(eq(speakers.id, "spk_probe_withdrawn_kept"));
    expect(keptSpeaker?.status).toBe("withdrawn");
    expect(keptSpeaker?.deletedAt?.getTime()).toBe(withdrawnAt);

    const publicSpeakers = await (await request("/api/public/events/evt_devflow_conf_2027/speakers"))
      .json<{ items: Array<{ name: string }> }>();
    expect(publicSpeakers.items.some((speaker) => speaker.name === "Wren Terminal")).toBe(false);
  });

  it("leaves one live deliverable per request and keeps the duplicate's as archived history", async () => {
    await request("/api/health");
    const database = drizzle(env.DB);
    const now = Date.now();
    const [organizer] = await database.select({ id: users.id }).from(users)
      .where(eq(users.email, "sbek-organizer@example.com"));
    const taskId = "tsk_probe_file_request";
    await env.DB.batch([
      env.DB.prepare(
        "insert into person (id, name, email, organization, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
      ).bind("psn_probe_file_kept", "Marlow Deliver", "marlow.kept@example.com", "Deliver Co", now, now),
      env.DB.prepare(
        "insert into person (id, name, email, organization, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
      ).bind("psn_probe_file_dupe", "Marlow Deliver", "marlow.duplicate@example.com", "Deliver Co", now, now),
      env.DB.prepare(
        "insert into speaker (id, person_id, event_id, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
      ).bind("spk_probe_file_kept", "psn_probe_file_kept", "evt_devflow_conf_2027", "ready", now, now),
      env.DB.prepare(
        "insert into speaker (id, person_id, event_id, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
      ).bind("spk_probe_file_dupe", "psn_probe_file_dupe", "evt_devflow_conf_2027", "ready", now, now),
      env.DB.prepare(
        "insert into task (id, event_id, task_type, title, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
      ).bind(taskId, "evt_devflow_conf_2027", "file_request", "Upload your slides", "active", now, now),
      env.DB.prepare(
        "insert into task_assignee (id, task_id, speaker_id, status, completed_at, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
      ).bind("tassn_probe_file_kept", taskId, "spk_probe_file_kept", "completed", now, now, now),
      env.DB.prepare(
        "insert into task_assignee (id, task_id, speaker_id, status, completed_at, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
      ).bind("tassn_probe_file_dupe", taskId, "spk_probe_file_dupe", "completed", now, now, now),
      env.DB.prepare(
        "insert into file (id, event_id, task_id, speaker_id, kind, display_name, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind("fil_probe_file_kept", "evt_devflow_conf_2027", taskId, "spk_probe_file_kept", "deliverable", "kept-slides.pdf", now, now),
      env.DB.prepare(
        "insert into file (id, event_id, task_id, speaker_id, kind, display_name, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind("fil_probe_file_dupe", "evt_devflow_conf_2027", taskId, "spk_probe_file_dupe", "deliverable", "duplicate-slides.pdf", now, now),
      env.DB.prepare(
        "insert into file_version (id, file_id, version, storage_key, mime_type, size_bytes, latest, uploaded_by_user_id, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind("fver_probe_file_kept", "fil_probe_file_kept", 1, "probe/kept-slides.pdf", "application/pdf", 12, 1, organizer!.id, now, now),
      env.DB.prepare(
        "insert into file_version (id, file_id, version, storage_key, mime_type, size_bytes, latest, uploaded_by_user_id, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind("fver_probe_file_dupe", "fil_probe_file_dupe", 1, "probe/duplicate-slides.pdf", "application/pdf", 34, 1, organizer!.id, now, now),
    ]);

    const cookie = await organizerCookie();
    const merged = await request("/api/speaker-directory/psn_probe_file_kept/merge", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ duplicatePersonId: "psn_probe_file_dupe" }),
    });
    expect(merged.status).toBe(200);

    // The organizer's deliverables list joins live files per assignment, so a second live row
    // for the same request would show the speaker's task twice with no way to tell them apart.
    const deliverables = await (await request("/api/events/evt_devflow_conf_2027/deliverables", {
      headers: { cookie },
    })).json<{ items: Array<{ taskId: string; speaker: { id: string }; file: { displayName: string } | null }> }>();
    const ownRows = deliverables.items.filter((item) =>
      item.taskId === taskId && item.speaker.id === "spk_probe_file_kept");
    expect(ownRows).toHaveLength(1);
    expect(ownRows[0]?.file?.displayName).toBe("kept-slides.pdf");

    // The duplicate's upload is not discarded and does not stay on the archived identity: it
    // belongs to the kept speaker as archived history, with its versions still downloadable.
    const [archivedFile] = await database.select().from(files).where(eq(files.id, "fil_probe_file_dupe"));
    expect(archivedFile).toMatchObject({
      speakerId: "spk_probe_file_kept",
      deletedAt: expect.any(Date),
    });
    expect(await database.select().from(fileVersions).where(eq(fileVersions.fileId, "fil_probe_file_dupe")))
      .toHaveLength(1);
    expect(await database.select().from(files).where(and(
      eq(files.taskId, taskId),
      eq(files.speakerId, "spk_probe_file_kept"),
      isNull(files.deletedAt),
    ))).toHaveLength(1);
  });
});
