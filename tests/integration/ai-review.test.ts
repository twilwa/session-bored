// ABOUTME: Exercises optional AI review assistance through authenticated Worker requests and real D1.
// ABOUTME: Protects organizer enablement, reviewer scope, blind identity, and non-deciding behavior.
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { Role } from "../../db/schema.ts";
import type { ReviewAssistant, ReviewAssistanceInput } from "../../worker/ai/review-assistance.ts";
import type { AuthSession } from "../../worker/auth.ts";
import worker from "../../worker/index.ts";
import { createAIReviewRoutes } from "../../worker/routes/ai-review.ts";

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
    role: Role | null;
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
    context.set("role", "reviewer");
    await next();
  });
  app.route("/api", createAIReviewRoutes(() => assistant));
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

    const generatedInputs: ReviewAssistanceInput[] = [];
    const assistant: ReviewAssistant = {
      async generate(input) {
        generatedInputs.push(input);
        return {
          summary: JSON.stringify(input.proposal),
          suggestedScores: { [criterion.id]: 4 },
          reasoning: { [criterion.id]: "The proposal supplies concrete evidence." },
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
      suggestedScores: {},
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
