// ABOUTME: Exercises organizer CFP form versioning and publication through the real Worker and D1.
// ABOUTME: Proves historical answers and pinned drafts keep the exact form contract they started with.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../../worker/index.ts";

async function request(path: string, init?: RequestInit): Promise<Response> {
  return worker.request(`http://example.test${path}`, init, env);
}

async function accountCookie(email: string, password: string): Promise<string> {
  const response = await request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

async function organizerCookie(): Promise<string> {
  return accountCookie("sbek-organizer@example.com", "SbekTest!2027-org");
}

const versionTwoFields = [
  { key: "session_title", label: "Session title", fieldType: "short_text", required: true },
  { key: "abstract", label: "Abstract", fieldType: "long_text", required: true },
  { key: "track", label: "Track", fieldType: "dropdown", required: true },
  { key: "format", label: "Format", fieldType: "dropdown", required: true },
  { key: "speaker_bio", label: "Speaker bio", fieldType: "long_text", required: false },
  { key: "key_takeaway", label: "One key takeaway", fieldType: "short_text", required: true },
  {
    key: "audience_level",
    label: "Audience level",
    fieldType: "dropdown",
    required: false,
    options: ["Beginner", "Intermediate", "Advanced"],
  },
  {
    key: "workshop_prerequisites",
    label: "Workshop prerequisites",
    fieldType: "long_text",
    required: false,
    conditional: { fieldKey: "format", operator: "equals", value: "Workshop (120 min)" },
  },
] as const;

describe.sequential("organizer CFP builder", () => {
  it("forks a published form and keeps an existing submission rendering byte-identical", async () => {
    await request("/api/health");
    const submissionResponse = await request("/api/public/cfp/devflow-conf-2027/submissions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        intent: "submit",
        speaker: { name: "Versioned Speaker", email: "versioned.speaker@example.com" },
        proposal: {
          title: "Stable answers across form edits",
          abstract: "The exact words and labels must survive later organizer changes.",
          track: "Developer Experience",
          format: "Talk (30 min)",
          audienceLevel: "Advanced",
          answers: { key_takeaway: "Immutable form contracts preserve meaning." },
        },
      }),
    });
    expect(submissionResponse.status).toBe(201);
    const created = await submissionResponse.json<{ submission: { id: string } }>();
    const cookie = await organizerCookie();
    const headers = { cookie };

    const beforeResponse = await request(`/api/cfp-builder/submissions/${created.submission.id}`, { headers });
    expect(beforeResponse.status).toBe(200);
    const before = await beforeResponse.text();

    const editResponse = await request("/api/cfp-builder/forms/frm_devflow_cfp_2027", {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        welcomeCopy: "Bring the hard-won lesson behind your work.",
        confirmationCopy: "Your proposal is safely in the review queue.",
        confirmationEmailCopy: "We received {talk_title} for DevFlow Conf 2027.",
        openAt: "2026-08-01T00:00:00.000Z",
        closeAt: "2027-04-30T23:59:59.000Z",
        minimumSpeakers: 1,
        maximumSpeakers: null,
        fields: versionTwoFields,
      }),
    });
    expect(editResponse.status).toBe(200);
    expect(await editResponse.json()).toMatchObject({
      version: { formId: "frm_devflow_cfp_2027", version: 2, status: "draft" },
    });

    const afterResponse = await request(`/api/cfp-builder/submissions/${created.submission.id}`, { headers });
    expect(afterResponse.status).toBe(200);
    expect(await afterResponse.text()).toBe(before);
  });

  it("renders each submission against the exact published version it used", async () => {
    const cookie = await organizerCookie();
    const headers = { cookie };
    const publishResponse = await request("/api/cfp-builder/forms/frm_devflow_cfp_2027/publish", {
      method: "POST",
      headers,
    });
    expect(publishResponse.status).toBe(200);
    expect(await publishResponse.json()).toMatchObject({
      publicUrl: "/cfp/devflow-conf-2027",
      version: { version: 2, status: "published" },
    });

    const publicResponse = await request("/api/public/cfp/devflow-conf-2027");
    expect(publicResponse.status).toBe(200);
    const publicForm = await publicResponse.json<{
      form: { version: number };
      fields: Array<{ key: string; label: string }>;
    }>();
    expect(publicForm.form.version).toBe(2);
    expect(publicForm.fields.find((field) => field.key === "key_takeaway")?.label).toBe("One key takeaway");

    const versionOneResponse = await request("/api/cfp-builder/submissions/sub_ci_monorepo", { headers });
    expect(versionOneResponse.status).toBe(200);
    const versionOne = await versionOneResponse.json<{
      form: { version: number };
      answers: Array<{ key: string; label: string }>;
    }>();
    expect(versionOne.form.version).toBe(1);
    expect(versionOne.answers.find((answer) => answer.key === "key_takeaway")?.label).toBe("Key takeaway");

    const versionTwoSubmission = await request("/api/public/cfp/devflow-conf-2027/submissions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        intent: "submit",
        speaker: { name: "Version Two Speaker", email: "version.two@example.com" },
        proposal: {
          title: "The current contract",
          abstract: "New submissions use the newly published field snapshot.",
          track: "AI Engineering",
          format: "Talk (30 min)",
          answers: { key_takeaway: "Version two label" },
        },
      }),
    });
    expect(versionTwoSubmission.status).toBe(201);
    const created = await versionTwoSubmission.json<{ submission: { id: string } }>();
    const renderedResponse = await request(`/api/cfp-builder/submissions/${created.submission.id}`, { headers });
    const rendered = await renderedResponse.json<{
      form: { version: number };
      answers: Array<{ key: string; label: string; value: unknown }>;
    }>();
    expect(rendered.form.version).toBe(2);
    expect(rendered.answers.find((answer) => answer.key === "key_takeaway")).toMatchObject({
      label: "One key takeaway",
      value: "Version two label",
    });
  });

  it("routes the form category into the matching review track pool", async () => {
    const submissionResponse = await request("/api/public/cfp/devflow-conf-2027/submissions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        intent: "submit",
        speaker: { name: "Routed Speaker", email: "routed.speaker@example.com" },
        proposal: {
          title: "Category routing reaches the right readers",
          abstract: "The form's track category should feed the canonical reviewer track pool.",
          track: "Developer Experience",
          format: "Talk (30 min)",
          answers: { key_takeaway: "Use the shared submission-track relation." },
        },
      }),
    });
    expect(submissionResponse.status).toBe(201);
    const created = await submissionResponse.json<{ submission: { id: string } }>();
    const organizer = await organizerCookie();
    const configResponse = await request(
      "/api/review/events/evt_devflow_conf_2027/config",
      { headers: { cookie: organizer } },
    );
    expect(configResponse.status).toBe(200);
    const config = await configResponse.json<{ tracks: Array<{ id: string; name: string }> }>();
    const developerExperience = config.tracks.find((track) => track.name === "Developer Experience");
    const platform = config.tracks.find((track) => track.name === "Platform & Infra");
    expect(developerExperience).toBeDefined();
    expect(platform).toBeDefined();

    const createReviewer = async (email: string, trackId: string) => {
      const response = await request("/api/review/events/evt_devflow_conf_2027/reviewers", {
        method: "POST",
        headers: { cookie: organizer, "content-type": "application/json" },
        body: JSON.stringify({
          name: email.split("@")[0],
          email,
          password: "RoutedTest!2027",
          trackIds: [trackId],
        }),
      });
      expect(response.status).toBe(201);
    };
    await createReviewer("devex-route-reviewer@example.com", developerExperience!.id);
    await createReviewer("platform-route-reviewer@example.com", platform!.id);

    const queueIds = async (email: string) => {
      const cookie = await accountCookie(email, "RoutedTest!2027");
      const response = await request("/api/review/queue", { headers: { cookie } });
      expect(response.status).toBe(200);
      const body = await response.json<{ items: Array<{ submissionId: string }> }>();
      return body.items.map((item) => item.submissionId);
    };
    expect(await queueIds("devex-route-reviewer@example.com")).toContain(created.submission.id);
    expect(await queueIds("platform-route-reviewer@example.com")).not.toContain(created.submission.id);
  });

  it("evaluates conditional visibility before server validation and persistence", async () => {
    const cookie = await organizerCookie();
    const headers = { cookie };
    const conditionalFields = versionTwoFields.map((field) => field.key === "workshop_prerequisites"
      ? { ...field, required: true }
      : field);
    const editResponse = await request("/api/cfp-builder/forms/frm_devflow_cfp_2027", {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        welcomeCopy: "Bring the hard-won lesson behind your work.",
        confirmationCopy: "Your proposal is safely in the review queue.",
        confirmationEmailCopy: "We received {talk_title} for DevFlow Conf 2027.",
        openAt: "2026-08-01T00:00:00.000Z",
        closeAt: "2027-04-30T23:59:59.000Z",
        minimumSpeakers: 1,
        maximumSpeakers: null,
        fields: conditionalFields,
      }),
    });
    expect(editResponse.status).toBe(200);
    expect(await editResponse.json()).toMatchObject({ version: { version: 3, status: "draft" } });
    expect((await request("/api/cfp-builder/forms/frm_devflow_cfp_2027/publish", {
      method: "POST",
      headers,
    })).status).toBe(200);

    const talkResponse = await request("/api/public/cfp/devflow-conf-2027/submissions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        intent: "submit",
        speaker: { name: "Conditional Talk", email: "conditional.talk@example.com" },
        proposal: {
          title: "A talk without workshop setup",
          abstract: "Hidden required fields must not block a different session format.",
          track: "Platform & Infra",
          format: "Talk (30 min)",
          answers: {
            key_takeaway: "Visibility is server-owned.",
            workshop_prerequisites: "Stale value left by an earlier workshop selection.",
          },
        },
      }),
    });
    expect(talkResponse.status).toBe(201);
    const talk = await talkResponse.json<{
      submission: { answers: Record<string, unknown> };
    }>();
    expect(talk.submission.answers).not.toHaveProperty("workshop_prerequisites");

    const workshopResponse = await request("/api/public/cfp/devflow-conf-2027/submissions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        intent: "submit",
        speaker: { name: "Conditional Workshop", email: "conditional.workshop@example.com" },
        proposal: {
          title: "A workshop needs setup",
          abstract: "Visible conditional fields retain their required behavior.",
          track: "Developer Experience",
          format: "Workshop (120 min)",
          answers: { key_takeaway: "Bring the right environment." },
        },
      }),
    });
    expect(workshopResponse.status).toBe(422);
    expect(await workshopResponse.json()).toMatchObject({
      fields: { workshop_prerequisites: "Workshop prerequisites is required." },
    });
  });

  it("keeps an unpublished form unreachable at its public URL", async () => {
    const cookie = await organizerCookie();
    const createResponse = await request("/api/cfp-builder/events/evt_devflow_conf_2027/forms", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Partner track CFP",
        publicSlug: "devflow-partner-track",
        welcomeCopy: "Propose a partner session.",
        confirmationCopy: "Your partner proposal is saved.",
        confirmationEmailCopy: "We received {talk_title}.",
        openAt: null,
        closeAt: "2027-04-30T23:59:59.000Z",
        minimumSpeakers: 1,
        maximumSpeakers: null,
        fields: [],
      }),
    });
    expect(createResponse.status).toBe(201);
    expect(await createResponse.json()).toMatchObject({
      form: { name: "Partner track CFP", publicSlug: "devflow-partner-track" },
      version: { version: 1, status: "draft" },
      publicUrl: "/cfp/devflow-partner-track",
    });

    const publicResponse = await request("/api/public/cfp/devflow-partner-track");
    expect(publicResponse.status).toBe(404);
    expect(await publicResponse.json()).toEqual({ error: "not_found" });
  });

  it("keeps drafts pinned and offers the newer form without migrating saved work", async () => {
    const draftResponse = await request("/api/public/cfp/devflow-conf-2027/submissions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        intent: "draft",
        speaker: { name: "Pinned Draft", email: "pinned.draft@example.com" },
        proposal: { title: "Work that must not move versions", answers: {} },
      }),
    });
    expect(draftResponse.status).toBe(201);
    const draft = await draftResponse.json<{
      accessPath: string;
      editKey: string;
      submission: { id: string; formVersion: number };
    }>();
    expect(draft.submission.formVersion).toBe(3);

    const cookie = await organizerCookie();
    const headers = { cookie };
    const versionFourFields = [
      ...versionTwoFields,
      {
        key: "company_context",
        label: "Company context",
        fieldType: "short_text",
        required: true,
      },
    ];
    const editResponse = await request("/api/cfp-builder/forms/frm_devflow_cfp_2027", {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        welcomeCopy: "Version four is live for new proposals.",
        confirmationCopy: "Your proposal is safely in the review queue.",
        confirmationEmailCopy: "We received {talk_title} for DevFlow Conf 2027.",
        openAt: "2026-08-01T00:00:00.000Z",
        closeAt: "2027-04-30T23:59:59.000Z",
        minimumSpeakers: 1,
        maximumSpeakers: null,
        fields: versionFourFields,
      }),
    });
    expect(editResponse.status).toBe(200);
    expect(await editResponse.json()).toMatchObject({ version: { version: 4, status: "draft" } });
    expect((await request("/api/cfp-builder/forms/frm_devflow_cfp_2027/publish", {
      method: "POST",
      headers,
    })).status).toBe(200);

    const resumePath = `${draft.accessPath}?key=${encodeURIComponent(draft.editKey)}`;
    const resumeResponse = await request(resumePath);
    expect(resumeResponse.status).toBe(200);
    const resumed = await resumeResponse.json<{
      form: { version: number; fields: Array<{ key: string; label: string }> };
      newerVersionAvailable: { version: number; startUrl: string } | null;
      submission: { id: string; formVersion: number; title: string };
    }>();
    expect(resumed).toMatchObject({
      form: { version: 3 },
      newerVersionAvailable: { version: 4, startUrl: "/cfp/devflow-conf-2027" },
      submission: {
        id: draft.submission.id,
        formVersion: 3,
        title: "Work that must not move versions",
      },
    });
    expect(resumed.form.fields.find((field) => field.key === "key_takeaway")?.label).toBe("One key takeaway");
    expect(resumed.form.fields.some((field) => field.key === "company_context")).toBe(false);

    const submitResponse = await request(resumePath, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        intent: "submit",
        speaker: { name: "Pinned Draft", email: "pinned.draft@example.com" },
        proposal: {
          title: "Work that must not move versions",
          abstract: "This submission remains valid against version three.",
          track: "Developer Experience",
          format: "Talk (30 min)",
          answers: { key_takeaway: "Never reinterpret partial work." },
        },
      }),
    });
    expect(submitResponse.status).toBe(200);
    expect(await submitResponse.json()).toMatchObject({
      submission: { id: draft.submission.id, formVersion: 3, status: "submitted" },
    });
  });

  it("lists and browses versions, then closes the public CFP without breaking the page", async () => {
    const cookie = await organizerCookie();
    const headers = { cookie };
    const listResponse = await request("/api/cfp-builder/events/evt_devflow_conf_2027/forms", { headers });
    expect(listResponse.status).toBe(200);
    const list = await listResponse.json<{
      items: Array<{ id: string; publicSlug: string; version: number; status: string }>;
    }>();
    expect(list.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "frm_devflow_cfp_2027",
        publicSlug: "devflow-conf-2027",
        version: 4,
        status: "published",
      }),
      expect.objectContaining({ publicSlug: "devflow-partner-track", version: 1, status: "draft" }),
    ]));

    const formResponse = await request("/api/cfp-builder/forms/frm_devflow_cfp_2027", { headers });
    expect(formResponse.status).toBe(200);
    const form = await formResponse.json<{
      publicUrl: string;
      selectedVersion: { version: number; status: string };
      versions: Array<{ version: number; status: string }>;
      fields: Array<{ key: string; sortOrder: number; conditional: null | { fieldKey: string; value: string } }>;
    }>();
    expect(form.publicUrl).toBe("/cfp/devflow-conf-2027");
    expect(form.selectedVersion).toMatchObject({ version: 4, status: "published" });
    expect(form.versions.map((version) => version.version)).toEqual([4, 3, 2, 1]);
    expect(form.fields.map((field) => field.sortOrder)).toEqual(form.fields.map((_, index) => index));
    expect(form.fields.find((field) => field.key === "workshop_prerequisites")?.conditional).toEqual({
      fieldKey: "format",
      operator: "equals",
      value: "Workshop (120 min)",
    });

    const closeResponse = await request("/api/cfp-builder/forms/frm_devflow_cfp_2027/close", {
      method: "POST",
      headers,
    });
    expect(closeResponse.status).toBe(200);
    expect(await closeResponse.json()).toMatchObject({ version: { version: 4, status: "closed" } });

    const historicalResponse = await request("/api/cfp-builder/forms/frm_devflow_cfp_2027?version=3", { headers });
    expect(historicalResponse.status).toBe(200);
    expect(await historicalResponse.json()).toMatchObject({
      selectedVersion: { version: 3, status: "published" },
    });

    const publicResponse = await request("/api/public/cfp/devflow-conf-2027");
    expect(publicResponse.status).toBe(200);
    expect(await publicResponse.json()).toMatchObject({ form: { version: 4, status: "closed" } });
    const blockedSubmission = await request("/api/public/cfp/devflow-conf-2027/submissions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        intent: "draft",
        speaker: { name: "Too Late", email: "too.late@example.com" },
        proposal: { title: "Closed means closed" },
      }),
    });
    expect(blockedSubmission.status).toBe(409);
    expect(await blockedSubmission.json()).toMatchObject({ error: "cfp_closed" });
  });
});
