// ABOUTME: Exercises the organizer People surface: evidence, granting, revoking, and invitations.
// ABOUTME: Confirms only an organizer can open the gate and that a grant is always attributed.
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { and, asc, eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  events,
  forms,
  people,
  reviewerInvites,
  reviewerRoundPools,
  reviewerTracks,
  reviewRounds,
  roleGrants,
  sessions,
  sessionSpeakers,
  speakers,
  submissions,
  submissionSpeakers,
  tracks,
  users,
} from "../../db/schema.ts";
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

interface OpenInvite {
  id: string;
  email: string;
  emailDelivery: "sent" | "failed" | "not_attempted";
  canResend: boolean;
  accountStatus?: string;
}

async function loadPeople(cookie: string): Promise<{ items: PersonAccountSummary[]; invites: OpenInvite[] }> {
  const response = await request("/api/people", { headers: { cookie } });
  expect(response.status).toBe(200);
  return response.json();
}

async function userIdFor(email: string): Promise<string> {
  const [row] = await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.email, email));
  return row!.id;
}

/** Confirms an account's address the way the database records it: the flag the invite door reads. */
async function confirmAddress(email: string): Promise<void> {
  await drizzle(env.DB).update(users).set({ emailVerified: true }).where(eq(users.email, email));
}

/**
 * A second event to invite an existing reviewer into: what makes a remit "extended" rather than
 * "granted" is a reviewer who already reads somewhere else.
 */
async function seedSecondEvent(): Promise<{ eventId: string; trackId: string; roundId: string }> {
  const database = drizzle(env.DB);
  const eventId = `evt_second_${crypto.randomUUID().slice(0, 8)}`;
  const trackId = `trk_${crypto.randomUUID().slice(0, 8)}`;
  const roundId = `rnd_${crypto.randomUUID().slice(0, 8)}`;
  await database.insert(events).values({
    id: eventId,
    slug: `second-${crypto.randomUUID().slice(0, 8)}`,
    name: "Second Conf 2028",
    startDate: "2028-05-12",
    endDate: "2028-05-14",
    venue: "SFO",
    timezone: "America/Los_Angeles",
  }).onConflictDoNothing();
  await database.insert(tracks).values({ id: trackId, eventId, name: "Reliability", sortOrder: 0 });
  await database
    .insert(reviewRounds)
    .values({ id: roundId, eventId, name: "Second review", status: "open" });
  return { eventId, trackId, roundId };
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
      body: JSON.stringify({
        role: "speaker",
        speakerEventId: "evt_devflow_conf_2027",
        note: "Filling in for a withdrawn talk.",
      }),
    });
    expect(granted.status).toBe(200);
    // Silent by default: nothing is emailed unless the organizer ticks notify.
    expect(await granted.json()).toEqual({
      granted: true,
      role: "speaker",
      notified: false,
      speakerProfileReady: true,
    });
    const speakerContent = await request("/api/speaker/content?eventId=evt_devflow_conf_2027", {
      headers: { cookie: attendeeCookie },
    });
    expect(speakerContent.status).toBe(200);
    expect((await speakerContent.json<{ profile: { name: string; email: string } | null }>()).profile).toMatchObject({
      name: "Rising Star",
      email: "rising-star@example.com",
    });

    const [speakerProfile] = await drizzle(env.DB)
      .select({ personUserId: people.userId, eventId: speakers.eventId })
      .from(people)
      .innerJoin(speakers, eq(speakers.personId, people.id))
      .where(and(eq(people.userId, userId), eq(speakers.eventId, "evt_devflow_conf_2027")));
    expect(speakerProfile).toEqual({ personUserId: userId, eventId: "evt_devflow_conf_2027" });

    const completedProfile = await request("/api/portal/profile?eventId=evt_devflow_conf_2027", {
      method: "PATCH",
      headers: { cookie: attendeeCookie, "content-type": "application/json" },
      body: JSON.stringify({ bio: "Ready to complete onboarding." }),
    });
    expect(completedProfile.status).toBe(200);

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

  it("repairs the profile chain for an account that already holds speaker access", async () => {
    await request("/api/health");
    const cookie = await organizerCookie();
    const speakerCookie = await signUp("Earlier Promotion", "earlier-promotion@example.com");
    const userId = await userIdFor("earlier-promotion@example.com");
    const organizerId = await userIdFor("sbek-organizer@example.com");
    const database = drizzle(env.DB);
    await database.insert(roleGrants).values({
      userId,
      role: "speaker",
      source: "organizer",
      grantedByUserId: organizerId,
      grantedAt: new Date(),
    });

    const before = await request("/api/speaker/content?eventId=evt_devflow_conf_2027", {
      headers: { cookie: speakerCookie },
    });
    expect((await before.json<{ profile: unknown }>()).profile).toBeNull();

    const repaired = await request(`/api/people/${userId}/grants`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ role: "speaker", speakerEventId: "evt_devflow_conf_2027" }),
    });
    expect(repaired.status).toBe(200);
    expect(await repaired.json()).toMatchObject({ granted: false, role: "speaker" });

    const after = await request("/api/speaker/content?eventId=evt_devflow_conf_2027", {
      headers: { cookie: speakerCookie },
    });
    expect((await after.json<{ profile: { name: string } | null }>()).profile).toMatchObject({
      name: "Earlier Promotion",
    });
  });

  it("binds promoted speakers and their portal actions to the active event", async () => {
    await request("/api/health");
    const organizer = await organizerCookie();
    const speakerCookie = await signUp("Returning Speaker", "returning-promotion@example.com");
    const userId = await userIdFor("returning-promotion@example.com");
    const database = drizzle(env.DB);
    const suffix = crypto.randomUUID().slice(0, 8);
    const otherEventId = `evt_previous_${suffix}`;
    const personId = `psn_previous_${suffix}`;
    const otherSpeakerId = `spk_previous_${suffix}`;
    const otherSessionId = `ses_previous_${suffix}`;
    const otherFormId = `frm_previous_${suffix}`;
    const otherSubmissionId = `sub_previous_${suffix}`;
    await database.insert(events).values({
      id: otherEventId,
      slug: `previous-${suffix}`,
      name: "Previous Conference",
      startDate: "2026-05-12",
      endDate: "2026-05-14",
      venue: "Portland",
      timezone: "America/Los_Angeles",
    });
    await database.insert(people).values({
      id: personId,
      userId,
      name: "Returning Speaker",
      email: "returning-promotion@example.com",
    });
    await database.insert(forms).values({
      id: otherFormId,
      eventId: otherEventId,
      name: "Previous conference CFP",
      publicSlug: `previous-cfp-${suffix}`,
      version: 1,
      status: "closed",
    });
    await database.insert(submissions).values({
      id: otherSubmissionId,
      eventId: otherEventId,
      formId: otherFormId,
      formVersion: 1,
      submitterPersonId: personId,
      status: "accepted",
      isDraft: false,
      title: "Previous conference proposal",
      abstract: "This proposal belongs only to the previous event.",
    });
    await database.insert(submissionSpeakers).values({
      id: `sspk_previous_${suffix}`,
      submissionId: otherSubmissionId,
      personId,
    });
    await database.insert(speakers).values({
      id: otherSpeakerId,
      personId,
      eventId: otherEventId,
      status: "confirmed",
    });
    await database.insert(sessions).values({
      id: otherSessionId,
      eventId: otherEventId,
      title: "Previous conference session",
      abstract: "This belongs only to the previous event.",
      contentStatus: "draft",
      scheduleStatus: "tbd",
      directEntry: true,
      icsUid: `${otherSessionId}@session-bored`,
    });
    await database.insert(sessionSpeakers).values({
      id: `ssnr_previous_${suffix}`,
      sessionId: otherSessionId,
      speakerId: otherSpeakerId,
    });

    const refusedPreviousPromotion = await request(`/api/people/${userId}/grants`, {
      method: "POST",
      headers: { cookie: organizer, "content-type": "application/json" },
      body: JSON.stringify({ role: "speaker", speakerEventId: otherEventId }),
    });
    expect(refusedPreviousPromotion.status).toBe(400);
    await expect(refusedPreviousPromotion.json()).resolves.toEqual({ error: "invalid_speaker_event" });
    expect((await loadPeople(organizer)).items.find((item) => item.id === userId)?.grants).toEqual([]);

    const promoted = await request(`/api/people/${userId}/grants`, {
      method: "POST",
      headers: { cookie: organizer, "content-type": "application/json" },
      body: JSON.stringify({ role: "speaker", speakerEventId: "evt_devflow_conf_2027" }),
    });
    expect(promoted.status).toBe(200);
    const [activeSpeaker] = await database
      .select({ id: speakers.id })
      .from(speakers)
      .where(and(eq(speakers.personId, personId), eq(speakers.eventId, "evt_devflow_conf_2027")));
    expect(activeSpeaker).toBeDefined();

    const content = await request("/api/speaker/content?eventId=evt_devflow_conf_2027", {
      headers: { cookie: speakerCookie },
    });
    expect(content.status).toBe(200);
    expect(await content.json()).toMatchObject({
      profile: { speakerId: activeSpeaker!.id },
      sessions: [],
    });

    const previousContent = await request(`/api/speaker/content?eventId=${otherEventId}`, {
      headers: { cookie: speakerCookie },
    });
    expect(previousContent.status).toBe(400);
    await expect(previousContent.json()).resolves.toEqual({ error: "invalid_speaker_event" });

    const unscopedSubmission = await request(`/api/speaker/submissions/${otherSubmissionId}`, {
      headers: { cookie: speakerCookie },
    });
    expect(unscopedSubmission.status).toBe(400);
    await expect(unscopedSubmission.json()).resolves.toEqual({ error: "speaker_event_required" });

    const previousSubmission = await request(
      `/api/speaker/submissions/${otherSubmissionId}?eventId=${otherEventId}`,
      { headers: { cookie: speakerCookie } },
    );
    expect(previousSubmission.status).toBe(400);
    await expect(previousSubmission.json()).resolves.toEqual({ error: "invalid_speaker_event" });

    const activeEventSubmission = await request(
      `/api/speaker/submissions/${otherSubmissionId}?eventId=evt_devflow_conf_2027`,
      { headers: { cookie: speakerCookie } },
    );
    expect(activeEventSubmission.status).toBe(403);

    const crossEventWrite = await request(
      `/api/portal/sessions/${otherSessionId}?eventId=evt_devflow_conf_2027`,
      {
        method: "PATCH",
        headers: { cookie: speakerCookie, "content-type": "application/json" },
        body: JSON.stringify({ title: "Wrong event write" }),
      },
    );
    expect(crossEventWrite.status).toBe(403);

    const previousEventWrite = await request(`/api/portal/sessions/${otherSessionId}?eventId=${otherEventId}`, {
      method: "PATCH",
      headers: { cookie: speakerCookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "Previous event revision" }),
    });
    expect(previousEventWrite.status).toBe(400);
    await expect(previousEventWrite.json()).resolves.toEqual({ error: "invalid_speaker_event" });
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

    const inviteId = listed.invites.find((invite) => invite.email === "future.reviewer@example.com")!.id;

    // A second open invitation for the same address and event is refused rather than duplicated,
    // and the refusal names the action that does help somebody whose mail never arrived.
    const duplicate = await request("/api/events/evt_devflow_conf_2027/reviewer-invites", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ email: "future.reviewer@example.com" }),
    });
    expect(duplicate.status).toBe(409);
    const refusal = await duplicate.json<{ error: string; inviteId: string; note: string }>();
    expect(refusal).toMatchObject({ error: "invite_already_open", inviteId });
    expect(refusal.note).toContain("Resend invitation");

    // The action it names is really open on that invitation, so the organizer is not sent nowhere.
    expect((await request(
      `/api/events/evt_devflow_conf_2027/reviewer-invites/${refusal.inviteId}/resend`,
      { method: "POST", headers: { cookie } },
    )).status).toBe(200);

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

  it("names the fix when an invitation cannot be recorded", async () => {
    await request("/api/health");
    const cookie = await organizerCookie();
    const database = drizzle(env.DB);
    const eventId = "evt_devflow_conf_2027";
    const invited = "no-open-round-invite@example.com";

    const inviteReviewer = async (email: string) =>
      request(`/api/events/${eventId}/reviewer-invites`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });

    const malformed = await inviteReviewer("not-an-address");
    expect(malformed.status).toBe(400);
    const malformedRefusal = await malformed.json<{ error: string; note: string }>();
    expect(malformedRefusal.error).toBe("invalid_email");
    expect(malformedRefusal.note).toContain("valid email address");

    const openRoundIds = (
      await database
        .select({ id: reviewRounds.id })
        .from(reviewRounds)
        .where(and(eq(reviewRounds.eventId, eventId), eq(reviewRounds.status, "open")))
    ).map((round) => round.id);
    expect(openRoundIds.length).toBeGreaterThan(0);
    await database.update(reviewRounds).set({ status: "closed" }).where(inArray(reviewRounds.id, openRoundIds));

    const refused = await inviteReviewer(invited);
    expect(refused.status).toBe(409);
    const refusal = await refused.json<{ error: string; note: string }>();
    expect(refusal.error).toBe("open_round_required");
    expect(refusal.note).toContain("review round");
    expect(refusal.note).toContain("Committee setup");
    // Nothing was recorded, so nobody waits on an invitation that would redeem into an empty queue.
    expect((await loadPeople(cookie)).invites.map((invite) => invite.email)).not.toContain(invited);

    // And the recourse the note names is the fix: with a round open again the invitation records.
    await database.update(reviewRounds).set({ status: "open" }).where(inArray(reviewRounds.id, openRoundIds));
    expect((await inviteReviewer(invited)).status).toBe(201);
    expect((await loadPeople(cookie)).invites.map((invite) => invite.email)).toContain(invited);
  });

  it("requires a remit when People grants reviewer and opens that reviewer's queue", async () => {
    await request("/api/health");
    const cookie = await organizerCookie();
    const eventId = "evt_devflow_conf_2027";
    const email = "granted-from-people@example.com";
    const attendeeCookie = await signUp("Granted From People", email);
    const userId = await userIdFor(email);

    const missingRemit = await request(`/api/people/${userId}/grants`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ role: "reviewer" }),
    });
    expect(missingRemit.status).toBe(400);
    expect(await missingRemit.json()).toEqual({ error: "reviewer_remit_required" });
    expect((await request("/api/review/queue", { headers: { cookie: attendeeCookie } })).status).toBe(403);

    const configResponse = await request(`/api/review/events/${eventId}/config`, { headers: { cookie } });
    expect(configResponse.status).toBe(200);
    const config = await configResponse.json<{
      tracks: Array<{ id: string }>;
      rounds: Array<{ id: string; status: string }>;
    }>();

    const openRound = config.rounds.find((round) => round.status === "open");
    expect(openRound).toBeDefined();
    const granted = await request(`/api/people/${userId}/grants`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        role: "reviewer",
        reviewerRemit: {
          eventId,
          trackIds: config.tracks.map((track) => track.id),
          roundIds: [openRound?.id],
        },
      }),
    });
    expect(granted.status).toBe(200);
    expect(await granted.json()).toMatchObject({ granted: true, role: "reviewer" });

    const reviewerCookie = await signIn(email, "Greenroom!2027");
    const queue = await request("/api/review/queue", { headers: { cookie: reviewerCookie } });
    expect(queue.status).toBe(200);
    expect((await queue.json<{ items: unknown[] }>()).items.length).toBeGreaterThan(0);
  });

  it("replaces a revoked reviewer's previous remit when granting a narrower one", async () => {
    await request("/api/health");
    const cookie = await organizerCookie();
    const eventId = "evt_devflow_conf_2027";
    const email = "narrowed-regrant@example.com";
    await signUp("Narrowed Regrant", email);
    const userId = await userIdFor(email);
    const headers = { cookie, "content-type": "application/json" };

    const createdRound = await request(`/api/review/events/${eventId}/rounds`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: `Regrant ${crypto.randomUUID()}`, status: "open" }),
    });
    expect(createdRound.status).toBe(201);

    const config = await (await request(`/api/review/events/${eventId}/config`, { headers: { cookie } })).json<{
      tracks: Array<{ id: string }>;
      rounds: Array<{ id: string; status: string; reviewerPool: Array<{ id: string }> }>;
      reviewers: Array<{ id: string; trackIds: string[] }>;
    }>();
    const wideTrackIds = config.tracks.map((track) => track.id);
    const wideRoundIds = config.rounds.filter((round) => round.status === "open").map((round) => round.id);
    expect(wideTrackIds.length).toBeGreaterThan(1);
    expect(wideRoundIds.length).toBeGreaterThan(1);

    const grantReviewer = async (reviewerUserId: string, trackIds: string[], roundIds: string[]) => {
      const response = await request(`/api/people/${reviewerUserId}/grants`, {
        method: "POST",
        headers,
        body: JSON.stringify({ role: "reviewer", reviewerRemit: { eventId, trackIds, roundIds } }),
      });
      expect(response.status).toBe(200);
    };
    const readRemit = async (reviewerUserId: string) => {
      const effective = await (await request(`/api/review/events/${eventId}/config`, { headers: { cookie } })).json<{
        rounds: Array<{ id: string; reviewerPool: Array<{ id: string }> }>;
        reviewers: Array<{ id: string; trackIds: string[] }>;
      }>();
      return {
        trackIds: effective.reviewers.find((reviewer) => reviewer.id === reviewerUserId)?.trackIds.toSorted(),
        roundIds: effective.rounds
          .filter((round) => round.reviewerPool.some((reviewer) => reviewer.id === reviewerUserId))
          .map((round) => round.id)
          .toSorted(),
      };
    };
    await grantReviewer(userId, wideTrackIds, wideRoundIds);
    expect((await request(`/api/people/${userId}/grants/reviewer`, { method: "DELETE", headers: { cookie } })).status)
      .toBe(200);

    const narrowTrackIds = [wideTrackIds[0]!];
    const narrowRoundIds = [wideRoundIds[0]!];
    await grantReviewer(userId, narrowTrackIds, narrowRoundIds);
    expect(await readRemit(userId)).toEqual({
      trackIds: narrowTrackIds.toSorted(),
      roundIds: narrowRoundIds.toSorted(),
    });

    const otherEmail = "isolated-regrant@example.com";
    await signUp("Isolated Regrant", otherEmail);
    const otherUserId = await userIdFor(otherEmail);
    const otherTrackIds = [wideTrackIds.at(-1)!];
    const otherRoundIds = [wideRoundIds.at(-1)!];
    await grantReviewer(otherUserId, otherTrackIds, otherRoundIds);

    await grantReviewer(userId, narrowTrackIds, narrowRoundIds);
    expect(await readRemit(userId)).toEqual({
      trackIds: narrowTrackIds.toSorted(),
      roundIds: narrowRoundIds.toSorted(),
    });
    expect(await readRemit(otherUserId)).toEqual({
      trackIds: otherTrackIds.toSorted(),
      roundIds: otherRoundIds.toSorted(),
    });

    await grantReviewer(userId, wideTrackIds, wideRoundIds);
    expect(await readRemit(userId)).toEqual({
      trackIds: wideTrackIds.toSorted(),
      roundIds: wideRoundIds.toSorted(),
    });
    expect(await readRemit(otherUserId)).toEqual({
      trackIds: otherTrackIds.toSorted(),
      roundIds: otherRoundIds.toSorted(),
    });
  });

  it("keeps an invitation resendable while no email sender is connected", async () => {
    await request("/api/health");
    const cookie = await organizerCookie();
    const eventId = "evt_devflow_conf_2027";
    const invited = "unconnected-sender-invite@example.com";

    const created = await request(`/api/events/${eventId}/reviewer-invites`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ email: invited }),
    });
    expect(created.status).toBe(201);
    const createdPayload = await created.json<{ invite: { id: string }; emailDelivery: string }>();
    expect(createdPayload.emailDelivery).toBe("not_configured");
    const inviteId = createdPayload.invite.id;

    // Nothing was attempted, so the invitation is not stranded behind a send that never happened.
    const openInvite = (await loadPeople(cookie)).invites.find((invite) => invite.id === inviteId);
    expect(openInvite).toMatchObject({ email: invited, emailDelivery: "not_attempted", canResend: true });

    const resent = await request(`/api/events/${eventId}/reviewer-invites/${inviteId}/resend`, {
      method: "POST",
      headers: { cookie },
    });
    expect(resent.status).toBe(200);
    await expect(resent.json()).resolves.toMatchObject({
      invite: { id: inviteId, email: invited, eventId },
      emailDelivery: "not_configured",
    });

    // Still nobody has been reached, so it stays resendable rather than reading as sent.
    expect((await loadPeople(cookie)).invites.find((invite) => invite.id === inviteId))
      .toMatchObject({ emailDelivery: "not_attempted", canResend: true });
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

  it("refuses an invitation whose named remit names ids this event does not have", async () => {
    await request("/api/health");
    const cookie = await organizerCookie();

    const badTrack = await request("/api/events/evt_devflow_conf_2027/reviewer-invites", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ email: "bogus-track-invite@example.com", trackIds: ["trk_nowhere"] }),
    });
    expect(badTrack.status).toBe(400);
    expect(await badTrack.json()).toEqual({ error: "invalid_reviewer_tracks" });

    const badRound = await request("/api/events/evt_devflow_conf_2027/reviewer-invites", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ email: "bogus-round-invite@example.com", roundIds: ["rnd_never_opened"] }),
    });
    expect(badRound.status).toBe(400);
    expect(await badRound.json()).toEqual({ error: "invalid_reviewer_rounds" });
  });
});

describe("reviewer invitations for an address that already has an account", () => {
  const eventId = "evt_devflow_conf_2027";

  async function invite(
    cookie: string,
    email: string,
    body: Record<string, unknown> = {},
    targetEventId = eventId,
  ): Promise<Response> {
    return request(`/api/events/${targetEventId}/reviewer-invites`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ email, ...body }),
    });
  }

  async function remitOf(email: string): Promise<{ trackIds: string[]; roundIds: string[] } | undefined> {
    const [stored] = await drizzle(env.DB)
      .select({ trackIds: reviewerInvites.trackIds, roundIds: reviewerInvites.roundIds })
      .from(reviewerInvites)
      .where(eq(reviewerInvites.email, email));
    return stored;
  }

  async function tracksForReviewer(userId: string, scopedEventId: string): Promise<string[]> {
    const rows = await drizzle(env.DB)
      .select({ trackId: reviewerTracks.trackId })
      .from(reviewerTracks)
      .where(and(eq(reviewerTracks.reviewerUserId, userId), eq(reviewerTracks.eventId, scopedEventId)));
    return rows.map((row) => row.trackId);
  }

  it("upgrades a confirmed account the moment the invitation names its remit", async () => {
    await request("/api/health");
    const cookie = await organizerCookie();
    const database = drizzle(env.DB);
    const email = "already-confirmed-invite@example.com";
    await signUp("Already Confirmed", email);
    await confirmAddress(email);
    const userId = await userIdFor(email);

    const trackIds = (await database.select({ id: tracks.id }).from(tracks).where(eq(tracks.eventId, eventId)))
      .map((track) => track.id).slice(0, 1);
    const [openRound] = await database
      .select({ id: reviewRounds.id })
      .from(reviewRounds)
      .where(and(eq(reviewRounds.eventId, eventId), eq(reviewRounds.status, "open")));

    const created = await invite(cookie, email, { trackIds, roundIds: [openRound!.id] });
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({
      accountStatus: "confirmed",
      upgraded: true,
      grantedReviewerRole: true,
      account: { userId, name: "Already Confirmed" },
      appliedRemit: { trackIds, roundIds: [openRound!.id] },
    });

    // The remit the organizer chose is the remit that landed.
    expect(await tracksForReviewer(userId, eventId)).toEqual(trackIds);
    const pool = await database
      .select({ roundId: reviewerRoundPools.roundId })
      .from(reviewerRoundPools)
      .where(eq(reviewerRoundPools.reviewerUserId, userId));
    expect(pool.map((row) => row.roundId)).toContain(openRound!.id);
    const [grant] = await database
      .select({ role: roleGrants.role, source: roleGrants.source })
      .from(roleGrants)
      .where(eq(roleGrants.userId, userId));
    expect(grant).toMatchObject({ role: "reviewer", source: "reviewer_invite" });
    const [stored] = await database
      .select({ redeemedAt: reviewerInvites.redeemedAt, redeemedByUserId: reviewerInvites.redeemedByUserId })
      .from(reviewerInvites)
      .where(eq(reviewerInvites.email, email));
    expect(stored?.redeemedAt).not.toBeNull();
    expect(stored?.redeemedByUserId).toBe(userId);

    // The upgraded reviewer's queue opens with work in it.
    const reviewerCookie = await signIn(email, "Greenroom!2027");
    const queue = await request("/api/review/queue", { headers: { cookie: reviewerCookie } });
    expect(queue.status).toBe(200);
    expect((await queue.json<{ items: unknown[] }>()).items.length).toBeGreaterThan(0);
  });

  it("keeps a confirmed account pending when an invitation names no tracks", async () => {
    await request("/api/health");
    const cookie = await organizerCookie();
    const database = drizzle(env.DB);
    const email = "confirmed-no-tracks@example.com";
    await signUp("Confirmed No Tracks", email);
    await confirmAddress(email);
    const userId = await userIdFor(email);
    const [openRound] = await database
      .select({ id: reviewRounds.id })
      .from(reviewRounds)
      .where(and(eq(reviewRounds.eventId, eventId), eq(reviewRounds.status, "open")));

    const created = await invite(cookie, email, { trackIds: [], roundIds: [openRound!.id] });
    expect(created.status).toBe(201);
    const payload = await created.json<{ invite: { id: string }; accountStatus: string; upgraded: boolean }>();
    expect(payload).toMatchObject({ accountStatus: "confirmed", upgraded: false });
    expect(await tracksForReviewer(userId, eventId)).toEqual([]);
    expect(await database.select().from(roleGrants).where(eq(roleGrants.userId, userId))).toEqual([]);

    const upgrade = await request(`/api/events/${eventId}/reviewer-invites/${payload.invite.id}/upgrade`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ trackIds: [], roundIds: [openRound!.id] }),
    });
    expect(upgrade.status).toBe(400);
    await expect(upgrade.json()).resolves.toEqual({ error: "reviewer_remit_required" });
  });

  it("extends an existing reviewer's remit rather than granting them reviewer access again", async () => {
    await request("/api/health");
    const cookie = await organizerCookie();
    const second = await seedSecondEvent();
    const database = drizzle(env.DB);
    // The seeded reviewer already reviews the fixture event; the second event is the new one.
    // A reviewer onboarded through an invitation is confirmed by construction - redemption only
    // runs after the address is proved - so confirm the fixture identity the same way.
    await confirmAddress("sbek-reviewer@example.com");
    const reviewerId = await userIdFor("sbek-reviewer@example.com");
    const grantsBefore = await database
      .select({ id: roleGrants.id })
      .from(roleGrants)
      .where(and(eq(roleGrants.userId, reviewerId), eq(roleGrants.role, "reviewer")));

    const created = await invite(
      cookie,
      "sbek-reviewer@example.com",
      { trackIds: [second.trackId], roundIds: [second.roundId] },
      second.eventId,
    );
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({
      accountStatus: "confirmed",
      upgraded: true,
      // The copy distinction the organizer reads: not a fresh grant, a wider remit.
      grantedReviewerRole: false,
    });

    expect(await tracksForReviewer(reviewerId, second.eventId)).toEqual([second.trackId]);
    const grantsAfter = await database
      .select({ id: roleGrants.id })
      .from(roleGrants)
      .where(and(eq(roleGrants.userId, reviewerId), eq(roleGrants.role, "reviewer")));
    expect(grantsAfter).toHaveLength(grantsBefore.length);
  });

  it("keeps a confirmed account's invitation open when no remit was named, then upgrades it on request", async () => {
    await request("/api/health");
    const cookie = await organizerCookie();
    const email = "confirmed-no-remit@example.com";
    await signUp("Confirmed No Remit", email);
    await confirmAddress(email);
    const userId = await userIdFor(email);

    const created = await invite(cookie, email);
    expect(created.status).toBe(201);
    const payload = await created.json<{ invite: { id: string }; accountStatus: string; upgraded: boolean }>();
    expect(payload).toMatchObject({ accountStatus: "confirmed", upgraded: false });

    // No silent default upgrade: nothing was granted and the invitation still stands.
    expect(
      await drizzle(env.DB).select().from(roleGrants).where(eq(roleGrants.userId, userId)),
    ).toEqual([]);
    const [stored] = await drizzle(env.DB)
      .select({ redeemedAt: reviewerInvites.redeemedAt })
      .from(reviewerInvites)
      .where(eq(reviewerInvites.email, email));
    expect(stored?.redeemedAt).toBeNull();

    // The open-invite list says what state this is in, so the organizer is never stuck.
    const listed = await loadPeople(cookie);
    expect(listed.invites.find((row) => row.email === email)).toMatchObject({ accountStatus: "confirmed" });

    const trackIds = (await drizzle(env.DB)
      .select({ id: tracks.id })
      .from(tracks)
      .where(eq(tracks.eventId, eventId)))
      .map((track) => track.id).slice(0, 2);
    const [openRound] = await drizzle(env.DB)
      .select({ id: reviewRounds.id })
      .from(reviewRounds)
      .where(and(eq(reviewRounds.eventId, eventId), eq(reviewRounds.status, "open")));
    const upgraded = await request(`/api/events/${eventId}/reviewer-invites/${payload.invite.id}/upgrade`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ trackIds, roundIds: [openRound!.id] }),
    });
    expect(upgraded.status).toBe(200);
    await expect(upgraded.json()).resolves.toMatchObject({
      grantedReviewerRole: true,
      appliedRemit: { trackIds, roundIds: [openRound!.id] },
    });
    expect(await tracksForReviewer(userId, eventId)).toEqual(trackIds);

    // The stored remit is the chosen one, and the invitation is spent.
    expect(await remitOf(email)).toMatchObject({ trackIds, roundIds: [openRound!.id] });
    const [after] = await drizzle(env.DB)
      .select({ redeemedAt: reviewerInvites.redeemedAt })
      .from(reviewerInvites)
      .where(eq(reviewerInvites.email, email));
    expect(after?.redeemedAt).not.toBeNull();
  });

  it("leaves an unconfirmed account's invitation to the confirmation path", async () => {
    await request("/api/health");
    const cookie = await organizerCookie();
    const email = "unconfirmed-invite-door@example.com";
    await signUp("Unconfirmed Invite", email);
    const userId = await userIdFor(email);

    const created = await invite(cookie, email, { trackIds: [], roundIds: ["rnd_initial_review"] });
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({ accountStatus: "unconfirmed", upgraded: false });
    expect(
      await drizzle(env.DB).select().from(roleGrants).where(eq(roleGrants.userId, userId)),
    ).toEqual([]);

    const listed = await loadPeople(cookie);
    expect(listed.invites.find((row) => row.email === email)).toMatchObject({ accountStatus: "unconfirmed" });

    // And confirmation still redeems it, through the same hook as a brand-new sign-up.
    await confirmAddress(email);
    expect(
      await redeemReviewerInvites(drizzle(env.DB), { id: userId, email, emailVerified: true }),
    ).toHaveLength(1);
  });
});
