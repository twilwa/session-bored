// ABOUTME: Exercises anonymous CFP draft, submit, resume, edit, and deadline enforcement through the Worker.
// ABOUTME: Uses real D1 persistence so downstream submission and speaker handoffs are verified end to end.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../../worker/index.ts";

async function request(path: string, init?: RequestInit): Promise<Response> {
  return worker.request(`http://example.test${path}`, init, env);
}

const draft = {
  intent: "draft",
  speaker: {
    name: "Valerie Draft",
    email: "valerie.draft@example.com",
    jobTitle: "Staff Engineer",
    organization: "Useful Systems",
  },
  proposal: {
    title: "Partial work still counts",
    answers: {},
  },
};

describe("public CFP submissions", () => {
  it("stores the deadline as the event-local end-of-day instant", async () => {
    await request("/api/health");
    const response = await request("/api/public/cfp/devflow-conf-2027");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      event: { timezone: "America/Los_Angeles" },
      form: { closeAt: "2027-05-01T06:59:59.000Z" },
    });
  });

  it("rejects submission intents outside the published draft-or-submit contract", async () => {
    await request("/api/health");
    const response = await request("/api/public/cfp/devflow-conf-2027/submissions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...draft, intent: "save" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_request" });
  });

  it("round-trips a draft, final submission, and author edit without an account", async () => {
    await request("/api/health");
    const createResponse = await request("/api/public/cfp/devflow-conf-2027/submissions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json<{
      accessPath: string;
      editKey: string;
      editUrl: string;
      submission: { id: string; status: string; speaker: { id: string; speakerId: string } };
    }>();
    expect(created.submission).toMatchObject({ status: "draft" });
    expect(created.submission.id).toMatch(/^sub_/);
    expect(created.submission.speaker.id).toMatch(/^psn_/);
    expect(created.submission.speaker.speakerId).toMatch(/^spk_/);
    expect(created.editUrl).toContain(created.submission.id);

    const resumePath = `${created.accessPath}?key=${encodeURIComponent(created.editKey)}`;
    const resumed = await request(resumePath);
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({
      submission: {
        id: created.submission.id,
        status: "draft",
        title: "Partial work still counts",
      },
    });

    const incompleteSubmit = await request(resumePath, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...draft, intent: "submit" }),
    });
    expect(incompleteSubmit.status).toBe(422);
    expect(await incompleteSubmit.json()).toMatchObject({
      error: "validation_failed",
      fields: {
        abstract: "Abstract is required.",
        key_takeaway: "Key takeaway is required.",
      },
    });

    const completeProposal = {
      ...draft,
      intent: "submit",
      proposal: {
        title: "Partial work still counts",
        abstract: "How reliable tools preserve unfinished thinking without lowering final quality.",
        track: "Developer Experience",
        format: "Talk (30 min)",
        audienceLevel: "Intermediate",
        notesForReviewers: "First-time Greenroom submission.",
        answers: { key_takeaway: "Saving work and validating completion are different jobs." },
      },
    };
    const submitResponse = await request(resumePath, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(completeProposal),
    });
    expect(submitResponse.status).toBe(200);
    expect(await submitResponse.json()).toMatchObject({
      submission: {
        id: created.submission.id,
        status: "submitted",
        track: "Developer Experience",
        format: "Talk (30 min)",
        answers: { key_takeaway: "Saving work and validating completion are different jobs." },
      },
    });

    const editResponse = await request(resumePath, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...completeProposal,
        intent: "submit",
        speaker: { ...completeProposal.speaker, organization: "More Useful Systems" },
        proposal: {
          ...completeProposal.proposal,
          abstract: `${completeProposal.proposal.abstract} Updated before close.`,
        },
      }),
    });
    expect(editResponse.status).toBe(200);
    expect(await editResponse.json()).toMatchObject({
      submission: {
        status: "submitted",
        abstract: expect.stringContaining("Updated before close."),
        speaker: { organization: "More Useful Systems" },
      },
    });
  });

  it("refuses an author edit after close with a human explanation", async () => {
    await request("/api/health");
    const createResponse = await request("/api/public/cfp/devflow-conf-2027/submissions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...draft,
        speaker: { ...draft.speaker, email: "closed.edit@example.com" },
      }),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json<{ accessPath: string; editKey: string }>();

    await env.DB.prepare("update form set close_at = ? where public_slug = ?")
      .bind(Date.now() - 1_000, "devflow-conf-2027")
      .run();
    try {
      const response = await request(
        `${created.accessPath}?key=${encodeURIComponent(created.editKey)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(draft),
        },
      );
      expect(response.status).toBe(409);
      const body = await response.json<{ error: string; message: string }>();
      expect(body.error).toBe("cfp_closed");
      expect(body.message).toContain("edits are no longer accepted");
    } finally {
      await env.DB.prepare("update form set close_at = ? where public_slug = ?")
        .bind(new Date("2027-05-01T06:59:59.000Z").getTime(), "devflow-conf-2027")
        .run();
    }
  });
});
