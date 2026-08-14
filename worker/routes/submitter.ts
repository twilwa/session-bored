// ABOUTME: Serves the signed-in submitter dashboard from account-owned proposal records.
// ABOUTME: Scopes every lookup to the authenticated user's linked person identity.
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import {
  decisionNotices,
  forms,
  people,
  submissions,
  type SubmissionStatus,
} from "../../db/schema.ts";
import { speakerFacingSubmissionStatus } from "../../shared/api.ts";
import type { AuthSession } from "../auth.ts";
import { sentDecisionLetter } from "../speaker-access.ts";

type SubmitterEnvironment = {
  Bindings: CloudflareBindings;
  Variables: {
    authUser: AuthSession["user"] | null;
  };
};

type SubmitterDatabase = ReturnType<typeof drizzle>;

const submitterRoutes = new Hono<SubmitterEnvironment>();

function displayedSubmissionStatus(
  status: SubmissionStatus,
  decisionNotified: boolean,
): SubmissionStatus {
  const speakerStatus = speakerFacingSubmissionStatus({
    status,
    decisionNotified,
    hasOwnSession: false,
  });
  switch (speakerStatus) {
    case "in_review":
      return "under_review";
    case "not_selected":
      return "declined";
    default:
      return speakerStatus;
  }
}

async function readDisplayedSubmissionStatus(
  database: SubmitterDatabase,
  userId: string,
  submissionId: string,
): Promise<SubmissionStatus | null> {
  const [item] = await database
    .select({ status: submissions.status, sentDecisionNoticeId: decisionNotices.id })
    .from(submissions)
    .innerJoin(people, eq(submissions.submitterPersonId, people.id))
    .leftJoin(
      decisionNotices,
      and(eq(decisionNotices.submissionId, submissions.id), sentDecisionLetter()),
    )
    .where(and(eq(people.userId, userId), eq(submissions.id, submissionId)));
  return item === undefined
    ? null
    : displayedSubmissionStatus(item.status, item.sentDecisionNoticeId !== null);
}

submitterRoutes.get("/submitter/submissions", async (context) => {
  const user = context.get("authUser");
  if (user === null) {
    return context.json({ error: "authentication_required" }, 401);
  }
  const items = await drizzle(context.env.DB)
    .select({
      id: submissions.id,
      formSlug: forms.publicSlug,
      title: submissions.title,
      status: submissions.status,
      isDraft: submissions.isDraft,
      submittedAt: submissions.submittedAt,
      updatedAt: submissions.updatedAt,
      sentDecisionNoticeId: decisionNotices.id,
    })
    .from(submissions)
    .innerJoin(people, eq(submissions.submitterPersonId, people.id))
    .innerJoin(forms, eq(submissions.formId, forms.id))
    .leftJoin(
      decisionNotices,
      and(eq(decisionNotices.submissionId, submissions.id), sentDecisionLetter()),
    )
    .where(eq(people.userId, user.id));
  return context.json({
    items: items.map(({ sentDecisionNoticeId, status, ...item }) => ({
      ...item,
      status: displayedSubmissionStatus(status, sentDecisionNoticeId !== null),
    })),
  });
});

submitterRoutes.get("/submitter/submissions/:submissionId", async (context) => {
  const user = context.get("authUser");
  if (user === null) {
    return context.json({ error: "authentication_required" }, 401);
  }
  const status = await readDisplayedSubmissionStatus(
    drizzle(context.env.DB),
    user.id,
    context.req.param("submissionId"),
  );
  return status === null
    ? context.json({ error: "not_found" }, 404)
    : context.json({ status });
});

export default submitterRoutes;
