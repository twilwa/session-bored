// ABOUTME: Verifies the public audience surfaces enforce the approval gate with no authentication.
// ABOUTME: The unpublished-leak rule is the highest-priority correctness check in this lane.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../../worker/index.ts";

const EVENT_ID = "evt_devflow_conf_2027";

async function request(path: string): Promise<Response> {
  return worker.request(`http://example.test${path}`, undefined, env);
}

async function json<T>(path: string): Promise<{ status: number; body: T }> {
  const response = await request(path);
  return { status: response.status, body: await response.json<T>() };
}

interface SessionItem {
  id: string;
  title: string | null;
  abstract: string | null;
  track: string | null;
  format: string | null;
  room: string | null;
  scheduledDate: string | null;
  speakers: Array<{ id: string; name: string }>;
}
interface SessionsPayload {
  items: SessionItem[];
  total: number;
  filtered: number;
  facets: {
    event: { id: string; name: string };
    tracks: string[];
    formats: string[];
    rooms: string[];
    days: string[];
  };
}
interface SpeakerItem {
  id: string;
  name: string;
  jobTitle: string | null;
  organization: string | null;
  bio: string | null;
  sessionCount: number;
}
interface SpeakersPayload {
  items: SpeakerItem[];
  total: number;
  filtered: number;
}
interface SpeakerDetailPayload {
  speaker: { id: string; name: string; sessions: Array<{ id: string; title: string | null }> } & Record<string, unknown>;
}

async function seedLeakFixtures(): Promise<void> {
  // ABOUTME: Insert draft/in_review/soft-deleted sessions and a withdrawn speaker that must never appear publicly.
  const db = env.DB;
  await db
    .prepare(
      "INSERT INTO program_session (id, event_id, track_id, format_id, title, abstract, content_status, schedule_status, ics_uid, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      "ses_draft_secret",
      EVENT_ID,
      "trk_platform_infra",
      "fmt_talk_30",
      "Draft secret session",
      "Should never be public",
      "draft",
      "tbd",
      "ses_draft_secret@session-bored",
      Date.now(),
      Date.now(),
    )
    .run();
  await db
    .prepare(
      "INSERT INTO program_session (id, event_id, track_id, format_id, title, abstract, content_status, schedule_status, ics_uid, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      "ses_inreview_secret",
      EVENT_ID,
      "trk_ai_engineering",
      "fmt_talk_30",
      "In review secret session",
      "Should never be public",
      "in_review",
      "tbd",
      "ses_inreview_secret@session-bored",
      Date.now(),
      Date.now(),
    )
    .run();
  await db
    .prepare(
      "INSERT INTO program_session (id, event_id, track_id, format_id, title, abstract, content_status, schedule_status, ics_uid, deleted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      "ses_deleted_secret",
      EVENT_ID,
      "trk_developer_experience",
      "fmt_lightning_10",
      "Soft-deleted approved session",
      "Should never be public even though content_status is approved",
      "approved",
      "tbd",
      "ses_deleted_secret@session-bored",
      Date.now(),
      Date.now(),
      Date.now(),
    )
    .run();
  await db
    .prepare(
      "INSERT INTO person (id, name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind("psn_withdrawn_secret", "Wendy Withdrawn", "wendy-withdrawn@example.test", Date.now(), Date.now())
    .run();
  await db
    .prepare(
      "INSERT INTO speaker (id, person_id, event_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind("spk_withdrawn_secret", "psn_withdrawn_secret", EVENT_ID, "withdrawn", Date.now(), Date.now())
    .run();
  for (const [suffix, status] of [["invited", "invited"], ["pending", "pending_employer_approval"]] as const) {
    await db
      .prepare("INSERT INTO person (id, name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .bind(
        `psn_${suffix}_secret`,
        `${suffix} private speaker`,
        `${suffix}-private@example.test`,
        Date.now(),
        Date.now(),
      )
      .run();
    await db
      .prepare("INSERT INTO speaker (id, person_id, event_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(`spk_${suffix}_secret`, `psn_${suffix}_secret`, EVENT_ID, status, Date.now(), Date.now())
      .run();
  }
  // ABOUTME: A withdrawn speaker linked to an approved session must still be hidden from the directory,
  // and the session itself stays visible but must not list the withdrawn speaker.
  await db
    .prepare(
      "INSERT INTO session_speaker (id, session_id, speaker_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind("ssnr_withdrawn_docs", "ses_docs_retrieval", "spk_withdrawn_secret", Date.now(), Date.now())
    .run();
}

describe("Public audience surfaces", () => {
  it("serves sessions, speakers, and detail with no authentication", async () => {
    await request("/api/health");
    const sessions = await json<SessionsPayload>(
      `/api/public/events/${EVENT_ID}/sessions`,
    );
    expect(sessions.status).toBe(200);
    expect(sessions.body.items.map((item) => item.title)).toContain(
      "Docs That Answer Back: Retrieval-Grounded Documentation Sites",
    );

    const speakers = await json<SpeakersPayload>(`/api/public/events/${EVENT_ID}/speakers`);
    expect(speakers.status).toBe(200);
    expect(speakers.body.items.map((item) => item.name).sort()).toEqual(["Marcus Okafor", "Priya Raman"]);

    const detail = await json<SpeakerDetailPayload>(
      `/api/public/events/${EVENT_ID}/speakers/spk_marcus_devflow_2027`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.speaker.name).toBe("Marcus Okafor");
    expect(detail.body.speaker).not.toHaveProperty("email");
    expect(detail.body.speaker.sessions.map((session) => session.title)).toContain(
      "Docs That Answer Back: Retrieval-Grounded Documentation Sites",
    );
  });

  it("returns facets so the directory can render filter controls", async () => {
    const { body } = await json<SessionsPayload>(`/api/public/events/${EVENT_ID}/sessions`);
    expect(body.facets.event.name).toBe("DevFlow Conf 2027");
    expect(body.facets.tracks).toContain("Developer Experience");
    expect(body.facets.formats).toContain("Lightning Talk (10 min)");
    expect(body.facets.rooms).toContain("Main Stage");
    expect(body.facets.days).toContain("2027-05-13");
  });

  it("narrows sessions by title word and by speaker surname", async () => {
    const byTitle = await json<SessionsPayload>(`/api/public/events/${EVENT_ID}/sessions?q=retrieval`);
    expect(byTitle.body.filtered).toBeGreaterThanOrEqual(1);
    expect(byTitle.body.items.every((item) => item.title?.toLowerCase().includes("retrieval") ?? false)).toBe(true);

    const bySpeaker = await json<SessionsPayload>(`/api/public/events/${EVENT_ID}/sessions?q=okafor`);
    expect(bySpeaker.body.items.map((item) => item.title)).toContain(
      "Docs That Answer Back: Retrieval-Grounded Documentation Sites",
    );

    const miss = await json<SessionsPayload>(`/api/public/events/${EVENT_ID}/sessions?q=zzznomatch`);
    expect(miss.body.filtered).toBe(0);
    expect(miss.body.total).toBeGreaterThan(0);
  });

  it("composes track and format filters and narrows the result", async () => {
    const trackMatch = await json<SessionsPayload>(
      `/api/public/events/${EVENT_ID}/sessions?track=Developer%20Experience`,
    );
    expect(trackMatch.body.items.every((item) => item.track === "Developer Experience")).toBe(true);

    const trackMiss = await json<SessionsPayload>(
      `/api/public/events/${EVENT_ID}/sessions?track=AI%20Engineering`,
    );
    expect(trackMiss.body.filtered).toBe(0);

    const both = await json<SessionsPayload>(
      `/api/public/events/${EVENT_ID}/sessions?track=Developer%20Experience&format=Lightning%20Talk%20(10%20min)`,
    );
    expect(both.body.items.length).toBeGreaterThan(0);
  });

  it("alphabetizes the speaker directory by surname", async () => {
    const { body } = await json<SpeakersPayload>(`/api/public/events/${EVENT_ID}/speakers`);
    const surnames = body.items.map((item) => item.name.split(" ").slice(-1)[0] ?? item.name);
    const sorted = [...surnames].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(surnames).toEqual(sorted);
  });

  it("searches the speaker directory without losing the unfiltered total", async () => {
    const match = await json<SpeakersPayload>(`/api/public/events/${EVENT_ID}/speakers?q=priya`);
    expect(match.body.items.map((item) => item.name)).toEqual(["Priya Raman"]);
    expect(match.body.filtered).toBe(1);
    expect(match.body.total).toBe(2);

    const miss = await json<SpeakersPayload>(`/api/public/events/${EVENT_ID}/speakers?q=zzznomatch`);
    expect(miss.body.items).toEqual([]);
    expect(miss.body.filtered).toBe(0);
    expect(miss.body.total).toBe(2);
  });

  it("reports each speaker's count of approved sessions", async () => {
    const { body } = await json<SpeakersPayload>(`/api/public/events/${EVENT_ID}/speakers`);
    const marcus = body.items.find((item) => item.name === "Marcus Okafor");
    const priya = body.items.find((item) => item.name === "Priya Raman");
    expect(marcus?.sessionCount).toBe(1);
    expect(priya?.sessionCount).toBe(0);
  });

  it("404s an unknown speaker and a missing event", async () => {
    const unknown = await json<{ error?: string }>(
      `/api/public/events/${EVENT_ID}/speakers/spk_does_not_exist`,
    );
    expect(unknown.status).toBe(404);
    const missingEvent = await json<{ error?: string }>(
      `/api/public/events/evt_missing/sessions`,
    );
    expect(missingEvent.status).toBe(404);
  });

  it("never exposes draft, in-review, soft-deleted, or withdrawn content", async () => {
    await request("/api/health");
    await seedLeakFixtures();

    const sessions = await json<SessionsPayload>(`/api/public/events/${EVENT_ID}/sessions`);
    const sessionTitles = sessions.body.items.flatMap((item) => (item.title ? [item.title] : []));
    expect(sessionTitles).not.toContain("Draft secret session");
    expect(sessionTitles).not.toContain("In review secret session");
    expect(sessionTitles).not.toContain("Soft-deleted approved session");

    const speakers = await json<SpeakersPayload>(`/api/public/events/${EVENT_ID}/speakers`);
    const speakerNames = speakers.body.items.map((item) => item.name);
    expect(speakerNames).not.toContain("Wendy Withdrawn");
    expect(speakerNames).not.toContain("invited private speaker");
    expect(speakerNames).not.toContain("pending private speaker");

    const withdrawnDetail = await json<{ error?: string }>(
      `/api/public/events/${EVENT_ID}/speakers/spk_withdrawn_secret`,
    );
    expect(withdrawnDetail.status).toBe(404);
    for (const speakerId of ["spk_invited_secret", "spk_pending_secret"]) {
      const privateDetail = await json<{ error?: string }>(
        `/api/public/events/${EVENT_ID}/speakers/${speakerId}`,
      );
      expect(privateDetail.status).toBe(404);
    }

    // ABOUTME: The approved docs session remains visible, but the withdrawn speaker must be absent from its speaker list.
    const docs = sessions.body.items.find((item) => item.id === "ses_docs_retrieval");
    expect(docs).toBeDefined();
    expect(docs?.speakers.map((speaker) => speaker.name)).not.toContain("Wendy Withdrawn");
    expect(docs?.speakers.map((speaker) => speaker.name)).toContain("Marcus Okafor");
  });

  it("stays populated when a session is approved and published but its submission's decision was never synced (the production defect)", async () => {
    await request("/api/health");
    const db = env.DB;
    const backfillAcceptedDecision = () =>
      db
        .prepare(
          `UPDATE submission SET status = 'accepted' WHERE status != 'accepted' AND id IN (
             SELECT submission_id FROM program_session
             WHERE submission_id IS NOT NULL AND content_status = 'approved'
               AND published_at IS NOT NULL AND deleted_at IS NULL
           )`,
        )
        .run();

    // This exact shape — an approved, published session whose own submission's status never
    // caught up — is what production had: content_status/published_at came from seeding or a
    // migration backfill, while submission.status was left behind by an idempotent seed that
    // only runs once. Reproduce it directly rather than relying on any particular seed path.
    await db
      .prepare(
        "INSERT INTO submission (id, event_id, form_id, form_version, submitter_person_id, status, is_draft, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind("sub_stale_decision", EVENT_ID, "frm_devflow_cfp_2027", 1, "psn_priya_raman", "submitted", 0, "Stale decision talk", Date.now(), Date.now())
      .run();
    await db
      .prepare(
        "INSERT INTO program_session (id, event_id, submission_id, title, content_status, schedule_status, published_at, ics_uid, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind("ses_stale_decision", EVENT_ID, "sub_stale_decision", "Stale decision talk", "approved", "tbd", Date.now(), "ses_stale_decision@session-bored", Date.now(), Date.now())
      .run();

    const before = await json<SessionsPayload>(`/api/public/events/${EVENT_ID}/sessions`);
    expect(before.body.items.map((item) => item.id)).not.toContain("ses_stale_decision");

    await backfillAcceptedDecision();

    const after = await json<SessionsPayload>(`/api/public/events/${EVENT_ID}/sessions`);
    expect(after.body.items.map((item) => item.id)).toContain("ses_stale_decision");

    // Negative control: an approved-but-never-published session's submission must not be swept
    // up by the same backfill — only a genuinely published session implies the decision.
    await db
      .prepare(
        "INSERT INTO submission (id, event_id, form_id, form_version, submitter_person_id, status, is_draft, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind("sub_unpublished", EVENT_ID, "frm_devflow_cfp_2027", 1, "psn_priya_raman", "submitted", 0, "Unpublished talk", Date.now(), Date.now())
      .run();
    await db
      .prepare(
        "INSERT INTO program_session (id, event_id, submission_id, title, content_status, schedule_status, ics_uid, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind("ses_unpublished", EVENT_ID, "sub_unpublished", "Unpublished talk", "approved", "tbd", "ses_unpublished@session-bored", Date.now(), Date.now())
      .run();

    await backfillAcceptedDecision();

    const unpublishedSubmission = await db
      .prepare("SELECT status FROM submission WHERE id = ?")
      .bind("sub_unpublished")
      .first<{ status: string }>();
    expect(unpublishedSubmission?.status).toBe("submitted");
    const stillHidden = await json<SessionsPayload>(`/api/public/events/${EVENT_ID}/sessions`);
    expect(stillHidden.body.items.map((item) => item.id)).not.toContain("ses_unpublished");
  });
});
