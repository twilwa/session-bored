// ABOUTME: Verifies agenda scheduling through authenticated Worker requests and real D1 state.
// ABOUTME: Covers accepted-session reads, persistent placement, conflicts, TBD, and publishing.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { AgendaPublishResult, AgendaState } from "../../shared/api.ts";
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
        path: `/api/events/${eventId}/agenda/sessions`,
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Unauthorized direct session" }),
        },
      },
      {
        path: `/api/events/${eventId}/agenda/sessions/ses_docs_retrieval`,
        init: {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ scheduleStatus: "unplaced" }),
        },
      },
      {
        path: `/api/events/${eventId}/agenda/sessions/ses_docs_retrieval/content`,
        init: {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ contentStatus: "approved" }),
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

  it("creates, renames, and removes an unused room from the agenda", async () => {
    const createdResponse = await request(`/api/events/${eventId}/rooms`, {
      method: "POST",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Studio C" }),
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json<{ id: string; name: string }>();
    expect(created.name).toBe("Studio C");
    await expect(readAgenda(organizerCookie)).resolves.toMatchObject({
      rooms: expect.arrayContaining([{ id: created.id, name: "Studio C" }]),
    });

    const renamedResponse = await request(`/api/events/${eventId}/rooms/${created.id}`, {
      method: "PATCH",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Studio Three" }),
    });
    expect(renamedResponse.status).toBe(200);
    await expect(renamedResponse.json()).resolves.toMatchObject({ id: created.id, name: "Studio Three" });
    await expect(readAgenda(organizerCookie)).resolves.toMatchObject({
      rooms: expect.arrayContaining([{ id: created.id, name: "Studio Three" }]),
    });

    const removedResponse = await request(`/api/events/${eventId}/rooms/${created.id}`, {
      method: "DELETE",
      headers: { cookie: organizerCookie },
    });
    expect(removedResponse.status).toBe(204);
    expect((await readAgenda(organizerCookie)).rooms).not.toContainEqual(
      expect.objectContaining({ id: created.id }),
    );
  });

  it("keeps a room and its schedule intact when a session is assigned to it", async () => {
    await accept(["sub_docs_retrieval"], organizerCookie);
    await place("ses_docs_retrieval", organizerCookie, {
      scheduleStatus: "placed",
      scheduledDate: "2027-05-12",
      roomId: "rm_main_stage",
      startsAt: Date.parse("2027-05-12T16:00:00Z"),
    });
    const approval = await request(
      `/api/events/${eventId}/agenda/sessions/ses_docs_retrieval/content`,
      {
        method: "PATCH",
        headers: { cookie: organizerCookie, "content-type": "application/json" },
        body: JSON.stringify({ contentStatus: "approved" }),
      },
    );
    expect(approval.status).toBe(200);
    const publish = await request(`/api/events/${eventId}/agenda/publish`, {
      method: "POST",
      headers: { cookie: organizerCookie },
    });
    expect(publish.status).toBe(200);
    const publicBefore = await publicSessionIds();

    const removal = await request(`/api/events/${eventId}/rooms/rm_main_stage`, {
      method: "DELETE",
      headers: { cookie: organizerCookie },
    });
    expect(removal.status).toBe(409);
    await expect(removal.json()).resolves.toEqual({
      error: "room_in_use",
      message: "Main Stage still has 1 session assigned. Move it to another room or TBD before removing this room.",
    });
    const agenda = await readAgenda(organizerCookie);
    expect(agenda.rooms).toContainEqual({ id: "rm_main_stage", name: "Main Stage" });
    expect(agenda.sessions.find((session) => session.id === "ses_docs_retrieval")).toMatchObject({
      scheduleStatus: "placed",
      room: { id: "rm_main_stage", name: "Main Stage" },
    });
    expect(await publicSessionIds()).toEqual(publicBefore);
  });

  it("creates, renames, and removes an unused track from the agenda and CFP", async () => {
    const createdResponse = await request(`/api/events/${eventId}/tracks`, {
      method: "POST",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Web Performance" }),
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json<{ id: string; name: string }>();
    expect(created.name).toBe("Web Performance");
    expect((await readAgenda(organizerCookie)).tracks).toContainEqual(
      expect.objectContaining({ id: created.id, name: "Web Performance" }),
    );
    const cfpAfterCreate = await request("/api/public/cfp/devflow-conf-2027");
    expect(cfpAfterCreate.status).toBe(200);
    expect((await cfpAfterCreate.json<{ tracks: string[] }>()).tracks).toContain("Web Performance");

    const renamedResponse = await request(`/api/events/${eventId}/tracks/${created.id}`, {
      method: "PATCH",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Fast Web" }),
    });
    expect(renamedResponse.status).toBe(200);
    expect((await readAgenda(organizerCookie)).tracks).toContainEqual(
      expect.objectContaining({ id: created.id, name: "Fast Web" }),
    );
    const cfpAfterRename = await request("/api/public/cfp/devflow-conf-2027");
    expect((await cfpAfterRename.json<{ tracks: string[] }>()).tracks).toContain("Fast Web");

    const removedResponse = await request(`/api/events/${eventId}/tracks/${created.id}`, {
      method: "DELETE",
      headers: { cookie: organizerCookie },
    });
    expect(removedResponse.status).toBe(204);
    expect((await readAgenda(organizerCookie)).tracks).not.toContainEqual(
      expect.objectContaining({ id: created.id }),
    );
    const cfpAfterRemove = await request("/api/public/cfp/devflow-conf-2027");
    expect((await cfpAfterRemove.json<{ tracks: string[] }>()).tracks).not.toContain("Fast Web");
  });

  it("keeps a track and its routing intact while proposals or reviewer remits use it", async () => {
    const cfpBeforeResponse = await request("/api/public/cfp/devflow-conf-2027");
    const cfpBefore = await cfpBeforeResponse.json<{ tracks: string[] }>();
    const publicBefore = await publicSessionIds();

    const removal = await request(`/api/events/${eventId}/tracks/trk_platform_infra`, {
      method: "DELETE",
      headers: { cookie: organizerCookie },
    });
    expect(removal.status).toBe(409);
    await expect(removal.json()).resolves.toEqual({
      error: "track_in_use",
      message: "Platform & Infra is used by 1 proposal and 1 reviewer remit. Reassign them before removing this track.",
    });
    expect((await readAgenda(organizerCookie)).tracks).toContainEqual(
      expect.objectContaining({ id: "trk_platform_infra", name: "Platform & Infra" }),
    );
    const cfpAfterResponse = await request("/api/public/cfp/devflow-conf-2027");
    expect((await cfpAfterResponse.json<{ tracks: string[] }>()).tracks).toEqual(cfpBefore.tracks);
    expect(await publicSessionIds()).toEqual(publicBefore);
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
      newlyPublishedCount: 1,
      published: [{ id: "ses_docs_retrieval" }],
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

  it("names every session publishing skipped and why", async () => {
    await accept(["sub_docs_retrieval", "sub_ci_monorepo", "sub_ai_verification"], organizerCookie);
    const agenda = await readAgenda(organizerCookie);
    const placedDraft = agenda.sessions.find((item) => item.title.startsWith("Taming 40-Minute CI"));
    const unplacedDraft = agenda.sessions.find((item) => item.title.startsWith("Your AI Pair Programmer"));
    expect(placedDraft).toMatchObject({ contentStatus: "draft" });
    expect(unplacedDraft).toMatchObject({ contentStatus: "draft" });
    if (placedDraft === undefined || unplacedDraft === undefined) return;

    await place("ses_docs_retrieval", organizerCookie, {
      scheduleStatus: "placed",
      scheduledDate: "2027-05-13",
      roomId: "rm_room_2a",
      startsAt: Date.parse("2027-05-13T17:00:00Z"),
    });
    await place(placedDraft.id, organizerCookie, {
      scheduleStatus: "placed",
      scheduledDate: "2027-05-13",
      roomId: "rm_room_2b",
      startsAt: Date.parse("2027-05-13T18:00:00Z"),
    });

    const publishResponse = await request(`/api/events/${eventId}/agenda/publish`, {
      method: "POST",
      headers: { cookie: organizerCookie },
    });
    expect(publishResponse.status).toBe(200);
    const result = await publishResponse.json<AgendaPublishResult>();
    expect(result).toMatchObject({
      publishedCount: 1,
      newlyPublishedCount: 1,
      alreadyPublicCount: 0,
      published: [{ id: "ses_docs_retrieval" }],
      message: "1 session published · 2 sessions skipped.",
    });
    expect(result.skipped).toEqual([
      { id: unplacedDraft.id, title: unplacedDraft.title, reasons: ["content_not_approved", "not_placed"] },
      { id: placedDraft.id, title: placedDraft.title, reasons: ["content_not_approved"] },
    ]);
    expect(result.notes).toEqual([
      `Skipped “${unplacedDraft.title}” — its content is not approved yet and it is not on the schedule yet.`,
      `Skipped “${placedDraft.title}” — its content is not approved yet.`,
    ]);

    // The report is honest about the gate because the gate still holds.
    expect(await publicSessionIds()).toEqual(["ses_docs_retrieval"]);

    const republish = await request(`/api/events/${eventId}/agenda/publish`, {
      method: "POST",
      headers: { cookie: organizerCookie },
    });
    await expect(republish.json()).resolves.toMatchObject({
      newlyPublishedCount: 0,
      alreadyPublicCount: 1,
      message: "1 session already public · 2 sessions skipped.",
    });
  });

  it("completes accept, approve, place, publish, edit, and republish through organizer APIs", async () => {
    await accept(["sub_ci_monorepo"], organizerCookie);
    const acceptedAgenda = await readAgenda(organizerCookie);
    const session = acceptedAgenda.sessions.find((item) =>
      item.title.startsWith("Taming 40-Minute CI")
    );
    expect(session).toMatchObject({ contentStatus: "draft", publishedAt: null });
    if (session === undefined) return;

    const approvalResponse = await request(
      `/api/events/${eventId}/agenda/sessions/${session.id}/content`,
      {
        method: "PATCH",
        headers: { cookie: organizerCookie, "content-type": "application/json" },
        body: JSON.stringify({ contentStatus: "approved" }),
      },
    );
    expect(approvalResponse.status).toBe(200);
    await expect(approvalResponse.json<AgendaState>()).resolves.toMatchObject({
      sessions: expect.arrayContaining([
        expect.objectContaining({ id: session.id, contentStatus: "approved", publishedAt: null }),
      ]),
    });

    const firstPlacement = {
      scheduleStatus: "placed",
      scheduledDate: "2027-05-12",
      roomId: "rm_room_2a",
      startsAt: Date.parse("2027-05-12T17:00:00Z"),
    };
    await place(session.id, organizerCookie, firstPlacement);
    const firstPublish = await request(`/api/events/${eventId}/agenda/publish`, {
      method: "POST",
      headers: { cookie: organizerCookie },
    });
    expect(firstPublish.status).toBe(200);
    expect(await publicSessionIds()).toContain(session.id);

    const editedAgenda = await place(session.id, organizerCookie, {
      ...firstPlacement,
      roomId: "rm_room_2b",
      startsAt: Date.parse("2027-05-12T18:00:00Z"),
    });
    expect(editedAgenda.sessions.find((item) => item.id === session.id)?.publishedAt).toBeNull();
    expect(await publicSessionIds()).not.toContain(session.id);

    const republish = await request(`/api/events/${eventId}/agenda/publish`, {
      method: "POST",
      headers: { cookie: organizerCookie },
    });
    expect(republish.status).toBe(200);
    expect(await publicSessionIds()).toContain(session.id);
  });

  it("keeps approved published content live while showing its net changes from approval", async () => {
    await accept(["sub_ci_monorepo"], organizerCookie);
    const acceptedAgenda = await readAgenda(organizerCookie);
    const session = acceptedAgenda.sessions.find((item) => item.title.startsWith("Taming 40-Minute CI"));
    expect(session).toBeDefined();
    if (session === undefined) return;

    await place(session.id, organizerCookie, {
      scheduleStatus: "placed",
      scheduledDate: "2027-05-12",
      roomId: "rm_room_2a",
      startsAt: Date.parse("2027-05-12T17:00:00Z"),
    });
    const approval = await request(`/api/events/${eventId}/agenda/sessions/${session.id}/content`, {
      method: "PATCH",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({ contentStatus: "approved" }),
    });
    expect(approval.status).toBe(200);
    const approvedAgenda = await approval.json<AgendaState>();
    expect(approvedAgenda.sessions.find((item) => item.id === session.id)).toMatchObject({
      approvedContent: { title: session.title, abstract: session.abstract },
      contentStatus: "approved",
      editedSinceApproval: false,
    });

    const publish = await request(`/api/events/${eventId}/agenda/publish`, {
      method: "POST",
      headers: { cookie: organizerCookie },
    });
    expect(publish.status).toBe(200);
    const publishedAgenda = await readAgenda(organizerCookie);
    const publishedAt = publishedAgenda.sessions.find((item) => item.id === session.id)?.publishedAt;
    expect(publishedAt).toEqual(expect.any(Number));

    const editedTitle = "Taming CI without the wait";
    const editedAbstract = "A corrected organizer summary with the approved state left intact.";
    const edit = await request(`/api/events/${eventId}/agenda/sessions/${session.id}/content`, {
      method: "PATCH",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({ title: editedTitle, abstract: editedAbstract }),
    });
    expect(edit.status).toBe(200);
    const editedAgenda = await edit.json<AgendaState>();
    expect(editedAgenda.sessions.find((item) => item.id === session.id)).toMatchObject({
      title: editedTitle,
      abstract: editedAbstract,
      approvedContent: { title: session.title, abstract: session.abstract },
      contentStatus: "approved",
      editedSinceApproval: true,
      publishedAt,
    });

    const publicResponse = await request(`/api/public/events/${eventId}/sessions`);
    expect(publicResponse.status).toBe(200);
    await expect(publicResponse.json()).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ id: session.id, title: editedTitle, abstract: editedAbstract }),
      ]),
    });

    const republish = await request(`/api/events/${eventId}/agenda/publish`, {
      method: "POST",
      headers: { cookie: organizerCookie },
    });
    expect(republish.status).toBe(200);
    expect((await readAgenda(organizerCookie)).sessions.find((item) => item.id === session.id))
      .toMatchObject({ editedSinceApproval: true, contentStatus: "approved" });
  });

  it("does not infer edits for an existing approval without a content snapshot", async () => {
    const agenda = await readAgenda(organizerCookie);
    expect(agenda.sessions.find((session) => session.id === "ses_docs_retrieval")).toMatchObject({
      approvedContent: null,
      contentStatus: "approved",
      editedSinceApproval: false,
    });
  });

  it("creates a direct session in the event agenda without inventing a submission", async () => {
    const response = await request(`/api/events/${eventId}/agenda/sessions`, {
      method: "POST",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({
        title: "Opening keynote",
        abstract: "A direct programme entry that did not come through the CFP.",
        trackId: "trk_ai_engineering",
        formatId: "fmt_keynote_45",
      }),
    });

    expect(response.status).toBe(201);
    const result = await response.json<{ agenda: AgendaState; session: AgendaState["sessions"][number] }>();
    expect(result.session).toMatchObject({
      id: expect.stringMatching(/^ses_[0-9a-f]{32}$/),
      title: "Opening keynote",
      abstract: "A direct programme entry that did not come through the CFP.",
      contentStatus: "draft",
      scheduleStatus: "unplaced",
      scheduledDate: null,
      durationMinutes: 45,
      track: expect.objectContaining({ id: "trk_ai_engineering", name: "AI Engineering" }),
      room: null,
      speakers: [],
    });
    expect(result.agenda.sessions).toContainEqual(result.session);

    const placedAgenda = await place(result.session.id, organizerCookie, {
      scheduleStatus: "placed",
      scheduledDate: "2027-05-12",
      roomId: "rm_main_stage",
      startsAt: Date.parse("2027-05-12T16:00:00Z"),
    });
    expect(placedAgenda.sessions.find((session) => session.id === result.session.id)).toMatchObject({
      scheduleStatus: "placed",
      startsAt: Date.parse("2027-05-12T16:00:00Z"),
      endsAt: Date.parse("2027-05-12T16:45:00Z"),
    });

    const approval = await request(`/api/events/${eventId}/agenda/sessions/${result.session.id}/content`, {
      method: "PATCH",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({ contentStatus: "approved" }),
    });
    expect(approval.status).toBe(200);
    const publish = await request(`/api/events/${eventId}/agenda/publish`, {
      method: "POST",
      headers: { cookie: organizerCookie },
    });
    expect(publish.status).toBe(200);
    expect(await publicSessionIds()).toContain(result.session.id);
  });

  it("refuses invalid direct-session content and event resources without creating a session", async () => {
    const before = await readAgenda(organizerCookie);
    const cases = [
      { input: { title: "  " }, error: "invalid_session" },
      { input: { title: "Wrong track", trackId: "trk_not_in_event" }, error: "invalid_track" },
      { input: { title: "Wrong format", formatId: "fmt_not_in_event" }, error: "invalid_format" },
    ];

    for (const candidate of cases) {
      const response = await request(`/api/events/${eventId}/agenda/sessions`, {
        method: "POST",
        headers: { cookie: organizerCookie, "content-type": "application/json" },
        body: JSON.stringify(candidate.input),
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: candidate.error });
    }
    expect((await readAgenda(organizerCookie)).sessions).toHaveLength(before.sessions.length);
  });
});
