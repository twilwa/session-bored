// ABOUTME: Proves self-service sign-up lands on attendee and reaches no role-scoped surface.
// ABOUTME: Proves a reviewer invitation is only redeemed by someone who confirms the address.
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { reviewerInvites, roleGrants, type Role, users } from "../../db/schema.ts";
import { createAuth, type AuthSession } from "../../worker/auth.ts";
import type { EmailDelivery, EmailMessage } from "../../worker/email.ts";
import { applyReviewerRemit, redeemReviewerInvites } from "../../worker/reviewer-invites.ts";
import { resolveEffectiveRole } from "../../worker/roles.ts";
import reviewRoutes from "../../worker/routes/review.ts";
import worker from "../../worker/index.ts";

async function request(path: string, init?: RequestInit): Promise<Response> {
  return worker.request(`http://example.test${path}`, init, env);
}

async function signUp(name: string, email: string, body: Record<string, unknown> = {}): Promise<string> {
  const response = await request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, email, password: "Greenroom!2027", ...body }),
  });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
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

async function userIdFor(email: string): Promise<string> {
  const [row] = await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.email, email));
  expect(row).toBeDefined();
  return row!.id;
}

const documentHeaders = { "sec-fetch-dest": "document", accept: "text/html" };

describe("self-service sign-up", () => {
  it("lands a brand new account on attendee with no grant at all", async () => {
    await request("/api/health");
    await signUp("Fresh Account", "fresh-account@example.com");

    const database = drizzle(env.DB);
    const userId = await userIdFor("fresh-account@example.com");
    const grants = await database.select().from(roleGrants).where(eq(roleGrants.userId, userId));

    expect(grants).toEqual([]);
    expect(await resolveEffectiveRole(database, userId)).toBe("attendee");
  });

  it("ignores a role the sign-up body asks for", async () => {
    await request("/api/health");
    await signUp("Ambitious Account", "ambitious@example.com", { role: "organizer" });

    const database = drizzle(env.DB);
    const userId = await userIdFor("ambitious@example.com");

    expect(await database.select().from(roleGrants).where(eq(roleGrants.userId, userId))).toEqual([]);
    expect(await resolveEffectiveRole(database, userId)).toBe("attendee");
  });

  it("refuses an attendee every workspace, as a page and as an API call", async () => {
    await request("/api/health");
    const cookie = await signUp("Walled Out", "walled-out@example.com");

    for (const path of ["/organizer", "/reviewer", "/speaker"]) {
      expect((await request(path, { headers: { cookie, ...documentHeaders } })).status).toBe(403);
      expect((await request(path, { headers: { cookie } })).status).toBe(403);
    }
    for (const path of ["/api/events", "/api/reviewer/assignments", "/api/speaker/content"]) {
      expect((await request(path, { headers: { cookie } })).status).toBe(403);
    }
  });

  it("keeps the attendee's own submitter dashboard open", async () => {
    await request("/api/health");
    const cookie = await signUp("Own Records", "own-records@example.com");

    // Only the refusal is asserted here. A served page needs built assets, which this suite
    // deliberately runs without - `tests/e2e/account-access.spec.ts` opens the real page.
    const page = await request("/submitter", { headers: { cookie, ...documentHeaders } });
    expect(page.status).not.toBe(401);
    expect(page.status).not.toBe(403);

    const dashboard = await request("/api/submitter/submissions", { headers: { cookie } });
    expect(dashboard.status).toBe(200);
    expect(await dashboard.json()).toEqual({ items: [] });
  });
});

describe("reviewer invitation", () => {
  async function inviteReviewer(email: string): Promise<string> {
    const database = drizzle(env.DB);
    const organizerId = await userIdFor("sbek-organizer@example.com");
    const [invite] = await database
      .insert(reviewerInvites)
      .values({
        email,
        eventId: "evt_devflow_conf_2027",
        trackIds: [],
        roundIds: [],
        invitedByUserId: organizerId,
      })
      .returning({ id: reviewerInvites.id });
    return invite!.id;
  }

  it("grants nothing to somebody who signs up as an invited address without confirming it", async () => {
    await request("/api/health");
    const invited = "invited-reviewer@example.com";
    await inviteReviewer(invited);

    // The attack: a stranger who knows the invited address signs up as them and tries to
    // walk straight into the review committee.
    const cookie = await signUp("Impostor", invited);
    const database = drizzle(env.DB);
    const userId = await userIdFor(invited);

    expect(await database.select().from(roleGrants).where(eq(roleGrants.userId, userId))).toEqual([]);
    expect(await resolveEffectiveRole(database, userId)).toBe("attendee");
    expect((await request("/api/reviewer/assignments", { headers: { cookie } })).status).toBe(403);
    expect((await request("/reviewer", { headers: { cookie, ...documentHeaders } })).status).toBe(403);

    // The invitation is still open, waiting for whoever can actually read that mailbox.
    const [invite] = await database
      .select({ redeemedAt: reviewerInvites.redeemedAt })
      .from(reviewerInvites)
      .where(eq(reviewerInvites.email, invited));
    expect(invite?.redeemedAt).toBeNull();
  });

  it("refuses to redeem for an account whose address is not verified", async () => {
    await request("/api/health");
    const invited = "unverified-invite@example.com";
    await inviteReviewer(invited);
    await signUp("Not Verified", invited);
    const database = drizzle(env.DB);
    const userId = await userIdFor(invited);

    const redeemed = await redeemReviewerInvites(database, {
      id: userId,
      email: invited,
      emailVerified: false,
    });

    expect(redeemed).toEqual([]);
    expect(await resolveEffectiveRole(database, userId)).toBe("attendee");
  });

  it("grants reviewer once the address is confirmed, and only once", async () => {
    await request("/api/health");
    const invited = "confirming-reviewer@example.com";
    await inviteReviewer(invited);
    await signUp("Real Reviewer", invited);
    const database = drizzle(env.DB);
    const userId = await userIdFor(invited);

    const redeemed = await redeemReviewerInvites(database, {
      id: userId,
      email: invited,
      emailVerified: true,
    });
    expect(redeemed).toHaveLength(1);
    expect(await resolveEffectiveRole(database, userId)).toBe("reviewer");

    const [grant] = await database
      .select({ source: roleGrants.source, role: roleGrants.role })
      .from(roleGrants)
      .where(eq(roleGrants.userId, userId));
    expect(grant).toMatchObject({ role: "reviewer", source: "reviewer_invite" });

    // Redeeming again is a no-op: the invitation is spent.
    expect(await redeemReviewerInvites(database, { id: userId, email: invited, emailVerified: true }))
      .toEqual([]);
    expect(
      await database.select().from(roleGrants).where(eq(roleGrants.userId, userId)),
    ).toHaveLength(1);

    // And the reviewer area is now genuinely open to them.
    const cookie = await signIn(invited, "Greenroom!2027");
    expect((await request("/api/reviewer/assignments", { headers: { cookie } })).status).toBe(200);
  });

  it("redeems through the real confirmation link, not through a test-only shortcut", async () => {
    await request("/api/health");
    const invited = "link-clicker@example.com";
    await inviteReviewer(invited);

    // Sign up through Better Auth with a delivery we can read, so the test follows the exact
    // confirmation link a recipient would receive instead of minting its own token.
    const sent: EmailMessage[] = [];
    const capture: EmailDelivery = {
      async send(message) {
        sent.push(message);
        return { status: "sent", providerMessageId: "test" };
      },
    };
    await createAuth(env, capture).api.signUpEmail({
      body: { name: "Link Clicker", email: invited, password: "Greenroom!2027" },
    });

    const database = drizzle(env.DB);
    const userId = await userIdFor(invited);
    expect(await resolveEffectiveRole(database, userId)).toBe("attendee");

    const confirmUrl = sent.flatMap((message) => message.text.match(/https?:\/\/\S+verify-email\S+/) ?? [])[0];
    expect(confirmUrl).toBeDefined();

    const response = await request(
      `${new URL(confirmUrl!).pathname}${new URL(confirmUrl!).search}`,
      { headers: documentHeaders, redirect: "manual" },
    );
    expect([200, 302]).toContain(response.status);

    expect(await resolveEffectiveRole(database, userId)).toBe("reviewer");
    const [invite] = await database
      .select({ redeemedByUserId: reviewerInvites.redeemedByUserId })
      .from(reviewerInvites)
      .where(eq(reviewerInvites.email, invited));
    expect(invite?.redeemedByUserId).toBe(userId);
  });

  it("leaves a revoked invitation unredeemable", async () => {
    await request("/api/health");
    const invited = "revoked-invite@example.com";
    const inviteId = await inviteReviewer(invited);
    const database = drizzle(env.DB);
    const organizerId = await userIdFor("sbek-organizer@example.com");
    await database
      .update(reviewerInvites)
      .set({ revokedAt: new Date(), revokedByUserId: organizerId })
      .where(eq(reviewerInvites.id, inviteId));
    await signUp("Too Late", invited);
    const userId = await userIdFor(invited);

    expect(
      await redeemReviewerInvites(database, { id: userId, email: invited, emailVerified: true }),
    ).toEqual([]);
    expect(await resolveEffectiveRole(database, userId)).toBe("attendee");
  });
});

describe("granting and revoking", () => {
  it("takes effect on the caller's very next request, in both directions", async () => {
    await request("/api/health");
    const cookie = await signUp("Promoted Later", "promoted-later@example.com");
    const database = drizzle(env.DB);
    const userId = await userIdFor("promoted-later@example.com");
    const organizerId = await userIdFor("sbek-organizer@example.com");

    expect((await request("/api/reviewer/assignments", { headers: { cookie } })).status).toBe(403);

    await database.insert(roleGrants).values({
      userId,
      role: "reviewer",
      source: "organizer",
      grantedByUserId: organizerId,
      grantedAt: new Date(),
    });
    expect((await request("/api/reviewer/assignments", { headers: { cookie } })).status).toBe(200);

    await database
      .update(roleGrants)
      .set({ revokedAt: new Date(), revokedByUserId: organizerId })
      .where(and(eq(roleGrants.userId, userId), eq(roleGrants.role, "reviewer")));
    expect((await request("/api/reviewer/assignments", { headers: { cookie } })).status).toBe(403);
  });

  it("authorizes every review handler from `roles` alone, with no second role variable to fall behind", async () => {
    // A request carries its grant union and nothing else. This mounts the review routes the
    // way the contract says to - supplying `roles` - and walks the handlers that authorize
    // inline. Any handler still reading a single display role refuses this caller outright,
    // which is exactly how the two below were left behind when the rest were migrated.
    await request("/api/health");
    const [reviewer] = await drizzle(env.DB)
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(eq(users.email, "sbek-reviewer@example.com"));
    expect(reviewer).toBeDefined();

    const app = new Hono<{
      Bindings: typeof env;
      Variables: { authSession: null; authUser: AuthSession["user"]; roles: Role[] | null };
    }>();
    app.use("*", async (context, next) => {
      context.set("authSession", null);
      context.set("authUser", {
        ...reviewer!,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as AuthSession["user"]);
      context.set("roles", ["reviewer"]);
      await next();
    });
    app.route("/api", reviewRoutes);
    const call = (path: string, init?: RequestInit) =>
      app.request(`http://example.test${path}`, init, env);

    expect((await call("/api/review/queue")).status).toBe(200);
    expect((await call("/api/review/submissions/sub_ci_monorepo")).status).toBe(200);
    expect((await call("/api/review/submissions/sub_ci_monorepo/comments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Authorized from the union alone." }),
    })).status).toBe(201);
  });

  it("reads and comments on a proposal through a grant union, not a single role", async () => {
    // The two review handlers that authorize inline rather than through `requireRole`. They
    // must answer the same grant union every other gate does - a caller carries `roles`, and
    // there is no single display role for them to fall behind.
    await request("/api/health");
    const cookie = await signUp("Union Reader", "union-reader@example.com");
    const database = drizzle(env.DB);
    const userId = await userIdFor("union-reader@example.com");
    const organizerId = await userIdFor("sbek-organizer@example.com");
    const detailPath = "/api/review/submissions/sub_ci_monorepo";

    expect((await request(detailPath, { headers: { cookie } })).status).toBe(403);

    // Speaker first, so the narrower grant is the one already held when reviewer arrives.
    for (const role of ["speaker", "reviewer"] as const) {
      await database.insert(roleGrants).values({
        userId,
        role,
        source: "organizer",
        grantedByUserId: organizerId,
        grantedAt: new Date(),
      });
    }
    await applyReviewerRemit(database, {
      eventId: "evt_devflow_conf_2027",
      reviewerUserId: userId,
      trackIds: ["trk_platform_infra"],
      roundIds: ["rnd_initial_review"],
    });

    const detail = await request(detailPath, { headers: { cookie } });
    expect(detail.status).toBe(200);
    expect((await detail.json<{ id: string }>()).id).toBe("sub_ci_monorepo");

    const comment = await request(`${detailPath}/comments`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ body: "Read through a grant union." }),
    });
    expect(comment.status).toBe(201);

    // The union widens nothing it was not given: a proposal outside the remit stays shut.
    expect((await request("/api/review/submissions/sub_ai_verification", { headers: { cookie } })).status)
      .toBe(403);
  });

  it("opens both areas to an account holding two grants", async () => {
    await request("/api/health");
    const cookie = await signUp("Two Hats", "two-hats@example.com");
    const database = drizzle(env.DB);
    const userId = await userIdFor("two-hats@example.com");
    const organizerId = await userIdFor("sbek-organizer@example.com");

    for (const role of ["reviewer", "speaker"] as const) {
      await database.insert(roleGrants).values({
        userId,
        role,
        source: "organizer",
        grantedByUserId: organizerId,
        grantedAt: new Date(),
      });
    }

    const session = await request("/api/session", { headers: { cookie } });
    expect(session.status).toBe(200);
    expect((await session.json<{ user: { role: Role; roles: Role[] } }>()).user).toMatchObject({
      role: "reviewer",
      roles: ["reviewer", "speaker"],
    });

    // The second grant has to actually open the second area. Resolving to a single widest
    // role would answer `reviewer` here and refuse the speaker area it was just given.
    expect((await request("/api/reviewer/assignments", { headers: { cookie } })).status).toBe(200);
    expect((await request("/api/speaker/content", { headers: { cookie } })).status).toBe(200);
    for (const path of ["/reviewer", "/speaker"]) {
      expect((await request(path, { headers: { cookie, ...documentHeaders } })).status).not.toBe(403);
    }

    // And only the granted areas: nothing here confers organizer.
    expect((await request("/api/events", { headers: { cookie } })).status).toBe(403);
    expect((await request("/organizer", { headers: { cookie, ...documentHeaders } })).status).toBe(403);

    // Revoking one leaves the other standing.
    await database
      .update(roleGrants)
      .set({ revokedAt: new Date(), revokedByUserId: organizerId })
      .where(and(eq(roleGrants.userId, userId), eq(roleGrants.role, "reviewer")));
    expect((await request("/api/reviewer/assignments", { headers: { cookie } })).status).toBe(403);
    expect((await request("/api/speaker/content", { headers: { cookie } })).status).toBe(200);
  });
});
