// ABOUTME: Exercises event-scoped communication templates and preview queueing through the real Worker interface.
// ABOUTME: Verifies organizer authorization, draft review, tracked sending, and preserved dispatch history in D1.
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import type { EmailDelivery } from "../../worker/email.ts";
import { sendQueuedDispatch } from "../../worker/email/dispatch-queue.ts";
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

describe("event communication templates", () => {
  let organizerCookie: string;

  beforeEach(async () => {
    await request("/api/health");
    organizerCookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");
  });

  it("lets an organizer create an event template and list it beside read-only built-ins", async () => {
    const createResponse = await request(`/api/events/${eventId}/comms/templates`, {
      method: "POST",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Arrival logistics",
        subject: "Arrival details for {{eventName}}",
        body: "Hi {{recipientName}},\n\nMeet us at {{meetingPoint}}.",
      }),
    });

    expect(createResponse.status).toBe(201);
    const created = await createResponse.json<{ item: { key: string } }>();
    const listResponse = await request(`/api/events/${eventId}/comms/templates`, {
      headers: { cookie: organizerCookie },
    });
    expect(listResponse.status).toBe(200);
    const list = await listResponse.json<{ items: Array<Record<string, unknown>> }>();
    expect(list.items).toContainEqual(expect.objectContaining({
      key: created.item.key,
      name: "Arrival logistics",
      mergeFields: ["eventName", "recipientName", "meetingPoint"],
      editable: true,
    }));
    expect(list.items).toContainEqual(expect.objectContaining({
      key: "portal_invitation",
      name: "Portal invitation",
      editable: false,
    }));
  });

  it("lets an organizer edit and remove an authored template", async () => {
    const createResponse = await request(`/api/events/${eventId}/comms/templates`, {
      method: "POST",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "First name", subject: "Hello {{recipientName}}", body: "First body" }),
    });
    const created = await createResponse.json<{ item: { key: string } }>();

    const updateResponse = await request(`/api/events/${eventId}/comms/templates/${created.item.key}`, {
      method: "PATCH",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Schedule change",
        subject: "{{eventName}} schedule change",
        body: "Hi {{recipientName}}, see {{scheduleUrl}}.",
      }),
    });
    expect(updateResponse.status).toBe(200);
    await expect(updateResponse.json()).resolves.toMatchObject({
      item: {
        key: created.item.key,
        name: "Schedule change",
        mergeFields: ["eventName", "recipientName", "scheduleUrl"],
      },
    });

    const deleteResponse = await request(`/api/events/${eventId}/comms/templates/${created.item.key}`, {
      method: "DELETE",
      headers: { cookie: organizerCookie },
    });
    expect(deleteResponse.status).toBe(200);
    const listResponse = await request(`/api/events/${eventId}/comms/templates`, {
      headers: { cookie: organizerCookie },
    });
    const list = await listResponse.json<{ items: Array<{ key: string }> }>();
    expect(list.items.some((item) => item.key === created.item.key)).toBe(false);
  });

  it("rejects malformed merge fields before a template can be used", async () => {
    const response = await request(`/api/events/${eventId}/comms/templates`, {
      method: "POST",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Broken template",
        subject: "Update for {{eventName}}",
        body: "Hi {{recipientName}, this must not be queued.",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_merge_field_syntax" });
  });

  it("names unavailable merge fields before rendering an authored template", async () => {
    const createResponse = await request(`/api/events/${eventId}/comms/templates`, {
      method: "POST",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Schedule change",
        subject: "Update for {{eventName}}",
        body: "Hi {{recipientName}}, the schedule is at {{scheduleUrl}}.",
      }),
    });
    const created = await createResponse.json<{ item: { key: string } }>();

    const missingResponse = await request(
      `/api/events/${eventId}/comms/templates/${created.item.key}/preview`,
      {
        method: "POST",
        headers: { cookie: organizerCookie, "content-type": "application/json" },
        body: JSON.stringify({ recipientId: "spk_priya_devflow_2027", mergeFields: {} }),
      },
    );
    expect(missingResponse.status).toBe(422);
    await expect(missingResponse.json()).resolves.toEqual({
      error: "missing_merge_fields",
      fields: ["scheduleUrl"],
    });

    const previewResponse = await request(
      `/api/events/${eventId}/comms/templates/${created.item.key}/preview`,
      {
        method: "POST",
        headers: { cookie: organizerCookie, "content-type": "application/json" },
        body: JSON.stringify({
          recipientId: "spk_priya_devflow_2027",
          mergeFields: { scheduleUrl: "https://example.test/schedule" },
        }),
      },
    );
    expect(previewResponse.status).toBe(200);
    await expect(previewResponse.json()).resolves.toMatchObject({
      subject: "Update for DevFlow Conf 2027",
      text: "Hi Priya Raman, the schedule is at https://example.test/schedule.",
    });
  });

  it("queues a personalized draft from preview and claims no send when email is unconfigured", async () => {
    const createResponse = await request(`/api/events/${eventId}/comms/templates`, {
      method: "POST",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Speaker logistics",
        subject: "Logistics for {{eventName}}",
        body: "Hi {{recipientName}}, review {{logisticsUrl}}.",
      }),
    });
    const created = await createResponse.json<{ item: { key: string } }>();
    const recipientsResponse = await request(`/api/events/${eventId}/comms/recipients`, {
      headers: { cookie: organizerCookie },
    });
    expect(recipientsResponse.status).toBe(200);
    const recipients = await recipientsResponse.json<{
      items: Array<{ id: string; name: string; email: string }>;
    }>();
    const priya = recipients.items.find((recipient) => recipient.email === "sbek-speaker@example.com");
    expect(priya).toBeDefined();

    const missingFieldResponse = await request(
      `/api/events/${eventId}/comms/templates/${created.item.key}/drafts`,
      {
        method: "POST",
        headers: { cookie: organizerCookie, "content-type": "application/json" },
        body: JSON.stringify({ recipientIds: [priya!.id], mergeFields: {} }),
      },
    );
    expect(missingFieldResponse.status).toBe(422);
    await expect(missingFieldResponse.json()).resolves.toEqual({
      error: "missing_merge_fields",
      fields: ["logisticsUrl"],
    });

    const queueResponse = await request(
      `/api/events/${eventId}/comms/templates/${created.item.key}/drafts`,
      {
        method: "POST",
        headers: { cookie: organizerCookie, "content-type": "application/json" },
        body: JSON.stringify({
          recipientIds: [priya!.id],
          mergeFields: { logisticsUrl: "https://example.test/logistics" },
        }),
      },
    );
    expect(queueResponse.status).toBe(201);
    const queued = await queueResponse.json<{ drafts: Array<{ dispatchId: string }> }>();
    expect(queued.drafts).toHaveLength(1);

    const listResponse = await request(`/api/events/${eventId}/email-dispatches`, {
      headers: { cookie: organizerCookie },
    });
    const list = await listResponse.json<{
      items: Array<{ id: string; status: string; subject: string; body: string; recipients: Array<{ email: string }> }>;
    }>();
    expect(list.items).toContainEqual(expect.objectContaining({
      id: queued.drafts[0]!.dispatchId,
      status: "draft",
      subject: "Logistics for DevFlow Conf 2027",
      body: "Hi Priya Raman, review https://example.test/logistics.",
      recipients: [{ email: "sbek-speaker@example.com", name: "Priya Raman" }],
    }));

    const sendResponse = await request(
      `/api/events/${eventId}/email-dispatches/${queued.drafts[0]!.dispatchId}/send`,
      { method: "POST", headers: { cookie: organizerCookie } },
    );
    expect(sendResponse.status).toBe(409);
    await expect(sendResponse.json()).resolves.toEqual({ error: "email_not_configured" });
    const afterSendAttempt = await request(`/api/events/${eventId}/email-dispatches`, {
      headers: { cookie: organizerCookie },
    });
    const afterList = await afterSendAttempt.json<{ items: Array<{ id: string; status: string }> }>();
    expect(afterList.items.find((item) => item.id === queued.drafts[0]!.dispatchId)?.status).toBe("draft");
  });

  it("keeps sent dispatch history readable after its authored template is removed", async () => {
    const createResponse = await request(`/api/events/${eventId}/comms/templates`, {
      method: "POST",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Thank you",
        subject: "Thank you, {{recipientName}}",
        body: "Thanks for making {{eventName}} special.",
      }),
    });
    const created = await createResponse.json<{ item: { key: string } }>();
    const queueResponse = await request(
      `/api/events/${eventId}/comms/templates/${created.item.key}/drafts`,
      {
        method: "POST",
        headers: { cookie: organizerCookie, "content-type": "application/json" },
        body: JSON.stringify({ recipientIds: ["spk_priya_devflow_2027"], mergeFields: {} }),
      },
    );
    const queued = await queueResponse.json<{ drafts: Array<{ dispatchId: string }> }>();
    const delivery: EmailDelivery = {
      async send() {
        return { status: "sent", providerMessageId: "msg_template_history" };
      },
    };
    const sendResult = await sendQueuedDispatch(
      drizzle(env.DB),
      env,
      eventId,
      queued.drafts[0]!.dispatchId,
      delivery,
    );
    expect(sendResult).toMatchObject({ status: "attempted", sentCount: 1, failedCount: 0 });

    const deleteResponse = await request(`/api/events/${eventId}/comms/templates/${created.item.key}`, {
      method: "DELETE",
      headers: { cookie: organizerCookie },
    });
    expect(deleteResponse.status).toBe(200);
    const logResponse = await request(`/api/events/${eventId}/email-dispatches`, {
      headers: { cookie: organizerCookie },
    });
    const log = await logResponse.json<{
      items: Array<{ id: string; templateKey: string | null; subject: string; body: string; status: string }>;
    }>();
    expect(log.items.filter((item) => item.templateKey === created.item.key)).toHaveLength(1);
    expect(log.items).toContainEqual(expect.objectContaining({
      id: queued.drafts[0]!.dispatchId,
      templateKey: created.item.key,
      subject: "Thank you, Priya Raman",
      body: "Thanks for making DevFlow Conf 2027 special.",
      status: "sent",
    }));
  });

  it("allows only organizers to author templates", async () => {
    const reviewerCookie = await signIn("sbek-reviewer@example.com", "SbekTest!2027-rev");
    const speakerCookie = await signIn("sbek-speaker@example.com", "SbekTest!2027-spk");
    const input = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Private", subject: "Subject", body: "Body" }),
    } satisfies RequestInit;

    expect((await request(`/api/events/${eventId}/comms/templates`, input)).status).toBe(401);
    expect((await request(`/api/events/${eventId}/comms/templates`, {
      ...input,
      headers: { ...input.headers, cookie: reviewerCookie },
    })).status).toBe(403);
    expect((await request(`/api/events/${eventId}/comms/templates`, {
      ...input,
      headers: { ...input.headers, cookie: speakerCookie },
    })).status).toBe(403);
  });

  it("does not create a template outside an existing event", async () => {
    const response = await request("/api/events/evt_missing/comms/templates", {
      method: "POST",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Nowhere", subject: "Subject", body: "Body" }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "event_not_found" });
  });
});
