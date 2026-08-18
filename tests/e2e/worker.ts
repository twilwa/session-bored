// ABOUTME: Extends the local Playwright Worker with authenticated fixture setup routes.
// ABOUTME: Keeps browser-only database states real without exposing test controls in production.
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { users } from "../../db/schema.ts";
import { holdsAccess } from "../../worker/access.ts";
import app from "../../worker/index.ts";
import { grantRole } from "../../worker/roles.ts";

app.post("/api/e2e/speaker-access-only", async (context) => {
  const organizer = context.get("authUser");
  const roles = context.get("roles");
  if (organizer === null) {
    return context.json({ error: "authentication_required" }, 401);
  }
  if (roles === null || !holdsAccess(roles, "organizer")) {
    return context.json({ error: "forbidden" }, 403);
  }

  const payload = await context.req.json<{ userId?: unknown }>();
  if (typeof payload.userId !== "string" || payload.userId.length === 0) {
    return context.json({ error: "user_required" }, 400);
  }
  const database = drizzle(context.env.DB);
  const [account] = await database
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, payload.userId));
  if (account === undefined) {
    return context.json({ error: "not_found" }, 404);
  }

  const { granted } = await grantRole(database, {
    userId: account.id,
    role: "speaker",
    source: "backfill",
    grantedByUserId: organizer.id,
    note: "Playwright fixture for access granted without a linked speaker profile.",
  });
  return context.json({ granted }, 201);
});

export default app;
