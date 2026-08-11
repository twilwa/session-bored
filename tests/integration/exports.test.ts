// ABOUTME: Downloads every organizer export through the real Worker and D1 database.
// ABOUTME: Covers portable shapes, committee text, empty events, and role authorization.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../../worker/index.ts";

const eventId = "evt_devflow_conf_2027";
const exportNames = ["sessions.json", "speakers.json", "reviews.csv", "schedule.ics"] as const;

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

describe("organizer exports", () => {
  let organizerCookie: string;

  beforeEach(async () => {
    await request("/api/health");
    organizerCookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");
  });

  it("enforces organizer authorization on every download", async () => {
    for (const name of exportNames) {
      expect((await request(`/api/events/${eventId}/exports/${name}`)).status).toBe(401);
    }

    const reviewerCookie = await signIn("sbek-reviewer@example.com", "SbekTest!2027-rev");
    for (const name of exportNames) {
      expect((await request(`/api/events/${eventId}/exports/${name}`, {
        headers: { cookie: reviewerCookie },
      })).status).toBe(403);
    }
  });

  it("exports complete session and speaker records with meaningful relationships", async () => {
    const now = Date.now();
    await env.DB.prepare(
      "insert into event (id, slug, name, timezone, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
    ).bind("evt_other_export", "other-export", "Other Export", "UTC", now, now).run();
    await env.DB.prepare(
      "insert into form (id, event_id, name, public_slug, version, status, minimum_speakers, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind("frm_other_export", "evt_other_export", "Other CFP", "other-cfp", 1, "draft", 1, now, now).run();
    await env.DB.prepare(
      "insert into submission (id, event_id, form_id, form_version, submitter_person_id, status, is_draft, title, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      "sub_other_export",
      "evt_other_export",
      "frm_other_export",
      1,
      "psn_marcus_okafor",
      "submitted",
      0,
      "Another event proposal",
      now,
      now,
    ).run();
    await env.DB.prepare(
      "insert into submission_speaker (id, submission_id, person_id, role_label, sort_order, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      "sspk_other_export",
      "sub_other_export",
      "psn_marcus_okafor",
      "speaker",
      0,
      now,
      now,
    ).run();

    const sessionsResponse = await request(`/api/events/${eventId}/exports/sessions.json`, {
      headers: { cookie: organizerCookie },
    });
    expect(sessionsResponse.status).toBe(200);
    expect(sessionsResponse.headers.get("content-disposition")).toBe(
      'attachment; filename="sessions.json"',
    );
    const sessionDocument = await sessionsResponse.json<{
      schemaVersion: number;
      event: { id: string; name: string; timezone: string };
      sessions: Array<{
        id: string;
        sourceSubmission: { id: string; decision: string; customAnswers: unknown[] } | null;
        track: { id: string; name: string } | null;
        format: { id: string; name: string; durationMinutes: number | null } | null;
        speakers: Array<{ id: string; personId: string; name: string; email: string; role: string }>;
        calendar: { uid: string; sequence: number };
      }>;
    }>();
    expect(sessionDocument).toMatchObject({
      schemaVersion: 1,
      event: { id: eventId, name: "DevFlow Conf 2027", timezone: "America/Los_Angeles" },
    });
    expect(sessionDocument.sessions).toContainEqual(expect.objectContaining({
      id: "ses_docs_retrieval",
      sourceSubmission: expect.objectContaining({
        id: "sub_docs_retrieval",
        decision: "accepted",
        customAnswers: expect.any(Array),
      }),
      track: expect.objectContaining({ name: "Developer Experience" }),
      format: expect.objectContaining({ name: "Lightning Talk (10 min)", durationMinutes: 10 }),
      speakers: [expect.objectContaining({
        id: "spk_marcus_devflow_2027",
        personId: "psn_marcus_okafor",
        name: "Marcus Okafor",
        email: expect.stringContaining("@"),
        role: "speaker",
      })],
      calendar: { uid: "ses_docs_retrieval@session-bored", sequence: 0 },
    }));

    const speakersResponse = await request(`/api/events/${eventId}/exports/speakers.json`, {
      headers: { cookie: organizerCookie },
    });
    expect(speakersResponse.status).toBe(200);
    expect(speakersResponse.headers.get("content-disposition")).toBe(
      'attachment; filename="speakers.json"',
    );
    const speakerDocument = await speakersResponse.json<{
      schemaVersion: number;
      speakers: Array<{
        id: string;
        personId: string;
        email: string;
        socialLinks: Record<string, string> | null;
        sessions: Array<{ id: string; title: string; role: string }>;
        submissions: Array<{ id: string; title: string; decision: string; role: string }>;
      }>;
    }>();
    expect(speakerDocument.schemaVersion).toBe(1);
    expect(speakerDocument.speakers).toContainEqual(expect.objectContaining({
      id: "spk_marcus_devflow_2027",
      personId: "psn_marcus_okafor",
      email: expect.stringContaining("@"),
      sessions: [expect.objectContaining({ id: "ses_docs_retrieval", role: "speaker" })],
      submissions: [expect.objectContaining({ id: "sub_docs_retrieval", decision: "accepted" })],
    }));
    expect(speakerDocument.speakers.flatMap((speaker) => speaker.submissions))
      .not.toContainEqual(expect.objectContaining({ id: "sub_other_export" }));
  });

  it("exports scores, reviewer identity, decisions, notes, and discussion as valid CSV", async () => {
    const reviewerCookie = await signIn("sbek-reviewer@example.com", "SbekTest!2027-rev");
    const detailResponse = await request("/api/review/submissions/sub_ci_monorepo", {
      headers: { cookie: reviewerCookie },
    });
    const detail = await detailResponse.json<{
      criteria: Array<{ id: string; criterionType: string; options: string[] | null }>;
    }>();
    const scores = Object.fromEntries(detail.criteria.map((criterion) => {
      if (criterion.criterionType === "numeric") return [criterion.id, 4];
      if (criterion.criterionType === "dropdown") return [criterion.id, criterion.options?.[0] ?? "Accept"];
      return [criterion.id, "Evidence is clear,\nbut needs one follow-up."];
    }));
    const reviewResponse = await request("/api/review/submissions/sub_ci_monorepo/reviews", {
      method: "POST",
      headers: { cookie: reviewerCookie, "content-type": "application/json" },
      body: JSON.stringify({
        roundId: "rnd_initial_review",
        scores,
        comment: 'Strong, specific, and "ready" for committee review.',
      }),
    });
    expect(reviewResponse.status).toBe(200);
    const commentResponse = await request("/api/review/submissions/sub_ci_monorepo/comments", {
      method: "POST",
      headers: { cookie: reviewerCookie, "content-type": "application/json" },
      body: JSON.stringify({ body: "Keep the failure story,\nthen tighten the ending." }),
    });
    expect(commentResponse.status).toBe(201);

    const response = await request(`/api/events/${eventId}/exports/reviews.csv`, {
      headers: { cookie: organizerCookie },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="reviews.csv"',
    );
    const csv = await response.text();
    expect(csv.split("\r\n")[0]).toBe(
      "submission_id,submission_title,submission_decision,review_round,reviewer_name,reviewer_email,assignment_status,review_submitted_at,aggregate_score,criterion_id,criterion_label,criterion_type,criterion_score,review_notes,committee_discussion",
    );
    expect(csv).toContain("Sam Whitfield");
    expect(csv).toContain("Overall rating");
    expect(csv).toContain('"Strong, specific, and ""ready"" for committee review."');
    expect(csv).toContain("Sam Whitfield: Keep the failure story,\nthen tighten the ending.");
  });

  it("exports the whole placed schedule through the existing calendar contract", async () => {
    await env.DB.prepare(
      "update program_session set schedule_status = 'placed', scheduled_date = ?, starts_at = ?, ends_at = ?, room_id = ? where id = ?",
    ).bind(
      "2027-05-13",
      Date.parse("2027-05-13T17:00:00Z"),
      Date.parse("2027-05-13T17:10:00Z"),
      "rm_room_2a",
      "ses_docs_retrieval",
    ).run();

    const response = await request(`/api/events/${eventId}/exports/schedule.ics`, {
      headers: { cookie: organizerCookie },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/calendar");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="schedule.ics"',
    );
    const ics = await response.text();
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("UID:ses_docs_retrieval@session-bored");
    expect(ics).toContain("SUMMARY:Docs That Answer Back");
    expect(ics).toContain("LOCATION:Room 2A");
    expect(ics).toContain("END:VCALENDAR");
  });

  it("returns valid empty documents for an event with no exportable records", async () => {
    const now = Date.now();
    await env.DB.prepare(
      "insert into event (id, slug, name, timezone, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
    ).bind("evt_empty_export", "empty-export", "Empty Export", "UTC", now, now).run();

    const sessions = await request("/api/events/evt_empty_export/exports/sessions.json", {
      headers: { cookie: organizerCookie },
    });
    expect((await sessions.json<{ sessions: unknown[] }>()).sessions).toEqual([]);

    const speakers = await request("/api/events/evt_empty_export/exports/speakers.json", {
      headers: { cookie: organizerCookie },
    });
    expect((await speakers.json<{ speakers: unknown[] }>()).speakers).toEqual([]);

    const reviews = await request("/api/events/evt_empty_export/exports/reviews.csv", {
      headers: { cookie: organizerCookie },
    });
    expect((await reviews.text()).split("\r\n")).toHaveLength(2);

    const schedule = await request("/api/events/evt_empty_export/exports/schedule.ics", {
      headers: { cookie: organizerCookie },
    });
    expect(await schedule.text()).not.toContain("BEGIN:VEVENT");
  });
});
