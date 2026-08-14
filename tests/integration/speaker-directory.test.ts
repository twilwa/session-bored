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
    expect(await database.select().from(directoryMerges).where(and(
      eq(directoryMerges.keptPersonId, "psn_priya_raman"),
      eq(directoryMerges.mergedPersonId, duplicatePersonId),
    ))).toHaveLength(1);
    expect(await database.select().from(people).where(and(eq(people.id, duplicatePersonId), isNull(people.deletedAt))))
      .toHaveLength(0);
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
});
