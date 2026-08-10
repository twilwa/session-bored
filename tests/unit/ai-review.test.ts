// ABOUTME: Verifies AI review assistance stays advisory, scoped, and identity-safe.
// ABOUTME: Exercises the injectable model seam without making external API requests.
import { describe, expect, it } from "vitest";
import {
  buildReviewAssistanceInput,
  createAnthropicReviewAssistant,
  selectEditableSuggestions,
} from "../../worker/ai/review-assistance.ts";

describe("AI review assistance", () => {
  it("removes known speaker identity from blind-round model input", () => {
    const input = buildReviewAssistanceInput({
      anonymized: true,
      existingSummary: null,
      proposal: {
        title: "Priya Raman on reliable delivery",
        abstract: "Priya Raman of Northstar Labs shares a staff engineer's field notes.",
        audienceLevel: "Intermediate",
        notesForReviewers: "Contact priya@example.com with questions.",
      },
      participants: [{
        name: "Priya Raman",
        email: "priya@example.com",
        jobTitle: "Staff Engineer",
        organization: "Northstar Labs",
      }],
      criteria: [{
        id: "crt_relevance",
        label: "Relevance",
        description: null,
        criterionType: "numeric",
        options: null,
        weight: 2,
        required: true,
      }],
    });

    const serialized = JSON.stringify(input).toLowerCase();
    expect(serialized).not.toContain("priya");
    expect(serialized).not.toContain("northstar");
    expect(serialized).not.toContain("staff engineer");
    expect(serialized).not.toContain("priya@example.com");
    expect(serialized).toContain("[identity hidden]");
  });

  it("translates an injected Anthropic response into advisory assistance", async () => {
    const requests: Request[] = [];
    const assistant = createAnthropicReviewAssistant(
      "test-key",
      async (input, init) => {
        requests.push(new Request(input, init));
        return new Response(JSON.stringify({
          content: [{
            type: "text",
            text: JSON.stringify({
              summary: "A concise account of the proposal's delivery lessons.",
              suggestedScores: { crt_relevance: 4 },
              reasoning: { crt_relevance: "The proposal gives concrete evidence." },
            }),
          }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    );

    const result = await assistant.generate({
      anonymized: false,
      existingSummary: null,
      proposal: {
        title: "Reliable delivery",
        abstract: "Lessons from repeated production rollouts.",
        audienceLevel: "Intermediate",
        notesForReviewers: null,
      },
      criteria: [{
        id: "crt_relevance",
        label: "Relevance",
        description: null,
        criterionType: "numeric",
        options: null,
        weight: 2,
        required: true,
      }],
    });

    expect(result).toEqual({
      summary: "A concise account of the proposal's delivery lessons.",
      suggestedScores: { crt_relevance: 4 },
      reasoning: { crt_relevance: "The proposal gives concrete evidence." },
      model: "claude-haiku-4-5-20251001",
    });
    const request = requests[0];
    expect(request).toBeDefined();
    expect(request?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(request?.headers.get("x-api-key")).toBe("test-key");
    expect(request?.headers.get("anthropic-version")).toBe("2023-06-01");
  });

  it("keeps only suggestions a reviewer can submit against the round criteria", () => {
    const suggestions = selectEditableSuggestions(
      {
        crt_rating: 4,
        crt_recommendation: "Accept",
        crt_notes: "Evidence is specific.",
        crt_unknown: 5,
      },
      [
        {
          id: "crt_rating",
          label: "Rating",
          description: null,
          criterionType: "numeric",
          options: null,
          weight: 1,
          required: true,
        },
        {
          id: "crt_recommendation",
          label: "Recommendation",
          description: null,
          criterionType: "dropdown",
          options: ["Strong yes", "Maybe", "No"],
          weight: null,
          required: true,
        },
        {
          id: "crt_notes",
          label: "Notes",
          description: null,
          criterionType: "free_text",
          options: null,
          weight: null,
          required: false,
        },
      ],
    );

    expect(suggestions).toEqual({
      crt_rating: 4,
      crt_notes: "Evidence is specific.",
    });
  });
});
