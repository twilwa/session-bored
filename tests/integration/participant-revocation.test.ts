// ABOUTME: Proves that removing a participant revokes their reach into the proposal and its session.
// ABOUTME: Covers both removal doors, every speaker-facing read and write, and naming somebody again.
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { sessions, taskAssignees, tasks } from "../../db/schema.ts";
import type { EmailDelivery, EmailDeliveryResult } from "../../worker/email.ts";
import { sendSessionCalendarInvite } from "../../worker/email/calendar-invite.ts";
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

const eventId = "evt_devflow_conf_2027";
const marcusCredentials = { email: "sbek-speaker2@example.com", password: "SbekTest!2027-spk2" };
const priyaCredentials = { email: "sbek-speaker@example.com", password: "SbekTest!2027-spk" };

interface Participant {
  id: string;
  personId: string;
  name: string;
  email: string;
  roleLabel: string;
}

interface SpeakerContent {
  submissions: Array<{ id: string; title: string }>;
  sessions: Array<{ id: string; title: string; editable: boolean }>;
  tasks: Array<{ id: string; title: string }>;
}

interface CreatedProposal {
  accessPath: string;
  editKey: string;
  submission: { id: string; participants: Participant[] };
}

interface Collaborator {
  name: string;
  email: string;
  roleLabel: string;
}

function panelProposal(authorEmail: string, collaborators: Collaborator[]) {
  return {
    intent: "submit" as const,
    speaker: {
      name: "Rosa Okonkwo",
      email: authorEmail,
      jobTitle: "Principal Engineer",
      organization: "Northwind Labs",
    },
    collaborators,
    proposal: {
      title: "What a panel actually owes its audience",
      abstract: "Three practitioners on the difference between a discussion and a performance.",
      track: "Developer Experience",
      format: "Talk (30 min)",
      audienceLevel: "Intermediate",
      answers: { key_takeaway: "A panel needs a shared question, not three separate talks." },
    },
  };
}

async function createPanel(authorEmail: string, collaborators: Collaborator[]): Promise<CreatedProposal> {
  const response = await request("/api/public/cfp/devflow-conf-2027/submissions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(panelProposal(authorEmail, collaborators)),
  });
  expect(response.status).toBe(201);
  return response.json<CreatedProposal>();
}

async function accept(submissionId: string, organizerCookie: string): Promise<string> {
  const response = await request(`/api/events/${eventId}/disposition`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: organizerCookie },
    body: JSON.stringify({ submissionIds: [submissionId], status: "accepted" }),
  });
  expect(response.status).toBe(200);
  const body = await response.json<{ handoffs: Array<{ session: { id: string } }> }>();
  const sessionId = body.handoffs[0]?.session.id;
  if (sessionId === undefined) {
    throw new Error(`Acceptance of ${submissionId} created no session`);
  }
  return sessionId;
}

async function participantsOf(submissionId: string, organizerCookie: string): Promise<Participant[]> {
  const response = await request(`/api/events/${eventId}/submissions/${submissionId}/participants`, {
    headers: { cookie: organizerCookie },
  });
  expect(response.status).toBe(200);
  return (await response.json<{ participants: Participant[] }>()).participants;
}

async function speakerContent(cookie: string): Promise<SpeakerContent> {
  const response = await request("/api/speaker/content", { headers: { cookie } });
  expect(response.status).toBe(200);
  return response.json<SpeakerContent>();
}

/**
 * Every speaker-facing door a named participant is given, read and write. A removal that closes
 * some of them and leaves others open is the defect this suite exists to catch, so each case
 * walks the whole list rather than a representative one.
 */
async function speakerReach(cookie: string, submissionId: string, sessionId: string) {
  const proposal = await request(`/api/speaker/submissions/${submissionId}`, { headers: { cookie } });
  const content = await speakerContent(cookie);
  const sessionWrite = await request(`/api/portal/sessions/${sessionId}`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ abstract: "Rewritten by whoever still holds the door open." }),
  });
  return {
    proposalRead: proposal.status,
    listsProposal: content.submissions.some((item) => item.id === submissionId),
    listsSession: content.sessions.some((item) => item.id === sessionId),
    sessionWrite: sessionWrite.status,
  };
}

const fullReach = { proposalRead: 200, listsProposal: true, listsSession: true, sessionWrite: 200 };
const noReach = { proposalRead: 403, listsProposal: false, listsSession: false, sessionWrite: 403 };

/** Records who a send was addressed to, so nothing in this suite reaches the network. */
function recordingDelivery(): EmailDelivery & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async send(message): Promise<EmailDeliveryResult> {
      calls.push(message.recipient);
      return { status: "sent", providerMessageId: `msg_${calls.length}` };
    },
  };
}

async function liveTaskAssignments(email: string): Promise<number> {
  const row = await env.DB.prepare(
    `select count(*) as count from task_assignee
       join speaker on speaker.id = task_assignee.speaker_id
       join person on person.id = speaker.person_id
      where person.email = ? and task_assignee.deleted_at is null`,
  ).bind(email).first<{ count: number }>();
  return row?.count ?? 0;
}

async function liveSessionLinks(sessionId: string, email: string): Promise<number> {
  const row = await env.DB.prepare(
    `select count(*) as count from session_speaker
       join speaker on speaker.id = session_speaker.speaker_id
       join person on person.id = speaker.person_id
      where session_speaker.session_id = ? and person.email = ? and session_speaker.deleted_at is null`,
  ).bind(sessionId, email).first<{ count: number }>();
  return row?.count ?? 0;
}

/**
 * The rows a template-less event really produces: `resolveOnboardingTasks` seeds a session's
 * own onboarding tasks when the event configures no event-wide templates, and hands them to
 * every participant carried onto that session. The seeded fixture event configures templates,
 * so this writes the same shape directly rather than standing up a second event.
 */
async function giveSessionScopedTask(sessionId: string, email: string, title: string): Promise<string> {
  const speaker = await env.DB.prepare(
    `select speaker.id as id from speaker
       join person on person.id = speaker.person_id
      where person.email = ? and speaker.event_id = ?`,
  ).bind(email, eventId).first<{ id: string }>();
  expect(speaker).not.toBeNull();
  const database = drizzle(env.DB);
  const taskId = `tsk_scoped_${sessionId}`;
  await database
    .insert(tasks)
    .values({ id: taskId, eventId, sessionId, taskType: "general", title, status: "active" });
  await database
    .insert(taskAssignees)
    .values({ id: `tassn_scoped_${sessionId}`, taskId, speakerId: speaker!.id });
  return taskId;
}

async function taskIsLiveFor(taskId: string, email: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `select count(*) as count from task_assignee
       join speaker on speaker.id = task_assignee.speaker_id
       join person on person.id = speaker.person_id
      where task_assignee.task_id = ? and person.email = ? and task_assignee.deleted_at is null`,
  ).bind(taskId, email).first<{ count: number }>();
  return (row?.count ?? 0) > 0;
}

const marcus = { name: "Marcus Okafor", email: marcusCredentials.email, roleLabel: "co-speaker" };

describe("removing a participant revokes what naming them granted", () => {
  let organizerCookie: string;
  let marcusCookie: string;

  beforeEach(async () => {
    await request("/api/health");
    organizerCookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");
    marcusCookie = await signIn(marcusCredentials.email, marcusCredentials.password);
  });

  it("closes every speaker-facing door the organizer's removal claims to close", async () => {
    const created = await createPanel("rosa.organizerdoor@example.test", []);
    const sessionId = await accept(created.submission.id, organizerCookie);
    const path = `/api/events/${eventId}/submissions/${created.submission.id}/participants`;
    const added = await request(path, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify(marcus),
    });
    expect(added.status).toBe(201);
    const named = (await added.json<{ participants: Participant[] }>()).participants
      .find((participant) => participant.email === marcus.email);
    expect(named).toBeDefined();

    // Being named really does open all of them, so the refusals below mean removal and nothing else.
    expect(await speakerReach(marcusCookie, created.submission.id, sessionId)).toEqual(fullReach);

    const removed = await request(`${path}/${named?.id}`, { method: "DELETE", headers: { cookie: organizerCookie } });
    expect(removed.status).toBe(200);

    expect(await speakerReach(marcusCookie, created.submission.id, sessionId)).toEqual(noReach);
    expect(await liveSessionLinks(sessionId, marcus.email)).toBe(0);

    // The removal is the whole reason for the refusal: his own other session is untouched.
    expect((await speakerContent(marcusCookie)).sessions.map((session) => session.id))
      .toContain("ses_docs_retrieval");
  });

  it("closes the same doors when the author drops a collaborator from the proposal", async () => {
    const created = await createPanel("rosa.authordoor@example.test", [marcus]);
    const sessionId = await accept(created.submission.id, organizerCookie);
    const resumePath = `${created.accessPath}?key=${encodeURIComponent(created.editKey)}`;

    expect(await speakerReach(marcusCookie, created.submission.id, sessionId)).toEqual(fullReach);

    const dropped = await request(resumePath, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(panelProposal("rosa.authordoor@example.test", [])),
    });
    expect(dropped.status).toBe(200);

    expect(await speakerReach(marcusCookie, created.submission.id, sessionId)).toEqual(noReach);
    expect(await liveSessionLinks(sessionId, marcus.email)).toBe(0);

    // The author naming them again is the same restoration the organizer's door performs.
    const restored = await request(resumePath, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(panelProposal("rosa.authordoor@example.test", [marcus])),
    });
    expect(restored.status).toBe(200);
    expect(await speakerReach(marcusCookie, created.submission.id, sessionId)).toEqual(fullReach);
  });

  it("leaves the author and the remaining participants exactly where they were", async () => {
    const priya = { name: "Priya Raman", email: priyaCredentials.email, roleLabel: "co-speaker" };
    const created = await createPanel("rosa.remaining@example.test", [marcus, priya]);
    const sessionId = await accept(created.submission.id, organizerCookie);
    const path = `/api/events/${eventId}/submissions/${created.submission.id}/participants`;
    const named = (await participantsOf(created.submission.id, organizerCookie))
      .find((participant) => participant.email === marcus.email);

    const removed = await request(`${path}/${named?.id}`, { method: "DELETE", headers: { cookie: organizerCookie } });
    expect(removed.status).toBe(200);

    const priyaCookie = await signIn(priyaCredentials.email, priyaCredentials.password);
    expect(await speakerReach(priyaCookie, created.submission.id, sessionId)).toEqual(fullReach);
    expect(await liveSessionLinks(sessionId, priya.email)).toBe(1);
    expect(await liveTaskAssignments(priya.email)).toBeGreaterThan(0);

    const remaining = await participantsOf(created.submission.id, organizerCookie);
    expect(remaining.map((participant) => participant.email))
      .toEqual(["rosa.remaining@example.test", priya.email]);
  });

  it("gives a participant named again everything a participant has", async () => {
    const created = await createPanel("rosa.restored@example.test", [marcus]);
    const sessionId = await accept(created.submission.id, organizerCookie);
    const path = `/api/events/${eventId}/submissions/${created.submission.id}/participants`;
    const named = (await participantsOf(created.submission.id, organizerCookie))
      .find((participant) => participant.email === marcus.email);
    await request(`${path}/${named?.id}`, { method: "DELETE", headers: { cookie: organizerCookie } });
    expect(await speakerReach(marcusCookie, created.submission.id, sessionId)).toEqual(noReach);

    const namedAgain = await request(path, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify(marcus),
    });
    expect(namedAgain.status).toBe(201);

    expect(await speakerReach(marcusCookie, created.submission.id, sessionId)).toEqual(fullReach);
    // The same participant row comes back rather than a second one, so nothing downstream doubles.
    const restored = (await participantsOf(created.submission.id, organizerCookie))
      .find((participant) => participant.email === marcus.email);
    expect(restored?.id).toBe(named?.id);
    expect(await liveSessionLinks(sessionId, marcus.email)).toBe(1);
  });

  it("takes back the onboarding work naming them created, and gives it back when they return", async () => {
    const collaborator = { name: "Named Collaborator", email: "solo.removed@example.test", roleLabel: "co-speaker" };
    const created = await createPanel("rosa.onboarding@example.test", [collaborator]);
    await accept(created.submission.id, organizerCookie);
    const path = `/api/events/${eventId}/submissions/${created.submission.id}/participants`;
    expect(await liveTaskAssignments(collaborator.email)).toBeGreaterThan(0);

    const named = (await participantsOf(created.submission.id, organizerCookie))
      .find((participant) => participant.email === collaborator.email);
    const removed = await request(`${path}/${named?.id}`, { method: "DELETE", headers: { cookie: organizerCookie } });
    expect(removed.status).toBe(200);
    expect(await liveTaskAssignments(collaborator.email)).toBe(0);

    const namedAgain = await request(path, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify(collaborator),
    });
    expect(namedAgain.status).toBe(201);
    expect(await liveTaskAssignments(collaborator.email)).toBeGreaterThan(0);
  });

  it("keeps the onboarding work of somebody who still speaks elsewhere at the event", async () => {
    const created = await createPanel("rosa.elsewhere@example.test", [marcus]);
    const sessionId = await accept(created.submission.id, organizerCookie);
    const path = `/api/events/${eventId}/submissions/${created.submission.id}/participants`;
    const named = (await participantsOf(created.submission.id, organizerCookie))
      .find((participant) => participant.email === marcus.email);
    await request(`${path}/${named?.id}`, { method: "DELETE", headers: { cookie: organizerCookie } });

    expect(await liveSessionLinks(sessionId, marcus.email)).toBe(0);
    expect(await liveTaskAssignments(marcus.email)).toBeGreaterThan(0);
    const ownTask = (await speakerContent(marcusCookie)).tasks[0];
    expect(ownTask).toBeDefined();
    const complete = await request(`/api/portal/tasks/${ownTask?.id}`, {
      method: "PATCH",
      headers: { cookie: marcusCookie, "content-type": "application/json" },
      body: JSON.stringify({ status: "completed" }),
    });
    expect(complete.status).toBe(200);
  });

  it("stops showing the removed participant to the committee that judges the proposal", async () => {
    // The seeded reviewer's remit covers this proposal, and a reviewer declares a conflict of
    // interest against exactly this list, so a name the program team removed must leave it.
    const path = `/api/events/${eventId}/submissions/sub_ci_monorepo/participants`;
    const added = await request(path, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({ name: "Briefly Named", email: "briefly.named@example.test", roleLabel: "co-presenter" }),
    });
    expect(added.status).toBe(201);

    const reviewerCookie = await signIn("sbek-reviewer@example.com", "SbekTest!2027-rev");
    const beforeRemoval = await request("/api/review/submissions/sub_ci_monorepo", {
      headers: { cookie: reviewerCookie },
    });
    expect(beforeRemoval.status).toBe(200);
    expect(await beforeRemoval.text()).toContain("Briefly Named");

    const named = (await participantsOf("sub_ci_monorepo", organizerCookie))
      .find((participant) => participant.email === "briefly.named@example.test");
    const removed = await request(`${path}/${named?.id}`, { method: "DELETE", headers: { cookie: organizerCookie } });
    expect(removed.status).toBe(200);

    for (const cookie of [reviewerCookie, organizerCookie]) {
      const detail = await request("/api/review/submissions/sub_ci_monorepo", { headers: { cookie } });
      expect(detail.status).toBe(200);
      expect(await detail.text()).not.toContain("Briefly Named");
    }
  });

  it("leaves the removed participant off the session's own board and calendar invite", async () => {
    const collaborator = { name: "Named Collaborator", email: "solo.invite@example.test", roleLabel: "co-speaker" };
    const created = await createPanel("rosa.invite@example.test", [collaborator]);
    const sessionId = await accept(created.submission.id, organizerCookie);
    const path = `/api/events/${eventId}/submissions/${created.submission.id}/participants`;
    const named = (await participantsOf(created.submission.id, organizerCookie))
      .find((participant) => participant.email === collaborator.email);
    await request(`${path}/${named?.id}`, { method: "DELETE", headers: { cookie: organizerCookie } });

    const board = await request(`/api/events/${eventId}/agenda`, { headers: { cookie: organizerCookie } });
    expect(board.status).toBe(200);
    const boardSessions = (await board.json<{ sessions: Array<{ id: string; speakers: Array<{ name: string }> }> }>())
      .sessions;
    const card = boardSessions.find((session) => session.id === sessionId);
    expect(card).toBeDefined();
    expect(card?.speakers.map((speaker) => speaker.name)).toEqual(["Rosa Okonkwo"]);

    const database = drizzle(env.DB);
    await database
      .update(sessions)
      .set({ startsAt: new Date("2027-05-13T17:00:00Z"), endsAt: new Date("2027-05-13T17:30:00Z") })
      .where(eq(sessions.id, sessionId));
    const delivery = recordingDelivery();
    const invite = await sendSessionCalendarInvite(database, env, eventId, sessionId, null, delivery);
    expect(invite).toMatchObject({ status: "sent" });
    expect(delivery.calls).toEqual(["rosa.invite@example.test"]);
  });

  it("stops inventing a clash between two sessions that no longer share anybody", async () => {
    // The board's speaker list is also the input to the speaker-overlap rule, so a removed
    // participant left in it double-books a person who is on only one of the two sessions and
    // offers to unplace the session that was placed correctly.
    const created = await createPanel("rosa.clash@example.test", []);
    const sessionId = await accept(created.submission.id, organizerCookie);
    const path = `/api/events/${eventId}/submissions/${created.submission.id}/participants`;
    const added = await request(path, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify(marcus),
    });
    expect(added.status).toBe(201);
    const named = (await participantsOf(created.submission.id, organizerCookie))
      .find((participant) => participant.email === marcus.email);

    const place = async (placedSessionId: string, roomId: string) =>
      request(`/api/events/${eventId}/agenda/sessions/${placedSessionId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: organizerCookie },
        body: JSON.stringify({
          scheduleStatus: "placed",
          scheduledDate: "2027-05-13",
          roomId,
          startsAt: new Date("2027-05-13T14:00:00Z").getTime(),
        }),
      });

    await place(sessionId, "rm_room_2a");
    const whileNamed = await place("ses_docs_retrieval", "rm_main_stage");
    expect(whileNamed.status).toBe(200);
    const named_conflicts = (await whileNamed.json<{ conflicts: Array<{ kind: string; name: string }> }>()).conflicts;
    // Marcus really is on both sessions right now, so the clash is real and reported.
    expect(named_conflicts.some((conflict) => conflict.kind === "speaker" && conflict.name === "Marcus Okafor"))
      .toBe(true);

    const removed = await request(`${path}/${named?.id}`, { method: "DELETE", headers: { cookie: organizerCookie } });
    expect(removed.status).toBe(200);

    const board = await request(`/api/events/${eventId}/agenda`, { headers: { cookie: organizerCookie } });
    const agenda = await board.json<{
      sessions: Array<{ id: string; speakers: Array<{ name: string }> }>;
      conflicts: Array<{ kind: string; name: string; sessionIds: string[] }>;
    }>();
    expect(agenda.sessions.find((session) => session.id === sessionId)?.speakers.map((speaker) => speaker.name))
      .toEqual(["Rosa Okonkwo"]);
    expect(agenda.conflicts.filter((conflict) => conflict.kind === "speaker")).toEqual([]);
  });

  it("never writes mail to the participant it names or removes", async () => {
    const created = await createPanel("rosa.silent@example.test", []);
    await accept(created.submission.id, organizerCookie);
    const path = `/api/events/${eventId}/submissions/${created.submission.id}/participants`;
    const added = await request(path, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify(marcus),
    });
    expect(added.status).toBe(201);
    const named = (await participantsOf(created.submission.id, organizerCookie))
      .find((participant) => participant.email === marcus.email);
    await request(`${path}/${named?.id}`, { method: "DELETE", headers: { cookie: organizerCookie } });

    const mail = await env.DB.prepare("select count(*) as count from email_dispatch where recipients like ?")
      .bind(`%${marcus.email}%`).first<{ count: number }>();
    expect(mail?.count).toBe(0);
  });

  it("takes back a session's own onboarding work as soon as they leave that session", async () => {
    // Two sessions, one person on both. Session-scoped work belongs to the session, so
    // leaving the first must take its work back even though they still speak at the second -
    // and the second removal must not be the only chance to archive it.
    // A collaborator who speaks nowhere else at the event, so the final removal really is
    // their last session - the seeded Marcus always keeps `ses_docs_retrieval`.
    const twoSessions = {
      name: "Ilse Vandermeer",
      email: "ilse.twosessions@example.test",
      roleLabel: "co-speaker",
    };
    const first = await createPanel("rosa.twosessions.one@example.test", [twoSessions]);
    const second = await createPanel("rosa.twosessions.two@example.test", [twoSessions]);
    const firstSessionId = await accept(first.submission.id, organizerCookie);
    const secondSessionId = await accept(second.submission.id, organizerCookie);
    expect(firstSessionId).not.toBe(secondSessionId);

    const firstTaskId = await giveSessionScopedTask(firstSessionId, twoSessions.email, "Record a session trailer");
    const secondTaskId = await giveSessionScopedTask(secondSessionId, twoSessions.email, "Send the panel questions");
    expect(await taskIsLiveFor(firstTaskId, twoSessions.email)).toBe(true);
    expect(await taskIsLiveFor(secondTaskId, twoSessions.email)).toBe(true);

    const removeFrom = async (submissionId: string) => {
      const path = `/api/events/${eventId}/submissions/${submissionId}/participants`;
      const named = (await participantsOf(submissionId, organizerCookie))
        .find((participant) => participant.email === twoSessions.email);
      expect(named).toBeDefined();
      const response = await request(`${path}/${named?.id}`, {
        method: "DELETE",
        headers: { cookie: organizerCookie },
      });
      expect(response.status).toBe(200);
    };

    await removeFrom(first.submission.id);
    expect(await liveSessionLinks(firstSessionId, twoSessions.email)).toBe(0);
    expect(await taskIsLiveFor(firstTaskId, twoSessions.email)).toBe(false);
    // They still speak at the second session, so its own work stays.
    expect(await taskIsLiveFor(secondTaskId, twoSessions.email)).toBe(true);

    await removeFrom(second.submission.id);
    expect(await taskIsLiveFor(secondTaskId, twoSessions.email)).toBe(false);
    // Nothing from either session is left for the portal to expose or accept an upload against.
    expect(await taskIsLiveFor(firstTaskId, twoSessions.email)).toBe(false);
    expect(await liveTaskAssignments(twoSessions.email)).toBe(0);
  });
});
