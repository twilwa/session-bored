// ABOUTME: Exercises Greenroom review discourse and evaluation through real Worker requests.
// ABOUTME: Verifies reviewer scope, canonical sorts, comments, scoring, and silent decisions.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
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
  const cookie = response.headers.get("set-cookie");
  expect(cookie).toBeTruthy();
  return cookie?.split(";")[0] ?? "";
}

describe("review engine", () => {
  it("shows a reviewer exactly their remit and blocks organizer-only review views", async () => {
    await request("/api/health");
    const cookie = await signIn("sbek-reviewer@example.com", "SbekTest!2027-rev");
    const headers = { cookie };

    const queueResponse = await request("/api/review/queue", { headers });
    expect(queueResponse.status).toBe(200);
    const queue = await queueResponse.json<{ items: Array<{ submissionId: string }> }>();
    expect(queue.items.map((item) => item.submissionId)).toEqual(["sub_ci_monorepo"]);

    expect((await request("/api/review/submissions/sub_ci_monorepo", { headers })).status).toBe(200);
    expect((await request("/api/review/submissions/sub_ai_verification", { headers })).status).toBe(403);
    expect(
      (await request("/api/review/events/evt_devflow_conf_2027/worklist", { headers })).status,
    ).toBe(403);
  });

  it("round-trips an attributable committee comment through the submission permalink", async () => {
    await request("/api/health");
    const reviewerCookie = await signIn("sbek-reviewer@example.com", "SbekTest!2027-rev");
    const commentResponse = await request(
      "/api/review/submissions/sub_ci_monorepo/comments",
      {
        method: "POST",
        headers: { cookie: reviewerCookie, "content-type": "application/json" },
        body: JSON.stringify({ body: "The failure story makes this proposal useful." }),
      },
    );
    expect(commentResponse.status).toBe(201);

    const reviewerDetailResponse = await request(
      "/api/review/submissions/sub_ci_monorepo",
      { headers: { cookie: reviewerCookie } },
    );
    const reviewerDetail = await reviewerDetailResponse.json<{
      comments: Array<{ body: string; author: { name: string }; createdAt: string }>;
    }>();
    expect(reviewerDetail.comments).toEqual([
      expect.objectContaining({
        body: "The failure story makes this proposal useful.",
        author: expect.objectContaining({ name: "Sam Whitfield" }),
        createdAt: expect.any(String),
      }),
    ]);

    const organizerCookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");
    const organizerDetailResponse = await request(
      "/api/review/submissions/sub_ci_monorepo",
      { headers: { cookie: organizerCookie } },
    );
    expect(organizerDetailResponse.status).toBe(200);
    const organizerDetail = await organizerDetailResponse.json<{ comments: Array<{ body: string }> }>();
    expect(organizerDetail.comments.map((comment) => comment.body)).toContain(
      "The failure story makes this proposal useful.",
    );

    expect(
      (
        await request("/api/review/submissions/sub_ai_verification/comments", {
          method: "POST",
          headers: { cookie: reviewerCookie, "content-type": "application/json" },
          body: JSON.stringify({ body: "I should not be able to post here." }),
        })
      ).status,
    ).toBe(403);
  });

  it("stores a weighted scorecard and exposes its aggregate to the organizer", async () => {
    await request("/api/health");
    const organizerCookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");
    const criterionResponse = await request(
      "/api/review/rounds/rnd_initial_review/criteria",
      {
        method: "POST",
        headers: { cookie: organizerCookie, "content-type": "application/json" },
        body: JSON.stringify({
          label: "Relevance",
          criterionType: "numeric",
          weight: 2,
          required: true,
        }),
      },
    );
    expect(criterionResponse.status).toBe(201);
    const criterion = await criterionResponse.json<{ id: string }>();

    const reviewerCookie = await signIn("sbek-reviewer@example.com", "SbekTest!2027-rev");
    const detailResponse = await request("/api/review/submissions/sub_ci_monorepo", {
      headers: { cookie: reviewerCookie },
    });
    const detail = await detailResponse.json<{
      criteria: Array<{ id: string; criterionType: string }>;
    }>();
    expect(detail.criteria.map((item) => item.criterionType)).toEqual(
      expect.arrayContaining(["numeric", "dropdown", "free_text"]),
    );

    const reviewResponse = await request(
      "/api/review/submissions/sub_ci_monorepo/reviews",
      {
        method: "POST",
        headers: { cookie: reviewerCookie, "content-type": "application/json" },
        body: JSON.stringify({
          roundId: "rnd_initial_review",
          scores: {
            crt_overall_rating: 4,
            [criterion.id]: 2,
            crt_recommendation: "Accept",
            crt_notes: "Strong evidence, but the relevance is narrower.",
          },
          comment: "Recommend discussing this in the accept group.",
        }),
      },
    );
    expect(reviewResponse.status).toBe(200);
    const savedReview = await reviewResponse.json<{ aggregateScore: number }>();
    expect(savedReview.aggregateScore).toBeCloseTo(8 / 3, 5);

    const organizerDetailResponse = await request(
      "/api/review/submissions/sub_ci_monorepo?roundId=rnd_initial_review",
      { headers: { cookie: organizerCookie } },
    );
    const organizerDetail = await organizerDetailResponse.json<{
      reviews: Array<{ comment: string; author: { name: string } }>;
    }>();
    expect(organizerDetail.reviews).toContainEqual(
      expect.objectContaining({
        comment: "Recommend discussing this in the accept group.",
        author: expect.objectContaining({ name: "Sam Whitfield" }),
      }),
    );

    const worklistResponse = await request(
      "/api/review/events/evt_devflow_conf_2027/worklist?sort=score",
      { headers: { cookie: organizerCookie } },
    );
    expect(worklistResponse.status).toBe(200);
    const worklist = await worklistResponse.json<{
      items: Array<{ submissionId: string; ratingCount: number; averageScore: number | null }>;
    }>();
    expect(worklist.items.find((item) => item.submissionId === "sub_ci_monorepo")).toEqual(
      expect.objectContaining({ ratingCount: 1, averageScore: expect.closeTo(8 / 3, 5) }),
    );
  });

  it("provisions usable reviewer credentials with all submissions as the default remit", async () => {
    await request("/api/health");
    const organizerCookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");
    const provisionResponse = await request(
      "/api/review/events/evt_devflow_conf_2027/reviewers",
      {
        method: "POST",
        headers: { cookie: organizerCookie, "content-type": "application/json" },
        body: JSON.stringify({
          name: "Alex Chen",
          email: "alex-reviewer@example.com",
          password: "ReviewTalks!2027",
        }),
      },
    );
    expect(provisionResponse.status).toBe(201);
    const provisioned = await provisionResponse.json<{
      reviewer: { id: string; email: string };
      remit: { mode: string; trackIds: string[] };
    }>();
    expect(provisioned.reviewer.email).toBe("alex-reviewer@example.com");
    expect(provisioned.remit).toEqual({
      mode: "all_submissions",
      trackIds: expect.arrayContaining([
        "trk_ai_engineering",
        "trk_platform_infra",
        "trk_developer_experience",
      ]),
    });

    const reviewerCookie = await signIn("alex-reviewer@example.com", "ReviewTalks!2027");
    const queueResponse = await request("/api/review/queue", {
      headers: { cookie: reviewerCookie },
    });
    expect(queueResponse.status).toBe(200);
    const queue = await queueResponse.json<{ items: Array<{ submissionId: string }> }>();
    expect(queue.items.map((item) => item.submissionId).sort()).toEqual([
      "sub_ai_verification",
      "sub_ci_monorepo",
      "sub_docs_retrieval",
    ]);
    expect(
      (
        await request("/api/review/events/evt_devflow_conf_2027/worklist", {
          headers: { cookie: reviewerCookie },
        })
      ).status,
    ).toBe(403);
  });

  it("combines track responsibility with explicit per-submission overrides", async () => {
    await request("/api/health");
    const organizerCookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");
    const provisionResponse = await request(
      "/api/review/events/evt_devflow_conf_2027/reviewers",
      {
        method: "POST",
        headers: { cookie: organizerCookie, "content-type": "application/json" },
        body: JSON.stringify({
          name: "Morgan Diaz",
          email: "morgan-reviewer@example.com",
          password: "ReviewTalks!2027",
          trackIds: ["trk_ai_engineering"],
        }),
      },
    );
    const provisioned = await provisionResponse.json<{ reviewer: { id: string } }>();
    expect(provisionResponse.status).toBe(201);

    const assignmentResponse = await request(
      "/api/review/rounds/rnd_initial_review/assignments",
      {
        method: "POST",
        headers: { cookie: organizerCookie, "content-type": "application/json" },
        body: JSON.stringify({
          reviewerUserId: provisioned.reviewer.id,
          submissionIds: ["sub_ci_monorepo"],
        }),
      },
    );
    expect(assignmentResponse.status).toBe(201);

    const reviewerCookie = await signIn("morgan-reviewer@example.com", "ReviewTalks!2027");
    const queueResponse = await request("/api/review/queue", {
      headers: { cookie: reviewerCookie },
    });
    const queue = await queueResponse.json<{ items: Array<{ submissionId: string }> }>();
    expect(queue.items.map((item) => item.submissionId).sort()).toEqual([
      "sub_ai_verification",
      "sub_ci_monorepo",
    ]);
  });

  it("orders the coverage worklist and decision agenda by the two canonical sorts", async () => {
    await request("/api/health");
    const organizerCookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");
    await request("/api/review/events/evt_devflow_conf_2027/reviewers", {
      method: "POST",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Taylor Brooks",
        email: "taylor-reviewer@example.com",
        password: "ReviewTalks!2027",
      }),
    });
    const reviewerCookie = await signIn("taylor-reviewer@example.com", "ReviewTalks!2027");
    const detailResponse = await request(
      "/api/review/submissions/sub_ai_verification",
      { headers: { cookie: reviewerCookie } },
    );
    const detail = await detailResponse.json<{
      round: { id: string };
      criteria: Array<{
        id: string;
        criterionType: "numeric" | "dropdown" | "free_text";
        options: string[] | null;
      }>;
    }>();
    const scores = Object.fromEntries(
      detail.criteria.map((criterion) => {
        if (criterion.criterionType === "numeric") return [criterion.id, 5];
        if (criterion.criterionType === "dropdown") return [criterion.id, criterion.options?.[0] ?? "Accept"];
        return [criterion.id, "Top of the decision agenda."];
      }),
    );
    expect(
      (
        await request("/api/review/submissions/sub_ai_verification/reviews", {
          method: "POST",
          headers: { cookie: reviewerCookie, "content-type": "application/json" },
          body: JSON.stringify({ roundId: detail.round.id, scores }),
        })
      ).status,
    ).toBe(200);

    const coverageResponse = await request(
      "/api/review/events/evt_devflow_conf_2027/worklist?sort=coverage",
      { headers: { cookie: organizerCookie } },
    );
    const coverage = await coverageResponse.json<{
      progress: { completedReadSlots: number; totalReadSlots: number; targetReviews: number };
      items: Array<{ submissionId: string; ratingCount: number; averageScore: number | null }>;
    }>();
    expect(coverage.progress).toEqual({
      completedReadSlots: expect.any(Number),
      totalReadSlots: 6,
      targetReviews: 2,
    });
    expect(coverage.items.map((item) => item.ratingCount)).toEqual(
      [...coverage.items.map((item) => item.ratingCount)].sort((left, right) => left - right),
    );

    const scoreResponse = await request(
      "/api/review/events/evt_devflow_conf_2027/worklist?sort=score",
      { headers: { cookie: organizerCookie } },
    );
    const scoreAgenda = await scoreResponse.json<typeof coverage>();
    expect(scoreAgenda.items[0]).toEqual(
      expect.objectContaining({ submissionId: "sub_ai_verification", averageScore: 5 }),
    );
    const scoresInOrder = scoreAgenda.items
      .map((item) => item.averageScore)
      .filter((score): score is number => score !== null);
    expect(scoresInOrder).toEqual([...scoresInOrder].sort((left, right) => right - left));
  });

  it("keeps round pools independent and hides speaker identity only in blind reviewer views", async () => {
    await request("/api/health");
    const organizerCookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");
    const roundResponse = await request(
      "/api/review/events/evt_devflow_conf_2027/rounds",
      {
        method: "POST",
        headers: { cookie: organizerCookie, "content-type": "application/json" },
        body: JSON.stringify({
          name: "Final Review",
          opensAt: "2027-02-16T00:00:00.000Z",
          closesAt: "2027-03-01T00:00:00.000Z",
          anonymized: true,
          status: "open",
        }),
      },
    );
    expect(roundResponse.status).toBe(201);
    const round = await roundResponse.json<{ id: string }>();
    const criterionResponse = await request(`/api/review/rounds/${round.id}/criteria`, {
      method: "POST",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({
        label: "Final score",
        criterionType: "numeric",
        weight: 1,
        required: true,
      }),
    });
    expect(criterionResponse.status).toBe(201);

    const provisionResponse = await request(
      "/api/review/events/evt_devflow_conf_2027/reviewers",
      {
        method: "POST",
        headers: { cookie: organizerCookie, "content-type": "application/json" },
        body: JSON.stringify({
          name: "Blair Singh",
          email: "blair-reviewer@example.com",
          password: "ReviewTalks!2027",
          roundIds: [round.id],
        }),
      },
    );
    expect(provisionResponse.status).toBe(201);
    const provisioned = await provisionResponse.json<{ reviewer: { id: string } }>();

    const reviewerCookie = await signIn("blair-reviewer@example.com", "ReviewTalks!2027");
    const blindResponse = await request("/api/review/submissions/sub_ci_monorepo", {
      headers: { cookie: reviewerCookie },
    });
    const blindDetail = await blindResponse.json<{
      round: { id: string; anonymized: boolean };
      participants: unknown[];
    }>();
    expect(blindDetail.round).toEqual({ id: round.id, name: "Final Review", anonymized: true });
    expect(blindDetail.participants).toEqual([]);

    const organizerDetailResponse = await request(
      `/api/review/submissions/sub_ci_monorepo?roundId=${round.id}`,
      { headers: { cookie: organizerCookie } },
    );
    const organizerDetail = await organizerDetailResponse.json<{
      participants: Array<{ name: string }>;
    }>();
    expect(organizerDetail.participants.map((participant) => participant.name)).toContain("Priya Raman");

    const configResponse = await request(
      "/api/review/events/evt_devflow_conf_2027/config",
      { headers: { cookie: organizerCookie } },
    );
    const config = await configResponse.json<{
      rounds: Array<{
        id: string;
        criteria: Array<{ label: string }>;
        reviewerPool: Array<{ id: string }>;
      }>;
    }>();
    expect(config.rounds).toHaveLength(2);
    expect(config.rounds.find((item) => item.id === round.id)).toEqual(
      expect.objectContaining({
        criteria: [expect.objectContaining({ label: "Final score" })],
        reviewerPool: [expect.objectContaining({ id: provisioned.reviewer.id })],
      }),
    );
    expect(
      config.rounds.find((item) => item.id === "rnd_initial_review")?.reviewerPool
        .map((reviewer) => reviewer.id),
    ).not.toContain(provisioned.reviewer.id);
  });

  it("changes review status without creating any communication dispatch", async () => {
    await request("/api/health");
    const organizerCookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");
    const before = await env.DB.prepare("select count(*) as count from email_dispatch")
      .first<{ count: number }>();

    const response = await request(
      "/api/review/submissions/sub_ci_monorepo/status",
      {
        method: "PATCH",
        headers: { cookie: organizerCookie, "content-type": "application/json" },
        body: JSON.stringify({ status: "maybe" }),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      expect.objectContaining({ status: "maybe", notificationSent: false }),
    );
    const after = await env.DB.prepare("select count(*) as count from email_dispatch")
      .first<{ count: number }>();
    expect(after?.count).toBe(before?.count);
  });
});
