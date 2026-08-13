// ABOUTME: Exercises optional AI review assistance through authenticated Worker requests and real D1.
// ABOUTME: Protects organizer enablement, reviewer scope, blind identity, and non-deciding behavior.
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { Role } from "../../db/schema.ts";
import type { ReviewAssistant, ReviewAssistanceInput } from "../../worker/ai/review-assistance.ts";
import type { AuthSession } from "../../worker/auth.ts";
import { reviewErrorMessage } from "../../client/pages/review/reviewClient.tsx";
import worker from "../../worker/index.ts";
import { createAIReviewRoutes } from "../../worker/routes/ai-review.ts";
import reviewRoutes from "../../worker/routes/review.ts";

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

type TestEnvironment = {
  Bindings: CloudflareBindings;
  Variables: {
    authSession: AuthSession["session"] | null;
    authUser: AuthSession["user"] | null;
    roles: Role[] | null;
  };
};

function createInjectedApp(
  reviewer: { id: string; name: string; email: string },
  assistant: ReviewAssistant,
): Hono<TestEnvironment> {
  const app = new Hono<TestEnvironment>();
  const authUser = {
    ...reviewer,
    role: "reviewer",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as AuthSession["user"];
  app.use("*", async (context, next) => {
    context.set("authSession", null);
    context.set("authUser", authUser);
    // The whole contract: a caller carries its grant union and nothing else.
    context.set("roles", ["reviewer"]);
    await next();
  });
  app.route("/api", createAIReviewRoutes(() => assistant));
  app.route("/api", reviewRoutes);
  return app;
}

describe("AI-assisted review", () => {
  it("is off by default for an event and unavailable to its reviewers", async () => {
    await request("/api/health");
    const organizerCookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");
    const configResponse = await request(
      "/api/review/events/evt_devflow_conf_2027/ai-assistance",
      { headers: { cookie: organizerCookie } },
    );
    expect(configResponse.status).toBe(200);
    await expect(configResponse.json()).resolves.toEqual({ enabled: false });

    const reviewerCookie = await signIn("sbek-reviewer@example.com", "SbekTest!2027-rev");
    const assistanceResponse = await request(
      "/api/review/submissions/sub_ci_monorepo/ai-assistance",
      {
        method: "POST",
        headers: { cookie: reviewerCookie, "content-type": "application/json" },
        body: JSON.stringify({ roundId: "rnd_initial_review" }),
      },
    );
    expect(assistanceResponse.status).toBe(200);
    await expect(assistanceResponse.json()).resolves.toEqual({ status: "disabled" });
  });

  it("lets only an organizer enable assistance for an event", async () => {
    await request("/api/health");
    const path = "/api/review/events/evt_devflow_conf_2027/ai-assistance";
    const init = {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    };
    expect((await request(path, init)).status).toBe(401);

    const reviewerCookie = await signIn("sbek-reviewer@example.com", "SbekTest!2027-rev");
    expect((await request(path, {
      ...init,
      headers: { ...init.headers, cookie: reviewerCookie },
    })).status).toBe(403);

    const speakerCookie = await signIn("sbek-speaker@example.com", "SbekTest!2027-spk");
    expect((await request(path, {
      ...init,
      headers: { ...init.headers, cookie: speakerCookie },
    })).status).toBe(403);

    const organizerCookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");
    const enableResponse = await request(path, {
      ...init,
      headers: { ...init.headers, cookie: organizerCookie },
    });
    expect(enableResponse.status).toBe(200);
    await expect(enableResponse.json()).resolves.toEqual({ enabled: true });

    const configResponse = await request(path, { headers: { cookie: organizerCookie } });
    await expect(configResponse.json()).resolves.toEqual({ enabled: true });
  });

  it("degrades quietly when the API key is absent without changing human work", async () => {
    await request("/api/health");
    const organizerCookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");
    await request("/api/review/events/evt_devflow_conf_2027/ai-assistance", {
      method: "PATCH",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    const reviewerCookie = await signIn("sbek-reviewer@example.com", "SbekTest!2027-rev");
    const detailPath = "/api/review/submissions/sub_ci_monorepo?roundId=rnd_initial_review";
    const before = await request(detailPath, { headers: { cookie: reviewerCookie } });
    const beforeDetail = await before.json<{ status: string; reviews: unknown[]; comments: unknown[] }>();

    const assistanceResponse = await request(
      "/api/review/submissions/sub_ci_monorepo/ai-assistance",
      {
        method: "POST",
        headers: { cookie: reviewerCookie, "content-type": "application/json" },
        body: JSON.stringify({ roundId: "rnd_initial_review" }),
      },
    );
    expect(assistanceResponse.status).toBe(200);
    await expect(assistanceResponse.json()).resolves.toEqual({ status: "unavailable" });

    const after = await request(detailPath, { headers: { cookie: reviewerCookie } });
    const afterDetail = await after.json<{ status: string; reviews: unknown[]; comments: unknown[] }>();
    expect(afterDetail).toEqual(beforeDetail);
  });

  it("degrades quietly when the model provider fails", async () => {
    await request("/api/health");
    const organizerCookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");
    await request("/api/review/events/evt_devflow_conf_2027/ai-assistance", {
      method: "PATCH",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    const reviewer = await env.DB.prepare(
      "select id, name, email from user where email = ?",
    ).bind("sbek-reviewer@example.com").first<{ id: string; name: string; email: string }>();
    expect(reviewer).not.toBeNull();
    const assistant: ReviewAssistant = {
      async generate() {
        throw new Error("rate limited");
      },
    };
    const injectedApp = createInjectedApp(reviewer!, assistant);
    const response = await injectedApp.request(
      "http://example.test/api/review/submissions/sub_ci_monorepo/ai-assistance",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roundId: "rnd_initial_review" }),
      },
      env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "unavailable" });
  });

  it("regenerates summaries and score suggestions after an author edits proposal content", async () => {
    await request("/api/health");
    const organizerCookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");
    await request("/api/review/events/evt_devflow_conf_2027/ai-assistance", {
      method: "PATCH",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    const proposal = {
      intent: "submit",
      speaker: {
        name: "Cache Revision Speaker",
        email: "cache-revision@example.com",
        jobTitle: "Staff Engineer",
        organization: "Revision Systems",
      },
      proposal: {
        title: "Caching the proposal reviewers actually read",
        abstract: "The original proposal explains why review caches need precise keys.",
        track: "Developer Experience",
        format: "Talk (30 min)",
        audienceLevel: "Intermediate",
        notesForReviewers: "Focus on the cache contract.",
        answers: { key_takeaway: "Cache identity must follow content identity." },
      },
    };
    const createResponse = await request("/api/public/cfp/devflow-conf-2027/submissions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(proposal),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json<{
      accessPath: string;
      editKey: string;
      submission: { id: string };
    }>();
    const provisionResponse = await request(
      "/api/review/events/evt_devflow_conf_2027/reviewers",
      {
        method: "POST",
        headers: { cookie: organizerCookie, "content-type": "application/json" },
        body: JSON.stringify({
          name: "Cache Revision Reviewer",
          email: "cache-revision-reviewer@example.com",
          password: "CacheReview!2027",
        }),
      },
    );
    expect(provisionResponse.status).toBe(201);
    const provisioned = await provisionResponse.json<{
      reviewer: { id: string; name: string; email: string };
    }>();
    const generatedAbstracts: Array<string | null> = [];
    const assistant: ReviewAssistant = {
      async generate(input) {
        generatedAbstracts.push(input.proposal.abstract);
        return {
          summary: input.proposal.abstract ?? "No abstract supplied.",
          suggestedScores: {
            crt_overall_rating: generatedAbstracts.length === 1 ? 4 : 3,
            crt_recommendation: "Maybe",
            crt_notes: "The proposal states a concrete cache contract.",
          },
          reasoning: {
            crt_overall_rating: "The proposal states a concrete cache contract.",
            crt_recommendation: "The reviewer should confirm the event fit.",
            crt_notes: "The cache behavior is supported by the abstract.",
          },
          model: "deterministic-test-model",
        };
      },
    };
    const injectedApp = createInjectedApp(provisioned.reviewer, assistant);
    const assistanceUrl = `http://example.test/api/review/submissions/${created.submission.id}/ai-assistance`;
    const assistanceInit = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roundId: "rnd_initial_review" }),
    };

    const first = await injectedApp.request(assistanceUrl, assistanceInit, env);
    await expect(first.json()).resolves.toEqual(expect.objectContaining({
      status: "ready",
      summary: proposal.proposal.abstract,
      suggestedScores: {
        crt_overall_rating: 4,
        crt_recommendation: "Maybe",
        crt_notes: "The proposal states a concrete cache contract.",
      },
      cached: false,
    }));
    const cached = await injectedApp.request(assistanceUrl, assistanceInit, env);
    await expect(cached.json()).resolves.toEqual(expect.objectContaining({ cached: true }));
    expect(generatedAbstracts).toEqual([proposal.proposal.abstract]);

    const revisedAbstract = `${proposal.proposal.abstract} The revision adds author-edit coverage.`;
    const editResponse = await request(
      `${created.accessPath}?key=${encodeURIComponent(created.editKey)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...proposal,
          intent: "submit",
          proposal: { ...proposal.proposal, abstract: revisedAbstract },
        }),
      },
    );
    expect(editResponse.status).toBe(200);

    const revised = await injectedApp.request(assistanceUrl, assistanceInit, env);
    await expect(revised.json()).resolves.toEqual(expect.objectContaining({
      status: "ready",
      summary: revisedAbstract,
      suggestedScores: {
        crt_overall_rating: 3,
        crt_recommendation: "Maybe",
        crt_notes: "The proposal states a concrete cache contract.",
      },
      cached: false,
    }));
    expect(generatedAbstracts).toEqual([proposal.proposal.abstract, revisedAbstract]);
  });

  it("does not expose incomplete generated or cached scorecard suggestions", async () => {
    await request("/api/health");
    const organizerCookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");
    await request("/api/review/events/evt_devflow_conf_2027/ai-assistance", {
      method: "PATCH",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    const provisionResponse = await request(
      "/api/review/events/evt_devflow_conf_2027/reviewers",
      {
        method: "POST",
        headers: { cookie: organizerCookie, "content-type": "application/json" },
        body: JSON.stringify({
          name: "Complete Suggestion Reviewer",
          email: "complete-suggestion-reviewer@example.com",
          password: "CompleteReview!2027",
        }),
      },
    );
    expect(provisionResponse.status).toBe(201);
    const provisioned = await provisionResponse.json<{
      reviewer: { id: string; name: string; email: string };
    }>();
    let generationCount = 0;
    const assistant: ReviewAssistant = {
      async generate() {
        generationCount += 1;
        return {
          summary: "A concise summary for a human reviewer.",
          suggestedScores: generationCount === 1
            ? { crt_recommendation: "Maybe" }
            : {
              crt_overall_rating: 4,
              crt_recommendation: "Maybe",
              crt_notes: "The proposal supplies concrete evidence.",
            },
          reasoning: {},
          model: "deterministic-test-model",
        };
      },
    };
    const injectedApp = createInjectedApp(provisioned.reviewer, assistant);
    const assistanceUrl =
      "http://example.test/api/review/submissions/sub_ai_verification/ai-assistance";
    const assistanceInit = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roundId: "rnd_initial_review" }),
    };

    const incompleteResponse = await injectedApp.request(assistanceUrl, assistanceInit, env);
    await expect(incompleteResponse.json()).resolves.toEqual({ status: "unavailable" });

    const completeResponse = await injectedApp.request(assistanceUrl, assistanceInit, env);
    const complete = await completeResponse.json<{
      status: string;
      suggestionId: string;
      suggestedScores: Record<string, string | number>;
      cached: boolean;
    }>();
    expect(complete).toEqual(expect.objectContaining({
      status: "ready",
      suggestedScores: {
        crt_overall_rating: 4,
        crt_recommendation: "Maybe",
        crt_notes: "The proposal supplies concrete evidence.",
      },
      cached: false,
    }));
    expect(generationCount).toBe(2);

    await env.DB.prepare("update ai_score_suggestion set scores = ? where id = ?")
      .bind(JSON.stringify({ crt_recommendation: "Maybe" }), complete.suggestionId)
      .run();
    const repairedResponse = await injectedApp.request(assistanceUrl, assistanceInit, env);
    await expect(repairedResponse.json()).resolves.toEqual(expect.objectContaining({
      status: "ready",
      suggestionId: complete.suggestionId,
      suggestedScores: complete.suggestedScores,
      cached: false,
    }));
    const cachedResponse = await injectedApp.request(assistanceUrl, assistanceInit, env);
    await expect(cachedResponse.json()).resolves.toEqual(expect.objectContaining({
      status: "ready",
      suggestedScores: complete.suggestedScores,
      cached: true,
    }));
    expect(generationCount).toBe(3);
  });

  it("requires a human edit or confirmation for every AI-suggested score", async () => {
    await request("/api/health");
    const organizerCookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");
    await request("/api/review/events/evt_devflow_conf_2027/ai-assistance", {
      method: "PATCH",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    const reviewer = await env.DB.prepare(
      "select id, name, email from user where email = ?",
    ).bind("sbek-reviewer@example.com").first<{ id: string; name: string; email: string }>();
    expect(reviewer).not.toBeNull();
    const assistant: ReviewAssistant = {
      async generate() {
        return {
          summary: "A concise summary for a human reviewer.",
          suggestedScores: {
            crt_overall_rating: 4,
            crt_recommendation: "Accept",
            crt_notes: "The proposal supplies concrete evidence.",
          },
          reasoning: {},
          model: "deterministic-test-model",
        };
      },
    };
    const injectedApp = createInjectedApp(reviewer!, assistant);
    const assistanceResponse = await injectedApp.request(
      "http://example.test/api/review/submissions/sub_ci_monorepo/ai-assistance",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roundId: "rnd_initial_review" }),
      },
      env,
    );
    const assistance = await assistanceResponse.json<{
      status: string;
      suggestionId: string;
      suggestedScores: Record<string, string | number>;
    }>();
    expect(assistance.status).toBe("ready");
    expect(assistance.suggestionId).toMatch(/^aig_/);
    expect(assistance.suggestedScores).toEqual({
      crt_overall_rating: 4,
      crt_recommendation: "Accept",
      crt_notes: "The proposal supplies concrete evidence.",
    });
    const reviewUrl = "http://example.test/api/review/submissions/sub_ci_monorepo/reviews";
    const unchangedResponse = await injectedApp.request(
      reviewUrl,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          roundId: "rnd_initial_review",
          scores: assistance.suggestedScores,
          aiSuggestionId: assistance.suggestionId,
        }),
      },
      env,
    );
    expect(unchangedResponse.status).toBe(422);
    const unchangedPayload = await unchangedResponse.json<{ error: string }>();
    expect(unchangedPayload).toEqual({
      error: "human_score_choice_required",
    });
    expect(reviewErrorMessage(unchangedPayload.error, unchangedResponse.status)).toBe(
      "Change or confirm each AI-suggested score before saving.",
    );

    const confirmedResponse = await injectedApp.request(
      reviewUrl,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          roundId: "rnd_initial_review",
          scores: assistance.suggestedScores,
          aiSuggestionId: assistance.suggestionId,
          confirmedAiScoreCriterionIds: Object.keys(assistance.suggestedScores),
        }),
      },
      env,
    );
    expect(confirmedResponse.status).toBe(200);
    await expect(confirmedResponse.json()).resolves.toEqual(expect.objectContaining({
      scores: assistance.suggestedScores,
    }));

    const editedScores = { ...assistance.suggestedScores, crt_overall_rating: 3 };
    const editedResponse = await injectedApp.request(
      reviewUrl,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          roundId: "rnd_initial_review",
          scores: editedScores,
          aiSuggestionId: assistance.suggestionId,
          confirmedAiScoreCriterionIds: Object.keys(assistance.suggestedScores)
            .filter((criterionId) => criterionId !== "crt_overall_rating"),
        }),
      },
      env,
    );
    expect(editedResponse.status).toBe(200);
    await expect(editedResponse.json()).resolves.toEqual(expect.objectContaining({
      scores: editedScores,
    }));
  });

  it("returns cached blind-safe suggestions without recording a human decision", async () => {
    await request("/api/health");
    const organizerCookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");
    await request("/api/review/events/evt_devflow_conf_2027/ai-assistance", {
      method: "PATCH",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    const roundResponse = await request("/api/review/events/evt_devflow_conf_2027/rounds", {
      method: "POST",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Blind second pass", anonymized: true, status: "open" }),
    });
    expect(roundResponse.status).toBe(201);
    const round = await roundResponse.json<{ id: string }>();
    const criterionResponse = await request(`/api/review/rounds/${round.id}/criteria`, {
      method: "POST",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({
        label: "Evidence quality",
        criterionType: "numeric",
        weight: 2,
        required: true,
      }),
    });
    const criterion = await criterionResponse.json<{ id: string }>();
    const provisionResponse = await request(
      "/api/review/events/evt_devflow_conf_2027/reviewers",
      {
        method: "POST",
        headers: { cookie: organizerCookie, "content-type": "application/json" },
        body: JSON.stringify({
          name: "Blind AI Reviewer",
          email: "blind-ai-reviewer@example.com",
          password: "BlindReview!2027",
          trackIds: ["trk_platform_infra"],
          roundIds: [round.id],
        }),
      },
    );
    expect(provisionResponse.status).toBe(201);
    const provisioned = await provisionResponse.json<{
      reviewer: { id: string; name: string; email: string };
    }>();
    await env.DB.prepare(
      "update submission set title = ?, abstract = ?, notes_for_reviewers = ? where id = ?",
    ).bind(
      "Priya Raman's delivery lessons",
      "Priya Raman of Latticework Systems shares a Principal Engineer's field notes.",
      "Contact sbek-speaker@example.com with questions.",
      "sub_ci_monorepo",
    ).run();
    await env.DB.prepare(
      "insert into submission_value (id, submission_id, field_id, value, created_at, updated_at) values (?, ?, ?, ?, ?, ?) on conflict(submission_id, field_id) do update set value = excluded.value",
    ).bind(
      "val_blind_ai_visible",
      "sub_ci_monorepo",
      "fld_key_takeaway",
      JSON.stringify("Priya Raman demonstrates a repeatable delivery method."),
      Date.now(),
      Date.now(),
    ).run();
    await env.DB.prepare(
      "insert into submission_value (id, submission_id, field_id, value, created_at, updated_at) values (?, ?, ?, ?, ?, ?) on conflict(submission_id, field_id) do update set value = excluded.value",
    ).bind(
      "val_blind_ai_hidden",
      "sub_ci_monorepo",
      "fld_workshop_prerequisites",
      JSON.stringify("secret-blind-field from Latticework Systems"),
      Date.now(),
      Date.now(),
    ).run();
    await env.DB.prepare(
      "update form_version_field set visible_in_blind_review = 1 where form_version_id = ? and stable_field_id = ?",
    ).bind("frm_devflow_cfp_2027:v1", "fld_key_takeaway").run();

    const generatedInputs: ReviewAssistanceInput[] = [];
    const assistant: ReviewAssistant = {
      async generate(input) {
        generatedInputs.push(input);
        const generatedCriterion = input.criteria[0];
        if (generatedCriterion === undefined) {
          throw new Error("The blind review round needs a criterion");
        }
        return {
          summary: JSON.stringify(input.proposal),
          suggestedScores: { [generatedCriterion.id]: 4 },
          reasoning: { [generatedCriterion.id]: "The proposal supplies concrete evidence." },
          model: "deterministic-test-model",
        };
      },
    };
    const injectedApp = createInjectedApp(provisioned.reviewer, assistant);

    const reviewerCookie = await signIn("blind-ai-reviewer@example.com", "BlindReview!2027");
    const detailPath = `/api/review/submissions/sub_ci_monorepo?roundId=${round.id}`;
    const beforeDetail = await request(detailPath, { headers: { cookie: reviewerCookie } })
      .then((response) => response.json<{ status: string; reviews: unknown[] }>());
    const emailCountBefore = await env.DB.prepare(
      "select count(*) as count from email_dispatch",
    ).first<{ count: number }>();
    const assistancePath = "/api/review/submissions/sub_ci_monorepo/ai-assistance";
    const assistanceInit = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roundId: round.id }),
    };
    const firstResponse = await injectedApp.request(
      `http://example.test${assistancePath}`,
      assistanceInit,
      env,
    );
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json<{
      status: string;
      attribution: string;
      summary: string;
      suggestedScores: Record<string, string | number>;
      cached: boolean;
    }>();
    expect(first).toEqual(expect.objectContaining({
      status: "ready",
      attribution: "AI-generated reading aid — review and edit before saving",
      suggestedScores: { [criterion.id]: 4 },
      cached: false,
    }));
    expect(first.summary.toLowerCase()).not.toContain("priya");
    expect(first.summary.toLowerCase()).not.toContain("latticework");
    expect(JSON.stringify(generatedInputs).toLowerCase()).not.toContain("priya");
    expect(JSON.stringify(generatedInputs).toLowerCase()).not.toContain("latticework");
    expect(JSON.stringify(generatedInputs).toLowerCase()).not.toContain("secret-blind-field");
    expect(generatedInputs[0]?.proposal.answers).toEqual([{
      key: "key_takeaway",
      label: "Key takeaway",
      value: "[identity hidden] demonstrates a repeatable delivery method.",
    }]);

    const secondResponse = await injectedApp.request(
      `http://example.test${assistancePath}`,
      assistanceInit,
      env,
    );
    await expect(secondResponse.json()).resolves.toEqual(expect.objectContaining({
      status: "ready",
      cached: true,
    }));
    expect(generatedInputs).toHaveLength(1);

    const laterRoundResponse = await request("/api/review/events/evt_devflow_conf_2027/rounds", {
      method: "POST",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Blind final pass", anonymized: true, status: "open" }),
    });
    const laterRound = await laterRoundResponse.json<{ id: string }>();
    const laterCriterionResponse = await request(`/api/review/rounds/${laterRound.id}/criteria`, {
      method: "POST",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({
        label: "Program fit",
        criterionType: "numeric",
        weight: 1,
        required: true,
      }),
    });
    const laterCriterion = await laterCriterionResponse.json<{ id: string }>();
    const now = Date.now();
    await env.DB.prepare(
      "insert into reviewer_round_pool (id, round_id, reviewer_user_id, created_at, updated_at) values (?, ?, ?, ?, ?)",
    ).bind(
      `rpool_${crypto.randomUUID().replaceAll("-", "")}`,
      laterRound.id,
      provisioned.reviewer.id,
      now,
      now,
    ).run();
    const laterResponse = await injectedApp.request(
      `http://example.test${assistancePath}`,
      {
        ...assistanceInit,
        body: JSON.stringify({ roundId: laterRound.id }),
      },
      env,
    );
    await expect(laterResponse.json()).resolves.toEqual(expect.objectContaining({
      status: "ready",
      suggestedScores: { [laterCriterion.id]: 4 },
      cached: false,
    }));
    expect(generatedInputs).toHaveLength(2);
    expect(generatedInputs[1]?.existingSummary).toBe(first.summary);
    expect(generatedInputs[1]?.criteria.map((item) => item.id)).toEqual([laterCriterion.id]);

    const afterDetail = await request(detailPath, { headers: { cookie: reviewerCookie } })
      .then((response) => response.json<{ status: string; reviews: unknown[] }>());
    expect(afterDetail.status).toBe(beforeDetail.status);
    expect(afterDetail.reviews).toEqual(beforeDetail.reviews);
    const emailCountAfter = await env.DB.prepare(
      "select count(*) as count from email_dispatch",
    ).first<{ count: number }>();
    expect(emailCountAfter).toEqual(emailCountBefore);
  });
});
