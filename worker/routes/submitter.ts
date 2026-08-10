// ABOUTME: Serves the signed-in submitter dashboard from account-owned proposal records.
// ABOUTME: Scopes every lookup to the authenticated user's linked person identity.
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { forms, people, submissions } from "../../db/schema.ts";
import type { AuthSession } from "../auth.ts";

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
  if (user.role !== "speaker") {
    return context.json({ error: "forbidden" }, 403);
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
    })
    .from(submissions)
    .innerJoin(people, eq(submissions.submitterPersonId, people.id))
    .innerJoin(forms, eq(submissions.formId, forms.id))
    .where(eq(people.userId, user.id));
  return context.json({ items });
});

export default submitterRoutes;
