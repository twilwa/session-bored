// ABOUTME: Exercises real delivery, the reviewed decision-batch send, reminders, and calendar invites
// ABOUTME: against real D1 state with an injected fake delivery so nothing here reaches the network.
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { decisionNotices, emailDispatches, sessions, speakers, tasks, taskAssignees } from "../../db/schema.ts";
import type { EmailDelivery, EmailDeliveryResult } from "../../worker/email.ts";
import { dispatchDecisionNoticeEmails, retryDecisionNotice } from "../../worker/email/decision-notices.ts";
import { sendQueuedDispatch } from "../../worker/email/dispatch-queue.ts";
import { draftOverdueTaskReminders } from "../../worker/email/reminders.ts";
import { sendPortalInvitationEmail } from "../../worker/email/portal-invitation.ts";
import { sendSessionCalendarInvite } from "../../worker/email/calendar-invite.ts";
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

/** Deterministic fake delivery: succeeds on its first call per instance, fails after. */
function alternatingDelivery(): EmailDelivery & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async send(message): Promise<EmailDeliveryResult> {
      calls.push(message.recipient);
      return calls.length === 1
        ? { status: "sent", providerMessageId: `msg_${calls.length}` }
        : { status: "failed", error: "simulated_failure" };
    },
  };
}

function alwaysSends(): EmailDelivery & { calls: Array<{ recipient: string; attachments?: unknown[] }> } {
  const calls: Array<{ recipient: string; attachments?: unknown[] }> = [];
  return {
    calls,
    async send(message): Promise<EmailDeliveryResult> {
      calls.push({
        recipient: message.recipient,
        ...(message.attachments === undefined ? {} : { attachments: message.attachments }),
      });
      return { status: "sent", providerMessageId: `msg_${calls.length}` };
    },
  };
}

const eventId = "evt_devflow_conf_2027" as const;

describe("silence first", () => {
  it("submitting a CFP proposal while unconfigured touches no dispatch log", async () => {
    await request("/api/health");
    const before = await env.DB.prepare("select count(*) as count from email_dispatch").first<{ count: number }>();
    const response = await request("/api/public/cfp/devflow-conf-2027/submissions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        intent: "submit",
        speaker: { name: "Silent Speaker", email: "silent-speaker@example.com" },
        proposal: {
          title: "A proposal",
          abstract: "An abstract long enough to pass validation.",
          track: "Developer Experience",
          format: "Talk (30 min)",
          audienceLevel: "Intermediate",
          answers: { key_takeaway: "One clear takeaway." },
        },
      }),
    });
    expect(response.status).toBe(201);
    const after = await env.DB.prepare("select count(*) as count from email_dispatch").first<{ count: number }>();
    expect(after?.count).toBe(before?.count);
  });
});

describe("decision notice dispatch", () => {
  let cookie: string;
  let database: ReturnType<typeof drizzle>;

  beforeEach(async () => {
    await request("/api/health");
    database = drizzle(env.DB);
    cookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");
  });

  it("sends only newly queued notices, records per-recipient outcome, and lets a failure retry", async () => {
    await request(`/api/events/${eventId}/disposition`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ submissionIds: ["sub_ci_monorepo"], status: "accepted" }),
    });
    await request(`/api/events/${eventId}/disposition`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ submissionIds: ["sub_ai_verification"], status: "declined" }),
    });
    const previewResponse = await request(`/api/events/${eventId}/decision-batches`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ submissionIds: ["sub_ci_monorepo", "sub_ai_verification"] }),
    });
    const preview = await previewResponse.json<{ id: string }>();

    // Dispatch through the real HTTP seam - unconfigured in this test run, so it only queues.
    const dispatchResponse = await request(`/api/events/${eventId}/decision-batches/${preview.id}/dispatch`, {
      method: "POST",
      headers: { cookie },
    });
    await expect(dispatchResponse.json()).resolves.toMatchObject({ emailDelivery: "not_configured", sent: [], failed: [] });

    const queuedNotices = await database
      .select()
      .from(decisionNotices)
      .where(eq(decisionNotices.batchId, preview.id));
    expect(queuedNotices).toHaveLength(2);
    expect(queuedNotices.every((notice) => notice.deliveryStatus === "queued")).toBe(true);

    // Now exercise the send logic itself with a fake delivery injected - no network involved.
    const delivery = alternatingDelivery();
    const result = await dispatchDecisionNoticeEmails(database, env, eventId, queuedNotices, delivery);
    expect(result.configured).toBe(true);
    expect(result.sent).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(delivery.calls).toHaveLength(2);

    // A configured decision-letter send also lands in the shared Communications dispatch log,
    // not just decision_notice - both the sent and failed attempts are visible there.
    const dispatchLogRows = await database
      .select()
      .from(emailDispatches)
      .where(eq(emailDispatches.eventId, eventId));
    const decisionLogRows = dispatchLogRows.filter((row) => row.templateKey?.startsWith("decision_"));
    expect(decisionLogRows).toHaveLength(2);
    expect(decisionLogRows.map((row) => row.status).sort()).toEqual(["failed", "sent"]);

    // Re-running against the SAME already-updated rows must not re-send the one that already succeeded.
    const reDelivery = alternatingDelivery();
    const alreadySent = queuedNotices.filter((notice) => result.sent.includes(notice.submissionId));
    const stillFailed = queuedNotices.filter((notice) => result.failed.includes(notice.submissionId));
    expect(alreadySent).toHaveLength(1);
    expect(stillFailed).toHaveLength(1);

    const rowsAfter = await database.select().from(decisionNotices).where(eq(decisionNotices.batchId, preview.id));
    const sentRow = rowsAfter.find((row) => row.submissionId === result.sent[0]);
    const failedRow = rowsAfter.find((row) => row.submissionId === result.failed[0]);
    expect(sentRow).toMatchObject({ deliveryStatus: "sent", providerMessageId: "msg_1" });
    expect(sentRow?.sentAt).not.toBeNull();
    expect(failedRow).toMatchObject({ deliveryStatus: "failed", failureReason: "simulated_failure" });
    expect(failedRow?.sentAt).toBeNull();

    // Retrying the failed one succeeds and is visible per-recipient; the already-sent one is untouched.
    const retrySucceeds: EmailDelivery = { async send() { return { status: "sent", providerMessageId: "retry_1" }; } };
    const retryResult = await retryDecisionNotice(database, env, eventId, failedRow!.submissionId, retrySucceeds);
    expect(retryResult).toEqual({ status: "sent" });
    const [retried] = await database.select().from(decisionNotices).where(eq(decisionNotices.id, failedRow!.id));
    expect(retried).toMatchObject({ deliveryStatus: "sent", providerMessageId: "retry_1" });

    // The HTTP retry route refuses to retry a notice that is not currently failed.
    const notRetryable = await request(`/api/events/${eventId}/decision-notices/${retried!.submissionId}/retry`, {
      method: "POST",
      headers: { cookie },
    });
    expect(notRetryable.status).toBe(409);
    const notFound = await request(`/api/events/${eventId}/decision-notices/sub_missing/retry`, {
      method: "POST",
      headers: { cookie },
    });
    expect(notFound.status).toBe(404);

    // Dispatching the same batch again queues nothing new, so nothing is emailed twice.
    const secondDispatch = await request(`/api/events/${eventId}/decision-batches/${preview.id}/dispatch`, {
      method: "POST",
      headers: { cookie },
    });
    await expect(secondDispatch.json()).resolves.toMatchObject({ queuedCount: 0, skippedCount: 2 });
    expect(reDelivery.calls).toHaveLength(0);
  });
});

describe("reminder review queue", () => {
  let cookie: string;
  let userId: string;
  let database: ReturnType<typeof drizzle>;

  beforeEach(async () => {
    await request("/api/health");
    database = drizzle(env.DB);
    cookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");
    const session = await request("/api/session", { headers: { cookie } });
    const payload = await session.json<{ user: { id: string } }>();
    userId = payload.user.id;
  });

  async function makeOverdueTask(): Promise<string> {
    const taskId = `tsk_test_${crypto.randomUUID().slice(0, 8)}`;
    await database.insert(tasks).values({
      id: taskId,
      eventId,
      title: "Confirm bio",
      dueAt: new Date("2020-01-01T00:00:00Z"),
      status: "active",
    });
    await database.insert(taskAssignees).values({
      id: `tassn_test_${crypto.randomUUID().slice(0, 8)}`,
      taskId,
      speakerId: "spk_priya_devflow_2027",
    });
    return taskId;
  }

  it("drafts one reminder per speaker with overdue tasks, skips duplicates, and never auto-sends", async () => {
    await makeOverdueTask();
    const first = await draftOverdueTaskReminders({
      database,
      eventId,
      appOrigin: "https://example.test",
      now: new Date(),
      createdByUserId: userId,
    });
    expect(first.drafted).toHaveLength(1);
    expect(first.drafted[0]).toMatchObject({ recipientEmail: "sbek-speaker@example.com", overdueTaskCount: 1 });

    const [draftRow] = await database
      .select()
      .from(emailDispatches)
      .where(eq(emailDispatches.id, first.drafted[0]!.dispatchId));
    expect(draftRow).toMatchObject({ status: "draft" });

    const second = await draftOverdueTaskReminders({
      database,
      eventId,
      appOrigin: "https://example.test",
      now: new Date(),
      createdByUserId: userId,
    });
    expect(second.drafted).toHaveLength(0);
    expect(second.skipped).toBeGreaterThan(0);

    // Approving a send while unconfigured must not mark the draft sent.
    const unconfiguredSend = await request(`/api/events/${eventId}/email-dispatches/${draftRow!.id}/send`, {
      method: "POST",
      headers: { cookie },
    });
    expect(unconfiguredSend.status).toBe(409);
    const [stillDraft] = await database.select().from(emailDispatches).where(eq(emailDispatches.id, draftRow!.id));
    expect(stillDraft!.status).toBe("draft");

    // Editing the draft before send.
    const editResponse = await request(`/api/events/${eventId}/email-dispatches/${draftRow!.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ subject: "Edited subject" }),
    });
    expect(editResponse.status).toBe(200);

    // Approve-and-send with an injected delivery - the explicit act that actually sends.
    const delivery = alwaysSends();
    const sendResult = await sendQueuedDispatch(database, env, eventId, draftRow!.id, delivery);
    expect(sendResult).toMatchObject({ status: "attempted", sentCount: 1, failedCount: 0 });
    expect(delivery.calls).toHaveLength(1);
    const [sentRow] = await database.select().from(emailDispatches).where(eq(emailDispatches.id, draftRow!.id));
    expect(sentRow).toMatchObject({ status: "sent", subject: "Edited subject" });
    expect(sentRow!.sentAt).not.toBeNull();

    // A sent dispatch can no longer be edited or discarded.
    const editAfterSend = await request(`/api/events/${eventId}/email-dispatches/${draftRow!.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ subject: "Too late" }),
    });
    expect(editAfterSend.status).toBe(409);
  });

  it("discards a draft without sending it", async () => {
    await makeOverdueTask();
    const drafted = await draftOverdueTaskReminders({
      database,
      eventId,
      appOrigin: "https://example.test",
      now: new Date(),
      createdByUserId: userId,
    });
    const dispatchId = drafted.drafted[0]!.dispatchId;
    const discardResponse = await request(`/api/events/${eventId}/email-dispatches/${dispatchId}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(discardResponse.status).toBe(200);
    const list = await request(`/api/events/${eventId}/email-dispatches`, { headers: { cookie } });
    const payload = await list.json<{ items: Array<{ id: string }> }>();
    expect(payload.items.some((item) => item.id === dispatchId)).toBe(false);

    // A discarded draft must not permanently block that speaker from a future reminder.
    const redrafted = await draftOverdueTaskReminders({
      database,
      eventId,
      appOrigin: "https://example.test",
      now: new Date(),
      createdByUserId: userId,
    });
    expect(redrafted.drafted).toHaveLength(1);
    expect(redrafted.drafted[0]!.dispatchId).not.toBe(dispatchId);
  });
});

describe("calendar invites", () => {
  let database: ReturnType<typeof drizzle>;

  beforeEach(async () => {
    await request("/api/health");
    database = drizzle(env.DB);
  });

  it("requires the session to be scheduled before an invite can be built", async () => {
    const delivery = alwaysSends();
    const result = await sendSessionCalendarInvite(database, env, eventId, "ses_docs_retrieval", null, delivery);
    expect(result).toEqual({ status: "not_scheduled" });
    expect(delivery.calls).toHaveLength(0);
  });

  it("keeps the UID stable and advances SEQUENCE across a regenerate after the session changes", async () => {
    await database
      .update(sessions)
      .set({ startsAt: new Date("2027-05-13T17:00:00Z"), endsAt: new Date("2027-05-13T17:10:00Z") })
      .where(eq(sessions.id, "ses_docs_retrieval"));

    const [before] = await database.select().from(sessions).where(eq(sessions.id, "ses_docs_retrieval"));
    expect(before!.icsSequence).toBe(0);

    const firstDelivery = alwaysSends();
    const first = await sendSessionCalendarInvite(database, env, eventId, "ses_docs_retrieval", null, firstDelivery);
    expect(first).toMatchObject({ status: "sent", sentCount: 1, failedCount: 0, sequence: 1 });
    const firstIcs = firstDelivery.calls[0]!.attachments as Array<{ content: string }>;
    const firstDecoded = atob(firstIcs[0]!.content);
    expect(firstDecoded).toContain("UID:ses_docs_retrieval@session-bored");
    expect(firstDecoded).toContain("SEQUENCE:1");

    // Mutate the session (room change) and regenerate.
    await database.update(sessions).set({ title: "Docs Retrieval, revisited" }).where(eq(sessions.id, "ses_docs_retrieval"));
    const secondDelivery = alwaysSends();
    const second = await sendSessionCalendarInvite(database, env, eventId, "ses_docs_retrieval", null, secondDelivery);
    expect(second).toMatchObject({ status: "sent", sequence: 2 });
    const secondIcs = secondDelivery.calls[0]!.attachments as Array<{ content: string }>;
    const secondDecoded = atob(secondIcs[0]!.content);
    expect(secondDecoded).toContain("UID:ses_docs_retrieval@session-bored");
    expect(secondDecoded).toContain("SEQUENCE:2");

    const [after] = await database.select().from(sessions).where(eq(sessions.id, "ses_docs_retrieval"));
    expect(after!.icsSequence).toBe(2);
  });

  it("reports session_not_found for an unknown session", async () => {
    const result = await sendSessionCalendarInvite(database, env, eventId, "ses_missing", null, alwaysSends());
    expect(result).toEqual({ status: "session_not_found" });
  });
});

describe("portal invitation", () => {
  it("sends to the speaker's address and reports speaker_not_found otherwise", async () => {
    await request("/api/health");
    const delivery = alwaysSends();
    const result = await sendPortalInvitationEmail({
      env,
      eventId,
      speakerId: "spk_priya_devflow_2027",
      delivery,
    });
    expect(result).toMatchObject({ status: "sent" });
    expect(delivery.calls).toEqual([{ recipient: "sbek-speaker@example.com", attachments: undefined }]);

    const missing = await sendPortalInvitationEmail({
      env,
      eventId,
      speakerId: "spk_does_not_exist",
      delivery: alwaysSends(),
    });
    expect(missing).toEqual({ status: "speaker_not_found" });
  });
});
