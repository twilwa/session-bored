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

  it("shows the complete proposal with labels from its pinned form version", async () => {
    await request("/api/health");
    const submissionId = "sub_ci_monorepo";
    await env.DB.prepare(
      "insert into submission_value (id, submission_id, field_id, value, created_at, updated_at) values (?, ?, ?, ?, ?, ?) on conflict(submission_id, field_id) do update set value = excluded.value",
    ).bind(
      "val_pinned_label",
      submissionId,
      "fld_key_takeaway",
      JSON.stringify("Historical questions keep their original meaning."),
      Date.now(),
      Date.now(),
    ).run();
    await env.DB.prepare("update form_field set label = ? where id = ?")
      .bind("Current draft takeaway prompt", "fld_key_takeaway")
      .run();
    await env.DB.prepare(
      "insert into submission_track (id, submission_id, track_id, created_at, updated_at) values (?, ?, ?, ?, ?)",
    ).bind(
      "strk_second_review_track",
      submissionId,
      "trk_developer_experience",
      Date.now(),
      Date.now(),
    ).run();

    const reviewerCookie = await signIn("sbek-reviewer@example.com", "SbekTest!2027-rev");
    const detailResponse = await request(
      `/api/review/submissions/${submissionId}?roundId=rnd_initial_review`,
      { headers: { cookie: reviewerCookie } },
    );
    expect(detailResponse.status).toBe(200);
    const detail = await detailResponse.json<{
      audienceLevel: string | null;
      format: { id: string; name: string } | null;
      tracks: Array<{ name: string }>;
      answers: Array<{ key: string; label: string; value: unknown }>;
    }>();
    expect(detail.audienceLevel).toBe("Intermediate");
    expect(detail.format).toEqual(expect.objectContaining({ name: "Talk (30 min)" }));
    expect(detail.tracks.map((track) => track.name)).toEqual([
      "Platform & Infra",
      "Developer Experience",
    ]);
    expect(detail.answers).toEqual([
      {
        key: "key_takeaway",
        label: "Key takeaway",
        value: "Historical questions keep their original meaning.",
      },
    ]);
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

  it("lets organizers maintain criteria without rewriting historical scores", async () => {
    await request("/api/health");
    const organizerCookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");
    const criterionResponse = await request(
      "/api/review/rounds/rnd_initial_review/criteria",
      {
        method: "POST",
        headers: { cookie: organizerCookie, "content-type": "application/json" },
        body: JSON.stringify({
          label: "Technical depth",
          criterionType: "numeric",
          weight: 1,
          required: true,
        }),
      },
    );
    expect(criterionResponse.status).toBe(201);
    const criterion = await criterionResponse.json<{ id: string }>();
    const criterionPath = `/api/review/criteria/${criterion.id}`;

    const reviewerCookie = await signIn("sbek-reviewer@example.com", "SbekTest!2027-rev");
    expect((await request(criterionPath, {
      method: "PATCH",
      headers: { cookie: reviewerCookie, "content-type": "application/json" },
      body: JSON.stringify({ label: "Reviewer cannot rename this" }),
    })).status).toBe(403);
    expect((await request(criterionPath, { method: "DELETE" })).status).toBe(401);

    const detailResponse = await request("/api/review/submissions/sub_ci_monorepo", {
      headers: { cookie: reviewerCookie },
    });
    const detail = await detailResponse.json<{
      criteria: Array<{
        id: string;
        criterionType: "numeric" | "dropdown" | "free_text";
        options: string[] | null;
        weight: number | null;
        required: boolean;
      }>;
    }>();
    const scores: Record<string, string | number> = {};
    for (const item of detail.criteria) {
      if (item.id === criterion.id) scores[item.id] = 2;
      else if (item.criterionType === "numeric") scores[item.id] = 4;
      else if (item.criterionType === "dropdown") scores[item.id] = item.options?.[0] ?? "Accept";
      else if (item.required) scores[item.id] = "Reviewed by a human.";
    }
    const otherNumericWeight = detail.criteria
      .filter((item) => item.id !== criterion.id && item.criterionType === "numeric")
      .reduce((total, item) => total + (item.weight ?? 1), 0);
    const initialAggregate = (4 * otherNumericWeight + 2) / (otherNumericWeight + 1);
    const updatedAggregate = (4 * otherNumericWeight + 6) / (otherNumericWeight + 3);
    const reviewResponse = await request(
      "/api/review/submissions/sub_ci_monorepo/reviews",
      {
        method: "POST",
        headers: { cookie: reviewerCookie, "content-type": "application/json" },
        body: JSON.stringify({ roundId: "rnd_initial_review", scores }),
      },
    );
    expect(reviewResponse.status).toBe(200);
    const savedReview = await reviewResponse.json<{
      scores: Record<string, string | number>;
      aggregateScore: number;
    }>();
    expect(savedReview.scores).toEqual(scores);
    expect(savedReview.aggregateScore).toBeCloseTo(initialAggregate, 5);

    const updateResponse = await request(criterionPath, {
      method: "PATCH",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({ label: "Technical evidence", weight: 3 }),
    });
    expect(updateResponse.status).toBe(200);
    await expect(updateResponse.json()).resolves.toEqual(expect.objectContaining({
      criterion: expect.objectContaining({
        id: criterion.id,
        label: "Technical evidence",
        weight: 3,
      }),
      recomputedReviews: 1,
    }));

    const typeChangeResponse = await request(criterionPath, {
      method: "PATCH",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({ criterionType: "free_text" }),
    });
    expect(typeChangeResponse.status).toBe(409);
    await expect(typeChangeResponse.json()).resolves.toEqual({ error: "criterion_type_locked" });

    const updatedDetailResponse = await request(
      "/api/review/submissions/sub_ci_monorepo?roundId=rnd_initial_review",
      { headers: { cookie: reviewerCookie } },
    );
    const updatedDetail = await updatedDetailResponse.json<{
      reviews: Array<{ scores: Record<string, string | number>; aggregateScore: number }>;
    }>();
    expect(updatedDetail.reviews[0]?.scores).toEqual(scores);
    expect(updatedDetail.reviews[0]?.aggregateScore).toBeCloseTo(updatedAggregate, 5);

    const deleteResponse = await request(criterionPath, {
      method: "DELETE",
      headers: { cookie: organizerCookie },
    });
    expect(deleteResponse.status).toBe(200);
    await expect(deleteResponse.json()).resolves.toEqual({
      removedCriterionId: criterion.id,
      recomputedReviews: 1,
    });

    const removedDetailResponse = await request(
      "/api/review/submissions/sub_ci_monorepo?roundId=rnd_initial_review",
      { headers: { cookie: reviewerCookie } },
    );
    const removedDetail = await removedDetailResponse.json<{
      criteria: Array<{ id: string }>;
      reviews: Array<{ scores: Record<string, string | number>; aggregateScore: number }>;
    }>();
    expect(removedDetail.criteria.map((item) => item.id)).not.toContain(criterion.id);
    expect(removedDetail.reviews[0]?.scores).toEqual(scores);
    expect(removedDetail.reviews[0]?.aggregateScore).toBe(4);

    const revisedScores: Record<string, string | number> = {
      ...scores,
      crt_overall_rating: 5,
    };
    delete revisedScores[criterion.id];
    const remainingNumericCriteria = detail.criteria.filter(
      (item) => item.id !== criterion.id && item.criterionType === "numeric",
    );
    const revisedWeight = remainingNumericCriteria.reduce(
      (total, item) => total + (item.weight ?? 1),
      0,
    );
    const revisedAggregate = remainingNumericCriteria.reduce(
      (total, item) => total + Number(revisedScores[item.id]) * (item.weight ?? 1),
      0,
    ) / revisedWeight;
    const revisedReviewResponse = await request(
      "/api/review/submissions/sub_ci_monorepo/reviews",
      {
        method: "POST",
        headers: { cookie: reviewerCookie, "content-type": "application/json" },
        body: JSON.stringify({ roundId: "rnd_initial_review", scores: revisedScores }),
      },
    );
    expect(revisedReviewResponse.status).toBe(200);
    const revisedReview = await revisedReviewResponse.json<{
      scores: Record<string, string | number>;
      aggregateScore: number;
    }>();
    expect(revisedReview.scores).toEqual({ ...revisedScores, [criterion.id]: 2 });
    expect(revisedReview.aggregateScore).toBeCloseTo(revisedAggregate, 5);
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

    await env.DB.prepare(
      "insert into submission_value (id, submission_id, field_id, value, created_at, updated_at) values (?, ?, ?, ?, ?, ?) on conflict(submission_id, field_id) do update set value = excluded.value",
    ).bind(
      "val_blind_identity",
      "sub_ci_monorepo",
      "fld_key_takeaway",
      JSON.stringify("Contact Priya Raman at sbek-speaker@example.com"),
      Date.now(),
      Date.now(),
    ).run();
    await env.DB.prepare(
      "insert into submission_value (id, submission_id, field_id, value, created_at, updated_at) values (?, ?, ?, ?, ?, ?) on conflict(submission_id, field_id) do update set value = excluded.value",
    ).bind(
      "val_blind_hidden_identity",
      "sub_ci_monorepo",
      "fld_workshop_prerequisites",
      JSON.stringify("Priya Raman leads delivery at Latticework Systems."),
      Date.now(),
      Date.now(),
    ).run();
    await env.DB.prepare(
      "update form_version_field set visible_in_blind_review = 1 where form_version_id = ? and stable_field_id = ?",
    ).bind("frm_devflow_cfp_2027:v1", "fld_key_takeaway").run();
    await env.DB.prepare(
      "insert into form_version (id, form_id, version, status, minimum_speakers, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?) on conflict(form_id, version) do update set status = excluded.status",
    ).bind(
      "frm_devflow_cfp_2027:blind-draft",
      "frm_devflow_cfp_2027",
      2,
      "draft",
      1,
      Date.now(),
      Date.now(),
    ).run();
    await env.DB.prepare(
      "insert into form_version_field (id, form_version_id, stable_field_id, key, label, field_type, required, visible_in_blind_review, sort_order, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict(form_version_id, key) do update set visible_in_blind_review = excluded.visible_in_blind_review",
    ).bind(
      "fld_blind_draft_takeaway",
      "frm_devflow_cfp_2027:blind-draft",
      "fld_key_takeaway",
      "key_takeaway",
      "Current draft takeaway prompt",
      "short_text",
      0,
      0,
      0,
      Date.now(),
      Date.now(),
    ).run();
    await env.DB.prepare("update form set version = 2 where id = ?")
      .bind("frm_devflow_cfp_2027")
      .run();

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
      answers: Array<{ key: string; label: string; value: string }>;
    }>();
    expect(blindDetail.round).toEqual({ id: round.id, name: "Final Review", anonymized: true });
    expect(blindDetail.participants).toEqual([]);
    expect(blindDetail.answers).toEqual([{
      key: "key_takeaway",
      label: "Key takeaway",
      value: "Contact Priya Raman at sbek-speaker@example.com",
    }]);
    expect(blindDetail.answers.map((answer) => answer.key)).not.toContain("workshop_prerequisites");

    const organizerDetailResponse = await request(
      `/api/review/submissions/sub_ci_monorepo?roundId=${round.id}`,
      { headers: { cookie: organizerCookie } },
    );
    const organizerDetail = await organizerDetailResponse.json<{
      participants: Array<{ name: string }>;
      answers: Array<{ label: string; value: string }>;
    }>();
    expect(organizerDetail.participants.map((participant) => participant.name)).toContain("Priya Raman");
    expect(organizerDetail.answers).toContainEqual({
      label: "Key takeaway",
      key: "key_takeaway",
      value: "Contact Priya Raman at sbek-speaker@example.com",
    });
    expect(organizerDetail.answers).toContainEqual({
      label: "Workshop prerequisites",
      key: "workshop_prerequisites",
      value: "Priya Raman leads delivery at Latticework Systems.",
    });

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
    await env.DB.prepare("update form set version = 1 where id = ?")
      .bind("frm_devflow_cfp_2027")
      .run();
    await env.DB.prepare(
      "update form_version_field set visible_in_blind_review = 0 where form_version_id = ? and stable_field_id = ?",
    ).bind("frm_devflow_cfp_2027:v1", "fld_key_takeaway").run();
    await env.DB.prepare("delete from form_version_field where form_version_id = ?")
      .bind("frm_devflow_cfp_2027:blind-draft")
      .run();
    await env.DB.prepare("delete from form_version where id = ?")
      .bind("frm_devflow_cfp_2027:blind-draft")
      .run();
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

  it("reserves review decisions for organizers", async () => {
    await request("/api/health");
    const endpoint = "/api/review/submissions/sub_ci_monorepo/status";
    const decision = (cookie?: string) => request(endpoint, {
      method: "PATCH",
      headers: {
        ...(cookie === undefined ? {} : { cookie }),
        "content-type": "application/json",
      },
      body: JSON.stringify({ status: "accepted" }),
    });

    expect((await decision()).status).toBe(401);
    const reviewerCookie = await signIn("sbek-reviewer@example.com", "SbekTest!2027-rev");
    expect((await decision(reviewerCookie)).status).toBe(403);
    const speakerCookie = await signIn("sbek-speaker@example.com", "SbekTest!2027-spk");
    expect((await decision(speakerCookie)).status).toBe(403);
    const organizerCookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");
    expect((await decision(organizerCookie)).status).toBe(200);
  });

  it("applies every committee decision silently from both review surfaces", async () => {
    await request("/api/health");
    const organizerCookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");
    const emailDispatchesBefore = await env.DB.prepare(
      "select count(*) as count from email_dispatch",
    ).first<{ count: number }>();
    const decisionNoticesBefore = await env.DB.prepare(
      "select count(*) as count from decision_notice",
    ).first<{ count: number }>();

    for (const status of ["accepted", "maybe", "declined"] as const) {
      const reviewResponse = await request(
        "/api/review/submissions/sub_ci_monorepo/status",
        {
          method: "PATCH",
          headers: { cookie: organizerCookie, "content-type": "application/json" },
          body: JSON.stringify({ status }),
        },
      );
      expect(reviewResponse.status).toBe(200);
      expect(await reviewResponse.json()).toEqual(
        expect.objectContaining({
          id: "sub_ci_monorepo",
          status,
          notificationSent: false,
        }),
      );

      const dispositionResponse = await request(
        "/api/events/evt_devflow_conf_2027/disposition",
        {
          method: "PATCH",
          headers: { cookie: organizerCookie, "content-type": "application/json" },
          body: JSON.stringify({ submissionIds: ["sub_ci_monorepo"], status }),
        },
      );
      expect(dispositionResponse.status).toBe(200);
      expect(await dispositionResponse.json()).toEqual(
        expect.objectContaining({
          notificationMode: "silent",
          updated: [{ id: "sub_ci_monorepo", status }],
        }),
      );
    }

    const emailDispatchesAfter = await env.DB.prepare(
      "select count(*) as count from email_dispatch",
    ).first<{ count: number }>();
    const decisionNoticesAfter = await env.DB.prepare(
      "select count(*) as count from decision_notice",
    ).first<{ count: number }>();
    expect(emailDispatchesAfter?.count).toBe(emailDispatchesBefore?.count);
    expect(decisionNoticesAfter?.count).toBe(decisionNoticesBefore?.count);
  });

  it("keeps one handoff when review acceptance is repeated from disposition", async () => {
    await request("/api/health");
    const organizerCookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");
    const reviewResponse = await request(
      "/api/review/submissions/sub_ci_monorepo/status",
      {
        method: "PATCH",
        headers: { cookie: organizerCookie, "content-type": "application/json" },
        body: JSON.stringify({ status: "accepted" }),
      },
    );
    expect(reviewResponse.status).toBe(200);
    const firstSession = await env.DB.prepare(
      "select id from program_session where submission_id = ?",
    ).bind("sub_ci_monorepo").first<{ id: string }>();
    expect(firstSession?.id).toMatch(/^ses_/);

    const dispositionResponse = await request(
      "/api/events/evt_devflow_conf_2027/disposition",
      {
        method: "PATCH",
        headers: { cookie: organizerCookie, "content-type": "application/json" },
        body: JSON.stringify({ submissionIds: ["sub_ci_monorepo"], status: "accepted" }),
      },
    );
    expect(dispositionResponse.status).toBe(200);
    const disposition = await dispositionResponse.json<{
      handoffs: Array<{ session: { id: string }; speakers: Array<{ id: string }> }>;
    }>();
    expect(disposition.handoffs[0]?.session.id).toBe(firstSession?.id);
    expect(disposition.handoffs[0]?.speakers.map((speaker) => speaker.id)).toEqual([
      "spk_priya_devflow_2027",
    ]);

    const sessions = await env.DB.prepare(
      "select count(*) as count from program_session where submission_id = ?",
    ).bind("sub_ci_monorepo").first<{ count: number }>();
    const sessionSpeakers = await env.DB.prepare(
      "select count(*) as count from session_speaker where session_id = ?",
    ).bind(firstSession?.id).first<{ count: number }>();
    const taskAssignments = await env.DB.prepare(
      "select count(*) as count from task_assignee where speaker_id = ?",
    ).bind("spk_priya_devflow_2027").first<{ count: number }>();
    expect(sessions?.count).toBe(1);
    expect(sessionSpeakers?.count).toBe(1);
    expect(taskAssignments?.count).toBe(5);
  });

  it("un-accepts from review without destroying or orphaning handoff records", async () => {
    await request("/api/health");
    const organizerCookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");
    const acceptResponse = await request(
      "/api/events/evt_devflow_conf_2027/disposition",
      {
        method: "PATCH",
        headers: { cookie: organizerCookie, "content-type": "application/json" },
        body: JSON.stringify({ submissionIds: ["sub_ci_monorepo"], status: "accepted" }),
      },
    );
    const accepted = await acceptResponse.json<{
      handoffs: Array<{ session: { id: string }; speakers: Array<{ id: string }> }>;
    }>();
    const sessionId = accepted.handoffs[0]?.session.id;
    const speakerIds = accepted.handoffs[0]?.speakers.map((speaker) => speaker.id) ?? [];
    expect(sessionId).toMatch(/^ses_/);
    await env.DB.prepare(
      "update program_session set schedule_status = ?, scheduled_date = ?, starts_at = ?, ends_at = ? where id = ?",
    ).bind(
      "placed",
      "2027-05-13",
      new Date("2027-05-13T17:00:00Z").getTime(),
      new Date("2027-05-13T17:30:00Z").getTime(),
      sessionId,
    ).run();

    const reverseResponse = await request(
      "/api/review/submissions/sub_ci_monorepo/status",
      {
        method: "PATCH",
        headers: { cookie: organizerCookie, "content-type": "application/json" },
        body: JSON.stringify({ status: "maybe" }),
      },
    );
    expect(reverseResponse.status).toBe(200);
    expect(await reverseResponse.json()).toEqual(
      expect.objectContaining({
        id: "sub_ci_monorepo",
        status: "maybe",
        notificationSent: false,
      }),
    );

    const retainedSession = await env.DB.prepare(
      "select id, content_status as contentStatus, schedule_status as scheduleStatus, scheduled_date as scheduledDate, starts_at as startsAt, ends_at as endsAt from program_session where submission_id = ?",
    ).bind("sub_ci_monorepo").first<{
      id: string;
      contentStatus: string;
      scheduleStatus: string;
      scheduledDate: string;
      startsAt: number;
      endsAt: number;
    }>();
    expect(retainedSession).toEqual({
      id: sessionId,
      contentStatus: "draft",
      scheduleStatus: "placed",
      scheduledDate: "2027-05-13",
      startsAt: new Date("2027-05-13T17:00:00Z").getTime(),
      endsAt: new Date("2027-05-13T17:30:00Z").getTime(),
    });
    const retainedSpeakers = await env.DB.prepare(
      "select speaker_id as speakerId from session_speaker where session_id = ? order by speaker_id",
    ).bind(sessionId).all<{ speakerId: string }>();
    expect(retainedSpeakers.results.map((speaker) => speaker.speakerId)).toEqual(speakerIds);
    const retainedTaskAssignments = await env.DB.prepare(
      "select count(*) as count from task_assignee where speaker_id = ?",
    ).bind(speakerIds[0]).first<{ count: number }>();
    expect(retainedTaskAssignments?.count).toBe(5);
  });

  it("hands an accepted review submission to the program and onboarding flows", async () => {
    await request("/api/health");
    const createResponse = await request("/api/public/cfp/devflow-conf-2027/submissions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        intent: "submit",
        speaker: {
          name: "Review Handoff Speaker",
          email: "review-handoff@example.com",
          jobTitle: "Staff Engineer",
          organization: "Program Systems",
        },
        proposal: {
          title: "The review handoff contract",
          abstract: "How one decision path keeps program and onboarding records consistent.",
          track: "Developer Experience",
          format: "Talk (30 min)",
          audienceLevel: "Intermediate",
          answers: { key_takeaway: "A decision is not complete until its handoff succeeds." },
        },
      }),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json<{
      submission: { id: string; speaker: { speakerId: string } };
    }>();

    const organizerCookie = await signIn("sbek-organizer@example.com", "SbekTest!2027-org");
    const response = await request(
      `/api/review/submissions/${created.submission.id}/status`,
      {
        method: "PATCH",
        headers: { cookie: organizerCookie, "content-type": "application/json" },
        body: JSON.stringify({ status: "accepted" }),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        id: created.submission.id,
        status: "accepted",
        notificationSent: false,
      }),
    );

    const session = await env.DB.prepare(
      "select id, submission_id as submissionId from program_session where submission_id = ?",
    ).bind(created.submission.id).first<{ id: string; submissionId: string }>();
    expect(session).toEqual({
      id: expect.stringMatching(/^ses_/),
      submissionId: created.submission.id,
    });
    const adoptedSpeaker = await env.DB.prepare(
      "select speaker_id as speakerId from session_speaker where session_id = ?",
    ).bind(session?.id).first<{ speakerId: string }>();
    expect(adoptedSpeaker?.speakerId).toBe(created.submission.speaker.speakerId);
    const assignedTasks = await env.DB.prepare(
      "select task.title from task_assignee join task on task.id = task_assignee.task_id where task_assignee.speaker_id = ? order by task.id",
    ).bind(created.submission.speaker.speakerId).all<{ title: string }>();
    expect(assignedTasks.results.map((task) => task.title)).toEqual([
      "Confirm participation",
      "Upload headshot",
      "Complete bio and profile",
      "Upload final slides by 2027-05-01",
      "Sign speaker release form",
    ]);
  });
});
