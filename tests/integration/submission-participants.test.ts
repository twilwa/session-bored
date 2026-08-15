// ABOUTME: Exercises multi-participant proposals from the public CFP through acceptance and the session.
// ABOUTME: Uses real D1 persistence so participant ownership, privacy, and handoff are verified end to end.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { ParticipantRemovalOutcome } from "../../shared/api.ts";
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

  it("holds a participant added to a published session until the organizer republishes", async () => {
    const created = await createPanel("rosa.pending-publication@example.test");
    await request(`/api/events/${eventId}/disposition`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({ submissionIds: [created.submission.id], status: "accepted" }),
    });
    const session = await env.DB.prepare("select id from program_session where submission_id = ?")
      .bind(created.submission.id).first<{ id: string }>();
    expect(session).not.toBeNull();
    await request(`/api/events/${eventId}/agenda/sessions/${session?.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({ scheduleStatus: "tbd", scheduledDate: "2027-05-13" }),
    });
    await request(`/api/events/${eventId}/agenda/sessions/${session?.id}/content`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({ contentStatus: "approved" }),
    });
    const agendaBeforeFirstPublish = await request(`/api/events/${eventId}/agenda`, {
      headers: { cookie: organizerCookie },
    }).then((response) => response.json<{ sessions: Array<{ id: string; pendingSpeakerCount: number }> }>());
    expect(agendaBeforeFirstPublish.sessions.find((item) => item.id === session?.id)?.pendingSpeakerCount).toBe(0);
    const firstPublish = await request(`/api/events/${eventId}/agenda/publish`, {
      method: "POST",
      headers: { cookie: organizerCookie },
    });
    expect(firstPublish.status).toBe(200);

    const repeatedAcceptance = await request(`/api/events/${eventId}/disposition`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({ submissionIds: [created.submission.id], status: "accepted" }),
    });
    expect(repeatedAcceptance.status).toBe(200);
    const publicAfterRepeatedAcceptance = await request(`/api/public/events/${eventId}/sessions`);
    const publicAfterRepeatedAcceptanceText = await publicAfterRepeatedAcceptance.text();
    for (const participantName of ["Rosa Okonkwo", "Dev Malhotra", "Ines Brenner"]) {
      expect(publicAfterRepeatedAcceptanceText).toContain(participantName);
    }

    const participantsPath = `/api/events/${eventId}/submissions/${created.submission.id}/participants`;
    const added = await request(participantsPath, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({
        name: "Pending Presenter",
        email: "pending.presenter@example.test",
        roleLabel: "co-speaker",
      }),
    });
    expect(added.status).toBe(201);
    const afterAdd = await added.json<{
      sessionPubliclyLive: boolean;
      participants: Array<Participant & { publicationPending: boolean }>;
    }>();
    expect(afterAdd.sessionPubliclyLive).toBe(true);
    expect(afterAdd.participants.find((participant) => participant.name === "Pending Presenter"))
      .toMatchObject({ onSession: true, publicationPending: true });

    // Re-applying the decision is a silent status change the product allows at any time, and it
    // must not stand in for the republish that confirms a held participant.
    const acceptedAgainWhilePending = await request(`/api/events/${eventId}/disposition`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({ submissionIds: [created.submission.id], status: "accepted" }),
    });
    expect(acceptedAgainWhilePending.status).toBe(200);

    const publicBefore = await request(`/api/public/events/${eventId}/sessions`);
    const publicBeforeText = await publicBefore.text();
    expect(publicBeforeText).toContain("What a panel actually owes its audience");
    expect(publicBeforeText).not.toContain("Pending Presenter");
    const directoryBefore = await request(`/api/public/events/${eventId}/speakers`);
    expect(await directoryBefore.text()).not.toContain("Pending Presenter");
    const agendaBeforeRepublish = await request(`/api/events/${eventId}/agenda`, {
      headers: { cookie: organizerCookie },
    }).then((response) => response.json<{ sessions: Array<{ id: string; pendingSpeakerCount: number }> }>());
    expect(agendaBeforeRepublish.sessions.find((item) => item.id === session?.id)?.pendingSpeakerCount).toBe(1);
    const embedResponse = await request(`/api/events/${eventId}/embeds`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({ name: "Pending participant proof", widgetType: "sessions", status: "published" }),
    });
    expect(embedResponse.status).toBe(201);
    const embed = await embedResponse.json<{ publicToken: string }>();
    const embedBefore = await request(`/api/public/embeds/${embed.publicToken}.json`);
    expect(await embedBefore.text()).not.toContain("Pending Presenter");

    const rosterBefore = await request(`/api/events/${eventId}/roster`, {
      headers: { cookie: organizerCookie },
    });
    const rosterBeforePayload = await rosterBefore.json<{
      items: Array<{
        name: string;
        status: string;
        pendingPublicationSessions: Array<{ id: string; title: string; awaitingContentApproval: boolean }>;
      }>;
    }>();
    expect(rosterBeforePayload.items.find((speaker) => speaker.name === "Pending Presenter"))
      .toMatchObject({
        pendingPublicationSessions: [{
          id: session?.id,
          title: "What a panel actually owes its audience",
          awaitingContentApproval: false,
        }],
      });

    const republish = await request(`/api/events/${eventId}/agenda/publish`, {
      method: "POST",
      headers: { cookie: organizerCookie },
    });
    expect(republish.status).toBe(200);
    // Nobody becomes public without this publish naming them.
    const republishBody = await republish.json<{
      releasedParticipants: Array<{ sessionId: string; sessionTitle: string; name: string }>;
      notes: string[];
    }>();
    expect(republishBody.releasedParticipants).toEqual([{
      sessionId: session?.id,
      sessionTitle: "What a panel actually owes its audience",
      speakerId: expect.stringMatching(/^spk_/),
      name: "Pending Presenter",
    }]);
    expect(republishBody.notes.join(" ")).toContain("Pending Presenter");

    const publicAfter = await request(`/api/public/events/${eventId}/sessions`);
    expect(await publicAfter.text()).toContain("Pending Presenter");
    const directoryAfter = await request(`/api/public/events/${eventId}/speakers`);
    expect(await directoryAfter.text()).toContain("Pending Presenter");
    const embedAfter = await request(`/api/public/embeds/${embed.publicToken}.json`);
    expect(await embedAfter.text()).toContain("Pending Presenter");
    const participantsAfter = await request(participantsPath, { headers: { cookie: organizerCookie } });
    const participantsAfterPayload = await participantsAfter.json<{
      participants: Array<Participant & { publicationPending: boolean }>;
    }>();
    expect(participantsAfterPayload.participants.find((participant) => participant.name === "Pending Presenter"))
      .toMatchObject({ publicationPending: false });
    const rosterAfter = await request(`/api/events/${eventId}/roster`, {
      headers: { cookie: organizerCookie },
    }).then((response) =>
      response.json<{ items: Array<{ name: string; pendingPublicationSessions: unknown[] }> }>()
    );
    expect(rosterAfter.items.find((speaker) => speaker.name === "Pending Presenter")?.pendingPublicationSessions)
      .toEqual([]);
  });

  it("leaves an archived speaker's pending place pending, however often the agenda is published", async () => {
    const created = await createPanel("rosa.archived-pending@example.test");
    await request(`/api/events/${eventId}/disposition`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({ submissionIds: [created.submission.id], status: "accepted" }),
    });
    const session = await env.DB.prepare("select id from program_session where submission_id = ?")
      .bind(created.submission.id).first<{ id: string }>();
    await request(`/api/events/${eventId}/agenda/sessions/${session?.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({ scheduleStatus: "tbd", scheduledDate: "2027-05-13" }),
    });
    await request(`/api/events/${eventId}/agenda/sessions/${session?.id}/content`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({ contentStatus: "approved" }),
    });
    const publish = () =>
      request(`/api/events/${eventId}/agenda/publish`, { method: "POST", headers: { cookie: organizerCookie } });
    expect((await publish()).status).toBe(200);

    const email = "archived.pending@example.test";
    const added = await request(`/api/events/${eventId}/submissions/${created.submission.id}/participants`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({ name: "Archived Pending", email, roleLabel: "co-speaker" }),
    });
    expect(added.status).toBe(201);
    const readRoster = () =>
      request(`/api/events/${eventId}/roster`, { headers: { cookie: organizerCookie } })
        .then((response) => response.json<{ items: Array<{ id: string; name: string; status: string }> }>());
    const speakerId = (await readRoster()).items.find((speaker) => speaker.name === "Archived Pending")?.id;
    expect(speakerId).toBeDefined();

    // Archiving takes them off the roster and off the agenda's pending count, so a publish run
    // for unrelated reasons is one the organizer was never told concerned them.
    expect((await request(`/api/events/${eventId}/speakers/${speakerId}`, {
      method: "DELETE",
      headers: { cookie: organizerCookie },
    })).status).toBe(200);
    const agendaWhileArchived = await request(`/api/events/${eventId}/agenda`, {
      headers: { cookie: organizerCookie },
    }).then((response) => response.json<{ sessions: Array<{ id: string; pendingSpeakerCount: number }> }>());
    expect(agendaWhileArchived.sessions.find((item) => item.id === session?.id)?.pendingSpeakerCount).toBe(0);
    const whileArchived = await request(
      `/api/events/${eventId}/submissions/${created.submission.id}/participants`,
      { headers: { cookie: organizerCookie } },
    ).then((response) =>
      response.json<{ participants: Array<{ name: string; onSession: boolean; publicationPending: boolean }> }>()
    );
    expect(whileArchived.participants.find((participant) => participant.name === "Archived Pending"))
      .toMatchObject({ onSession: true, publicationPending: false });
    expect((await publish()).status).toBe(200);

    // Restoring them is not a publication decision, so their place is still waiting for one.
    const restored = await request(`/api/events/${eventId}/speakers`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({ name: "Archived Pending", email, status: "onboarding" }),
    });
    expect(restored.status).toBe(200);
    await expect(restored.json()).resolves.toMatchObject({ restoredSpeaker: true });

    expect(await (await request(`/api/public/events/${eventId}/sessions`)).text())
      .not.toContain("Archived Pending");
    const agendaAfterRestore = await request(`/api/events/${eventId}/agenda`, {
      headers: { cookie: organizerCookie },
    }).then((response) => response.json<{ sessions: Array<{ id: string; pendingSpeakerCount: number }> }>());
    expect(agendaAfterRestore.sessions.find((item) => item.id === session?.id)?.pendingSpeakerCount).toBe(1);

    expect((await publish()).status).toBe(200);
    expect(await (await request(`/api/public/events/${eventId}/sessions`)).text())
      .toContain("Archived Pending");
  });

  it("names content approval, not a republish, for a session the publish route would skip", async () => {
    const created = await createPanel("rosa.unpublishable@example.test");
    const decide = (status: string) =>
      request(`/api/events/${eventId}/disposition`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: organizerCookie },
        body: JSON.stringify({ submissionIds: [created.submission.id], status }),
      });
    await decide("accepted");
    const session = await env.DB.prepare("select id from program_session where submission_id = ?")
      .bind(created.submission.id).first<{ id: string }>();
    await request(`/api/events/${eventId}/agenda/sessions/${session?.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({ scheduleStatus: "tbd", scheduledDate: "2027-05-13" }),
    });
    await request(`/api/events/${eventId}/agenda/sessions/${session?.id}/content`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({ contentStatus: "approved" }),
    });
    expect((await request(`/api/events/${eventId}/agenda/publish`, {
      method: "POST",
      headers: { cookie: organizerCookie },
    })).status).toBe(200);

    // Un-accepting returns the session's content to draft and keeps its schedule and publication
    // marker, so from here on publish skips it however many participants are waiting.
    expect((await decide("maybe")).status).toBe(200);
    const participantsPath = `/api/events/${eventId}/submissions/${created.submission.id}/participants`;
    const added = await request(participantsPath, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({
        name: "Unpublishable Addition",
        email: "unpublishable.addition@example.test",
        roleLabel: "co-speaker",
      }),
    });
    expect(added.status).toBe(201);
    expect((await decide("accepted")).status).toBe(200);

    const agenda = await request(`/api/events/${eventId}/agenda`, { headers: { cookie: organizerCookie } })
      .then((response) =>
        response.json<{ sessions: Array<{ id: string; contentStatus: string; pendingSpeakerCount: number }> }>()
      );
    // The hold is a fact about the participation, so it is on show even though the session that
    // would release it is currently unpublishable.
    expect(agenda.sessions.find((item) => item.id === session?.id))
      .toMatchObject({ contentStatus: "draft", pendingSpeakerCount: 1 });

    // The roster has to say what clears the hold - a bare republish would skip this session.
    const roster = await request(`/api/events/${eventId}/roster`, { headers: { cookie: organizerCookie } })
      .then((response) =>
        response.json<{
          items: Array<{
            name: string;
            pendingPublicationSessions: Array<{ id: string; title: string; awaitingContentApproval: boolean }>;
          }>;
        }>()
      );
    expect(roster.items.find((speaker) => speaker.name === "Unpublishable Addition"))
      .toMatchObject({
        pendingPublicationSessions: [{
          id: session?.id,
          title: "What a panel actually owes its audience",
          awaitingContentApproval: true,
        }],
      });

    const listed = await request(participantsPath, { headers: { cookie: organizerCookie } })
      .then((response) =>
        response.json<{
          sessionPublishedAt: number | null;
          sessionPubliclyLive: boolean;
          sessionAwaitingContentApproval: boolean;
          participants: Array<{ name: string; onSession: boolean; publicationPending: boolean }>;
        }>()
      );
    expect(listed.sessionPublishedAt).not.toBeNull();
    expect(listed.sessionPubliclyLive).toBe(false);
    expect(listed.sessionAwaitingContentApproval).toBe(true);
    expect(listed.participants.find((participant) => participant.name === "Unpublishable Addition"))
      .toMatchObject({ onSession: true, publicationPending: true });

    // The publish route agrees: it skips the session rather than revealing anybody on it.
    const publish = await request(`/api/events/${eventId}/agenda/publish`, {
      method: "POST",
      headers: { cookie: organizerCookie },
    });
    expect(publish.status).toBe(200);
    const publishBody = await publish.json<{ skipped: Array<{ id: string; reasons: string[] }> }>();
    expect(publishBody.skipped.find((skip) => skip.id === session?.id)?.reasons).toContain("content_not_approved");
    const directory = await request(`/api/public/events/${eventId}/speakers`);
    expect(await directory.text()).not.toContain("Unpublishable Addition");
  });

  it("leaves a speaker the organizer parked at invited parked when the session first publishes", async () => {
    const created = await createPanel("rosa.parked@example.test");
    await request(`/api/events/${eventId}/disposition`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({ submissionIds: [created.submission.id], status: "accepted" }),
    });
    const session = await env.DB.prepare("select id from program_session where submission_id = ?")
      .bind(created.submission.id).first<{ id: string }>();

    // The session has never been published, so this addition starts onboarding like anybody else.
    const added = await request(`/api/events/${eventId}/submissions/${created.submission.id}/participants`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({
        name: "Parked Presenter",
        email: "parked.presenter@example.test",
        roleLabel: "co-speaker",
      }),
    });
    expect(added.status).toBe(201);
    const readStatus = async () =>
      (await request(`/api/events/${eventId}/roster`, { headers: { cookie: organizerCookie } })
        .then((response) => response.json<{ items: Array<{ id: string; name: string; status: string }> }>()))
        .items.find((speaker) => speaker.name === "Parked Presenter");
    const speaker = await readStatus();
    expect(speaker).toMatchObject({ status: "onboarding" });

    // The organizer parks them by hand on the roster. Publishing the agenda is a decision about
    // the programme, not a licence to overrule a workflow status somebody set deliberately.
    expect((await request(`/api/events/${eventId}/speakers/${speaker?.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({ status: "invited" }),
    })).status).toBe(200);
    await request(`/api/events/${eventId}/agenda/sessions/${session?.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({ scheduleStatus: "tbd", scheduledDate: "2027-05-13" }),
    });
    await request(`/api/events/${eventId}/agenda/sessions/${session?.id}/content`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({ contentStatus: "approved" }),
    });
    expect((await request(`/api/events/${eventId}/agenda/publish`, {
      method: "POST",
      headers: { cookie: organizerCookie },
    })).status).toBe(200);

    expect(await readStatus()).toMatchObject({ status: "invited" });
    const programme = await (await request(`/api/public/events/${eventId}/sessions`)).text();
    expect(programme).toContain("What a panel actually owes its audience");
    expect(programme).not.toContain("Parked Presenter");
    expect(await (await request(`/api/public/events/${eventId}/speakers`)).text())
      .not.toContain("Parked Presenter");
  });

  it("changes nobody's standing at the event, whichever publish the organizer runs", async () => {
    const created = await createPanel("rosa.standing@example.test");
    await request(`/api/events/${eventId}/disposition`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({ submissionIds: [created.submission.id], status: "accepted" }),
    });
    const session = await env.DB.prepare("select id from program_session where submission_id = ?")
      .bind(created.submission.id).first<{ id: string }>();
    const standings = async () =>
      (await env.DB.prepare("select id, status from speaker where event_id = ? order by id")
        .bind(eventId).all<{ id: string; status: string }>()).results;
    const publish = () =>
      request(`/api/events/${eventId}/agenda/publish`, { method: "POST", headers: { cookie: organizerCookie } });

    // Publishing with nothing eligible, on a first publish, and on a republish that releases a
    // hold: an agenda decision never rewrites whether somebody has agreed to present.
    const beforeAnything = await standings();
    expect((await publish()).status).toBe(200);
    expect(await standings()).toEqual(beforeAnything);

    await request(`/api/events/${eventId}/agenda/sessions/${session?.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({ scheduleStatus: "tbd", scheduledDate: "2027-05-13" }),
    });
    await request(`/api/events/${eventId}/agenda/sessions/${session?.id}/content`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({ contentStatus: "approved" }),
    });
    const beforeFirstPublish = await standings();
    expect((await publish()).status).toBe(200);
    expect(await standings()).toEqual(beforeFirstPublish);

    expect((await request(`/api/events/${eventId}/submissions/${created.submission.id}/participants`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({ name: "Standing Addition", email: "standing.addition@example.test" }),
    })).status).toBe(201);
    const beforeRepublish = await standings();
    const republish = await publish();
    expect(republish.status).toBe(200);
    await expect(republish.json()).resolves.toMatchObject({
      releasedParticipants: [expect.objectContaining({ name: "Standing Addition" })],
    });
    expect(await standings()).toEqual(beforeRepublish);
  });

  it("keeps a held participant held and on show when the session is re-placed before the republish", async () => {
    const created = await createPanel("rosa.replaced@example.test");
    await request(`/api/events/${eventId}/disposition`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({ submissionIds: [created.submission.id], status: "accepted" }),
    });
    const session = await env.DB.prepare("select id from program_session where submission_id = ?")
      .bind(created.submission.id).first<{ id: string }>();
    const place = (placement: Record<string, unknown>) =>
      request(`/api/events/${eventId}/agenda/sessions/${session?.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: organizerCookie },
        body: JSON.stringify(placement),
      });
    await place({ scheduleStatus: "tbd", scheduledDate: "2027-05-13" });
    await request(`/api/events/${eventId}/agenda/sessions/${session?.id}/content`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({ contentStatus: "approved" }),
    });
    expect((await request(`/api/events/${eventId}/agenda/publish`, {
      method: "POST",
      headers: { cookie: organizerCookie },
    })).status).toBe(200);

    const participantsPath = `/api/events/${eventId}/submissions/${created.submission.id}/participants`;
    expect((await request(participantsPath, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({ name: "Moved Along", email: "moved.along@example.test", roleLabel: "co-speaker" }),
    })).status).toBe(201);

    const heldCount = async () =>
      (await env.DB.prepare(
        `select count(*) as count from session_speaker
          where session_id = ? and deleted_at is null and publication_hold_at is not null`,
      ).bind(session?.id).first<{ count: number }>())?.count ?? 0;
    const affordances = async () => ({
      held: await heldCount(),
      agenda: (await request(`/api/events/${eventId}/agenda`, { headers: { cookie: organizerCookie } })
        .then((response) =>
          response.json<{ sessions: Array<{ id: string; pendingSpeakerCount: number }> }>()
        ))
        .sessions.find((item) => item.id === session?.id)?.pendingSpeakerCount,
      panel: (await request(participantsPath, { headers: { cookie: organizerCookie } })
        .then((response) =>
          response.json<{ participants: Array<{ name: string; publicationPending: boolean }> }>()
        ))
        .participants.filter((participant) => participant.publicationPending).length,
      roster: (await request(`/api/events/${eventId}/roster`, { headers: { cookie: organizerCookie } })
        .then((response) =>
          response.json<{ items: Array<{ name: string; pendingPublicationSessions: Array<{ id: string }> }> }>()
        ))
        .items.find((speaker) => speaker.name === "Moved Along")?.pendingPublicationSessions.length,
    });
    const outstandingSteps = async () => {
      const roster = await request(`/api/events/${eventId}/roster`, { headers: { cookie: organizerCookie } })
        .then((response) =>
          response.json<{
            items: Array<{
              name: string;
              pendingPublicationSessions: Array<
                { awaitingContentApproval: boolean; awaitingPlacement: boolean }
              >;
            }>;
          }>()
        );
      const panel = await request(participantsPath, { headers: { cookie: organizerCookie } })
        .then((response) =>
          response.json<{
            sessionAwaitingContentApproval: boolean;
            sessionAwaitingPlacement: boolean;
          }>()
        );
      return {
        roster: roster.items.find((speaker) => speaker.name === "Moved Along")
          ?.pendingPublicationSessions[0],
        panel: {
          awaitingContentApproval: panel.sessionAwaitingContentApproval,
          awaitingPlacement: panel.sessionAwaitingPlacement,
        },
      };
    };
    expect(await affordances()).toEqual({ held: 1, agenda: 1, panel: 1, roster: 1 });

    // Every state the session can be dragged into. The hold belongs to the participation, so it
    // survives placement clearing the session's own publication and stays on show throughout -
    // otherwise the next publish reveals somebody the organizer was never shown. What the notice
    // asks for has to follow the state: publishing skips an unplaced session, so offering a bare
    // republish there leaves the participant held with nothing the organizer can do about it.
    for (const step of [
      { placement: { scheduleStatus: "tbd", scheduledDate: "2027-05-14" }, awaitingPlacement: false },
      { placement: { scheduleStatus: "unplaced" }, awaitingPlacement: true },
      { placement: { scheduleStatus: "tbd", scheduledDate: "2027-05-12" }, awaitingPlacement: false },
    ]) {
      expect((await place(step.placement)).status).toBe(200);
      expect(await affordances()).toEqual({ held: 1, agenda: 1, panel: 1, roster: 1 });
      const outstanding = { awaitingContentApproval: false, awaitingPlacement: step.awaitingPlacement };
      expect(await outstandingSteps()).toMatchObject({ roster: outstanding, panel: outstanding });
      expect(await (await request(`/api/public/events/${eventId}/sessions`)).text())
        .not.toContain("Moved Along");
    }

    // An unplaced session the publish would skip is named as skipped, and the hold stands.
    expect((await place({ scheduleStatus: "unplaced" })).status).toBe(200);
    const skippedPublish = await request(`/api/events/${eventId}/agenda/publish`, {
      method: "POST",
      headers: { cookie: organizerCookie },
    });
    expect(skippedPublish.status).toBe(200);
    await expect(skippedPublish.json()).resolves.toMatchObject({
      releasedParticipants: [],
      skipped: expect.arrayContaining([
        expect.objectContaining({ id: session?.id, reasons: ["not_placed"] }),
      ]),
    });
    expect(await affordances()).toEqual({ held: 1, agenda: 1, panel: 1, roster: 1 });
    expect((await place({ scheduleStatus: "tbd", scheduledDate: "2027-05-12" })).status).toBe(200);
    await request(`/api/events/${eventId}/agenda/sessions/${session?.id}/content`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({ contentStatus: "approved" }),
    });
    expect(await affordances()).toEqual({ held: 1, agenda: 1, panel: 1, roster: 1 });

    const released = await request(`/api/events/${eventId}/agenda/publish`, {
      method: "POST",
      headers: { cookie: organizerCookie },
    });
    expect(released.status).toBe(200);
    await expect(released.json()).resolves.toMatchObject({
      releasedParticipants: [expect.objectContaining({ name: "Moved Along" })],
    });
    expect(await affordances()).toEqual({ held: 0, agenda: 0, panel: 0, roster: 0 });
    expect(await (await request(`/api/public/events/${eventId}/sessions`)).text()).toContain("Moved Along");
  });

  it("decides a restored participant's hold afresh rather than inheriting the old one", async () => {
    const created = await createPanel("rosa.restored@example.test");
    await request(`/api/events/${eventId}/disposition`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({ submissionIds: [created.submission.id], status: "accepted" }),
    });
    const session = await env.DB.prepare("select id from program_session where submission_id = ?")
      .bind(created.submission.id).first<{ id: string }>();
    const participantsPath = `/api/events/${eventId}/submissions/${created.submission.id}/participants`;
    const holdOf = async (email: string) =>
      (await env.DB.prepare(
        `select session_speaker.publication_hold_at as hold from session_speaker
           join speaker on speaker.id = session_speaker.speaker_id
           join person on person.id = speaker.person_id
          where session_speaker.session_id = ? and person.email = ? and session_speaker.deleted_at is null`,
      ).bind(session?.id, email).first<{ hold: number | null }>())?.hold ?? null;
    const addAgain = async (name: string, email: string) => {
      const response = await request(participantsPath, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: organizerCookie },
        body: JSON.stringify({ name, email, roleLabel: "co-speaker" }),
      });
      expect(response.status).toBe(201);
      return response.json<{ participants: Array<{ id: string; name: string }> }>();
    };
    const removeNamed = async (name: string) => {
      const listed = await request(participantsPath, { headers: { cookie: organizerCookie } })
        .then((response) => response.json<{ participants: Array<{ id: string; name: string }> }>());
      const target = listed.participants.find((participant) => participant.name === name);
      expect((await request(`${participantsPath}/${target?.id}`, {
        method: "DELETE",
        headers: { cookie: organizerCookie },
      })).status).toBe(200);
    };

    // Removed and re-added while the session is unpublished: no hold, whatever the row said before.
    await addAgain("Return Trip", "return.trip@example.test");
    expect(await holdOf("return.trip@example.test")).toBeNull();
    await removeNamed("Return Trip");
    await addAgain("Return Trip", "return.trip@example.test");
    expect(await holdOf("return.trip@example.test")).toBeNull();

    await request(`/api/events/${eventId}/agenda/sessions/${session?.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({ scheduleStatus: "tbd", scheduledDate: "2027-05-13" }),
    });
    await request(`/api/events/${eventId}/agenda/sessions/${session?.id}/content`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({ contentStatus: "approved" }),
    });
    expect((await request(`/api/events/${eventId}/agenda/publish`, {
      method: "POST",
      headers: { cookie: organizerCookie },
    })).status).toBe(200);
    expect(await holdOf("return.trip@example.test")).toBeNull();

    // Removed while public and re-added: held again, because their public place has to be
    // confirmed a second time rather than resumed from the publish that predates the removal.
    await removeNamed("Return Trip");
    await addAgain("Return Trip", "return.trip@example.test");
    expect(await holdOf("return.trip@example.test")).not.toBeNull();
    expect(await (await request(`/api/public/events/${eventId}/sessions`)).text())
      .not.toContain("Return Trip");

    // And the same removal followed by a re-placement, so the session is unpublished again: the
    // restored link starts clean rather than carrying the hold it happened to have.
    await removeNamed("Return Trip");
    await request(`/api/events/${eventId}/agenda/sessions/${session?.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({ scheduleStatus: "tbd", scheduledDate: "2027-05-14" }),
    });
    await addAgain("Return Trip", "return.trip@example.test");
    expect(await holdOf("return.trip@example.test")).toBeNull();
  });

  it("never releases or takes a publication hold through a roster workflow edit", async () => {
    const created = await createPanel("rosa.roster-edit@example.test");
    await request(`/api/events/${eventId}/disposition`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({ submissionIds: [created.submission.id], status: "accepted" }),
    });
    const session = await env.DB.prepare("select id from program_session where submission_id = ?")
      .bind(created.submission.id).first<{ id: string }>();
    await request(`/api/events/${eventId}/agenda/sessions/${session?.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({ scheduleStatus: "tbd", scheduledDate: "2027-05-13" }),
    });
    await request(`/api/events/${eventId}/agenda/sessions/${session?.id}/content`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({ contentStatus: "approved" }),
    });
    expect((await request(`/api/events/${eventId}/agenda/publish`, {
      method: "POST",
      headers: { cookie: organizerCookie },
    })).status).toBe(200);
    expect((await request(`/api/events/${eventId}/submissions/${created.submission.id}/participants`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({ name: "Workflow Edited", email: "workflow.edited@example.test" }),
    })).status).toBe(201);
    const speakerId = (await request(`/api/events/${eventId}/roster`, { headers: { cookie: organizerCookie } })
      .then((response) => response.json<{ items: Array<{ id: string; name: string }> }>()))
      .items.find((speaker) => speaker.name === "Workflow Edited")?.id;
    expect(speakerId).toBeDefined();
    const hold = async () =>
      (await env.DB.prepare(
        "select publication_hold_at as hold from session_speaker where session_id = ? and speaker_id = ?",
      ).bind(session?.id, speakerId).first<{ hold: number | null }>())?.hold ?? null;
    const takenAt = await hold();
    expect(takenAt).not.toBeNull();

    // Every workflow status an organizer can set. Agreeing to present is not the same decision
    // as appearing on the public site, and the roster must not be able to make it.
    for (const status of ["confirmed", "pending_employer_approval", "ready", "invited", "onboarding"]) {
      expect((await request(`/api/events/${eventId}/speakers/${speakerId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: organizerCookie },
        body: JSON.stringify({ status }),
      })).status).toBe(200);
      expect(await hold()).toBe(takenAt);
      expect(await (await request(`/api/public/events/${eventId}/sessions`)).text())
        .not.toContain("Workflow Edited");
      expect(await (await request(`/api/public/events/${eventId}/speakers`)).text())
        .not.toContain("Workflow Edited");
    }
  });

  it("reports that a removed participant remains an event speaker", async () => {
    const created = await createPanel("rosa.remains@example.test");
    await request(`/api/events/${eventId}/disposition`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({ submissionIds: [created.submission.id], status: "accepted" }),
    });
    const path = `/api/events/${eventId}/submissions/${created.submission.id}/participants`;
    const listed = await (await request(path, { headers: { cookie: organizerCookie } }))
      .json<{ participants: Participant[] }>();
    const collaborator = listed.participants.find((participant) => participant.name === "Dev Malhotra");
    expect(collaborator).toBeDefined();

    const removed = await request(`${path}/${collaborator?.id}`, {
      method: "DELETE",
      headers: { cookie: organizerCookie },
    });
    expect(removed.status).toBe(200);
    const afterRemove = await removed.json<{ removal: ParticipantRemovalOutcome }>();
    expect(afterRemove.removal).toMatchObject({
      name: "Dev Malhotra",
      remainsEventSpeaker: true,
      // The proposal's session content was never approved, so the directory never listed them,
      // and the outcome says so rather than claiming a public place they did not have.
      listedPublicly: false,
      speaksElsewhereAtEvent: false,
      // Acceptance carried them onto the session, so removal really did take that access.
      heldSessionAccess: true,
    });
    expect(afterRemove.removal.speakerId).not.toBeNull();

    const stillASpeaker = await env.DB.prepare(
      `select speaker.status as status, speaker.deleted_at as deleted_at from speaker
         join person on person.id = speaker.person_id
        where person.email = ? and speaker.event_id = ?`,
    ).bind(`dev.rosa.remains@example.test`, eventId).first<{ status: string; deleted_at: string | null }>();
    expect(stillASpeaker).toMatchObject({ status: "onboarding", deleted_at: null });
  });

  it("reports the session's content status, so the notice claims only the access that existed", async () => {
    const created = await createPanel("rosa.approved@example.test");
    await request(`/api/events/${eventId}/disposition`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({ submissionIds: [created.submission.id], status: "accepted" }),
    });
    const path = `/api/events/${eventId}/submissions/${created.submission.id}/participants`;
    const listed = await (await request(path, { headers: { cookie: organizerCookie } }))
      .json<{ sessionId: string | null; sessionContentStatus: string | null; participants: Participant[] }>();
    expect(listed.sessionContentStatus).toBe("draft");

    // Approving locks the speakers out of editing, so removal takes no write access from them.
    const approved = await request(
      `/api/events/${eventId}/agenda/sessions/${listed.sessionId}/content`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: organizerCookie },
        body: JSON.stringify({ contentStatus: "approved" }),
      },
    );
    expect(approved.status).toBe(200);
    const collaborator = listed.participants.find((participant) => participant.name === "Dev Malhotra");
    const removed = await request(`${path}/${collaborator?.id}`, {
      method: "DELETE",
      headers: { cookie: organizerCookie },
    });
    expect(removed.status).toBe(200);
    await expect(removed.json()).resolves.toMatchObject({
      sessionContentStatus: "approved",
      removal: { name: "Dev Malhotra", remainsEventSpeaker: true, heldSessionAccess: true },
    });
  });

  it("takes no session access from a participant the session never carried", async () => {
    const authorEmail = "rosa.late.named@example.test";
    const created = await createPanel(authorEmail);
    await request(`/api/events/${eventId}/disposition`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({ submissionIds: [created.submission.id], status: "accepted" }),
    });

    // The author names somebody through the public CFP edit. Naming is not admitting, so this
    // person joins the proposal without ever being carried onto its session.
    const proposal = panelProposal(authorEmail, "submit");
    const amended = await request(`${created.accessPath}?key=${encodeURIComponent(created.editKey)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...proposal,
        collaborators: [
          ...proposal.collaborators,
          { name: "Late Named", email: `late.${authorEmail}`, roleLabel: "co-speaker" },
        ],
      }),
    });
    expect(amended.status).toBe(200);

    const path = `/api/events/${eventId}/submissions/${created.submission.id}/participants`;
    const listed = await (await request(path, { headers: { cookie: organizerCookie } }))
      .json<{ sessionId: string | null; participants: Array<Participant & { onSession: boolean }> }>();
    expect(listed.sessionId).not.toBeNull();
    const lateNamed = listed.participants.find((participant) => participant.name === "Late Named");
    expect(lateNamed?.onSession).toBe(false);

    const removed = await request(`${path}/${lateNamed?.id}`, {
      method: "DELETE",
      headers: { cookie: organizerCookie },
    });
    expect(removed.status).toBe(200);
    // The proposal has a session, but this person never reached it, so removal took nothing there.
    await expect(removed.json()).resolves.toMatchObject({
      sessionContentStatus: "draft",
      removal: { name: "Late Named", heldSessionAccess: false },
    });
  });

  it("reports the programme they still speak on when this proposal has no session", async () => {
    // The same person on two proposals: one accepted and scheduled, one still under review.
    const sharedCollaborator = { name: "Two Stage", email: "two.stage@example.test", roleLabel: "co-speaker" };
    const proposal = async (authorEmail: string) => {
      const response = await request("/api/public/cfp/devflow-conf-2027/submissions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...panelProposal(authorEmail, "submit"),
          collaborators: [sharedCollaborator],
        }),
      });
      expect(response.status).toBe(201);
      return response.json<CreatedProposal>();
    };
    const scheduled = await proposal("rosa.two.a@example.test");
    const undecided = await proposal("rosa.two.b@example.test");
    await request(`/api/events/${eventId}/disposition`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({ submissionIds: [scheduled.submission.id], status: "accepted" }),
    });

    const path = `/api/events/${eventId}/submissions/${undecided.submission.id}/participants`;
    const listed = await (await request(path, { headers: { cookie: organizerCookie } }))
      .json<{ sessionId: string | null; sessionContentStatus: string | null; participants: Participant[] }>();
    expect(listed.sessionId).toBeNull();
    expect(listed.sessionContentStatus).toBeNull();
    const collaborator = listed.participants.find((participant) => participant.name === "Two Stage");

    const removed = await request(`${path}/${collaborator?.id}`, {
      method: "DELETE",
      headers: { cookie: organizerCookie },
    });
    expect(removed.status).toBe(200);
    // Removing them here touches nothing on the accepted proposal, and the notice must say so.
    await expect(removed.json()).resolves.toMatchObject({
      removal: {
        name: "Two Stage",
        remainsEventSpeaker: true,
        speaksElsewhereAtEvent: true,
        heldSessionAccess: false,
      },
    });
  });

  it("says nothing is left standing when the removed participant holds no speaker record", async () => {
    const created = await createPanel("rosa.nospeaker@example.test");
    const path = `/api/events/${eventId}/submissions/${created.submission.id}/participants`;
    const listed = await (await request(path, { headers: { cookie: organizerCookie } }))
      .json<{ participants: Participant[] }>();
    const collaborator = listed.participants.find((participant) => participant.name === "Ines Brenner");

    const removed = await request(`${path}/${collaborator?.id}`, {
      method: "DELETE",
      headers: { cookie: organizerCookie },
    });
    expect(removed.status).toBe(200);
    // A collaborator on an undecided proposal was never adopted as an event speaker.
    await expect(removed.json()).resolves.toMatchObject({
      removal: { name: "Ines Brenner", remainsEventSpeaker: false, listedPublicly: false, speakerId: null },
    });
  });
});
