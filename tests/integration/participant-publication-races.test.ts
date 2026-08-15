// ABOUTME: Verifies participant publication writes remain private across concurrent attach and publish boundaries.
// ABOUTME: Uses real D1 statements so hold derivation and release snapshots prove persisted behavior.
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../../worker/index.ts";
import {
  recordSessionParticipation,
} from "../../worker/submission-decision.ts";
import {
  publishSessionsAndReleaseParticipantHolds,
  snapshotParticipantPublicationHolds,
} from "../../worker/routes/agenda.ts";

const eventId = "evt_devflow_conf_2027";
const sessionId = "ses_docs_retrieval";

async function seedSpeaker(suffix: string): Promise<string> {
  const personId = `psn_publication_race_${suffix}`;
  const speakerId = `spk_publication_race_${suffix}`;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "insert into person (id, name, email, created_at, updated_at) values (?, ?, ?, ?, ?)",
    ).bind(personId, `Publication Race ${suffix}`, `${suffix}@publication-race.example.test`, now, now),
    env.DB.prepare(
      "insert into speaker (id, person_id, event_id, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
    ).bind(speakerId, personId, eventId, "onboarding", now, now),
  ]);
  return speakerId;
}

describe("participant publication write boundaries", () => {
  beforeEach(async () => {
    await worker.request("http://example.test/api/health", undefined, env);
  });

  it("derives a new link's hold from the session state inside the link write", async () => {
    const speakerId = await seedSpeaker("atomic_attach");
    await env.DB.prepare("update program_session set published_at = ? where id = ?")
      .bind(Date.now(), sessionId)
      .run();

    await recordSessionParticipation(drizzle(env.DB), {
      id: "ssnr_publication_race_atomic_attach",
      sessionId,
      speakerId,
      roleLabel: "co-speaker",
      sortOrder: 9,
    });

    const link = await env.DB.prepare(
      "select publication_hold_at as publicationHoldAt from session_speaker where id = ?",
    ).bind("ssnr_publication_race_atomic_attach").first<{ publicationHoldAt: number | null }>();
    expect(link?.publicationHoldAt).toEqual(expect.any(Number));
  });

  it("releases only the held links captured at the publish boundary", async () => {
    const beforeSpeakerId = await seedSpeaker("before_publish");
    const afterSpeakerId = await seedSpeaker("after_publish_started");
    const beforeHoldAt = Date.now() - 1_000;
    await env.DB.prepare(
      "insert into session_speaker (id, session_id, speaker_id, publication_hold_at, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
    ).bind(
      "ssnr_publication_race_before",
      sessionId,
      beforeSpeakerId,
      beforeHoldAt,
      beforeHoldAt,
      beforeHoldAt,
    ).run();
    const database = drizzle(env.DB);
    const heldAtStart = await snapshotParticipantPublicationHolds(database, eventId);

    const afterHoldAt = Date.now();
    await env.DB.prepare(
      "insert into session_speaker (id, session_id, speaker_id, publication_hold_at, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
    ).bind(
      "ssnr_publication_race_after",
      sessionId,
      afterSpeakerId,
      afterHoldAt,
      afterHoldAt,
      afterHoldAt,
    ).run();

    const released = await publishSessionsAndReleaseParticipantHolds(
      database,
      [sessionId],
      new Date(),
      heldAtStart,
    );
    expect(released).toContainEqual({ sessionId, speakerId: beforeSpeakerId });
    expect(released).not.toContainEqual({ sessionId, speakerId: afterSpeakerId });
    const links = await env.DB.prepare(
      "select id, publication_hold_at as publicationHoldAt from session_speaker where id in (?, ?) order by id",
    ).bind("ssnr_publication_race_before", "ssnr_publication_race_after")
      .all<{ id: string; publicationHoldAt: number | null }>();
    expect(links.results).toEqual([
      { id: "ssnr_publication_race_after", publicationHoldAt: afterHoldAt },
      { id: "ssnr_publication_race_before", publicationHoldAt: null },
    ]);
  });
});
