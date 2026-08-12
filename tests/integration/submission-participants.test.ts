// ABOUTME: Exercises multi-participant proposals from the public CFP through acceptance and the session.
// ABOUTME: Uses real D1 persistence so participant ownership, privacy, and handoff are verified end to end.
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

const eventId = "evt_devflow_conf_2027";

interface Participant {
  id: string;
  personId: string;
  name: string;
  email: string;
  roleLabel: string;
  isSubmitter: boolean;
}

interface CreatedProposal {
  accessPath: string;
  editKey: string;
  submission: { id: string; participants: Participant[] };
}

function panelProposal(authorEmail: string, intent: "draft" | "submit") {
  return {
    intent,
    speaker: {
      name: "Rosa Okonkwo",
      email: authorEmail,
      jobTitle: "Principal Engineer",
      organization: "Northwind Labs",
    },
    collaborators: [
      { name: "Dev Malhotra", email: `dev.${authorEmail}`, roleLabel: "co-speaker" },
      { name: "Ines Brenner", email: `ines.${authorEmail}`, roleLabel: "moderator" },
    ],
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

async function createPanel(authorEmail: string, intent: "draft" | "submit" = "submit"): Promise<CreatedProposal> {
  const response = await request("/api/public/cfp/devflow-conf-2027/submissions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(panelProposal(authorEmail, intent)),
  });
  expect(response.status).toBe(201);
  return response.json<CreatedProposal>();
}

describe("a proposal that names more than one participant", () => {
  beforeEach(async () => {
    await request("/api/health");
  });

  it("keeps every named participant, in order, through save, edit, and resume", async () => {
    const created = await createPanel("rosa.panel@example.test");
    expect(created.submission.participants.map((participant) => [participant.name, participant.roleLabel]))
      .toEqual([
        ["Rosa Okonkwo", "speaker"],
        ["Dev Malhotra", "co-speaker"],
        ["Ines Brenner", "moderator"],
      ]);
    expect(created.submission.participants[0]?.isSubmitter).toBe(true);
    expect(created.submission.participants[1]?.isSubmitter).toBe(false);
    const restorableId = created.submission.participants[2]?.id;

    const resumePath = `${created.accessPath}?key=${encodeURIComponent(created.editKey)}`;
    const resumed = await request(resumePath);
    expect(resumed.status).toBe(200);
    const resumedBody = await resumed.json<{ submission: { participants: Participant[] } }>();
    expect(resumedBody.submission.participants).toHaveLength(3);

    const dropped = panelProposal("rosa.panel@example.test", "submit");
    const withoutModerator = await request(resumePath, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...dropped, collaborators: [dropped.collaborators[0]] }),
    });
    expect(withoutModerator.status).toBe(200);
    const afterRemoval = await withoutModerator.json<{ submission: { participants: Participant[] } }>();
    expect(afterRemoval.submission.participants.map((participant) => participant.name))
      .toEqual(["Rosa Okonkwo", "Dev Malhotra"]);

    // ABOUTME: A collaborator the author drops and names again keeps the same participant row,
    // so nothing downstream of the proposal sees a brand-new person.
    const restored = await request(resumePath, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(dropped),
    });
    expect(restored.status).toBe(200);
    const afterRestore = await restored.json<{ submission: { participants: Participant[] } }>();
    expect(afterRestore.submission.participants).toHaveLength(3);
    expect(afterRestore.submission.participants[2]?.id).toBe(restorableId);
  });

  it("refuses a participant without a usable identity and refuses a repeated email", async () => {
    const base = panelProposal("rosa.rules@example.test", "submit");
    const nameless = await request("/api/public/cfp/devflow-conf-2027/submissions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...base,
        collaborators: [
          { name: "", email: "no.name@example.test", roleLabel: "co-speaker" },
          { name: "Bad Address", email: "not-an-email", roleLabel: "co-speaker" },
          { name: "Twice Over", email: "rosa.rules@example.test", roleLabel: "co-speaker" },
        ],
      }),
    });
    expect(nameless.status).toBe(422);
    await expect(nameless.json()).resolves.toMatchObject({
      error: "validation_failed",
      fields: {
        "collaborators.0.name": "Give this participant a name, or clear the row.",
        "collaborators.1.email": "Enter a valid email address for this participant.",
        "collaborators.2.email": "This email is already on the proposal.",
      },
    });

    // A row the author started and abandoned is an unused slot, not a validation failure.
    const untouchedRow = await request("/api/public/cfp/devflow-conf-2027/submissions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...base, collaborators: [{ name: "", email: "", roleLabel: "" }] }),
    });
    expect(untouchedRow.status).toBe(201);
    const solo = await untouchedRow.json<CreatedProposal>();
    expect(solo.submission.participants).toHaveLength(1);
  });

  it("gives a collaborator no reach into the proposal and writes no mail to them", async () => {
    const dispatchesBefore = await env.DB.prepare("select count(*) as count from email_dispatch")
      .first<{ count: number }>();
    const created = await createPanel("rosa.privacy@example.test");

    // The private author link is the only key, and naming somebody does not mint them one.
    const authorKeys = await env.DB.prepare(
      "select count(*) as count from submission_author_access where submission_id = ?",
    ).bind(created.submission.id).first<{ count: number }>();
    expect(authorKeys?.count).toBe(1);
    expect((await request(created.accessPath)).status).toBe(404);

    const dispatchesAfter = await env.DB.prepare("select count(*) as count from email_dispatch")
      .first<{ count: number }>();
    expect(dispatchesAfter?.count).toBe(dispatchesBefore?.count);
    const collaboratorMail = await env.DB.prepare(
      "select count(*) as count from email_dispatch where recipients like ?",
    ).bind("%rosa.privacy@example.test%").first<{ count: number }>();
    expect(collaboratorMail?.count).toBe(0);
  });

  it("shows the committee every participant without exposing their contact details", async () => {
    const created = await createPanel("rosa.committee@example.test");
    const organizerCookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");

    const detail = await request(`/api/review/submissions/${created.submission.id}`, {
      headers: { cookie: organizerCookie },
    });
    expect(detail.status).toBe(200);
    const body = await detail.text();
    expect(body).toContain("Dev Malhotra");
    expect(body).toContain("Ines Brenner");
    expect(body).not.toContain("dev.rosa.committee@example.test");
  });
});

describe("acceptance carries every participant onto the session", () => {
  let organizerCookie: string;

  beforeEach(async () => {
    await request("/api/health");
    organizerCookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");
  });

  it("creates one session speaker per participant and keeps their role labels", async () => {
    const created = await createPanel("rosa.accept@example.test");
    const accepted = await request(`/api/events/${eventId}/disposition`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({ submissionIds: [created.submission.id], status: "accepted" }),
    });
    expect(accepted.status).toBe(200);
    const handoff = await accepted.json<{ handoffs: Array<{ speakers: Array<{ name: string }> }> }>();
    expect(handoff.handoffs[0]?.speakers.map((speaker) => speaker.name))
      .toEqual(["Rosa Okonkwo", "Dev Malhotra", "Ines Brenner"]);

    const sessionSpeakerRows = await env.DB.prepare(
      `select person.name as name, session_speaker.role_label as role_label
         from session_speaker
         join program_session on program_session.id = session_speaker.session_id
         join speaker on speaker.id = session_speaker.speaker_id
         join person on person.id = speaker.person_id
        where program_session.submission_id = ? and session_speaker.deleted_at is null
        order by session_speaker.sort_order`,
    ).bind(created.submission.id).all<{ name: string; role_label: string }>();
    expect(sessionSpeakerRows.results).toEqual([
      { name: "Rosa Okonkwo", role_label: "speaker" },
      { name: "Dev Malhotra", role_label: "co-speaker" },
      { name: "Ines Brenner", role_label: "moderator" },
    ]);

    // Every participant picks up the same onboarding work, not only the person who submitted.
    const assignments = await env.DB.prepare(
      `select count(distinct session_speaker.speaker_id) as count
         from session_speaker
         join program_session on program_session.id = session_speaker.session_id
         join task_assignee on task_assignee.speaker_id = session_speaker.speaker_id
        where program_session.submission_id = ? and task_assignee.deleted_at is null`,
    ).bind(created.submission.id).first<{ count: number }>();
    expect(assignments?.count).toBe(3);

    const roster = await request(`/api/events/${eventId}/roster`, { headers: { cookie: organizerCookie } });
    const rosterBody = await roster.json<{ items: Array<{ name: string }> }>();
    const rosterNames = rosterBody.items.map((item) => item.name);
    expect(rosterNames).toEqual(expect.arrayContaining(["Rosa Okonkwo", "Dev Malhotra", "Ines Brenner"]));
  });

  it("publishes the full participant list to the public program without any address", async () => {
    const created = await createPanel("rosa.public@example.test");
    await request(`/api/events/${eventId}/disposition`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({ submissionIds: [created.submission.id], status: "accepted" }),
    });
    const session = await env.DB.prepare("select id from program_session where submission_id = ?")
      .bind(created.submission.id).first<{ id: string }>();
    expect(session).not.toBeNull();

    const placed = await request(`/api/events/${eventId}/agenda/sessions/${session?.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({ scheduleStatus: "tbd", scheduledDate: "2027-05-13" }),
    });
    expect(placed.status).toBe(200);

    const approved = await request(`/api/events/${eventId}/agenda/sessions/${session?.id}/content`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({ contentStatus: "approved" }),
    });
    expect(approved.status).toBe(200);
    const published = await request(`/api/events/${eventId}/agenda/publish`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({ sessionIds: [session?.id] }),
    });
    expect(published.status).toBe(200);

    const program = await request(`/api/public/events/${eventId}/sessions`);
    expect(program.status).toBe(200);
    const programText = await program.text();
    // The author's speaker row already existed from their first draft; acceptance must clear it
    // for publication too, or the person who wrote the proposal is the one name the public misses.
    expect(programText).toContain("Rosa Okonkwo");
    expect(programText).toContain("Dev Malhotra");
    expect(programText).toContain("Ines Brenner");
    expect(programText).not.toContain("@example.test");
  });
});

describe("the program team's own hold on the participant list", () => {
  let organizerCookie: string;

  beforeEach(async () => {
    await request("/api/health");
    organizerCookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");
  });

  it("answers only organizers", async () => {
    const created = await createPanel("rosa.access@example.test");
    const path = `/api/events/${eventId}/submissions/${created.submission.id}/participants`;
    expect((await request(path)).status).toBe(401);

    const reviewerCookie = await signIn("sbek-reviewer@example.com", "SbekTest!2027-rev");
    expect((await request(path, { headers: { cookie: reviewerCookie } })).status).toBe(403);

    const speakerCookie = await signIn("sbek-speaker@example.com", "SbekTest!2027-spk");
    expect((await request(path, { headers: { cookie: speakerCookie } })).status).toBe(403);

    expect((await request(path, { headers: { cookie: organizerCookie } })).status).toBe(200);
  });

  it("adds, amends, and removes participants on a proposal still under review", async () => {
    const created = await createPanel("rosa.amend@example.test");
    const path = `/api/events/${eventId}/submissions/${created.submission.id}/participants`;

    const added = await request(path, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({
        name: "Late Addition",
        email: "late.addition@example.test",
        roleLabel: "workshop assistant",
      }),
    });
    expect(added.status).toBe(201);
    const afterAdd = await added.json<{ sessionId: string | null; participants: Participant[] }>();
    expect(afterAdd.sessionId).toBeNull();
    expect(afterAdd.participants.map((participant) => participant.name))
      .toEqual(["Rosa Okonkwo", "Dev Malhotra", "Ines Brenner", "Late Addition"]);

    const duplicate = await request(path, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({ name: "Late Addition", email: "late.addition@example.test" }),
    });
    expect(duplicate.status).toBe(409);

    const amended = await request(`${path}/${afterAdd.participants[3]?.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({ roleLabel: "co-speaker" }),
    });
    expect(amended.status).toBe(200);
    const afterAmend = await amended.json<{ participants: Participant[] }>();
    expect(afterAmend.participants[3]?.roleLabel).toBe("co-speaker");

    const submitterRemoval = await request(`${path}/${afterAdd.participants[0]?.id}`, {
      method: "DELETE",
      headers: { cookie: organizerCookie },
    });
    expect(submitterRemoval.status).toBe(409);
    await expect(submitterRemoval.json()).resolves.toMatchObject({ error: "submitter_cannot_be_removed" });

    const removed = await request(`${path}/${afterAdd.participants[3]?.id}`, {
      method: "DELETE",
      headers: { cookie: organizerCookie },
    });
    expect(removed.status).toBe(200);
    const afterRemove = await removed.json<{ participants: Participant[] }>();
    expect(afterRemove.participants.map((participant) => participant.name))
      .toEqual(["Rosa Okonkwo", "Dev Malhotra", "Ines Brenner"]);
  });

  it("carries a participant added after acceptance onto the session and its onboarding work", async () => {
    const created = await createPanel("rosa.late@example.test");
    await request(`/api/events/${eventId}/disposition`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({ submissionIds: [created.submission.id], status: "accepted" }),
    });
    const path = `/api/events/${eventId}/submissions/${created.submission.id}/participants`;

    const added = await request(path, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({ name: "After The Fact", email: "after.the.fact@example.test", roleLabel: "co-speaker" }),
    });
    expect(added.status).toBe(201);
    const afterAdd = await added.json<{ sessionId: string | null; participants: Array<Participant & { onSession: boolean }> }>();
    expect(afterAdd.sessionId).not.toBeNull();
    expect(afterAdd.participants.every((participant) => participant.onSession)).toBe(true);

    const carried = await env.DB.prepare(
      `select person.name as name, session_speaker.role_label as role_label
         from session_speaker
         join program_session on program_session.id = session_speaker.session_id
         join speaker on speaker.id = session_speaker.speaker_id
         join person on person.id = speaker.person_id
        where program_session.submission_id = ? and session_speaker.deleted_at is null
          and person.email = ?`,
    ).bind(created.submission.id, "after.the.fact@example.test").first<{ name: string; role_label: string }>();
    expect(carried).toMatchObject({ name: "After The Fact", role_label: "co-speaker" });

    const onboarding = await env.DB.prepare(
      `select count(*) as count from task_assignee
         join speaker on speaker.id = task_assignee.speaker_id
         join person on person.id = speaker.person_id
        where person.email = ? and task_assignee.deleted_at is null`,
    ).bind("after.the.fact@example.test").first<{ count: number }>();
    expect(onboarding?.count).toBeGreaterThan(0);

    const removed = await request(`${path}/${afterAdd.participants[3]?.id}`, {
      method: "DELETE",
      headers: { cookie: organizerCookie },
    });
    expect(removed.status).toBe(200);
    const stillLinked = await env.DB.prepare(
      `select count(*) as count from session_speaker
         join program_session on program_session.id = session_speaker.session_id
         join speaker on speaker.id = session_speaker.speaker_id
         join person on person.id = speaker.person_id
        where program_session.submission_id = ? and person.email = ? and session_speaker.deleted_at is null`,
    ).bind(created.submission.id, "after.the.fact@example.test").first<{ count: number }>();
    expect(stillLinked?.count).toBe(0);
    // Removing somebody from the programme never erases the speaker Greenroom already adopted.
    const speakerRow = await env.DB.prepare(
      "select count(*) as count from speaker join person on person.id = speaker.person_id where person.email = ?",
    ).bind("after.the.fact@example.test").first<{ count: number }>();
    expect(speakerRow?.count).toBe(1);
  });
});
