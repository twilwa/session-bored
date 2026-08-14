// ABOUTME: Exercises organizer embed management and every public delivery format through the real Worker.
// ABOUTME: Proves embed tokens can only narrow the established public approval and publication gate.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
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

async function createEmbed(
  cookie: string,
  input: {
    name: string;
    widgetType: "sessions" | "speakers" | "agenda" | "itinerary" | "gallery";
    status?: "draft" | "published";
    track?: string;
  },
): Promise<{ id: string; publicToken: string; status: string }> {
  const response = await request(`/api/events/${eventId}/embeds`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  expect(response.status).toBe(201);
  return response.json();
}

function publicDeliveryPaths(publicToken: string): string[] {
  return [
    // The extensionless public read is the iframe document's data request.
    `/api/public/embeds/${publicToken}`,
    `/api/public/embeds/${publicToken}.json`,
    `/api/public/embeds/${publicToken}.ics`,
    `/embed/${publicToken}.js`,
  ];
}

async function expectPublicDeliveryStatus(publicToken: string, status: number): Promise<void> {
  for (const path of publicDeliveryPaths(publicToken)) {
    expect((await request(path)).status, path).toBe(status);
  }
}

describe("organizer embed builder", () => {
  let organizerCookie: string;

  beforeEach(async () => {
    await request("/api/health");
    organizerCookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");
  });

  it("requires organizer access and persists every supported widget type", async () => {
    expect((await request(`/api/events/${eventId}/embeds`)).status).toBe(401);
    const reviewerCookie = await signIn("sbek-reviewer@example.com", "SbekTest!2027-rev");
    expect((await request(`/api/events/${eventId}/embeds`, { headers: { cookie: reviewerCookie } })).status).toBe(403);

    const created = [];
    for (const widgetType of ["sessions", "speakers", "agenda", "itinerary", "gallery"] as const) {
      created.push(await createEmbed(organizerCookie, {
        name: `${widgetType} embed`,
        widgetType,
        status: "published",
        track: "Developer Experience",
      }));
    }

    const listResponse = await request(`/api/events/${eventId}/embeds`, {
      headers: { cookie: organizerCookie },
    });
    expect(listResponse.status).toBe(200);
    const list = await listResponse.json<{ items: Array<{ widgetType: string; config: { track?: string } }> }>();
    expect(new Set(list.items.map((item) => item.widgetType))).toEqual(
      new Set(["sessions", "speakers", "agenda", "itinerary", "gallery"]),
    );
    expect(list.items.every((item) => item.config.track === "Developer Experience")).toBe(true);

    for (const [index, embed] of created.entries()) {
      const publicResponse = await request(`/api/public/embeds/${embed.publicToken}`);
      expect(publicResponse.status).toBe(200);
      const payload = await publicResponse.json<{ embed: { widgetType: string }; items: unknown[] }>();
      expect(payload.embed.widgetType).toBe(["sessions", "speakers", "agenda", "itinerary", "gallery"][index]);
      expect(payload.items.length).toBeGreaterThan(0);
    }
  });

  it("keeps draft tokens private in JSON, iCal, frame, and script delivery", async () => {
    const embed = await createEmbed(organizerCookie, {
      name: "Private draft",
      widgetType: "sessions",
    });
    expect(embed.status).toBe("draft");

    await expectPublicDeliveryStatus(embed.publicToken, 404);
  });

  it("publishes, edits, unpublishes, republishes, and deletes one token across every delivery format", async () => {
    const embed = await createEmbed(organizerCookie, {
      name: "Draft programme",
      widgetType: "sessions",
    });
    await expectPublicDeliveryStatus(embed.publicToken, 404);

    const updateResponse = await request(`/api/events/${eventId}/embeds/${embed.id}`, {
      method: "PATCH",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Published programme",
        widgetType: "agenda",
        status: "published",
        track: "Developer Experience",
      }),
    });
    expect(updateResponse.status).toBe(200);
    expect(await updateResponse.json()).toMatchObject({
      id: embed.id,
      name: "Published programme",
      widgetType: "agenda",
      status: "published",
      config: { track: "Developer Experience" },
    });
    await expectPublicDeliveryStatus(embed.publicToken, 200);

    const unpublishResponse = await request(`/api/events/${eventId}/embeds/${embed.id}`, {
      method: "PATCH",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Published programme",
        widgetType: "agenda",
        status: "draft",
        track: "Developer Experience",
      }),
    });
    expect(unpublishResponse.status).toBe(200);
    await expectPublicDeliveryStatus(embed.publicToken, 404);

    const republishResponse = await request(`/api/events/${eventId}/embeds/${embed.id}`, {
      method: "PATCH",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Published programme",
        widgetType: "agenda",
        status: "published",
        track: "Developer Experience",
      }),
    });
    expect(republishResponse.status).toBe(200);
    await expectPublicDeliveryStatus(embed.publicToken, 200);

    const removeResponse = await request(`/api/events/${eventId}/embeds/${embed.id}`, {
      method: "DELETE",
      headers: { cookie: organizerCookie },
    });
    expect(removeResponse.status).toBe(204);
    await expectPublicDeliveryStatus(embed.publicToken, 404);
  });

  it("revalidates stored public JSON after an edit or deletion", async () => {
    const embed = await createEmbed(organizerCookie, {
      name: "Stored programme",
      widgetType: "sessions",
      status: "published",
    });
    const path = `/api/public/embeds/${embed.publicToken}.json`;

    const initialResponse = await request(path);
    expect(initialResponse.status).toBe(200);
    expect(initialResponse.headers.get("cache-control")).toBe("public, no-cache, must-revalidate");
    const initialEtag = initialResponse.headers.get("etag");
    expect(initialEtag).toMatch(/^"[a-f0-9]{64}"$/);
    expect(await initialResponse.json()).toMatchObject({ embed: { name: "Stored programme" } });

    const unchangedResponse = await request(path, { headers: { "if-none-match": initialEtag! } });
    expect(unchangedResponse.status).toBe(304);
    expect(unchangedResponse.headers.get("etag")).toBe(initialEtag);

    const updateResponse = await request(`/api/events/${eventId}/embeds/${embed.id}`, {
      method: "PATCH",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Stored agenda",
        widgetType: "agenda",
        status: "published",
      }),
    });
    expect(updateResponse.status).toBe(200);

    const editedResponse = await request(path, { headers: { "if-none-match": initialEtag! } });
    expect(editedResponse.status).toBe(200);
    expect(editedResponse.headers.get("etag")).not.toBe(initialEtag);
    expect(await editedResponse.json()).toMatchObject({
      embed: { name: "Stored agenda", widgetType: "agenda" },
    });

    const removeResponse = await request(`/api/events/${eventId}/embeds/${embed.id}`, {
      method: "DELETE",
      headers: { cookie: organizerCookie },
    });
    expect(removeResponse.status).toBe(204);

    const removedResponse = await request(path, { headers: { "if-none-match": initialEtag! } });
    expect(removedResponse.status).toBe(404);
    expect(removedResponse.headers.get("cache-control")).toBe("public, no-cache, must-revalidate");
    expect(await removedResponse.json()).toEqual({ error: "not_found" });
  });

  it("delivers filtered JSON and iCal without leaking hidden sessions", async () => {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "insert into program_session (id, event_id, track_id, format_id, title, content_status, schedule_status, direct_entry, ics_uid, published_at, starts_at, ends_at, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        "ses_embed_public",
        eventId,
        "trk_developer_experience",
        "fmt_lightning_10",
        "Public embed session",
        "approved",
        "placed",
        1,
        "ses_embed_public@session-bored",
        now,
        now + 1_800_000,
        now + 3_600_000,
        now,
        now,
      ),
      env.DB.prepare(
        "insert into program_session (id, event_id, track_id, format_id, title, content_status, schedule_status, ics_uid, published_at, starts_at, ends_at, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        "ses_embed_unapproved",
        eventId,
        "trk_developer_experience",
        "fmt_lightning_10",
        "Unapproved embed secret",
        "in_review",
        "placed",
        "ses_embed_unapproved@session-bored",
        now,
        now + 3_600_000,
        now + 5_400_000,
        now,
        now,
      ),
      env.DB.prepare(
        "insert into program_session (id, event_id, track_id, format_id, title, content_status, schedule_status, ics_uid, starts_at, ends_at, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        "ses_embed_unpublished",
        eventId,
        "trk_developer_experience",
        "fmt_lightning_10",
        "Unpublished embed secret",
        "approved",
        "placed",
        "ses_embed_unpublished@session-bored",
        now + 7_200_000,
        now + 9_000_000,
        now,
        now,
      ),
      env.DB.prepare(
        "insert into submission (id, event_id, form_id, form_version, submitter_person_id, status, is_draft, title, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        "sub_embed_withdrawn",
        eventId,
        "frm_devflow_cfp_2027",
        1,
        "psn_marcus_okafor",
        "withdrawn",
        0,
        "Withdrawn embed secret",
        now,
        now,
      ),
      env.DB.prepare(
        "insert into program_session (id, event_id, submission_id, track_id, format_id, title, content_status, schedule_status, ics_uid, published_at, starts_at, ends_at, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        "ses_embed_withdrawn",
        eventId,
        "sub_embed_withdrawn",
        "trk_developer_experience",
        "fmt_lightning_10",
        "Withdrawn embed secret",
        "approved",
        "placed",
        "ses_embed_withdrawn@session-bored",
        now,
        now + 10_800_000,
        now + 12_600_000,
        now,
        now,
      ),
    ]);

    const embed = await createEmbed(organizerCookie, {
      name: "Public developer experience",
      widgetType: "sessions",
      status: "published",
      track: "Developer Experience",
    });

    for (const path of [
      `/api/public/embeds/${embed.publicToken}`,
      `/api/public/embeds/${embed.publicToken}.json`,
    ]) {
      const response = await request(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      const payload = await response.json<{ items: Array<{ title: string | null; track: string | null }> }>();
      expect(payload.items.length).toBeGreaterThan(0);
      expect(payload.items.every((item) => item.track === "Developer Experience")).toBe(true);
      expect(payload.items.map((item) => item.title)).not.toEqual(expect.arrayContaining([
        "Unapproved embed secret",
        "Unpublished embed secret",
        "Withdrawn embed secret",
      ]));
    }

    const scriptResponse = await request(`/embed/${embed.publicToken}.js`);
    expect(scriptResponse.status).toBe(200);
    expect(await scriptResponse.text()).not.toContain("embed secret");

    const calendarResponse = await request(`/api/public/embeds/${embed.publicToken}.ics`);
    expect(calendarResponse.status).toBe(200);
    expect(calendarResponse.headers.get("content-type")).toContain("text/calendar");
    const calendar = await calendarResponse.text();
    expect(calendar).toContain("BEGIN:VCALENDAR");
    expect(calendar).toContain("Public embed session");
    expect(calendar).not.toContain("embed secret");
  });

  it("rejects iCal delivery for speaker widgets instead of serving session calendars", async () => {
    for (const widgetType of ["speakers", "gallery"] as const) {
      const embed = await createEmbed(organizerCookie, {
        name: `${widgetType} without a calendar`,
        widgetType,
        status: "published",
      });

      const response = await request(`/api/public/embeds/${embed.publicToken}.ics`);
      expect(response.status, widgetType).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "not_found" });
    }
  });

  it("serves a host-safe iframe loader for a published token", async () => {
    const embed = await createEmbed(organizerCookie, {
      name: "Homepage programme",
      widgetType: "sessions",
      status: "published",
    });

    const response = await request(`/embed/${embed.publicToken}.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("javascript");
    const source = await response.text();
    expect(source).toContain(`/embed/${embed.publicToken}`);
    expect(source).toContain(`greenroom-${embed.publicToken}`);
    expect(source).toContain("greenroom:embed-height");
  });
});
