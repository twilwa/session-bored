// ABOUTME: Verifies agenda scheduling through authenticated Worker requests and real D1 state.
// ABOUTME: Covers accepted-session reads, persistent placement, conflicts, TBD, and publishing.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { AgendaState } from "../../shared/api.ts";
import worker from "../../worker/index.ts";

const eventId = "evt_devflow_conf_2027";

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

async function accept(submissionIds: string[], cookie: string): Promise<void> {
  const response = await request(`/api/events/${eventId}/disposition`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ submissionIds, status: "accepted" }),
  });
  expect(response.status).toBe(200);
}

async function readAgenda(cookie: string): Promise<AgendaState> {
  const response = await request(`/api/events/${eventId}/agenda`, { headers: { cookie } });
  expect(response.status).toBe(200);
  return response.json<AgendaState>();
}

async function place(
  sessionId: string,
  cookie: string,
  placement: Record<string, unknown>,
): Promise<AgendaState> {
  const response = await request(`/api/events/${eventId}/agenda/sessions/${sessionId}`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(placement),
  });
  expect(response.status).toBe(200);
  return response.json<AgendaState>();
}

async function publicSessionIds(): Promise<string[]> {
  const response = await request(`/api/public/events/${eventId}/sessions`);
  expect(response.status).toBe(200);
  const payload = await response.json<{ items: Array<{ id: string }> }>();
  return payload.items.map((session) => session.id);
}

describe("agenda builder", () => {
  let organizerCookie: string;

  beforeEach(async () => {
    await request("/api/health");
    organizerCookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");
    const agenda = await readAgenda(organizerCookie);
    for (const session of agenda.sessions) {
      await place(session.id, organizerCookie, { scheduleStatus: "unplaced" });
    }
  });

  it("allows only organizers to read, place, or publish agenda sessions", async () => {
    const operations: Array<{ path: string; init?: RequestInit }> = [
      { path: `/api/events/${eventId}/agenda` },
      {
        path: `/api/events/${eventId}/agenda/sessions/ses_docs_retrieval`,
        init: {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ scheduleStatus: "unplaced" }),
        },
      },
      { path: `/api/events/${eventId}/agenda/publish`, init: { method: "POST" } },
    ];
    for (const operation of operations) {
      expect((await request(operation.path, operation.init)).status).toBe(401);
    }
    for (const [email, password] of [
      ["sbek-reviewer@example.com", "SbekTest!2027-rev"],
      ["sbek-speaker@example.com", "SbekTest!2027-spk"],
    ] as const) {
      const cookie = await signIn(email, password);
      for (const operation of operations) {
        const headers = new Headers(operation.init?.headers);
        headers.set("cookie", cookie);
        expect((await request(operation.path, { ...operation.init, headers })).status).toBe(403);
      }
    }
  });

  it("builds the multi-day agenda from accepted program sessions", async () => {
    await accept(["sub_docs_retrieval"], organizerCookie);

    const response = await request(`/api/events/${eventId}/agenda`, {
      headers: { cookie: organizerCookie },
    });
    expect(response.status).toBe(200);
    const agenda = await response.json<AgendaState>();

    expect(agenda.event).toMatchObject({
      id: eventId,
      name: "DevFlow Conf 2027",
      startDate: "2027-05-12",
      endDate: "2027-05-14",
      timezone: "America/Los_Angeles",
    });
    expect(agenda.days).toEqual(["2027-05-12", "2027-05-13", "2027-05-14"]);
    expect(agenda.rooms.map((room) => room.name)).toEqual([
      "Main Stage",
      "Room 2A",
      "Room 2B",
      "Workshop Lab",
    ]);
    expect(agenda.tracks.map((track) => track.name)).toEqual([
      "AI Engineering",
      "Platform & Infra",
      "Developer Experience",
    ]);
    expect(agenda.sessions).toEqual([
      expect.objectContaining({
        id: "ses_docs_retrieval",
        title: "Docs That Answer Back: Retrieval-Grounded Documentation Sites",
        scheduleStatus: "unplaced",
        scheduledDate: null,
        durationMinutes: 10,
        track: expect.objectContaining({ name: "Developer Experience" }),
        speakers: [expect.objectContaining({ name: "Marcus Okafor" })],
      }),
    ]);
    expect(agenda.metrics).toEqual({ unplaced: 1, conflicts: 0, tbd: 0 });
  });

  it("persists a placed day, time, and room across a fresh read", async () => {
    await accept(["sub_docs_retrieval"], organizerCookie);
    const startsAt = Date.parse("2027-05-12T16:00:00Z");
    const placement = await request(
      `/api/events/${eventId}/agenda/sessions/ses_docs_retrieval`,
      {
        method: "PATCH",
        headers: { cookie: organizerCookie, "content-type": "application/json" },
        body: JSON.stringify({
          scheduleStatus: "placed",
          scheduledDate: "2027-05-12",
          roomId: "rm_main_stage",
          startsAt,
        }),
      },
    );
    expect(placement.status).toBe(200);
    await expect(placement.json<AgendaState>()).resolves.toMatchObject({
      metrics: { unplaced: 0, conflicts: 0, tbd: 0 },
      sessions: [
        expect.objectContaining({
          id: "ses_docs_retrieval",
          scheduleStatus: "placed",
          scheduledDate: "2027-05-12",
          startsAt,
          endsAt: startsAt + 10 * 60_000,
          room: { id: "rm_main_stage", name: "Main Stage" },
        }),
      ],
    });

    const reloaded = await readAgenda(organizerCookie);
    expect(reloaded.sessions.find((session) => session.id === "ses_docs_retrieval")).toMatchObject({
      scheduleStatus: "placed",
      scheduledDate: "2027-05-12",
      startsAt,
      endsAt: startsAt + 10 * 60_000,
      room: { id: "rm_main_stage", name: "Main Stage" },
    });
  });

  it("names room and speaker overlaps and clears them as soon as a session moves", async () => {
    await accept(["sub_ci_monorepo", "sub_ai_verification"], organizerCookie);
    const initialAgenda = await readAgenda(organizerCookie);
    const ciSession = initialAgenda.sessions.find((session) =>
      session.title.startsWith("Taming 40-Minute CI")
    );
    const aiSession = initialAgenda.sessions.find((session) =>
      session.title.startsWith("Your AI Pair Programmer")
    );
    expect(ciSession).toBeDefined();
    expect(aiSession).toBeDefined();
    if (ciSession === undefined || aiSession === undefined) return;

    const sharedPlacement = {
      scheduleStatus: "placed",
      scheduledDate: "2027-05-12",
      roomId: "rm_main_stage",
      startsAt: Date.parse("2027-05-12T16:00:00Z"),
    };
    await place(ciSession.id, organizerCookie, sharedPlacement);
    const conflicted = await place(aiSession.id, organizerCookie, sharedPlacement);

    expect(conflicted.metrics.conflicts).toBe(2);
    expect(conflicted.metrics.conflicts).toBe(conflicted.conflicts.length);
    expect(conflicted.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "room",
        name: "Main Stage",
        label: expect.stringContaining("Main Stage overlaps"),
        fixLabel: expect.stringContaining("Move"),
      }),
      expect.objectContaining({
        kind: "speaker",
        name: "Priya Raman",
        label: expect.stringContaining("Priya Raman overlaps"),
        fixLabel: expect.stringContaining("Move"),
      }),
    ]));

    const moved = await place(aiSession.id, organizerCookie, {
      ...sharedPlacement,
      startsAt: Date.parse("2027-05-12T16:30:00Z"),
    });
    expect(moved.conflicts).toEqual([]);
    expect(moved.metrics.conflicts).toBe(0);
    expect(moved.metrics.conflicts).toBe(moved.conflicts.length);
  });

  it("keeps TBD as a day placement without requiring a time or room", async () => {
    await accept(["sub_ci_monorepo"], organizerCookie);
    const agenda = await readAgenda(organizerCookie);
    const session = agenda.sessions.find((item) => item.title.startsWith("Taming 40-Minute CI"));
    expect(session).toBeDefined();
    if (session === undefined) return;

    const tbd = await place(session.id, organizerCookie, {
      scheduleStatus: "tbd",
      scheduledDate: "2027-05-14",
    });
    expect(tbd.sessions.find((item) => item.id === session.id)).toMatchObject({
      scheduleStatus: "tbd",
      scheduledDate: "2027-05-14",
      room: null,
      startsAt: null,
      endsAt: null,
    });
    expect(tbd.metrics).toMatchObject({ conflicts: 0, tbd: 1 });
  });

  it("keeps an approved placed session private until the organizer publishes", async () => {
    await accept(["sub_docs_retrieval"], organizerCookie);
    await place("ses_docs_retrieval", organizerCookie, {
      scheduleStatus: "placed",
      scheduledDate: "2027-05-13",
      roomId: "rm_room_2a",
      startsAt: Date.parse("2027-05-13T17:00:00Z"),
    });

    expect(await publicSessionIds()).not.toContain("ses_docs_retrieval");
  });

  it("removes a published session from public reads when its placement changes", async () => {
    await accept(["sub_docs_retrieval"], organizerCookie);
    await place("ses_docs_retrieval", organizerCookie, {
      scheduleStatus: "placed",
      scheduledDate: "2027-05-13",
      roomId: "rm_room_2a",
      startsAt: Date.parse("2027-05-13T17:00:00Z"),
    });
    const publishResponse = await request(`/api/events/${eventId}/agenda/publish`, {
      method: "POST",
      headers: { cookie: organizerCookie },
    });
    expect(publishResponse.status).toBe(200);
    expect(await publicSessionIds()).toContain("ses_docs_retrieval");

    await place("ses_docs_retrieval", organizerCookie, {
      scheduleStatus: "placed",
      scheduledDate: "2027-05-14",
      roomId: "rm_room_2b",
      startsAt: Date.parse("2027-05-14T18:00:00Z"),
    });

    expect(await publicSessionIds()).not.toContain("ses_docs_retrieval");
  });

  it("requires a live accepted decision for a published submission session", async () => {
    await accept(["sub_docs_retrieval"], organizerCookie);
    await place("ses_docs_retrieval", organizerCookie, {
      scheduleStatus: "tbd",
      scheduledDate: "2027-05-13",
    });
    const publishResponse = await request(`/api/events/${eventId}/agenda/publish`, {
      method: "POST",
      headers: { cookie: organizerCookie },
    });
    expect(publishResponse.status).toBe(200);
    expect(await publicSessionIds()).toContain("ses_docs_retrieval");

    await env.DB.prepare("UPDATE submission SET status = 'withdrawn' WHERE id = ?")
      .bind("sub_docs_retrieval")
      .run();

    expect(await publicSessionIds()).not.toContain("ses_docs_retrieval");
  });

  it("publishes approved scheduled data from the agenda source of truth", async () => {
    await accept(["sub_docs_retrieval"], organizerCookie);
    const startsAt = Date.parse("2027-05-13T17:00:00Z");
    await place("ses_docs_retrieval", organizerCookie, {
      scheduleStatus: "placed",
      scheduledDate: "2027-05-13",
      roomId: "rm_room_2a",
      startsAt,
    });

    const publishResponse = await request(`/api/events/${eventId}/agenda/publish`, {
      method: "POST",
      headers: { cookie: organizerCookie },
    });
    expect(publishResponse.status).toBe(200);
    await expect(publishResponse.json()).resolves.toMatchObject({
      status: "published",
      publishedCount: 1,
      message: "1 approved agenda session published.",
    });

    const publishedAgenda = await readAgenda(organizerCookie);
    expect(publishedAgenda.sessions.find((session) => session.id === "ses_docs_retrieval"))
      .toMatchObject({
        scheduledDate: "2027-05-13",
        startsAt,
        room: { id: "rm_room_2a", name: "Room 2A" },
        publishedAt: expect.any(Number),
      });
    const publicResponse = await request(`/api/public/events/${eventId}/sessions`);
    expect(publicResponse.status).toBe(200);
    await expect(publicResponse.json()).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          id: "ses_docs_retrieval",
          scheduledDate: "2027-05-13",
          room: "Room 2A",
        }),
      ],
    });
  });
});
