// ABOUTME: Configures Better Auth password sessions against the shared Drizzle D1 schema.
// ABOUTME: Exposes the authenticated role field used by Hono authorization middleware.
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth/minimal";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema.ts";

export function createAuth(env: CloudflareBindings) {
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
    user: {
      additionalFields: {
        role: {
          type: "string",
          required: false,
          defaultValue: "speaker",
          input: false,
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
export type AuthSession = Auth["$Infer"]["Session"];
