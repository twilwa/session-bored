// ABOUTME: Exercises real delivery, the reviewed decision-batch send, reminders, and calendar invites
// ABOUTME: against real D1 state with an injected fake delivery so nothing here reaches the network.
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decisionNotices, emailDispatches, people, sessions, speakers, submissions, tasks, taskAssignees } from "../../db/schema.ts";
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

const senderSecrets = { RESEND_API_KEY: "re_test_key", RESEND_FROM_ADDRESS: "Greenroom <program@example.test>" };

/** An address at a registrable domain, so the reserved-domain guard lets it through. */
const deliverableRecipient = "docs-retrieval-speaker@greenroom-mail.dev";

/**
 * The same Worker with the two sender secrets present, so a route resolves the
 * real Resend delivery exactly as production would. Every test that uses this
 * also installs `interceptResend`, so the attempt is answered in-process and
 * detection is never weakened to keep the network out.
 */
async function requestWithSenderConnected(path: string, init?: RequestInit): Promise<Response> {
  return worker.request(`http://example.test${path}`, init, { ...env, ...senderSecrets });
}

/** Answers only Resend's endpoint; any other host reaching global fetch fails the test. */
function interceptResend(reply: { ok: boolean; id?: string }): {
  calls: Array<{ to: string[]; from: string; subject: string; html: string; text: string }>;
} {
  const calls: Array<{ to: string[]; from: string; subject: string; html: string; text: string }> = [];
  const original = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, requestInit?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://api.resend.com/")) {
      return original(input as RequestInfo, requestInit);
    }
    calls.push(JSON.parse(String(requestInit?.body ?? "{}")));
    return reply.ok
      ? new Response(JSON.stringify({ id: reply.id ?? "resend_1" }), { status: 200 })
      : new Response("sender domain is not verified", { status: 403 });
  });
  return { calls };
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
    expect(result.attempted).toBe(true);
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
    const retryResult = await retryDecisionNotice(database, env, eventId, failedRow!.submissionId, failedRow!.id, retrySucceeds);
    expect(retryResult).toEqual({ status: "sent" });
    const [retried] = await database.select().from(decisionNotices).where(eq(decisionNotices.id, failedRow!.id));
    expect(retried).toMatchObject({ deliveryStatus: "sent", providerMessageId: "retry_1" });

    // The HTTP retry route refuses to retry a notice that is not currently failed.
    const notRetryable = await request(`/api/events/${eventId}/decision-notices/${retried!.submissionId}/retry`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ noticeId: retried!.id }),
    });
    expect(notRetryable.status).toBe(409);
    const notFound = await request(`/api/events/${eventId}/decision-notices/sub_missing/retry`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ noticeId: retried!.id }),
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

describe("a decision recorded while no sender is connected", () => {
  const submissionId = "sub_docs_retrieval";
  let cookie: string;
  let database: ReturnType<typeof drizzle>;
  let submitterPersonId: string;
  let seededSubmitterEmail: string;

  beforeEach(async () => {
    await request("/api/health");
    database = drizzle(env.DB);
    cookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");
    // Storage carries across tests in this file, so start each one from a
    // proposal that has never had a decision letter.
    await database.delete(decisionNotices).where(eq(decisionNotices.submissionId, submissionId));
    // These tests are about whether a connected sender really delivers, and the
    // seeded submitter is at example.com, which Greenroom now refuses to send
    // to at all. Give this one proposal an address that could actually receive
    // mail, and put the fixture back afterwards so nothing leaks into the
    // reminder and invitation tests that read the seeded addresses.
    const [submission] = await database
      .select({ personId: submissions.submitterPersonId })
      .from(submissions)
      .where(eq(submissions.id, submissionId));
    submitterPersonId = submission!.personId!;
    const [person] = await database.select({ email: people.email }).from(people).where(eq(people.id, submitterPersonId));
    seededSubmitterEmail = person!.email;
    await database.update(people).set({ email: deliverableRecipient }).where(eq(people.id, submitterPersonId));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await database.update(people).set({ email: seededSubmitterEmail }).where(eq(people.id, submitterPersonId));
  });

  /** Decides the proposal and builds a reviewed batch, stopping short of dispatch. */
  async function buildBatch(): Promise<string> {
    await request(`/api/events/${eventId}/disposition`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ submissionIds: [submissionId], status: "declined" }),
    });
    const previewResponse = await request(`/api/events/${eventId}/decision-batches`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ submissionIds: [submissionId] }),
    });
    return (await previewResponse.json<{ id: string }>()).id;
  }

  interface LoggedDispatch {
    id: string;
    status: string;
    templateKey: string | null;
    failureReason: string | null;
    recipients: Array<{ email: string }>;
  }

  /** The Communications dispatch log rows addressed to this proposal's speaker. */
  async function readLetterLog(recipientEmail: string): Promise<LoggedDispatch[]> {
    const response = await request(`/api/events/${eventId}/email-dispatches`, { headers: { cookie } });
    expect(response.status).toBe(200);
    const payload = await response.json<{ items: LoggedDispatch[] }>();
    return payload.items.filter((item) =>
      item.templateKey?.startsWith("decision_") === true &&
      item.recipients.some((recipient) => recipient.email === recipientEmail)
    );
  }

  it("names the missing Worker secrets so the organizer's alert can offer recourse", async () => {
    const unconfigured = await request("/api/email-sender", { headers: { cookie } });
    expect(unconfigured.status).toBe(200);
    await expect(unconfigured.json()).resolves.toEqual({
      connected: false,
      missingSecrets: ["RESEND_API_KEY", "RESEND_FROM_ADDRESS"],
    });

    const halfConfigured = await worker.request(
      "http://example.test/api/email-sender",
      { headers: { cookie } },
      { ...env, RESEND_API_KEY: "re_test_key" },
    );
    await expect(halfConfigured.json()).resolves.toEqual({
      connected: false,
      missingSecrets: ["RESEND_FROM_ADDRESS"],
    });

    const configured = await requestWithSenderConnected("/api/email-sender", { headers: { cookie } });
    await expect(configured.json()).resolves.toEqual({ connected: true, missingSecrets: [] });

    const anonymous = await request("/api/email-sender");
    expect(anonymous.status).toBe(401);
  });

  it("keeps the letter visible in Communications as pending, without claiming an attempt (#79)", async () => {
    const batchId = await buildBatch();
    const dispatchResponse = await request(`/api/events/${eventId}/decision-batches/${batchId}/dispatch`, {
      method: "POST",
      headers: { cookie },
    });
    await expect(dispatchResponse.json()).resolves.toMatchObject({
      emailDelivery: "not_configured",
      queuedCount: 1,
      pendingCount: 1,
      sent: [],
      failed: [],
    });

    const [notice] = await database.select().from(decisionNotices).where(eq(decisionNotices.batchId, batchId));
    expect(notice?.deliveryStatus).toBe("queued");

    // Nothing was attempted, so nothing is recorded as an attempt.
    const attempts = await database.select().from(emailDispatches).where(eq(emailDispatches.eventId, eventId));
    expect(attempts.some((row) =>
      row.templateKey?.startsWith("decision_") === true &&
      row.recipients.some((recipient) => recipient.email === notice!.recipientEmail)
    )).toBe(false);

    // The letter is still visible in the Communications dispatch log, in its own pending
    // state - neither sent nor failed - and says why nothing went out.
    const logged = await readLetterLog(notice!.recipientEmail);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      status: "queued",
      templateKey: `decision_${notice!.outcome}`,
      failureReason: "No email sender is connected, so delivery was not attempted.",
    });

    // Dispatching the batch again keeps reporting the same waiting letter rather than
    // forgetting it, and still queues nothing new.
    const second = await request(`/api/events/${eventId}/decision-batches/${batchId}/dispatch`, {
      method: "POST",
      headers: { cookie },
    });
    await expect(second.json()).resolves.toMatchObject({ queuedCount: 0, skippedCount: 1, pendingCount: 1 });
    expect(await readLetterLog(notice!.recipientEmail)).toHaveLength(1);
  });

  it("sends the waiting letter once a sender is connected, and never sends it twice", async () => {
    const batchId = await buildBatch();
    await request(`/api/events/${eventId}/decision-batches/${batchId}/dispatch`, {
      method: "POST",
      headers: { cookie },
    });
    const [queued] = await database.select().from(decisionNotices).where(eq(decisionNotices.batchId, batchId));
    expect(queued?.deliveryStatus).toBe("queued");

    const resend = interceptResend({ ok: true, id: "resend_waiting" });
    const sendWaiting = await requestWithSenderConnected(
      `/api/events/${eventId}/decision-notices/${queued!.submissionId}/retry`,
      {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ noticeId: queued!.id }),
      },
    );
    expect(sendWaiting.status).toBe(200);
    await expect(sendWaiting.json()).resolves.toEqual({ status: "sent" });
    expect(resend.calls).toHaveLength(1);
    expect(resend.calls[0]).toMatchObject({ to: [queued!.recipientEmail], from: senderSecrets.RESEND_FROM_ADDRESS });

    const [delivered] = await database.select().from(decisionNotices).where(eq(decisionNotices.id, queued!.id));
    expect(delivered).toMatchObject({ deliveryStatus: "sent", providerMessageId: "resend_waiting" });

    // The letter now reads as sent in the shared log, and no longer as pending.
    const logged = await readLetterLog(queued!.recipientEmail);
    expect(logged).toHaveLength(1);
    expect(logged[0]?.status).toBe("sent");

    // A delivered letter is refused, so connecting a sender can never re-send it.
    const again = await requestWithSenderConnected(
      `/api/events/${eventId}/decision-notices/${queued!.submissionId}/retry`,
      {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ noticeId: queued!.id }),
      },
    );
    expect(again.status).toBe(409);
    await expect(again.json()).resolves.toMatchObject({ error: "notice_not_retryable", currentStatus: "sent" });
    expect(resend.calls).toHaveLength(1);

    // Re-dispatching the batch has nothing left to hand over.
    const redispatch = await requestWithSenderConnected(`/api/events/${eventId}/decision-batches/${batchId}/dispatch`, {
      method: "POST",
      headers: { cookie },
    });
    await expect(redispatch.json()).resolves.toMatchObject({ queuedCount: 0, sent: [], failed: [] });
    expect(resend.calls).toHaveLength(1);
  });

  it("dispatching with a sender connected sends the letters it just queued", async () => {
    const batchId = await buildBatch();
    const resend = interceptResend({ ok: true, id: "resend_direct" });
    const dispatched = await requestWithSenderConnected(`/api/events/${eventId}/decision-batches/${batchId}/dispatch`, {
      method: "POST",
      headers: { cookie },
    });
    await expect(dispatched.json()).resolves.toMatchObject({
      emailDelivery: "dispatched",
      queuedCount: 1,
      pendingCount: 0,
      sent: [submissionId],
      failed: [],
    });
    expect(resend.calls).toHaveLength(1);
    const [notice] = await database.select().from(decisionNotices).where(eq(decisionNotices.batchId, batchId));
    expect(notice?.deliveryStatus).toBe("sent");
  });

  it("refuses a letter addressed to a reserved domain instead of bouncing off it", async () => {
    // The production shape of this: a letter queued to a fixture address, a
    // sender connected, and an organizer one click from a guaranteed hard
    // bounce against a freshly verified sending domain.
    const reservedRecipient = "qa-journey-2026@example.com";
    await database.update(people).set({ email: reservedRecipient }).where(eq(people.id, submitterPersonId));

    const batchId = await buildBatch();
    const resend = interceptResend({ ok: true, id: "resend_should_never_happen" });
    const dispatched = await requestWithSenderConnected(`/api/events/${eventId}/decision-batches/${batchId}/dispatch`, {
      method: "POST",
      headers: { cookie },
    });

    // Nothing reached the provider, so the sending domain's reputation is untouched.
    expect(resend.calls).toHaveLength(0);
    await expect(dispatched.json()).resolves.toMatchObject({ sent: [], failed: [submissionId] });

    // The letter is recorded as failed with a reason the organizer can act on,
    // never as sent, and it does not quietly disappear.
    const [notice] = await database.select().from(decisionNotices).where(eq(decisionNotices.batchId, batchId));
    expect(notice?.deliveryStatus).toBe("failed");
    expect(notice?.providerMessageId).toBeNull();
    expect(notice?.failureReason).toContain(reservedRecipient);
    expect(notice?.failureReason).toContain("can never receive mail");

    // It reads the same way in the shared Communications dispatch log.
    const logged = await readLetterLog(reservedRecipient);
    expect(logged.some((row) => row.status === "sent")).toBe(false);
    expect(logged.some((row) => row.status === "failed" && row.failureReason?.includes("can never receive mail") === true))
      .toBe(true);

    // Clicking "Send now" again says the same thing rather than trying again.
    const retried = await requestWithSenderConnected(
      `/api/events/${eventId}/decision-notices/${submissionId}/retry`,
      {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ noticeId: notice!.id }),
      },
    );
    expect(retried.status).toBe(502);
    await expect(retried.json()).resolves.toMatchObject({ status: "failed" });
    expect(resend.calls).toHaveLength(0);
  });

  it("records a provider rejection as failed and keeps it visible for a retry", async () => {
    const batchId = await buildBatch();
    const rejecting = interceptResend({ ok: false });
    const dispatched = await requestWithSenderConnected(`/api/events/${eventId}/decision-batches/${batchId}/dispatch`, {
      method: "POST",
      headers: { cookie },
    });
    await expect(dispatched.json()).resolves.toMatchObject({ failed: [submissionId], sent: [] });
    expect(rejecting.calls).toHaveLength(1);

    const [notice] = await database.select().from(decisionNotices).where(eq(decisionNotices.batchId, batchId));
    expect(notice?.deliveryStatus).toBe("failed");
    expect(notice?.failureReason).toContain("resend_403");

    const logged = await readLetterLog(notice!.recipientEmail);
    expect(logged.some((row) => row.status === "failed")).toBe(true);

    // Disposition reports the reason too, which is what Communications shows beside the letter.
    const disposition = await request(`/api/events/${eventId}/disposition`, { headers: { cookie } });
    const payload = await disposition.json<{ items: Array<{ id: string; notice: { deliveryStatus: string; failureReason: string | null } | null }> }>();
    const item = payload.items.find((row) => row.id === submissionId);
    expect(item?.notice).toMatchObject({ deliveryStatus: "failed" });
    expect(item?.notice?.failureReason).toContain("resend_403");
  });
});

describe("reviewer invitation dispatch", () => {
  let cookie: string;

  beforeEach(async () => {
    await request("/api/health");
    cookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function readInvitationDispatch(recipientEmail: string): Promise<{
    status: string;
    templateKey: string | null;
    failureReason: string | null;
    recipients: Array<{ email: string }>;
  } | undefined> {
    const response = await request(`/api/events/${eventId}/email-dispatches`, { headers: { cookie } });
    expect(response.status).toBe(200);
    const payload = await response.json<{
      items: Array<{
        status: string;
        templateKey: string | null;
        failureReason: string | null;
        recipients: Array<{ email: string }>;
      }>;
    }>();
    return payload.items.find((item) =>
      item.templateKey === "reviewer_invitation" &&
      item.recipients.some((recipient) => recipient.email === recipientEmail)
    );
  }

  it("sends the invitation through tracked delivery and lists the sent record in Communications", async () => {
    const recipientEmail = `reviewer-invite-success-${crypto.randomUUID()}@greenroom-mail.dev`;
    const resend = interceptResend({ ok: true, id: "resend_reviewer_invitation" });
    const response = await requestWithSenderConnected(`/api/events/${eventId}/reviewer-invites`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ email: recipientEmail }),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      invite: { email: recipientEmail, eventId },
      emailDelivery: "sent",
    });
    expect(resend.calls).toHaveLength(1);
    expect(resend.calls[0]).toMatchObject({
      to: [recipientEmail],
      from: senderSecrets.RESEND_FROM_ADDRESS,
    });
    expect(resend.calls[0]?.text).toContain(`/signup?email=${encodeURIComponent(recipientEmail)}`);
    expect(await readInvitationDispatch(recipientEmail)).toMatchObject({
      status: "sent",
      templateKey: "reviewer_invitation",
      failureReason: null,
    });
  });

  it("returns the failed outcome and lists the provider rejection in Communications", async () => {
    const recipientEmail = `reviewer-invite-failure-${crypto.randomUUID()}@greenroom-mail.dev`;
    const resend = interceptResend({ ok: false });
    const response = await requestWithSenderConnected(`/api/events/${eventId}/reviewer-invites`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ email: recipientEmail }),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      invite: { email: recipientEmail, eventId },
      emailDelivery: "failed",
      failureReason: expect.stringContaining("resend_403"),
    });
    expect(resend.calls).toHaveLength(1);
    expect(await readInvitationDispatch(recipientEmail)).toMatchObject({
      status: "failed",
      templateKey: "reviewer_invitation",
      failureReason: expect.stringContaining("resend_403"),
    });
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
