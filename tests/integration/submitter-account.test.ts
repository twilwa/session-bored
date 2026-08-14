// ABOUTME: Exercises submitter account ownership and dashboard access through the real Worker.
// ABOUTME: Proves anonymous author keys and signed-in proposal ownership never cross implicitly.
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";
import { decisionNotices } from "../../db/schema.ts";
import worker from "../../worker/index.ts";

async function request(path: string, init?: RequestInit): Promise<Response> {
  return worker.request(`http://example.test${path}`, init, env);
}

async function createAccount(name: string, email: string): Promise<string> {
  const response = await request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, email, password: "Greenroom!2027" }),
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie");
  expect(cookie).toBeTruthy();
  return cookie?.split(";")[0] ?? "";
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

function anonymousDraft(email: string, title = "An anonymous proposal") {
  return {
    intent: "draft",
    speaker: {
      name: "Anonymous Author",
      email,
    },
    proposal: {
      title,
      answers: {},
    },
  };
}

async function decide(
  submissionId: string,
  status: "accepted" | "maybe" | "declined",
  organizerCookie: string,
): Promise<void> {
  const response = await request("/api/events/evt_devflow_conf_2027/disposition", {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: organizerCookie },
    body: JSON.stringify({ submissionIds: [submissionId], status }),
  });
  expect(response.status).toBe(200);
}

/** Queues the letter the committee's current decision would send, and lands it on its recipient. */
async function sendDecisionLetter(submissionId: string, organizerCookie: string): Promise<void> {
  const previewResponse = await request("/api/events/evt_devflow_conf_2027/decision-batches", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: organizerCookie },
    body: JSON.stringify({ submissionIds: [submissionId] }),
  });
  expect(previewResponse.status).toBe(201);
  const preview = await previewResponse.json<{ id: string }>();
  const dispatchResponse = await request(
    `/api/events/evt_devflow_conf_2027/decision-batches/${preview.id}/dispatch`,
    { method: "POST", headers: { cookie: organizerCookie } },
  );
  expect(dispatchResponse.status).toBe(200);
  await drizzle(env.DB)
    .update(decisionNotices)
    .set({ deliveryStatus: "sent", sentAt: new Date() })
    .where(eq(decisionNotices.submissionId, submissionId));
}

async function listedStatus(submissionId: string, submitterCookie: string): Promise<string | undefined> {
  const response = await request("/api/submitter/submissions", {
    headers: { cookie: submitterCookie },
  });
  expect(response.status).toBe(200);
  const payload = await response.json<{ items: { id: string; status: string }[] }>();
  return payload.items.find((item) => item.id === submissionId)?.status;
}

describe("submitter account ownership", () => {
  it("requires authentication for the submitter dashboard", async () => {
    await request("/api/health");

    const response = await request("/api/submitter/submissions");

    expect(response.status).toBe(401);
  });

  it("creates a password-authenticated account from the public origin", async () => {
    await request("/api/health");
    const cookie = await createAccount("Portal Account", "portal-account@example.com");

    const response = await request("/api/session", { headers: { cookie } });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      user: { name: "Portal Account", email: "portal-account@example.com" },
    });
  });

  it("gives a self-created account the submitter dashboard and nothing more", async () => {
    await request("/api/health");
    const cookie = await createAccount("Self Serve", "self-serve@example.com");

    // The dashboard is theirs: it is scoped to the person, not to a role.
    const dashboard = await request("/api/submitter/submissions", { headers: { cookie } });
    expect(dashboard.status).toBe(200);
    expect(await dashboard.json()).toEqual({ items: [] });

    // Every role-scoped area stays shut.
    for (const path of ["/api/speaker/content", "/api/reviewer/assignments", "/api/events"]) {
      expect((await request(path, { headers: { cookie } })).status).toBe(403);
    }
  });

  it("does not list an anonymous proposal after account creation with the same email", async () => {
    await request("/api/health");
    const draft = anonymousDraft("anonymous-owner@example.com");
    const anonymousResponse = await request("/api/public/cfp/devflow-conf-2027/submissions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft),
    });
    expect(anonymousResponse.status).toBe(201);

    const cookie = await createAccount("Anonymous Author", draft.speaker.email);
    const response = await request("/api/submitter/submissions", { headers: { cookie } });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [] });
  });

  it("does not read an anonymous proposal from a matching account without its author key", async () => {
    await request("/api/health");
    const draft = anonymousDraft("anonymous-read@example.com");
    const createResponse = await request("/api/public/cfp/devflow-conf-2027/submissions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft),
    });
    const created = await createResponse.json<{ accessPath: string }>();
    const cookie = await createAccount("Anonymous Author", draft.speaker.email);

    const response = await request(created.accessPath, { headers: { cookie } });

    expect(response.status).toBe(404);
  });

  it("does not edit an anonymous proposal from a matching account without its author key", async () => {
    await request("/api/health");
    const draft = anonymousDraft("anonymous-edit@example.com");
    const createResponse = await request("/api/public/cfp/devflow-conf-2027/submissions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft),
    });
    const created = await createResponse.json<{ accessPath: string }>();
    const cookie = await createAccount("Anonymous Author", draft.speaker.email);

    const response = await request(created.accessPath, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ ...draft, proposal: { ...draft.proposal, title: "Stolen edit" } }),
    });

    expect(response.status).toBe(404);
  });

  it("does not claim an anonymous identity when a matching account submits", async () => {
    await request("/api/health");
    const draft = anonymousDraft("anonymous-claim@example.com");
    const anonymousResponse = await request("/api/public/cfp/devflow-conf-2027/submissions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft),
    });
    expect(anonymousResponse.status).toBe(201);
    const cookie = await createAccount("Anonymous Author", draft.speaker.email);

    const response = await request("/api/public/cfp/devflow-conf-2027/submissions", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ ...draft, proposal: { ...draft.proposal, title: "A signed-in proposal" } }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "anonymous_identity_exists" });
  });

  it("lists a proposal created while signed in", async () => {
    await request("/api/health");
    const draft = anonymousDraft("account-owner@example.com", "An account-owned proposal");
    const cookie = await createAccount("Account Owner", draft.speaker.email);
    const createResponse = await request("/api/public/cfp/devflow-conf-2027/submissions", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(draft),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json<{ submission: { id: string } }>();

    const response = await request("/api/submitter/submissions", { headers: { cookie } });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      items: [{ id: created.submission.id, title: "An account-owned proposal", status: "draft" }],
    });
  });

  it("lets a non-speaker submitter list and open only their own proposal", async () => {
    await request("/api/health");
    const otherDraft = anonymousDraft("non-speaker-other@example.com", "Another user's proposal");
    const otherCookie = await createAccount("Other Account", otherDraft.speaker.email);
    const otherCreateResponse = await request("/api/public/cfp/devflow-conf-2027/submissions", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: otherCookie },
      body: JSON.stringify(otherDraft),
    });
    expect(otherCreateResponse.status).toBe(201);
    const otherCreated = await otherCreateResponse.json<{ accessPath: string }>();

    const organizerCookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");
    const organizerDraft = anonymousDraft("sbek-organizer@example.com", "Organizer-owned proposal");
    const organizerCreateResponse = await request("/api/public/cfp/devflow-conf-2027/submissions", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify(organizerDraft),
    });
    expect(organizerCreateResponse.status).toBe(201);
    const organizerCreated = await organizerCreateResponse.json<{
      accessPath: string;
      submission: { id: string };
    }>();

    const listResponse = await request("/api/submitter/submissions", {
      headers: { cookie: organizerCookie },
    });
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toMatchObject({
      items: [{ id: organizerCreated.submission.id, title: "Organizer-owned proposal" }],
    });

    const ownResponse = await request(organizerCreated.accessPath, {
      headers: { cookie: organizerCookie },
    });
    expect(ownResponse.status).toBe(200);

    const otherResponse = await request(otherCreated.accessPath, {
      headers: { cookie: organizerCookie },
    });
    expect(otherResponse.status).toBe(404);
  });

  it("does not issue an anonymous author key for an account-owned proposal", async () => {
    await request("/api/health");
    const draft = anonymousDraft("account-keyless@example.com");
    const cookie = await createAccount("Keyless Account", draft.speaker.email);

    const response = await request("/api/public/cfp/devflow-conf-2027/submissions", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(draft),
    });

    expect(response.status).toBe(201);
    const body = await response.json<{ editKey?: string; editUrl: string }>();
    expect(body.editKey).toBeUndefined();
    expect(body.editUrl).not.toContain("key=");
  });

  it("does not list another account's proposal", async () => {
    await request("/api/health");
    const ownerDraft = anonymousDraft("list-owner@example.com", "Owner-only proposal");
    const ownerCookie = await createAccount("List Owner", ownerDraft.speaker.email);
    const createResponse = await request("/api/public/cfp/devflow-conf-2027/submissions", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify(ownerDraft),
    });
    expect(createResponse.status).toBe(201);
    const otherCookie = await createAccount("Other Submitter", "list-other@example.com");

    const response = await request("/api/submitter/submissions", { headers: { cookie: otherCookie } });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [] });
  });

  it("does not read another account's proposal", async () => {
    await request("/api/health");
    const ownerDraft = anonymousDraft("read-owner@example.com", "Private account proposal");
    const ownerCookie = await createAccount("Read Owner", ownerDraft.speaker.email);
    const createResponse = await request("/api/public/cfp/devflow-conf-2027/submissions", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify(ownerDraft),
    });
    const created = await createResponse.json<{ accessPath: string }>();
    const otherCookie = await createAccount("Read Intruder", "read-intruder@example.com");

    const response = await request(created.accessPath, { headers: { cookie: otherCookie } });

    expect(response.status).toBe(404);
  });

  it("does not read an account-owned proposal from its id without authentication", async () => {
    await request("/api/health");
    const draft = anonymousDraft("anonymous-id-read@example.com");
    const cookie = await createAccount("ID Read Owner", draft.speaker.email);
    const createResponse = await request("/api/public/cfp/devflow-conf-2027/submissions", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(draft),
    });
    const created = await createResponse.json<{ accessPath: string }>();

    const response = await request(created.accessPath);

    expect(response.status).toBe(404);
  });

  it("does not edit another account's proposal", async () => {
    await request("/api/health");
    const ownerDraft = anonymousDraft("edit-owner@example.com", "Unchanged account proposal");
    const ownerCookie = await createAccount("Edit Owner", ownerDraft.speaker.email);
    const createResponse = await request("/api/public/cfp/devflow-conf-2027/submissions", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify(ownerDraft),
    });
    const created = await createResponse.json<{ accessPath: string }>();
    const otherCookie = await createAccount("Edit Intruder", "edit-intruder@example.com");

    const response = await request(created.accessPath, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: otherCookie },
      body: JSON.stringify({
        ...ownerDraft,
        proposal: { ...ownerDraft.proposal, title: "Unauthorized account edit" },
      }),
    });

    expect(response.status).toBe(404);
  });

  it("does not edit an account-owned proposal from its id without authentication", async () => {
    await request("/api/health");
    const draft = anonymousDraft("anonymous-id-edit@example.com");
    const cookie = await createAccount("ID Edit Owner", draft.speaker.email);
    const createResponse = await request("/api/public/cfp/devflow-conf-2027/submissions", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(draft),
    });
    const created = await createResponse.json<{ accessPath: string }>();

    const response = await request(created.accessPath, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft),
    });

    expect(response.status).toBe(404);
  });

  it("reads an account-owned proposal without an anonymous author key", async () => {
    await request("/api/health");
    const draft = anonymousDraft("account-read@example.com", "Readable account proposal");
    const cookie = await createAccount("Account Reader", draft.speaker.email);
    const createResponse = await request("/api/public/cfp/devflow-conf-2027/submissions", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(draft),
    });
    const created = await createResponse.json<{ accessPath: string; submission: { id: string } }>();

    const response = await request(created.accessPath, { headers: { cookie } });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      submission: { id: created.submission.id, title: "Readable account proposal" },
    });
  });

  it("edits an account-owned proposal without an anonymous author key", async () => {
    await request("/api/health");
    const draft = anonymousDraft("account-edit@example.com", "Account proposal before edit");
    const cookie = await createAccount("Account Editor", draft.speaker.email);
    const createResponse = await request("/api/public/cfp/devflow-conf-2027/submissions", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(draft),
    });
    const created = await createResponse.json<{ accessPath: string }>();

    const response = await request(created.accessPath, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        ...draft,
        speaker: { ...draft.speaker, jobTitle: "Principal Engineer" },
        proposal: { ...draft.proposal, title: "Account proposal after edit" },
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      submission: {
        title: "Account proposal after edit",
        speaker: { jobTitle: "Principal Engineer" },
      },
    });
  });

  it("does not create account ownership from a different speaker email", async () => {
    await request("/api/health");
    const cookie = await createAccount("Account Identity", "account-identity@example.com");
    const draft = anonymousDraft("different-identity@example.com");

    const response = await request("/api/public/cfp/devflow-conf-2027/submissions", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(draft),
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "account_email_mismatch" });
  });

  it("does not add an anonymous proposal to another account by reusing its email", async () => {
    await request("/api/health");
    const draft = anonymousDraft("protected-account@example.com", "Protected account proposal");
    const cookie = await createAccount("Protected Account", draft.speaker.email);
    const ownedResponse = await request("/api/public/cfp/devflow-conf-2027/submissions", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(draft),
    });
    expect(ownedResponse.status).toBe(201);

    const response = await request("/api/public/cfp/devflow-conf-2027/submissions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...draft,
        proposal: { ...draft.proposal, title: "Injected anonymous proposal" },
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "account_sign_in_required" });
  });

  it("keeps a decision in review until its letter is sent", async () => {
    await request("/api/health");
    const draft = anonymousDraft("decision-owner@example.com", "Decision-ready proposal");
    const submitterCookie = await createAccount("Decision Owner", draft.speaker.email);
    const createResponse = await request("/api/public/cfp/devflow-conf-2027/submissions", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: submitterCookie },
      body: JSON.stringify(draft),
    });
    const created = await createResponse.json<{ submission: { id: string } }>();
    const organizerCookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");

    for (const status of ["accepted", "maybe", "declined"] as const) {
      await decide(created.submission.id, status, organizerCookie);
      expect(await listedStatus(created.submission.id, submitterCookie)).toBe("under_review");
    }

    const previewResponse = await request("/api/events/evt_devflow_conf_2027/decision-batches", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: organizerCookie },
      body: JSON.stringify({ submissionIds: [created.submission.id] }),
    });
    expect(previewResponse.status).toBe(201);
    const preview = await previewResponse.json<{ id: string }>();
    const dispatchResponse = await request(
      `/api/events/evt_devflow_conf_2027/decision-batches/${preview.id}/dispatch`,
      { method: "POST", headers: { cookie: organizerCookie } },
    );
    expect(dispatchResponse.status).toBe(200);

    expect(await listedStatus(created.submission.id, submitterCookie)).toBe("under_review");

    await drizzle(env.DB)
      .update(decisionNotices)
      .set({ deliveryStatus: "sent", sentAt: new Date() })
      .where(eq(decisionNotices.submissionId, created.submission.id));

    expect(await listedStatus(created.submission.id, submitterCookie)).toBe("declined");
  });

  it("keeps a sent maybe letter reading under review", async () => {
    await request("/api/health");
    const draft = anonymousDraft("maybe-decision@example.com", "Still-considered proposal");
    const cookie = await createAccount("Maybe Decision Owner", draft.speaker.email);
    const createResponse = await request("/api/public/cfp/devflow-conf-2027/submissions", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(draft),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json<{ accessPath: string; submission: { id: string } }>();
    const organizerCookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");
    await decide(created.submission.id, "maybe", organizerCookie);
    await sendDecisionLetter(created.submission.id, organizerCookie);

    expect(await listedStatus(created.submission.id, cookie)).toBe("under_review");
    const readResponse = await request(created.accessPath, { headers: { cookie } });
    expect(readResponse.status).toBe(200);
    expect(await readResponse.json()).toMatchObject({ submission: { status: "under_review" } });
  });

  it("masks a live decision on the proposal read and save until the letter is sent", async () => {
    await request("/api/health");
    const draft = anonymousDraft("cfp-decision-owner@example.com", "Live-decision proposal");
    const cookie = await createAccount("CFP Decision Owner", draft.speaker.email);
    const createResponse = await request("/api/public/cfp/devflow-conf-2027/submissions", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(draft),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json<{ accessPath: string; submission: { id: string } }>();
    const organizerCookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");
    await decide(created.submission.id, "accepted", organizerCookie);

    const readResponse = await request(created.accessPath, { headers: { cookie } });
    expect(readResponse.status).toBe(200);
    expect(await readResponse.json()).toMatchObject({ submission: { status: "under_review" } });

    const saveResponse = await request(created.accessPath, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        ...draft,
        proposal: { ...draft.proposal, title: "Live-decision proposal, edited" },
      }),
    });
    expect(saveResponse.status).toBe(200);
    expect(await saveResponse.json()).toMatchObject({ submission: { status: "under_review" } });

    await sendDecisionLetter(created.submission.id, organizerCookie);

    const decidedResponse = await request(created.accessPath, { headers: { cookie } });
    expect(decidedResponse.status).toBe(200);
    expect(await decidedResponse.json()).toMatchObject({ submission: { status: "accepted" } });
  });

  it("keeps showing the outcome the sent letter carried after a silent re-decision", async () => {
    await request("/api/health");
    const draft = anonymousDraft("resent-decision@example.com", "Re-decided proposal");
    const cookie = await createAccount("Resent Decision Owner", draft.speaker.email);
    const createResponse = await request("/api/public/cfp/devflow-conf-2027/submissions", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(draft),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json<{ accessPath: string; submission: { id: string } }>();
    const organizerCookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");
    await decide(created.submission.id, "accepted", organizerCookie);
    await sendDecisionLetter(created.submission.id, organizerCookie);

    // The letter said accepted, so every submitter surface says accepted.
    expect(await listedStatus(created.submission.id, cookie)).toBe("accepted");
    const readResponse = await request(created.accessPath, { headers: { cookie } });
    expect(await readResponse.json()).toMatchObject({ submission: { status: "accepted" } });

    // The committee silently reverses itself. No second letter can reach anyone.
    await decide(created.submission.id, "declined", organizerCookie);

    expect(await listedStatus(created.submission.id, cookie)).toBe("accepted");
    const afterResponse = await request(created.accessPath, { headers: { cookie } });
    expect(afterResponse.status).toBe(200);
    expect(await afterResponse.json()).toMatchObject({ submission: { status: "accepted" } });
    const saveResponse = await request(created.accessPath, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        ...draft,
        proposal: { ...draft.proposal, title: "Re-decided proposal, edited" },
      }),
    });
    expect(saveResponse.status).toBe(200);
    expect(await saveResponse.json()).toMatchObject({
      submission: { title: "Re-decided proposal, edited", status: "accepted" },
    });
  });

  it("does not reveal a silent acceptance after a declined letter was sent", async () => {
    await request("/api/health");
    const draft = anonymousDraft("resent-rejection@example.com", "Re-considered proposal");
    const cookie = await createAccount("Resent Rejection Owner", draft.speaker.email);
    const createResponse = await request("/api/public/cfp/devflow-conf-2027/submissions", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(draft),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json<{ accessPath: string; submission: { id: string } }>();
    const organizerCookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");
    await decide(created.submission.id, "declined", organizerCookie);
    await sendDecisionLetter(created.submission.id, organizerCookie);
    expect(await listedStatus(created.submission.id, cookie)).toBe("declined");

    await decide(created.submission.id, "accepted", organizerCookie);

    expect(await listedStatus(created.submission.id, cookie)).toBe("declined");
    const readResponse = await request(created.accessPath, { headers: { cookie } });
    expect(readResponse.status).toBe(200);
    expect(await readResponse.json()).toMatchObject({ submission: { status: "declined" } });
  });

  it("masks a live decision on an anonymous proposal read through its author key", async () => {
    await request("/api/health");
    const draft = anonymousDraft("anonymous-decision@example.com", "Anonymous decided proposal");
    const createResponse = await request("/api/public/cfp/devflow-conf-2027/submissions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json<{
      accessPath: string;
      editKey: string;
      submission: { id: string };
    }>();
    const organizerCookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");
    await decide(created.submission.id, "declined", organizerCookie);

    const response = await request(
      `${created.accessPath}?key=${encodeURIComponent(created.editKey)}`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ submission: { status: "under_review" } });
  });
});
