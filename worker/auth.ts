// ABOUTME: Configures Better Auth password sessions against the shared Drizzle D1 schema.
// ABOUTME: Confirms addresses at sign-up, which is what lets a reviewer invitation be redeemed.
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth/minimal";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema.ts";
import type { EmailDelivery } from "./email.ts";
import { sendAddressConfirmationEmail } from "./email/address-confirmation.ts";
import { redeemReviewerInvitesFor } from "./reviewer-invites.ts";

/**
 * `delivery` follows the same convention as every other sending site in `worker/email/*`:
 * tests inject a fake one so the confirmation link can be followed without touching the
 * network. Left out, it resolves from the environment and stays unconfigured until secrets exist.
 */
export function createAuth(env: CloudflareBindings, delivery?: EmailDelivery) {
  const database = drizzle(env.DB, { schema });

  return betterAuth({
    appName: "Greenroom",
    basePath: "/api/auth",
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.APP_ORIGIN, env.BETTER_AUTH_URL],
    database: drizzleAdapter(database, {
      provider: "sqlite",
      schema: {
        ...schema,
        user: schema.users,
        session: schema.authSessions,
        account: schema.authAccounts,
        verification: schema.authVerifications,
      },
    }),
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
    },
    emailVerification: {
      // Confirming the address is what makes a reviewer invitation safe to redeem, so the
      // mail goes out at sign-up. It never gates signing in: an unconfirmed account is a
      // perfectly good attendee, and `requireEmailVerification` stays off.
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        await sendAddressConfirmationEmail(env, { name: user.name, email: user.email }, url, delivery);
      },
      afterEmailVerification: async (user) => {
        await redeemReviewerInvitesFor(env, { id: user.id, email: user.email });
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
export type AuthSession = Auth["$Infer"]["Session"];
