// ABOUTME: Proves a queued decision letter stays organizer-only and can be retired and re-queued.
// ABOUTME: Guards the send-once design: nothing reaches a speaker until a letter actually sends.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../../worker/index.ts";

const eventId = "evt_devflow_conf_2027";
const submissionId = "sub_ci_monorepo";

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

interface NoticeRow {
  id: string;
  recipient_email: string;
  delivery_status: string;
  cancelled_at: number | null;
  cancellation_reason: string | null;
}

async function noticesFor(id: string): Promise<NoticeRow[]> {
  const rows = await env.DB.prepare(
    "select id, recipient_email, delivery_status, cancelled_at, cancellation_reason" +
      " from decision_notice where submission_id = ? order by created_at",
  ).bind(id).all<NoticeRow>();
  return rows.results;
}

describe("decision notice correction", () => {
  let cookie: string;
  let headers: Record<string, string>;

  beforeEach(async () => {
    await request("/api/health");
    cookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");
    headers = { cookie, "content-type": "application/json" };
    // Storage is shared across the tests in this file, and one queued letter per submission is
    // the whole point of the unique index, so each test starts from no letter at all.
    await env.DB.prepare("delete from decision_notice where submission_id = ?").bind(submissionId).run();
    await env.DB.prepare("delete from decision_batch_item where submission_id = ?").bind(submissionId).run();
    await env.DB.prepare(
      "update person set email = 'sbek-speaker@example.com' where email like '%greenroom-probe.dev'",
    ).run();
  });

  /** Decide, review the rendered batch, and dispatch it to the queue - the whole shipped path. */
  async function queueLetter(status: string): Promise<{ batchId: string; recipientEmail: string }> {
    const decided = await request(`/api/events/${eventId}/disposition`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ submissionIds: [submissionId], status }),
    });
    expect(decided.status).toBe(200);
    const batch = await (await request(`/api/events/${eventId}/decision-batches`, {
      method: "POST",
      headers,
      body: JSON.stringify({ submissionIds: [submissionId] }),
    })).json<{ id: string; items: Array<{ recipientEmail: string }> }>();
    const dispatched = await request(
      `/api/events/${eventId}/decision-batches/${batch.id}/dispatch`,
      { method: "POST", headers: { cookie } },
    );
    expect(dispatched.status).toBe(200);
    await expect(dispatched.json()).resolves.toMatchObject({ queuedCount: 1 });
    return { batchId: batch.id, recipientEmail: batch.items[0]!.recipientEmail };
  }

  function cancel(body: Record<string, unknown> = {}): Promise<Response> {
    return request(`/api/events/${eventId}/decision-notices/${submissionId}/cancel`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  describe("a queued letter is organizer-only", () => {
    it("does not tell the speaker their decision until the letter actually sends", async () => {
      await queueLetter("declined");
      const [queued] = await noticesFor(submissionId);
      expect(queued!.delivery_status).toBe("queued");

      const speakerCookie = await signIn("sbek-speaker@example.com", "SbekTest!2027-spk");
      const content = await (await request("/api/speaker/content", { headers: { cookie: speakerCookie } }))
        .json<{ submissions: Array<{ id: string; speakerStatus: string }> }>();
      const own = content.submissions.find((item) => item.id === submissionId);
      expect(own?.speakerStatus).toBe("in_review");

      // The same decision must not leak through the per-proposal door either.
      const proposal = await (await request(`/api/speaker/submissions/${submissionId}`, {
        headers: { cookie: speakerCookie },
      })).json<Record<string, unknown>>();
      expect(proposal).not.toHaveProperty("status", "declined");
      expect(proposal.speakerStatus).toBe("in_review");
    });

    it("tells the speaker once the letter has actually been sent", async () => {
      await queueLetter("declined");
      await env.DB.prepare(
        "update decision_notice set delivery_status = 'sent', sent_at = ? where submission_id = ?",
      ).bind(Date.now(), submissionId).run();

      const speakerCookie = await signIn("sbek-speaker@example.com", "SbekTest!2027-spk");
      const content = await (await request("/api/speaker/content", { headers: { cookie: speakerCookie } }))
        .json<{ submissions: Array<{ id: string; speakerStatus: string }> }>();
      expect(content.submissions.find((item) => item.id === submissionId)?.speakerStatus)
        .toBe("not_selected");
      const proposal = await (await request(`/api/speaker/submissions/${submissionId}`, {
        headers: { cookie: speakerCookie },
      })).json<{ speakerStatus: string }>();
      expect(proposal.speakerStatus).toBe("not_selected");
    });

    it("keeps a failed letter organizer-only, because it never reached anyone", async () => {
      await queueLetter("declined");
      await env.DB.prepare(
        "update decision_notice set delivery_status = 'failed', failure_reason = 'nope' where submission_id = ?",
      ).bind(submissionId).run();

      const speakerCookie = await signIn("sbek-speaker@example.com", "SbekTest!2027-spk");
      const content = await (await request("/api/speaker/content", { headers: { cookie: speakerCookie } }))
        .json<{ submissions: Array<{ id: string; speakerStatus: string }> }>();
      expect(content.submissions.find((item) => item.id === submissionId)?.speakerStatus)
        .toBe("in_review");
    });
  });

  describe("cancelling", () => {
    it("requires an organizer", async () => {
      await queueLetter("declined");
      const speakerCookie = await signIn("sbek-speaker@example.com", "SbekTest!2027-spk");
      const refused = await request(`/api/events/${eventId}/decision-notices/${submissionId}/cancel`, {
        method: "POST",
        headers: { cookie: speakerCookie, "content-type": "application/json" },
        body: "{}",
      });
      expect(refused.status).toBe(403);
      const anonymous = await request(`/api/events/${eventId}/decision-notices/${submissionId}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(anonymous.status).toBe(401);
    });

    it("retires the letter with an attributed reason and stops it going out", async () => {
      await queueLetter("declined");
      const response = await cancel({ reason: "Wrong address on file." });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ status: "cancelled", submissionId });

      const [row] = await noticesFor(submissionId);
      expect(row!.cancelled_at).not.toBeNull();
      expect(row!.cancellation_reason).toBe("Wrong address on file.");
      expect(row!.delivery_status).toBe("queued");

      // Neither send door will touch it any more.
      const retry = await request(
        `/api/events/${eventId}/decision-notices/${submissionId}/retry`,
        { method: "POST", headers: { cookie } },
      );
      expect(retry.status).toBe(404);
    });

    it("refuses a letter that has already been sent", async () => {
      await queueLetter("declined");
      await env.DB.prepare(
        "update decision_notice set delivery_status = 'sent', sent_at = ? where submission_id = ?",
      ).bind(Date.now(), submissionId).run();
      const response = await cancel();
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ error: "notice_not_cancellable" });
      const [row] = await noticesFor(submissionId);
      expect(row!.cancelled_at).toBeNull();
    });

    it("refuses a second cancellation and an unknown letter", async () => {
      const missing = await cancel();
      expect(missing.status).toBe(404);
      await queueLetter("declined");
      expect((await cancel()).status).toBe(200);
      const again = await cancel();
      expect(again.status).toBe(409);
      await expect(again.json()).resolves.toMatchObject({ error: "notice_already_cancelled" });
    });

    it("leaves the letter visible in Communications rather than making it vanish", async () => {
      const { recipientEmail } = await queueLetter("declined");
      await cancel({ reason: "Queued to the wrong address." });

      const log = await (await request(`/api/events/${eventId}/email-dispatches`, { headers: { cookie } }))
        .json<{ items: Array<{ status: string; failureReason: string | null; recipients: Array<{ email: string }> }> }>();
      const cancelled = log.items.filter((item) => item.status === "cancelled");
      expect(cancelled).toHaveLength(1);
      expect(cancelled[0]!.recipients[0]!.email).toBe(recipientEmail);
      expect(cancelled[0]!.failureReason).toContain("Queued to the wrong address.");
    });

    it("stops counting against the organizer's disposition view exactly once", async () => {
      await queueLetter("declined");
      await cancel();
      const disposition = await (await request(`/api/events/${eventId}/disposition`, { headers: { cookie } }))
        .json<{ items: Array<{ id: string; notice: unknown }> }>();
      const rows = disposition.items.filter((item) => item.id === submissionId);
      // One row, not one per historical notice, and no live notice on it.
      expect(rows).toHaveLength(1);
      expect(rows[0]!.notice).toBeNull();
    });
  });

  describe("re-queueing after a cancellation", () => {
    it("queues a corrected letter rendered from the live record", async () => {
      const { recipientEmail } = await queueLetter("declined");
      const cancelled = await cancel({ recipientEmail: "Corrected.Address@Greenroom-Probe.dev" });
      expect(cancelled.status).toBe(200);
      await expect(cancelled.json()).resolves.toMatchObject({
        recipientEmail: "corrected.address@greenroom-probe.dev",
      });

      const requeued = await queueLetter("declined");
      expect(requeued.recipientEmail).toBe("corrected.address@greenroom-probe.dev");

      const rows = await noticesFor(submissionId);
      expect(rows).toHaveLength(2);
      expect(rows[0]!.cancelled_at).not.toBeNull();
      expect(rows[0]!.recipient_email).toBe(recipientEmail);
      expect(rows[1]!.cancelled_at).toBeNull();
      expect(rows[1]!.recipient_email).toBe("corrected.address@greenroom-probe.dev");
    });

    it("re-renders the outcome too, so a stale letter cannot be revived", async () => {
      await queueLetter("accepted");
      await cancel();
      await queueLetter("declined");
      const rows = await noticesFor(submissionId);
      const live = rows.find((row) => row.cancelled_at === null);
      const [subject] = await env.DB.prepare(
        "select subject from decision_notice where id = ?",
      ).bind(live!.id).all<{ subject: string }>().then((result) => result.results);
      expect(subject!.subject).toContain("Decision on your");
    });

    it("refuses an address another person already holds", async () => {
      await queueLetter("declined");
      const response = await cancel({ recipientEmail: "sbek-speaker2@example.com" });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ error: "recipient_email_taken" });
      // The letter is still live, because the correction it was asked to make did not happen.
      const [row] = await noticesFor(submissionId);
      expect(row!.cancelled_at).toBeNull();
    });

    it("rejects an address that is not an address", async () => {
      await queueLetter("declined");
      expect((await cancel({ recipientEmail: "not-an-address" })).status).toBe(400);
      expect((await cancel({ recipientEmail: "   " })).status).toBe(400);
      const [row] = await noticesFor(submissionId);
      expect(row!.cancelled_at).toBeNull();
    });

    it("does not let the original batch resurrect the cancelled letter", async () => {
      const { batchId } = await queueLetter("declined");
      await cancel({ recipientEmail: "corrected@greenroom-probe.dev" });

      const redispatch = await request(
        `/api/events/${eventId}/decision-batches/${batchId}/dispatch`,
        { method: "POST", headers: { cookie } },
      );
      expect(redispatch.status).toBe(200);
      await expect(redispatch.json()).resolves.toMatchObject({ queuedCount: 0, skippedCount: 1 });
      expect(await noticesFor(submissionId)).toHaveLength(1);
    });
  });
});
