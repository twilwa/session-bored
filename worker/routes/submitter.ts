// ABOUTME: Serves the signed-in submitter dashboard from account-owned proposal records.
// ABOUTME: Scopes every lookup to the authenticated user's linked person identity.
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { decisionNotices, forms, people, submissions } from "../../db/schema.ts";
import { submitterFacingSubmissionStatus } from "../../shared/api.ts";
import type { AuthSession } from "../auth.ts";
import { sentDecisionLetter } from "../speaker-access.ts";

type SubmitterEnvironment = {
  Bindings: CloudflareBindings;
  Variables: {
    authUser: AuthSession["user"] | null;
  };
};

const submitterRoutes = new Hono<SubmitterEnvironment>();

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
      status: submitterFacingSubmissionStatus(status, sentDecisionNoticeId !== null),
    })),
  });
});

export default submitterRoutes;
