// ABOUTME: Exercises the organizer People surface: evidence, granting, revoking, and invitations.
// ABOUTME: Confirms only an organizer can open the gate and that a grant is always attributed.
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { users } from "../../db/schema.ts";
import type { PersonAccountSummary } from "../../shared/api.ts";
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
});
