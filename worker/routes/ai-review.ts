// ABOUTME: Serves optional AI reading aids inside Greenroom's existing committee review scope.
// ABOUTME: Keeps organizer opt-in and reviewer assistance separate from decisions and human records.
import { and, asc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import {
  aiScoreSuggestions,
  aiSubmissionSummaries,
  eventReviewConfigs,
  events,
  people,
  scorecardCriteria,
  submissions,
  submissionSpeakers,
  type Role,
} from "../../db/schema.ts";
import { holdsAccess } from "../access.ts";
import type { AuthSession } from "../auth.ts";
import { reviewProposalAnswers } from "../review-answers.ts";
import {
  buildReviewAssistanceInput,
  createAnthropicReviewAssistant,
  fingerprintReviewProposal,
  protectGeneratedText,
  selectCompleteEditableSuggestions,
  type ParticipantIdentity,
  type ReviewAssistant,
} from "../ai/review-assistance.ts";
import { reviewerSubmission } from "./review.ts";

type AIReviewEnvironment = {
  Bindings: CloudflareBindings;
  Variables: {
    authSession: AuthSession["session"] | null;
    authUser: AuthSession["user"] | null;
    roles: Role[] | null;
  };
};

export type ReviewAssistantResolver = (environment: CloudflareBindings) => ReviewAssistant | null;

function resolveConfiguredAssistant(environment: CloudflareBindings): ReviewAssistant | null {
  const apiKey = (environment as CloudflareBindings & { ANTHROPIC_API_KEY?: unknown })
    .ANTHROPIC_API_KEY;
  return typeof apiKey === "string" && apiKey.length > 0
    ? createAnthropicReviewAssistant(apiKey)
    : null;
}

function requireRole(requiredRole: "organizer" | "reviewer") {
  return createMiddleware<AIReviewEnvironment>(async (context, next) => {
    const roles = context.get("roles") ?? null;
    if (roles === null) {
      return context.json({ error: "authentication_required" }, 401);
    }
    if (!holdsAccess(roles, requiredRole)) {
      return context.json({ error: "forbidden" }, 403);
    }
    await next();
  });
}

async function aiAssistanceEnabled(
  database: ReturnType<typeof drizzle>,
  eventId: string,
): Promise<boolean> {
  const [config] = await database
    .select({ enabled: eventReviewConfigs.aiAssistanceEnabled })
    .from(eventReviewConfigs)
    .where(eq(eventReviewConfigs.eventId, eventId));
  return config?.enabled === true;
}

export function createAIReviewRoutes(
  resolveAssistant: ReviewAssistantResolver = resolveConfiguredAssistant,
) {
  const routes = new Hono<AIReviewEnvironment>();

  routes.get(
    "/review/events/:eventId/ai-assistance",
    requireRole("organizer"),
    async (context) => context.json({
      enabled: await aiAssistanceEnabled(
        drizzle(context.env.DB),
        context.req.param("eventId"),
      ),
    }),
  );

  routes.patch(
    "/review/events/:eventId/ai-assistance",
    requireRole("organizer"),
    async (context) => {
      const user = context.get("authUser");
      if (user === null) {
        return context.json({ error: "authentication_required" }, 401);
      }
      const payload = await context.req.json<{ enabled?: unknown }>();
      if (typeof payload.enabled !== "boolean") {
        return context.json({ error: "enabled_required" }, 400);
      }
      const database = drizzle(context.env.DB);
      const eventId = context.req.param("eventId");
      const [event] = await database
        .select({ id: events.id })
        .from(events)
        .where(eq(events.id, eventId));
      if (event === undefined) {
        return context.json({ error: "not_found" }, 404);
      }
      await database
        .insert(eventReviewConfigs)
        .values({
          eventId,
          aiAssistanceEnabled: payload.enabled,
          updatedByUserId: user.id,
        })
        .onConflictDoUpdate({
          target: eventReviewConfigs.eventId,
          set: {
            aiAssistanceEnabled: payload.enabled,
            updatedByUserId: user.id,
            updatedAt: new Date(),
          },
        });
      return context.json({ enabled: payload.enabled });
    },
  );

  routes.post(
    "/review/submissions/:submissionId/ai-assistance",
    requireRole("reviewer"),
    async (context) => {
      const user = context.get("authUser");
      if (user === null) {
        return context.json({ error: "authentication_required" }, 401);
      }
      const payload = await context.req.json<{ roundId?: unknown }>();
      if (typeof payload.roundId !== "string") {
        return context.json({ error: "round_required" }, 400);
      }
      const database = drizzle(context.env.DB);
      const submissionId = context.req.param("submissionId");
      const scopedSubmission = await reviewerSubmission(
        database,
        user.id,
        submissionId,
        payload.roundId,
      );
      if (scopedSubmission === undefined) {
        return context.json({ error: "forbidden" }, 403);
      }
      if (!(await aiAssistanceEnabled(database, scopedSubmission.eventId))) {
        return context.json({ status: "disabled" });
      }
      const assistant = resolveAssistant(context.env);
      if (assistant === null) {
        return context.json({ status: "unavailable" });
      }
      const [submission] = await database
        .select({
          id: submissions.id,
          formId: submissions.formId,
          formVersion: submissions.formVersion,
          title: submissions.title,
          abstract: submissions.abstract,
          audienceLevel: submissions.audienceLevel,
          notesForReviewers: submissions.notesForReviewers,
        })
        .from(submissions)
        .where(eq(submissions.id, submissionId));
      if (submission === undefined) {
        return context.json({ error: "not_found" }, 404);
      }
      const [criteria, participants, answers] = await Promise.all([
        database
          .select()
          .from(scorecardCriteria)
          .where(eq(scorecardCriteria.roundId, payload.roundId))
          .orderBy(asc(scorecardCriteria.sortOrder)),
        database
          .select({
            name: people.name,
            email: people.email,
            jobTitle: people.jobTitle,
            organization: people.organization,
          })
          .from(submissionSpeakers)
          .innerJoin(people, eq(submissionSpeakers.personId, people.id))
          .where(and(eq(submissionSpeakers.submissionId, submissionId), isNull(submissionSpeakers.deletedAt))),
        reviewProposalAnswers(database, submission, scopedSubmission.anonymized),
      ]);
      const visibility = scopedSubmission.anonymized ? "blind" : "identified";
      const assistanceInput = buildReviewAssistanceInput({
        anonymized: scopedSubmission.anonymized,
        existingSummary: null,
        proposal: {
          title: submission.title,
          abstract: submission.abstract,
          audienceLevel: submission.audienceLevel,
          notesForReviewers: submission.notesForReviewers,
          answers,
        },
        participants,
        criteria,
      });
      const contentFingerprint = await fingerprintReviewProposal(assistanceInput.proposal);
      const criteriaFingerprint = JSON.stringify(criteria.map((criterion) => ({
        id: criterion.id,
        label: criterion.label,
        description: criterion.description,
        criterionType: criterion.criterionType,
        options: criterion.options,
        weight: criterion.weight,
        required: criterion.required,
      })));
      const [cachedSummary, cachedScores] = await Promise.all([
        database
          .select()
          .from(aiSubmissionSummaries)
          .where(and(
            eq(aiSubmissionSummaries.submissionId, submissionId),
            eq(aiSubmissionSummaries.formVersion, submission.formVersion),
            eq(aiSubmissionSummaries.contentFingerprint, contentFingerprint),
            eq(aiSubmissionSummaries.visibility, visibility),
          ))
          .then((rows) => rows[0]),
        database
          .select()
          .from(aiScoreSuggestions)
          .where(and(
            eq(aiScoreSuggestions.submissionId, submissionId),
            eq(aiScoreSuggestions.formVersion, submission.formVersion),
            eq(aiScoreSuggestions.contentFingerprint, contentFingerprint),
            eq(aiScoreSuggestions.roundId, payload.roundId),
            eq(aiScoreSuggestions.visibility, visibility),
            eq(aiScoreSuggestions.criteriaFingerprint, criteriaFingerprint),
          ))
          .then((rows) => rows[0]),
      ]);
      const cachedSuggestedScores = cachedScores === undefined
        ? null
        : selectCompleteEditableSuggestions(cachedScores.scores, criteria);
      if (
        cachedSummary !== undefined &&
        cachedScores !== undefined &&
        cachedSuggestedScores !== null
      ) {
        return context.json({
          status: "ready",
          suggestionId: cachedScores.id,
          attribution: "AI-generated reading aid — review and edit before saving",
          summary: cachedSummary.summary,
          suggestedScores: cachedSuggestedScores,
          reasoning: cachedScores.reasoning,
          cached: true,
        });
      }

      try {
        const generated = await assistant.generate({
          ...assistanceInput,
          existingSummary: cachedSummary?.summary ?? null,
        });
        const summary = protectGeneratedText(
          cachedSummary?.summary ?? generated.summary,
          scopedSubmission.anonymized,
          participants,
        ).trim();
        if (summary.length === 0) {
          return context.json({ status: "unavailable" });
        }
        const suggestedScores = selectCompleteEditableSuggestions(
          generated.suggestedScores,
          criteria,
        );
        if (suggestedScores === null) {
          return context.json({ status: "unavailable" });
        }
        const reasoning = Object.fromEntries(criteria.flatMap((criterion) => {
          const value = generated.reasoning[criterion.id];
          return typeof value === "string"
            ? [[criterion.id, protectGeneratedText(
              value,
              scopedSubmission.anonymized,
              participants,
            )]]
            : [];
        }));
        if (cachedSummary === undefined) {
          await database.insert(aiSubmissionSummaries).values({
            submissionId,
            formVersion: submission.formVersion,
            contentFingerprint,
            visibility,
            summary,
            model: generated.model,
          }).onConflictDoNothing();
        }
        await database.insert(aiScoreSuggestions).values({
          submissionId,
          formVersion: submission.formVersion,
          contentFingerprint,
          roundId: payload.roundId,
          visibility,
          criteriaFingerprint,
          scores: suggestedScores,
          reasoning,
          model: generated.model,
        }).onConflictDoUpdate({
          target: [
            aiScoreSuggestions.submissionId,
            aiScoreSuggestions.formVersion,
            aiScoreSuggestions.contentFingerprint,
            aiScoreSuggestions.roundId,
            aiScoreSuggestions.visibility,
            aiScoreSuggestions.criteriaFingerprint,
          ],
          set: {
            scores: suggestedScores,
            reasoning,
            model: generated.model,
          },
        });
        const [storedScores] = await database
          .select({ id: aiScoreSuggestions.id })
          .from(aiScoreSuggestions)
          .where(and(
            eq(aiScoreSuggestions.submissionId, submissionId),
            eq(aiScoreSuggestions.formVersion, submission.formVersion),
            eq(aiScoreSuggestions.contentFingerprint, contentFingerprint),
            eq(aiScoreSuggestions.roundId, payload.roundId),
            eq(aiScoreSuggestions.visibility, visibility),
            eq(aiScoreSuggestions.criteriaFingerprint, criteriaFingerprint),
          ));
        if (storedScores === undefined) {
          return context.json({ status: "unavailable" });
        }
        return context.json({
          status: "ready",
          suggestionId: storedScores.id,
          attribution: "AI-generated reading aid — review and edit before saving",
          summary,
          suggestedScores,
          reasoning,
          cached: false,
        });
      } catch {
        return context.json({ status: "unavailable" });
      }
    },
  );

  routes.get(
    "/review/submissions/:submissionId/ai-assistance",
    requireRole("reviewer"),
    async (context) => {
      const user = context.get("authUser");
      if (user === null) {
        return context.json({ error: "authentication_required" }, 401);
      }
      const roundId = context.req.query("roundId");
      if (roundId === undefined) {
        return context.json({ error: "round_required" }, 400);
      }
      const database = drizzle(context.env.DB);
      const scopedSubmission = await reviewerSubmission(
        database,
        user.id,
        context.req.param("submissionId"),
        roundId,
      );
      if (scopedSubmission === undefined) {
        return context.json({ error: "forbidden" }, 403);
      }
      return context.json({
        status: await aiAssistanceEnabled(database, scopedSubmission.eventId)
          ? "available"
          : "disabled",
      });
    },
  );

  return routes;
}

export default createAIReviewRoutes();
