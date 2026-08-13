// ABOUTME: Exercises the organizer People surface: evidence, granting, revoking, and invitations.
// ABOUTME: Confirms only an organizer can open the gate and that a grant is always attributed.
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { and, asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { reviewerInvites, reviewRounds, tracks, users } from "../../db/schema.ts";
import type { PersonAccountSummary } from "../../shared/api.ts";
import { redeemReviewerInvites } from "../../worker/reviewer-invites.ts";
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

async function signUp(name: string, email: string): Promise<string> {
  const response = await request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, email, password: "Greenroom!2027" }),
  });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

async function organizerCookie(): Promise<string> {
  return signIn("sbek-organizer@example.com", "SbekTest!2027-org");
}

async function loadPeople(cookie: string): Promise<{ items: PersonAccountSummary[]; invites: Array<{ id: string; email: string }> }> {
  const response = await request("/api/people", { headers: { cookie } });
  expect(response.status).toBe(200);
  return response.json();
}

async function userIdFor(email: string): Promise<string> {
  const [row] = await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.email, email));
  return row!.id;
}

describe("organizer People surface", () => {
  it("is closed to everyone but an organizer", async () => {
    await request("/api/health");
    expect((await request("/api/people")).status).toBe(401);

    const attendee = await signUp("Curious Attendee", "curious@example.com");
    expect((await request("/api/people", { headers: { cookie: attendee } })).status).toBe(403);

    const speaker = await signIn("sbek-speaker@example.com", "SbekTest!2027-spk");
    expect((await request("/api/people", { headers: { cookie: speaker } })).status).toBe(403);

    const reviewer = await signIn("sbek-reviewer@example.com", "SbekTest!2027-rev");
    expect((await request("/api/people", { headers: { cookie: reviewer } })).status).toBe(403);
  });

  it("shows the evidence behind each account, so a grant is never blind", async () => {
    await request("/api/health");
    const cookie = await organizerCookie();
    await signUp("No Records", "no-records@example.com");

    const { items } = await loadPeople(cookie);
    const programmed = items.find((person) => person.email === "sbek-speaker2@example.com");
    const proposalOnly = items.find((person) => person.email === "sbek-speaker@example.com");
    const fresh = items.find((person) => person.email === "no-records@example.com");

    // Marcus is actually on the programme.
    expect(programmed?.evidence.kind).toBe("programmed");
    expect(programmed?.evidence.programmedSessions).toBeGreaterThan(0);
    expect(programmed?.grants.map((grant) => grant.role)).toContain("speaker");

    // Priya holds proposals but nothing accepted. Both hold speaker access, and this column is
    // the only thing that tells an organizer the two are not the same case.
    expect(proposalOnly?.evidence.kind).toBe("proposals");
    expect(proposalOnly?.evidence.proposals).toBeGreaterThan(0);
    expect(proposalOnly?.evidence.programmedSessions).toBe(0);

    expect(fresh?.evidence).toEqual({ kind: "none", programmedSessions: 0, proposals: 0 });
    expect(fresh?.grants).toEqual([]);
    expect(fresh?.signInMethods).toEqual(["password"]);
  });

  it("grants an area, attributes it to the organizer, and reverses it without losing the history", async () => {
    await request("/api/health");
    const cookie = await organizerCookie();
    const attendeeCookie = await signUp("Rising Star", "rising-star@example.com");
    const userId = await userIdFor("rising-star@example.com");

    expect((await request("/api/speaker/content", { headers: { cookie: attendeeCookie } })).status).toBe(403);

    const granted = await request(`/api/people/${userId}/grants`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ role: "speaker", note: "Filling in for a withdrawn talk." }),
    });
    expect(granted.status).toBe(200);
    // Silent by default: nothing is emailed unless the organizer ticks notify.
    expect(await granted.json()).toEqual({ granted: true, role: "speaker", notified: false });
    expect((await request("/api/speaker/content", { headers: { cookie: attendeeCookie } })).status).toBe(200);

    const afterGrant = await loadPeople(cookie);
    const person = afterGrant.items.find((item) => item.id === userId);
    expect(person?.grants[0]).toMatchObject({
      role: "speaker",
      source: "organizer",
      note: "Filling in for a withdrawn talk.",
      grantedByName: "Jordan Alvarez",
    });

    const revoked = await request(`/api/people/${userId}/grants/speaker`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(revoked.status).toBe(200);
    expect((await request("/api/speaker/content", { headers: { cookie: attendeeCookie } })).status).toBe(403);

    const afterRevoke = await loadPeople(cookie);
    expect(afterRevoke.items.find((item) => item.id === userId)?.grants).toEqual([]);
  });

  it("refuses a role that is not grantable, including attendee", async () => {
    await request("/api/health");
    const cookie = await organizerCookie();
    const userId = await userIdFor("sbek-speaker@example.com");

    for (const role of ["attendee", "admin", ""]) {
      const response = await request(`/api/people/${userId}/grants`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ role }),
      });
      expect(response.status).toBe(400);
    }
  });

  it("records a reviewer invitation without granting anything yet", async () => {
    await request("/api/health");
    const cookie = await organizerCookie();

    const created = await request("/api/events/evt_devflow_conf_2027/reviewer-invites", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ email: "Future.Reviewer@Example.com" }),
    });
    expect(created.status).toBe(201);

    const listed = await loadPeople(cookie);
    // Normalized, so a differently-cased sign-up still matches the invitation.
    expect(listed.invites.map((invite) => invite.email)).toContain("future.reviewer@example.com");

    // A second open invitation for the same address and event is refused rather than duplicated.
    const duplicate = await request("/api/events/evt_devflow_conf_2027/reviewer-invites", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ email: "future.reviewer@example.com" }),
    });
    expect(duplicate.status).toBe(409);

    const inviteId = listed.invites.find((invite) => invite.email === "future.reviewer@example.com")!.id;
    expect((await request(`/api/reviewer-invites/${inviteId}`, { method: "DELETE", headers: { cookie } })).status)
      .toBe(200);
    expect((await loadPeople(cookie)).invites.map((invite) => invite.id)).not.toContain(inviteId);
  });

  it("gives an invitation that names no remit the same default a provisioned reviewer gets", async () => {
    await request("/api/health");
    const cookie = await organizerCookie();
    const database = drizzle(env.DB);
    const eventId = "evt_devflow_conf_2027";
    const invited = "default-remit-invite@example.com";

    const created = await request(`/api/events/${eventId}/reviewer-invites`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ email: invited }),
    });
    expect(created.status).toBe(201);

    const eventTrackIds = (
      await database.select({ id: tracks.id }).from(tracks).where(eq(tracks.eventId, eventId))
    ).map((track) => track.id);
    const openRoundIds = (
      await database
        .select({ id: reviewRounds.id })
        .from(reviewRounds)
        .where(and(eq(reviewRounds.eventId, eventId), eq(reviewRounds.status, "open")))
        .orderBy(asc(reviewRounds.sortOrder))
    ).map((round) => round.id);
    expect(eventTrackIds.length).toBeGreaterThan(0);
    expect(openRoundIds.length).toBeGreaterThan(0);

    // The symptom first: redeeming this invitation must open a queue with work in it.
    await signUp("Default Remit", invited);
    const userId = await userIdFor(invited);
    expect(await redeemReviewerInvites(database, { id: userId, email: invited, emailVerified: true }))
      .toHaveLength(1);

    const reviewerCookie = await signIn(invited, "Greenroom!2027");
    const queue = await request("/api/review/queue", { headers: { cookie: reviewerCookie } });
    expect(queue.status).toBe(200);
    expect((await queue.json<{ items: unknown[] }>()).items.length).toBeGreaterThan(0);

    // And the organizer's reviewer configuration lists them, rather than omitting them.
    const config = await request(`/api/review/events/${eventId}/config`, { headers: { cookie } });
    expect(config.status).toBe(200);
    expect(
      (await config.json<{ reviewers: Array<{ id: string }> }>()).reviewers.map((reviewer) => reviewer.id),
    ).toContain(userId);

    // And the cause: the invitation carried the default remit rather than nothing at all.
    const [stored] = await database
      .select({ trackIds: reviewerInvites.trackIds, roundIds: reviewerInvites.roundIds })
      .from(reviewerInvites)
      .where(eq(reviewerInvites.email, invited));
    expect(stored?.trackIds?.slice().sort()).toEqual(eventTrackIds.slice().sort());
    expect(stored?.roundIds).toEqual([openRoundIds[0]]);
  });

  it("takes a reviewer granted from People all the way to having work, without leaving the product", async () => {
    // Granting reviewer here opens the committee area and writes no remit, which is the whole
    // point of keeping the grant platform-wide. What it must never do is strand the account:
    // Committee setup has to list it so the organizer can finish what People started (#147).
    await request("/api/health");
    const cookie = await organizerCookie();
    const eventId = "evt_devflow_conf_2027";
    const email = "granted-from-people@example.com";
    await signUp("Granted From People", email);
    const userId = await userIdFor(email);

    const granted = await request(`/api/people/${userId}/grants`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ role: "reviewer" }),
    });
    expect(granted.status).toBe(200);
    expect(await granted.json()).toMatchObject({ granted: true, role: "reviewer" });

    // The grant on its own is a desk with nothing on it.
    const reviewerCookie = await signIn(email, "Greenroom!2027");
    const emptyQueue = await request("/api/review/queue", { headers: { cookie: reviewerCookie } });
    expect(emptyQueue.status).toBe(200);
    expect((await emptyQueue.json<{ items: unknown[] }>()).items).toHaveLength(0);

    const readConfig = async () => {
      const response = await request(`/api/review/events/${eventId}/config`, { headers: { cookie } });
      expect(response.status).toBe(200);
      return response.json<{
        tracks: Array<{ id: string }>;
        rounds: Array<{ id: string; status: string }>;
        reviewers: Array<{ id: string; trackIds: string[] }>;
      }>();
    };
    const config = await readConfig();
    expect(config.reviewers.find((reviewer) => reviewer.id === userId)).toMatchObject({ trackIds: [] });

    const openRound = config.rounds.find((round) => round.status === "open");
    expect(openRound).toBeDefined();
    const remit = await request(`/api/review/events/${eventId}/reviewers/${userId}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        trackIds: config.tracks.map((track) => track.id),
        roundIds: [openRound?.id],
      }),
    });
    expect(remit.status).toBe(200);

    const queue = await request("/api/review/queue", { headers: { cookie: reviewerCookie } });
    expect(queue.status).toBe(200);
    expect((await queue.json<{ items: unknown[] }>()).items.length).toBeGreaterThan(0);
    expect((await readConfig()).reviewers.find((reviewer) => reviewer.id === userId)?.trackIds)
      .toEqual(config.tracks.map((track) => track.id));
  });

  it("still lets an organizer invite a reviewer to no tracks at all", async () => {
    await request("/api/health");
    const cookie = await organizerCookie();
    const invited = "no-tracks-invite@example.com";

    expect((await request("/api/events/evt_devflow_conf_2027/reviewer-invites", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ email: invited, trackIds: [] }),
    })).status).toBe(201);

    const [stored] = await drizzle(env.DB)
      .select({ trackIds: reviewerInvites.trackIds })
      .from(reviewerInvites)
      .where(eq(reviewerInvites.email, invited));
    expect(stored?.trackIds).toEqual([]);
  });

  it("stops calling an account programmed once its session is no longer accepted", async () => {
    await request("/api/health");
    const cookie = await organizerCookie();
    const author = "unaccepted-evidence@example.com";
    const authorCookie = await signUp("Unaccepted Author", author);

    // Signed in, so the proposal's person carries this account and the People surface can see it.
    const created = await request("/api/public/cfp/devflow-conf-2027/submissions", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: authorCookie },
      body: JSON.stringify({
        intent: "submit",
        speaker: { name: "Unaccepted Author", email: author, jobTitle: "Staff Engineer", organization: "Northwind" },
        collaborators: [],
        proposal: {
          title: "A talk that was accepted and then was not",
          abstract: "What the People surface should say about somebody whose session was withdrawn.",
          track: "Developer Experience",
          format: "Talk (30 min)",
          audienceLevel: "Intermediate",
          answers: { key_takeaway: "Evidence has to track the live decision." },
        },
      }),
    });
    expect(created.status).toBe(201);
    const submissionId = (await created.json<{ submission: { id: string } }>()).submission.id;

    const disposition = async (status: string) => {
      const response = await request(`/api/events/evt_devflow_conf_2027/disposition`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ submissionIds: [submissionId], status }),
      });
      expect(response.status).toBe(200);
    };
    const evidenceOf = async () =>
      (await loadPeople(cookie)).items.find((person) => person.email === author)?.evidence;

    await disposition("accepted");
    expect(await evidenceOf()).toMatchObject({ kind: "programmed", programmedSessions: 1 });

    // Un-accepting keeps the session row on purpose. The evidence an organizer reads before
    // revoking a grant must follow the live decision, not the leftover row.
    await disposition("declined");
    expect(await evidenceOf()).toMatchObject({ kind: "proposals" });
  });
});
