// ABOUTME: Exercises the private cross-event speaker directory and its merge boundary.
// ABOUTME: Verifies organizer metadata, filters, history, relationship transfer, and account safety.
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
import type {
  SpeakerDirectoryDetailResponse,
  SpeakerDirectoryListResponse,
  SpeakerDirectoryMergeResult,
} from "../../shared/speaker-directory.ts";
import worker from "../../worker/index.ts";
import { applySpeakerMerge, planSpeakerMergeReferences } from "../../worker/speaker-merge.ts";

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

const directoryLatencyBudgetMs = 200;
const contendedRunnerRelativeCostLimit = 2;
const directoryLatencyContentionCapMs = directoryLatencyBudgetMs * contendedRunnerRelativeCostLimit;
const latencyMeasurementTimeoutMs = 30_000;

function directoryLatencyAllowanceMs(controlP95: number): number {
  return Math.min(
    directoryLatencyContentionCapMs,
    Math.max(directoryLatencyBudgetMs, controlP95 * contendedRunnerRelativeCostLimit),
  );
}

describe("speaker directory", () => {
  it("caps contention tolerance at twice the product latency budget", () => {
    const overloadedControlP95 = 1_000;
    const allowance = directoryLatencyAllowanceMs(overloadedControlP95);

    expect(allowance).toBe(directoryLatencyContentionCapMs);
  });

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

  it("saves private tags and custom fields and combines them in a paginated filter", async () => {
    await request("/api/health");
    const cookie = await organizerCookie();
    const saved = await request("/api/speaker-directory/psn_priya_raman/metadata", {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        tags: ["Keynote", "AI"],
        customFields: { Region: "EMEA", Language: "English" },
      }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({
      tags: ["AI", "Keynote"],
      customFields: { Language: "English", Region: "EMEA" },
    });

    const detail = await request("/api/speaker-directory/psn_priya_raman", { headers: { cookie } });
    expect((await detail.json<SpeakerDirectoryDetailResponse>()).person).toMatchObject({
      tags: ["AI", "Keynote"],
      customFields: { Language: "English", Region: "EMEA" },
    });

    const filtered = await request(
      "/api/speaker-directory?tag=keynote&field=region%3Aemea&sort=name&direction=asc&page=1&pageSize=1",
      { headers: { cookie } },
    );
    expect(filtered.status).toBe(200);
    expect(await filtered.json()).toMatchObject({
      total: 1,
      page: 1,
      pageSize: 1,
      pageCount: 1,
      items: [expect.objectContaining({ id: "psn_priya_raman" })],
    });

    const publicSpeakers = await request("/api/public/events/evt_devflow_conf_2027/speakers");
    expect(await publicSpeakers.text()).not.toContain("EMEA");
  });

  it("adds an attributed internal note without exposing it publicly", async () => {
    await request("/api/health");
    const cookie = await organizerCookie();
    const body = "Invite back for the private accessibility roundtable.";
    const created = await request("/api/speaker-directory/psn_priya_raman/notes", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ body }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ body, author: "Jordan Alvarez" });

    const detail = await request("/api/speaker-directory/psn_priya_raman", { headers: { cookie } });
    expect((await detail.json<SpeakerDirectoryDetailResponse>()).notes).toEqual([
      expect.objectContaining({ body, author: "Jordan Alvarez" }),
    ]);

    const publicSpeakers = await request("/api/public/events/evt_devflow_conf_2027/speakers");
    expect(await publicSpeakers.text()).not.toContain(body);
  });

  it("saves a named segment with the exact filters an organizer can rerun", async () => {
    await request("/api/health");
    const cookie = await organizerCookie();
    await request("/api/speaker-directory/psn_priya_raman/metadata", {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ tags: ["Keynote"], customFields: { Region: "EMEA" } }),
    });
    const filters = {
      search: "Priya",
      tags: ["Keynote"],
      customFields: [{ name: "Region", value: "EMEA" }],
      sort: "name",
      direction: "asc",
    };
    const created = await request("/api/speaker-directory/segments", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "EMEA keynotes", filters }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ name: "EMEA keynotes", filters });

    const list = await request("/api/speaker-directory", { headers: { cookie } });
    expect(await list.json()).toMatchObject({
      savedSegments: [expect.objectContaining({ name: "EMEA keynotes", filters })],
    });

    const rerun = await request(
      "/api/speaker-directory?q=Priya&tag=Keynote&field=Region%3AEMEA&sort=name&direction=asc",
      { headers: { cookie } },
    );
    expect(await rerun.json()).toMatchObject({
      total: 1,
      items: [expect.objectContaining({ id: "psn_priya_raman" })],
    });
  });

  it("moves identity references without rewriting standing, removals, or publication", async () => {
    await request("/api/health");
    const database = drizzle(env.DB);
    const [kept] = await database.select().from(people).where(eq(people.id, "psn_priya_raman"));
    expect(kept).toBeDefined();
    const now = Date.now();
    const publicationHoldAt = now - 30_000;
    const identityEventId = "evt_directory_identity";
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
        "insert into event (id, name, slug, timezone, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
      ).bind(identityEventId, "Directory Identity Summit", "directory-identity-summit", "UTC", now, now),
      env.DB.prepare(
        "insert into speaker (id, person_id, event_id, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
      ).bind(duplicateSpeakerId, duplicatePersonId, identityEventId, "ready", now, now),
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
      ).bind("sspk_directory_duplicate", submissionId, duplicatePersonId, "moderator", 2, now, now),
      env.DB.prepare(
        "insert into submission_speaker (id, submission_id, person_id, role_label, sort_order, created_at, updated_at, deleted_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind("sspk_directory_kept_archived", submissionId, "psn_priya_raman", "speaker", 9, now, now, now),
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
        "insert into program_session (id, event_id, title, content_status, schedule_status, direct_entry, ics_uid, published_at, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        sessionId,
        identityEventId,
        "A duplicate person's session",
        "draft",
        "tbd",
        1,
        "ses_directory_duplicate@session-bored",
        now - 60_000,
        now,
        now,
      ),
      env.DB.prepare(
        "insert into session_speaker (id, session_id, speaker_id, role_label, sort_order, publication_hold_at, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind("ssnr_directory_duplicate", sessionId, duplicateSpeakerId, "moderator", 2, publicationHoldAt, now, now),
      env.DB.prepare(
        "insert into task (id, event_id, title, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
      ).bind(taskId, identityEventId, "Duplicate profile task", "active", now, now),
      env.DB.prepare(
        "insert into task_assignee (id, task_id, speaker_id, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
      ).bind("tassn_directory_duplicate", taskId, duplicateSpeakerId, "in_progress", now, now),
      env.DB.prepare(
        "insert into file (id, event_id, task_id, speaker_id, kind, display_name, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(fileId, identityEventId, taskId, duplicateSpeakerId, "deliverable", "slides.pdf", now, now),
      env.DB.prepare(
        "insert into file_version (id, file_id, version, storage_key, mime_type, size_bytes, latest, uploaded_by_user_id, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind("fver_directory_duplicate", fileId, 1, "directory/slides.pdf", "application/pdf", 42, 1, kept!.userId, now, now),
      // A session the duplicate was removed from after finishing its onboarding work. Removal
      // archives both links precisely so the completion survives being restored later.
      env.DB.prepare(
        "insert into program_session (id, event_id, title, content_status, schedule_status, direct_entry, ics_uid, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        releasedSessionId,
        identityEventId,
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
      ).bind(releasedTaskId, identityEventId, releasedSessionId, "Released session task", "active", now, now),
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
    const mergeResult = await merged.json<SpeakerDirectoryMergeResult>();
    expect(mergeResult).toMatchObject({ keptPersonId: "psn_priya_raman", mergedPersonId: duplicatePersonId });
    expect(mergeResult.plan.conflicts).toEqual([]);
    expect(mergeResult.plan.moves).toEqual(expect.arrayContaining([
      expect.objectContaining({ reference: "submission", rowId: submissionId }),
      expect.objectContaining({ reference: "speaker", rowId: duplicateSpeakerId }),
    ]));
    expect(mergeResult.plan.retained).toEqual(expect.arrayContaining([
      expect.objectContaining({ reference: "submission_speaker", rowId: "sspk_directory_duplicate" }),
    ]));

    const [archivedPerson] = await database.select().from(people).where(eq(people.id, duplicatePersonId));
    expect(archivedPerson?.deletedAt).not.toBeNull();
    expect(archivedPerson).toMatchObject({
      userId: null,
      jobTitle: "Principal Engineer",
      bio: "Profile detail retained on the archived record.",
    });
    const [unchangedKeptPerson] = await database.select().from(people).where(eq(people.id, "psn_priya_raman"));
    expect(unchangedKeptPerson).toMatchObject({
      userId: kept!.userId,
      jobTitle: kept!.jobTitle,
      bio: kept!.bio,
    });
    expect((await database.select().from(submissions).where(eq(submissions.id, submissionId)))[0]?.submitterPersonId)
      .toBe("psn_priya_raman");
    const mergedProposalLinks = await database.select().from(submissionSpeakers)
      .where(eq(submissionSpeakers.submissionId, submissionId));
    expect(mergedProposalLinks.find((participant) => participant.id === "sspk_directory_duplicate")).toMatchObject({
      personId: duplicatePersonId,
      roleLabel: "moderator",
      sortOrder: 2,
      deletedAt: null,
    });
    expect(mergedProposalLinks.find((participant) => participant.id === "sspk_directory_kept_archived")).toMatchObject({
      personId: "psn_priya_raman",
      roleLabel: "speaker",
      sortOrder: 9,
      deletedAt: expect.any(Date),
    });
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
    const [adoptedSpeaker] = await database.select().from(speakers).where(eq(speakers.id, duplicateSpeakerId));
    expect(adoptedSpeaker).toMatchObject({
      personId: "psn_priya_raman",
      status: "ready",
      deletedAt: null,
    });
    const mergedSessionLinks = await database.select().from(sessionSpeakers)
      .where(eq(sessionSpeakers.sessionId, sessionId));
    expect(mergedSessionLinks.find((participant) => participant.id === "ssnr_directory_duplicate")).toMatchObject({
      speakerId: duplicateSpeakerId,
      roleLabel: "moderator",
      sortOrder: 2,
      publicationHoldAt: new Date(publicationHoldAt),
      deletedAt: null,
    });
    expect(mergedSessionLinks).toHaveLength(1);
    expect((await database.select().from(sessions).where(eq(sessions.id, sessionId)))[0]?.publishedAt?.getTime())
      .toBe(now - 60_000);
    const [duplicateAssignment] = await database.select().from(taskAssignees)
      .where(eq(taskAssignees.id, "tassn_directory_duplicate"));
    expect(duplicateAssignment).toMatchObject({
      speakerId: duplicateSpeakerId,
      status: "in_progress",
      grantedBySessionId: null,
      deletedAt: null,
    });
    expect((await database.select().from(files).where(eq(files.id, fileId)))[0]?.speakerId)
      .toBe(duplicateSpeakerId);
    const [mergedFileVersion] = await database.select().from(fileVersions)
      .where(eq(fileVersions.id, "fver_directory_duplicate"));
    const [directoryMerge] = await database.select().from(directoryMerges).where(and(
      eq(directoryMerges.keptPersonId, "psn_priya_raman"),
      eq(directoryMerges.mergedPersonId, duplicatePersonId),
    ));
    expect(mergedFileVersion?.supersededByMergeId).toBe(directoryMerge?.id);
    const [releasedSessionLink] = await database.select().from(sessionSpeakers)
      .where(eq(sessionSpeakers.id, "ssnr_directory_released"));
    expect(releasedSessionLink).toMatchObject({
      speakerId: duplicateSpeakerId,
      deletedAt: expect.any(Date),
    });
    const [releasedAssignment] = await database.select().from(taskAssignees)
      .where(eq(taskAssignees.id, "tassn_directory_released"));
    expect(releasedAssignment).toMatchObject({
      speakerId: duplicateSpeakerId,
      status: "completed",
      grantedBySessionId: releasedSessionId,
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

  it("refuses to strand either speaker row when both people have standing in one event", async () => {
    await request("/api/health");
    const database = drizzle(env.DB);
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "insert into person (id, name, email, organization, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
      ).bind(
        "psn_event_collision_kept",
        "Morgan Collision",
        "morgan.collision.kept@example.com",
        "Collision Works",
        now,
        now,
      ),
      env.DB.prepare(
        "insert into person (id, name, email, organization, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
      ).bind(
        "psn_event_collision_duplicate",
        "Morgan Collision",
        "morgan.collision.duplicate@example.com",
        "Collision Works",
        now,
        now,
      ),
      env.DB.prepare(
        "insert into speaker (id, person_id, event_id, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
      ).bind(
        "spk_event_collision_kept",
        "psn_event_collision_kept",
        "evt_devflow_conf_2027",
        "ready",
        now,
        now,
      ),
      env.DB.prepare(
        "insert into speaker (id, person_id, event_id, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
      ).bind(
        "spk_event_collision_duplicate",
        "psn_event_collision_duplicate",
        "evt_devflow_conf_2027",
        "ready",
        now,
        now,
      ),
    ]);

    const merged = await request("/api/speaker-directory/psn_event_collision_kept/merge", {
      method: "POST",
      headers: { cookie: await organizerCookie(), "content-type": "application/json" },
      body: JSON.stringify({ duplicatePersonId: "psn_event_collision_duplicate" }),
    });
    expect(merged.status).toBe(409);
    expect(await merged.json()).toMatchObject({
      error: "merge_requires_resolution",
      conflicts: [expect.objectContaining({
        reference: "speaker",
        rowId: "spk_event_collision_duplicate",
        targetRowId: "spk_event_collision_kept",
        reason: "event_speaker_collision",
      })],
    });

    expect((await database.select().from(people)
      .where(eq(people.id, "psn_event_collision_duplicate")))[0]?.deletedAt).toBeNull();
    expect((await database.select().from(speakers)
      .where(eq(speakers.id, "spk_event_collision_duplicate")))[0]).toMatchObject({
      personId: "psn_event_collision_duplicate",
      status: "ready",
      deletedAt: null,
    });
  });

  it("aborts when a direct reference arrives between plan and apply", async () => {
    await request("/api/health");
    const database = drizzle(env.DB);
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "insert into person (id, name, email, organization, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
      ).bind("psn_stale_kept", "Riley Race", "riley.kept@example.com", "Race Works", now, now),
      env.DB.prepare(
        "insert into person (id, name, email, organization, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
      ).bind("psn_stale_duplicate", "Riley Race", "riley.duplicate@example.com", "Race Works", now, now),
    ]);
    const [duplicatePerson] = await database.select().from(people)
      .where(eq(people.id, "psn_stale_duplicate"));
    const [organizer] = await database.select().from(users)
      .where(eq(users.email, "sbek-organizer@example.com"));
    expect(duplicatePerson).toBeDefined();
    expect(organizer).toBeDefined();

    const plan = planSpeakerMergeReferences({
      keptPersonId: "psn_stale_kept",
      mergedPersonId: "psn_stale_duplicate",
      submissions: [],
      submissionSpeakers: [],
      speakers: [],
      sessionSpeakers: [],
      taskAssignees: [],
      files: [],
      contactTags: [],
      customFields: [],
      notes: [],
    });
    await env.DB.prepare(
      "insert into submission (id, event_id, form_id, form_version, submitter_person_id, status, is_draft, title, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      "sub_stale_reference",
      "evt_devflow_conf_2027",
      "frm_devflow_cfp_2027",
      1,
      "psn_stale_duplicate",
      "draft",
      1,
      "A reference created after planning",
      now,
      now,
    ).run();

    await expect(applySpeakerMerge({
      database: env.DB,
      plan,
      keptPersonId: "psn_stale_kept",
      mergedPersonId: "psn_stale_duplicate",
      mergedByUserId: organizer!.id,
      reasons: ["same_name_and_organization"],
      mergedProfile: duplicatePerson,
      timestamp: now + 1,
    })).rejects.toThrow("speaker merge plan is stale");

    expect((await database.select().from(people)
      .where(eq(people.id, "psn_stale_duplicate")))[0]?.deletedAt).toBeNull();
    expect((await database.select().from(submissions)
      .where(eq(submissions.id, "sub_stale_reference")))[0]?.submitterPersonId).toBe("psn_stale_duplicate");
    expect(await database.select().from(directoryMerges)
      .where(eq(directoryMerges.mergedPersonId, "psn_stale_duplicate"))).toHaveLength(0);
  });

  it("refuses to revive an archived session participation or copy its publication state", async () => {
    await request("/api/health");
    const database = drizzle(env.DB);
    const now = Date.now();
    const publicationHoldAt = now - 30_000;
    const publishedAt = now - 60_000;
    await env.DB.batch([
      env.DB.prepare(
        "insert into person (id, name, email, organization, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
      ).bind("psn_hold_kept", "Taylor Merge", "taylor.kept@example.com", "Merge Works", now, now),
      env.DB.prepare(
        "insert into person (id, name, email, organization, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
      ).bind("psn_hold_duplicate", "Taylor Merge", "taylor.duplicate@example.com", "Merge Works", now, now),
      env.DB.prepare(
        "insert into speaker (id, person_id, event_id, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
      ).bind("spk_hold_kept", "psn_hold_kept", "evt_devflow_conf_2027", "ready", now, now),
      env.DB.prepare(
        "insert into speaker (id, person_id, event_id, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
      ).bind("spk_hold_duplicate", "psn_hold_duplicate", "evt_devflow_conf_2027", "ready", now, now),
      env.DB.prepare(
        "insert into program_session (id, event_id, title, content_status, schedule_status, direct_entry, ics_uid, published_at, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        "ses_hold_collision",
        "evt_devflow_conf_2027",
        "Publication belongs to the participation",
        "approved",
        "tbd",
        1,
        "ses_hold_collision@session-bored",
        publishedAt,
        now,
        now,
      ),
      env.DB.prepare(
        "insert into session_speaker (id, session_id, speaker_id, role_label, sort_order, created_at, updated_at, deleted_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind("ssnr_hold_kept", "ses_hold_collision", "spk_hold_kept", "speaker", 9, now, now, now),
      env.DB.prepare(
        "insert into session_speaker (id, session_id, speaker_id, role_label, sort_order, publication_hold_at, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        "ssnr_hold_duplicate",
        "ses_hold_collision",
        "spk_hold_duplicate",
        "moderator",
        2,
        publicationHoldAt,
        now,
        now,
      ),
    ]);

    const merged = await request("/api/speaker-directory/psn_hold_kept/merge", {
      method: "POST",
      headers: { cookie: await organizerCookie(), "content-type": "application/json" },
      body: JSON.stringify({ duplicatePersonId: "psn_hold_duplicate" }),
    });
    expect(merged.status).toBe(409);
    expect(await merged.json()).toMatchObject({
      error: "merge_requires_resolution",
      conflicts: expect.arrayContaining([expect.objectContaining({
        reference: "speaker",
        rowId: "spk_hold_duplicate",
        targetRowId: "spk_hold_kept",
        reason: "event_speaker_collision",
      })]),
    });

    const [keptPerson] = await database.select().from(people).where(eq(people.id, "psn_hold_kept"));
    const [duplicatePerson] = await database.select().from(people).where(eq(people.id, "psn_hold_duplicate"));
    expect(keptPerson?.deletedAt).toBeNull();
    expect(duplicatePerson?.deletedAt).toBeNull();

    const [keptSpeaker] = await database.select().from(speakers).where(eq(speakers.id, "spk_hold_kept"));
    const [duplicateSpeaker] = await database.select().from(speakers).where(eq(speakers.id, "spk_hold_duplicate"));
    expect(keptSpeaker).toMatchObject({ status: "ready", deletedAt: null });
    expect(duplicateSpeaker).toMatchObject({ status: "ready", deletedAt: null });

    const [keptParticipation] = await database.select().from(sessionSpeakers)
      .where(eq(sessionSpeakers.id, "ssnr_hold_kept"));
    const [duplicateParticipation] = await database.select().from(sessionSpeakers)
      .where(eq(sessionSpeakers.id, "ssnr_hold_duplicate"));
    expect(keptParticipation).toMatchObject({
      roleLabel: "speaker",
      sortOrder: 9,
      publicationHoldAt: null,
      deletedAt: expect.any(Date),
    });
    expect(duplicateParticipation).toMatchObject({
      roleLabel: "moderator",
      sortOrder: 2,
      publicationHoldAt: new Date(publicationHoldAt),
      deletedAt: null,
    });
    expect((await database.select().from(sessions).where(eq(sessions.id, "ses_hold_collision")))[0]?.publishedAt)
      .toEqual(new Date(publishedAt));
    expect(await database.select().from(directoryMerges)
      .where(eq(directoryMerges.mergedPersonId, "psn_hold_duplicate"))).toHaveLength(0);
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

  it("refuses to choose between same-event speaker rows with a headshot", async () => {
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
      ).bind("spk_directory_photo_merged", "psn_directory_photo_merged", "evt_devflow_conf_2027", "confirmed", now, now),
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
    expect(merged.status).toBe(409);
    expect(await merged.json()).toMatchObject({
      error: "merge_requires_resolution",
      conflicts: expect.arrayContaining([expect.objectContaining({ reason: "event_speaker_collision" })]),
    });

    const [keptPerson] = await database.select().from(people).where(eq(people.id, "psn_directory_photo_kept"));
    expect(keptPerson?.headshotUrl).toBeNull();
    const [duplicatePerson] = await database.select().from(people)
      .where(eq(people.id, "psn_directory_photo_merged"));
    expect(duplicatePerson?.headshotUrl)
      .toBe("/api/public/portal/speakers/spk_directory_photo_merged/headshot?version=1");
    expect(duplicatePerson?.deletedAt).toBeNull();
    expect((await database.select().from(files).where(eq(files.id, "fil_directory_photo_merged")))[0]?.speakerId)
      .toBe("spk_directory_photo_merged");
    const served = await request("/api/public/portal/speakers/spk_directory_photo_merged/headshot?version=1");
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
  });

  it("leaves profile and file headshots unchanged when same-event standing collides", async () => {
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
      ).bind("spk_directory_photo2_merged", "psn_directory_photo2_merged", "evt_devflow_conf_2027", "confirmed", now, now),
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
    expect(merged.status).toBe(409);
    expect(await merged.json()).toMatchObject({
      error: "merge_requires_resolution",
      conflicts: expect.arrayContaining([expect.objectContaining({ reason: "event_speaker_collision" })]),
    });

    const keptHeadshots = await database.select().from(files).where(and(
      eq(files.speakerId, "spk_directory_photo2_kept"),
      eq(files.kind, "headshot"),
    ));
    expect(keptHeadshots.map((file) => file.id)).toEqual(["fil_directory_photo2_kept"]);
    expect((await database.select().from(files).where(eq(files.id, "fil_directory_photo2_merged")))[0]?.speakerId)
      .toBe("spk_directory_photo2_merged");
    expect((await database.select().from(files).where(eq(files.id, "fil_directory_photo2_slides")))[0]?.speakerId)
      .toBe("spk_directory_photo2_merged");
    expect((await database.select().from(people).where(eq(people.id, "psn_directory_photo2_kept")))[0]?.headshotUrl)
      .toBe(keptUrl);
    expect((await database.select().from(people).where(eq(people.id, "psn_directory_photo2_merged")))[0]?.headshotUrl)
      .toBe("/api/public/portal/speakers/spk_directory_photo2_merged/headshot?version=1");
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
  it("refuses a merge that would adopt the duplicate's account", async () => {
    await request("/api/health");
    const database = drizzle(env.DB);
    const now = Date.now();
    const accountId = "usr_directory_account_adoption";
    await env.DB.prepare(
      "insert into user (id, name, email, email_verified, role, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      accountId,
      "Morgan Credential",
      "directory-account-adoption@example.com",
      1,
      "speaker",
      now,
      now,
    ).run();
    await env.DB.batch([
      env.DB.prepare(
        "insert into person (id, name, email, organization, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
      ).bind("psn_directory_account_kept", "Morgan Credential", "morgan.kept@example.com", "Credential Works", now, now),
      env.DB.prepare(
        "insert into person (id, user_id, name, email, organization, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        "psn_directory_account_adoption",
        accountId,
        "Morgan Credential",
        "morgan.account-person@example.com",
        "Credential Works",
        now,
        now,
      ),
    ]);

    const response = await request("/api/speaker-directory/psn_directory_account_kept/merge", {
      method: "POST",
      headers: { cookie: await organizerCookie(), "content-type": "application/json" },
      body: JSON.stringify({ duplicatePersonId: "psn_directory_account_adoption" }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "account_conflict" });
    const [keptPerson] = await database.select().from(people)
      .where(eq(people.id, "psn_directory_account_kept"));
    const [duplicatePerson] = await database.select().from(people)
      .where(eq(people.id, "psn_directory_account_adoption"));
    expect(keptPerson).toMatchObject({ userId: null, deletedAt: null });
    expect(duplicatePerson).toMatchObject({ userId: accountId, deletedAt: null });
  });
  it("refuses a merge when same-event speaker standings disagree", async () => {
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
    expect(merged.status).toBe(409);
    expect(await merged.json()).toMatchObject({ error: "merge_requires_resolution" });

    const [keptSpeaker] = await database.select().from(speakers)
      .where(eq(speakers.id, "spk_probe_withdrawn_kept"));
    expect(keptSpeaker?.status).toBe("withdrawn");
    expect(keptSpeaker?.deletedAt?.getTime()).toBe(withdrawnAt);
    const [duplicateSpeaker] = await database.select().from(speakers)
      .where(eq(speakers.id, "spk_probe_withdrawn_dupe"));
    expect(duplicateSpeaker).toMatchObject({
      personId: "psn_probe_withdrawn_dupe",
      status: "ready",
      deletedAt: null,
    });
    expect((await database.select().from(people).where(eq(people.id, "psn_probe_withdrawn_dupe")))[0]?.deletedAt)
      .toBeNull();

    const publicSpeakers = await (await request("/api/public/events/evt_devflow_conf_2027/speakers"))
      .json<{ items: Array<{ name: string }> }>();
    expect(publicSpeakers.items.some((speaker) => speaker.name === "Wren Terminal")).toBe(false);
  });

  it("leaves colliding deliverables live on their original records", async () => {
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
    expect(merged.status).toBe(409);
    expect(await merged.json()).toMatchObject({
      error: "merge_requires_resolution",
      conflicts: expect.arrayContaining([expect.objectContaining({ reason: "event_speaker_collision" })]),
    });

    const deliverables = await (await request("/api/events/evt_devflow_conf_2027/deliverables", {
      headers: { cookie },
    })).json<{ items: Array<{ taskId: string; speaker: { id: string }; file: { displayName: string } | null }> }>();
    const ownRows = deliverables.items.filter((item) =>
      item.taskId === taskId && item.speaker.id === "spk_probe_file_kept");
    expect(ownRows).toHaveLength(1);
    expect(ownRows[0]?.file?.displayName).toBe("kept-slides.pdf");

    const [duplicateFile] = await database.select().from(files).where(eq(files.id, "fil_probe_file_dupe"));
    expect(duplicateFile).toMatchObject({
      speakerId: "spk_probe_file_dupe",
      deletedAt: null,
    });
    expect(await database.select().from(fileVersions).where(eq(fileVersions.fileId, "fil_probe_file_dupe")))
      .toHaveLength(1);
    expect(await database.select().from(files).where(and(
      eq(files.taskId, taskId),
      eq(files.speakerId, "spk_probe_file_kept"),
      isNull(files.deletedAt),
    ))).toHaveLength(1);
    expect(await database.select().from(files).where(and(
      eq(files.taskId, taskId),
      eq(files.speakerId, "spk_probe_file_dupe"),
      isNull(files.deletedAt),
    ))).toHaveLength(1);
  });
  it("refuses conflicting withdrawal without moving any attached work", async () => {
    await request("/api/health");
    const database = drizzle(env.DB);
    const now = Date.now();
    const withdrawnAt = now - 90_000;
    await env.DB.batch([
      env.DB.prepare(
        "insert into event (id, name, slug, timezone, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
      ).bind("evt_probe_withdrawn_only", "Probe Summit 2029", "probe-summit-2029", "America/Los_Angeles", now, now),
      env.DB.prepare(
        "insert into person (id, name, email, organization, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
      ).bind("psn_probe_wd2_kept", "Robin Standing", "robin.kept@example.com", "Standing Works", now, now),
      env.DB.prepare(
        "insert into person (id, name, email, organization, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
      ).bind("psn_probe_wd2_dupe", "Robin Standing", "robin.duplicate@example.com", "Standing Works", now, now),
      // The record the organizer keeps is live and well past `invited` at this event.
      env.DB.prepare(
        "insert into speaker (id, person_id, event_id, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
      ).bind("spk_probe_wd2_kept", "psn_probe_wd2_kept", "evt_devflow_conf_2027", "confirmed", now, now),
      // The duplicate was withdrawn on the roster, which archives the row it withdraws.
      env.DB.prepare(
        "insert into speaker (id, person_id, event_id, status, created_at, updated_at, deleted_at) values (?, ?, ?, ?, ?, ?, ?)",
      ).bind("spk_probe_wd2_dupe", "psn_probe_wd2_dupe", "evt_devflow_conf_2027", "withdrawn", now, now, withdrawnAt),
      // And it is the only record either person has at this second event.
      env.DB.prepare(
        "insert into speaker (id, person_id, event_id, status, created_at, updated_at, deleted_at) values (?, ?, ?, ?, ?, ?, ?)",
      ).bind("spk_probe_wd2_only", "psn_probe_wd2_dupe", "evt_probe_withdrawn_only", "withdrawn", now, now, withdrawnAt),
      env.DB.prepare(
        "insert into program_session (id, event_id, title, content_status, schedule_status, direct_entry, ics_uid, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        "ses_probe_wd2",
        "evt_devflow_conf_2027",
        "A withdrawn duplicate's session",
        "draft",
        "tbd",
        1,
        "ses_probe_wd2@session-bored",
        now,
        now,
      ),
      env.DB.prepare(
        "insert into session_speaker (id, session_id, speaker_id, role_label, sort_order, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
      ).bind("ssnr_probe_wd2", "ses_probe_wd2", "spk_probe_wd2_dupe", "speaker", 0, now, now),
      env.DB.prepare(
        "insert into task (id, event_id, title, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
      ).bind("tsk_probe_wd2", "evt_devflow_conf_2027", "Withdrawn duplicate onboarding", "active", now, now),
      env.DB.prepare(
        "insert into task_assignee (id, task_id, speaker_id, status, completed_at, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
      ).bind("tassn_probe_wd2", "tsk_probe_wd2", "spk_probe_wd2_dupe", "completed", now, now, now),
    ]);

    const cookie = await organizerCookie();
    const withdrawnList = await request("/api/speaker-directory?q=Robin%20Standing", { headers: { cookie } });
    expect(withdrawnList.status).toBe(200);
    expect((await withdrawnList.json<SpeakerDirectoryListResponse>()).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "psn_probe_wd2_dupe", possibleDuplicateCount: 1 }),
    ]));
    const withdrawnDetail = await request("/api/speaker-directory/psn_probe_wd2_dupe", { headers: { cookie } });
    expect(withdrawnDetail.status).toBe(200);
    const withdrawnContact = await withdrawnDetail.json<SpeakerDirectoryDetailResponse>();
    expect(withdrawnContact.person.sessionCount).toBe(1);
    expect(withdrawnContact.person.events.find((event) => event.id === "evt_devflow_conf_2027")).toMatchObject({
      sessions: [expect.objectContaining({ id: "ses_probe_wd2" })],
    });
    const before = await request("/api/speaker-directory/psn_probe_wd2_kept", { headers: { cookie } });
    expect(before.status).toBe(200);
    expect((await before.json<SpeakerDirectoryDetailResponse>()).possibleDuplicates).toEqual([
      expect.objectContaining({ id: "psn_probe_wd2_dupe", reasons: ["same_name_and_organization"] }),
    ]);

    // The organizer opens the live record and keeps it - the direction the UI offers alongside
    // keeping the candidate, and the one that must not quietly undo the roster's withdrawal.
    const merged = await request("/api/speaker-directory/psn_probe_wd2_kept/merge", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ duplicatePersonId: "psn_probe_wd2_dupe" }),
    });
    expect(merged.status).toBe(409);
    expect(await merged.json()).toMatchObject({ error: "merge_requires_resolution" });

    const [keptSpeaker] = await database.select().from(speakers).where(eq(speakers.id, "spk_probe_wd2_kept"));
    expect(keptSpeaker).toMatchObject({ status: "confirmed", deletedAt: null });
    const [duplicateSpeaker] = await database.select().from(speakers)
      .where(eq(speakers.id, "spk_probe_wd2_dupe"));
    expect(duplicateSpeaker).toMatchObject({
      personId: "psn_probe_wd2_dupe",
      status: "withdrawn",
    });
    expect(duplicateSpeaker?.deletedAt?.getTime()).toBe(withdrawnAt);

    const [carriedSession] = await database.select().from(sessionSpeakers)
      .where(eq(sessionSpeakers.id, "ssnr_probe_wd2"));
    expect(carriedSession?.speakerId).toBe("spk_probe_wd2_dupe");
    const [carriedAssignment] = await database.select().from(taskAssignees)
      .where(eq(taskAssignees.id, "tassn_probe_wd2"));
    expect(carriedAssignment).toMatchObject({ speakerId: "spk_probe_wd2_dupe", status: "completed" });

    // The refusal is atomic: even an otherwise movable event record stays with the duplicate.
    const [onlySpeaker] = await database.select().from(speakers).where(eq(speakers.id, "spk_probe_wd2_only"));
    expect(onlySpeaker).toMatchObject({ personId: "psn_probe_wd2_dupe", status: "withdrawn" });
    expect(onlySpeaker?.deletedAt?.getTime()).toBe(withdrawnAt);
    expect((await database.select().from(people).where(eq(people.id, "psn_probe_wd2_dupe")))[0]?.deletedAt)
      .toBeNull();

    const publicSpeakers = await (await request("/api/public/events/evt_devflow_conf_2027/speakers"))
      .json<{ items: Array<{ name: string }> }>();
    expect(publicSpeakers.items.some((speaker) => speaker.name === "Robin Standing")).toBe(false);
  });

  it("answers a malformed merge request as a bad request rather than a server fault", async () => {
    await request("/api/health");
    const cookie = await organizerCookie();
    const response = await request("/api/speaker-directory/psn_priya_raman/merge", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{ not json",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_merge" });
  });
  it("does not fold assignment provenance when both speaker records hold the task", async () => {
    await request("/api/health");
    const database = drizzle(env.DB);
    const now = Date.now();
    const completedAt = now - 120_000;
    const taskId = "tsk_probe_folded_request";
    const [organizer] = await database.select({ id: users.id }).from(users)
      .where(eq(users.email, "sbek-organizer@example.com"));
    await env.DB.batch([
      env.DB.prepare(
        "insert into person (id, name, email, organization, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
      ).bind("psn_probe_fold_kept", "Ira Folded", "ira.kept@example.com", "Folded Systems", now, now),
      env.DB.prepare(
        "insert into person (id, name, email, organization, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
      ).bind("psn_probe_fold_dupe", "Ira Folded", "ira.duplicate@example.com", "Folded Systems", now, now),
      env.DB.prepare(
        "insert into speaker (id, person_id, event_id, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
      ).bind("spk_probe_fold_kept", "psn_probe_fold_kept", "evt_devflow_conf_2027", "ready", now, now),
      env.DB.prepare(
        "insert into speaker (id, person_id, event_id, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
      ).bind("spk_probe_fold_dupe", "psn_probe_fold_dupe", "evt_devflow_conf_2027", "ready", now, now),
      env.DB.prepare(
        "insert into program_session (id, event_id, title, content_status, schedule_status, direct_entry, ics_uid, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        "ses_probe_fold_grant",
        "evt_devflow_conf_2027",
        "The session that granted the kept assignment",
        "draft",
        "tbd",
        1,
        "ses_probe_fold_grant@session-bored",
        now,
        now,
      ),
      env.DB.prepare(
        "insert into task (id, event_id, task_type, title, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
      ).bind(taskId, "evt_devflow_conf_2027", "file_request", "Send the folded slides", "active", now, now),
      // The kept assignment came from a session handoff and has never answered this request.
      env.DB.prepare(
        "insert into task_assignee (id, task_id, speaker_id, granted_by_session_id, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        "tassn_probe_fold_kept",
        taskId,
        "spk_probe_fold_kept",
        "ses_probe_fold_grant",
        "assigned",
        now,
        now,
      ),
      // The duplicate's organizer-granted assignment is independently owed. It was then dropped
      // from the task's assignees, which archives the assignment and leaves the uploaded file live.
      env.DB.prepare(
        "insert into task_assignee (id, task_id, speaker_id, status, completed_at, created_at, updated_at, deleted_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind("tassn_probe_fold_dupe", taskId, "spk_probe_fold_dupe", "completed", completedAt, now, now, now),
      env.DB.prepare(
        "insert into file (id, event_id, task_id, speaker_id, kind, display_name, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind("fil_probe_fold", "evt_devflow_conf_2027", taskId, "spk_probe_fold_dupe", "deliverable", "folded-slides.pdf", now, now),
      env.DB.prepare(
        "insert into file_version (id, file_id, version, storage_key, mime_type, size_bytes, latest, uploaded_by_user_id, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind("fver_probe_fold", "fil_probe_fold", 1, "probe/folded-slides.pdf", "application/pdf", 21, 1, organizer!.id, now, now),
    ]);

    const cookie = await organizerCookie();
    const merged = await request("/api/speaker-directory/psn_probe_fold_kept/merge", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ duplicatePersonId: "psn_probe_fold_dupe" }),
    });
    expect(merged.status).toBe(409);
    expect(await merged.json()).toMatchObject({
      error: "merge_requires_resolution",
      conflicts: expect.arrayContaining([expect.objectContaining({ reason: "event_speaker_collision" })]),
    });

    const [keptAssignment] = await database.select().from(taskAssignees)
      .where(eq(taskAssignees.id, "tassn_probe_fold_kept"));
    expect(keptAssignment).toMatchObject({
      status: "assigned",
      grantedBySessionId: "ses_probe_fold_grant",
      completedAt: null,
      deletedAt: null,
    });
    const [duplicateAssignment] = await database.select().from(taskAssignees)
      .where(eq(taskAssignees.id, "tassn_probe_fold_dupe"));
    expect(duplicateAssignment).toMatchObject({
      speakerId: "spk_probe_fold_dupe",
      status: "completed",
      grantedBySessionId: null,
      deletedAt: expect.any(Date),
    });
    expect(duplicateAssignment?.completedAt?.getTime()).toBe(completedAt);

    // Refusing the identity merge leaves both assignment decisions and file ownership unchanged.
    const deliverables = await (await request("/api/events/evt_devflow_conf_2027/deliverables", {
      headers: { cookie },
    })).json<{
      items: Array<{
        taskId: string;
        speaker: { id: string };
        assignment: { status: string };
        file: { displayName: string } | null;
      }>;
    }>();
    const ownRows = deliverables.items.filter((item) =>
      item.taskId === taskId && item.speaker.id === "spk_probe_fold_kept");
    expect(ownRows).toHaveLength(1);
    expect(ownRows[0]?.assignment.status).toBe("assigned");
    expect(ownRows[0]?.file).toBeNull();
    expect((await database.select().from(files).where(eq(files.id, "fil_probe_fold")))[0]?.speakerId)
      .toBe("spk_probe_fold_dupe");
  });

  it("merges a directory history larger than D1's per-statement binding ceiling", async () => {
    await request("/api/health");
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "insert into person (id, name, email, organization, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
      ).bind("psn_probe_chunk_kept", "Alex Bound", "alex.kept@example.com", "Bound Systems", now, now),
      env.DB.prepare(
        "insert into person (id, name, email, organization, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
      ).bind("psn_probe_chunk_dupe", "Alex Bound", "alex.duplicate@example.com", "Bound Systems", now, now),
    ]);
    for (let offset = 0; offset < 101; offset += 20) {
      const statements: D1PreparedStatement[] = [];
      for (let index = offset; index < Math.min(101, offset + 20); index += 1) {
        const suffix = String(index).padStart(3, "0");
        const personId = index < 51 ? "psn_probe_chunk_kept" : "psn_probe_chunk_dupe";
        statements.push(
          env.DB.prepare(
            "insert into event (id, name, slug, timezone, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
          ).bind(
            `evt_probe_chunk_${suffix}`,
            `Bound Summit ${suffix}`,
            `bound-summit-${suffix}`,
            "America/Los_Angeles",
            now,
            now,
          ),
          env.DB.prepare(
            "insert into speaker (id, person_id, event_id, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
          ).bind(
            `spk_probe_chunk_${suffix}`,
            personId,
            `evt_probe_chunk_${suffix}`,
            "ready",
            now,
            now,
          ),
        );
      }
      await env.DB.batch(statements);
    }

    const merged = await request("/api/speaker-directory/psn_probe_chunk_kept/merge", {
      method: "POST",
      headers: { cookie: await organizerCookie(), "content-type": "application/json" },
      body: JSON.stringify({ duplicatePersonId: "psn_probe_chunk_dupe" }),
    });
    expect(merged.status).toBe(200);
    expect(await merged.json()).toMatchObject({
      keptPersonId: "psn_probe_chunk_kept",
      mergedPersonId: "psn_probe_chunk_dupe",
    });
  });

  it("keeps multi-criteria filter, sort, and pagination under the admin-table latency budget", async () => {
    await request("/api/health");
    const now = Date.now();
    await env.DB.prepare(
      "insert into speaker_directory_tag (id, name, normalized_name, created_at, updated_at) values (?, ?, ?, ?, ?)",
    ).bind("dtag_performance", "Performance", "performance", now, now).run();
    for (let offset = 0; offset < 300; offset += 25) {
      const statements: D1PreparedStatement[] = [];
      for (let index = offset; index < offset + 25; index += 1) {
        const suffix = String(index).padStart(3, "0");
        const personId = `psn_performance_${suffix}`;
        const speakerId = `spk_performance_${suffix}`;
        statements.push(
          env.DB.prepare(
            "insert into person (id, name, email, organization, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
          ).bind(
            personId,
            `Performance Contact ${suffix}`,
            `performance-${suffix}@example.com`,
            "Performance Labs",
            now,
            now,
          ),
          env.DB.prepare(
            "insert into speaker (id, person_id, event_id, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
          ).bind(speakerId, personId, "evt_devflow_conf_2027", "invited", now, now),
          env.DB.prepare(
            "insert into speaker_directory_contact_tag (person_id, tag_id, created_at) values (?, ?, ?)",
          ).bind(personId, "dtag_performance", now),
          env.DB.prepare(
            "insert into speaker_directory_custom_field (id, person_id, name, normalized_name, value, normalized_value, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
          ).bind(
            `dcf_performance_${suffix}`,
            personId,
            "Region",
            "region",
            index % 2 === 0 ? "EMEA" : "North America",
            index % 2 === 0 ? "emea" : "north america",
            now,
            now,
          ),
        );
      }
      await env.DB.batch(statements);
    }

    const cookie = await organizerCookie();
    const filteredPath =
      "/api/speaker-directory?q=Performance&tag=Performance&field=Region%3AEMEA&sort=events&direction=desc&page=3&pageSize=25";
    const controlPath = "/api/speaker-directory?page=1&pageSize=25";
    const warmed = await request(filteredPath, { headers: { cookie } });
    expect(warmed.status).toBe(200);
    expect(await warmed.json()).toMatchObject({
      total: 150,
      page: 3,
      pageSize: 25,
      pageCount: 6,
    });

    const filteredDurations: number[] = [];
    const controlDurations: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      const controlStartedAt = performance.now();
      expect((await request(controlPath, { headers: { cookie } })).status).toBe(200);
      controlDurations.push(performance.now() - controlStartedAt);
      const startedAt = performance.now();
      const response = await request(filteredPath, { headers: { cookie } });
      filteredDurations.push(performance.now() - startedAt);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        total: 150,
        page: 3,
        pageSize: 25,
        pageCount: 6,
      });
    }
    filteredDurations.sort((first, second) => first - second);
    controlDurations.sort((first, second) => first - second);
    const p95 = filteredDurations[Math.ceil(filteredDurations.length * 0.95) - 1]!;
    const controlP95 = controlDurations[Math.ceil(controlDurations.length * 0.95) - 1]!;
    expect(p95).toBeLessThan(directoryLatencyAllowanceMs(controlP95));
  }, latencyMeasurementTimeoutMs);
});
