// ABOUTME: Serves optional AI reading aids inside Greenroom's existing committee review scope.
// ABOUTME: Keeps organizer opt-in and reviewer assistance separate from decisions and human records.
import { and, asc, eq } from "drizzle-orm";
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
import type { AuthSession } from "../auth.ts";
import {
  buildReviewAssistanceInput,
  createAnthropicReviewAssistant,
  protectGeneratedText,
  selectEditableSuggestions,
  type ParticipantIdentity,
  type ReviewAssistant,
} from "../ai/review-assistance.ts";
import { reviewerSubmission } from "./review.ts";

type AIReviewEnvironment = {
  Bindings: CloudflareBindings;
  Variables: {
    authSession: AuthSession["session"] | null;
    authUser: AuthSession["user"] | null;
    role: Role | null;
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
    const role = context.get("role");
    if (role === null) {
      return context.json({ error: "authentication_required" }, 401);
    }
    if (role !== requiredRole) {
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
      const [criteria, participants] = await Promise.all([
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
          .where(eq(submissionSpeakers.submissionId, submissionId)),
      ]);
      const visibility = scopedSubmission.anonymized ? "blind" : "identified";
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
            eq(aiSubmissionSummaries.visibility, visibility),
          ))
          .then((rows) => rows[0]),
        database
          .select()
          .from(aiScoreSuggestions)
          .where(and(
            eq(aiScoreSuggestions.submissionId, submissionId),
            eq(aiScoreSuggestions.formVersion, submission.formVersion),
            eq(aiScoreSuggestions.roundId, payload.roundId),
            eq(aiScoreSuggestions.visibility, visibility),
            eq(aiScoreSuggestions.criteriaFingerprint, criteriaFingerprint),
          ))
          .then((rows) => rows[0]),
      ]);
      if (cachedSummary !== undefined && cachedScores !== undefined) {
        return context.json({
          status: "ready",
          attribution: "AI-generated reading aid — review and edit before saving",
          summary: cachedSummary.summary,
          suggestedScores: cachedScores.scores,
          reasoning: cachedScores.reasoning,
          cached: true,
        });
      }

      try {
        const generated = await assistant.generate(buildReviewAssistanceInput({
          anonymized: scopedSubmission.anonymized,
          existingSummary: cachedSummary?.summary ?? null,
          proposal: {
            title: submission.title,
            abstract: submission.abstract,
            audienceLevel: submission.audienceLevel,
            notesForReviewers: submission.notesForReviewers,
          },
          participants,
          criteria,
        }));
        const summary = protectGeneratedText(
          cachedSummary?.summary ?? generated.summary,
          scopedSubmission.anonymized,
          participants,
        ).trim();
        if (summary.length === 0) {
          return context.json({ status: "unavailable" });
        }
        const suggestedScores = selectEditableSuggestions(generated.suggestedScores, criteria);
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
            visibility,
            summary,
            model: generated.model,
          }).onConflictDoNothing();
        }
        await database.insert(aiScoreSuggestions).values({
          submissionId,
          formVersion: submission.formVersion,
          roundId: payload.roundId,
          visibility,
          criteriaFingerprint,
          scores: suggestedScores,
          reasoning,
          model: generated.model,
        }).onConflictDoNothing();
        return context.json({
          status: "ready",
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

  return routes;
}

export default createAIReviewRoutes();
