// ABOUTME: Issues and authenticates revocable agent credentials against the account's live grants.
// ABOUTME: Stores only credential digests and returns one issued role instead of the account's grant union.
import { and, desc, eq, isNull } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";
import { agentCredentials, users, type GrantableRole } from "../db/schema.ts";
import { hasLiveGrant } from "./roles.ts";

type Database = ReturnType<typeof drizzle>;

export interface AgentCredentialIdentity {
  credential: { id: string; name: string; role: GrantableRole };
  user: typeof users.$inferSelect;
}

function credentialSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function credentialDigest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bearerValue(authorization: string): string | null {
  const [scheme, value, remainder] = authorization.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== "bearer" || value === undefined || remainder !== undefined) {
    return null;
  }
  return value;
}

export function presentsBearerCredential(authorization: string | undefined): boolean {
  return authorization?.trim().split(/\s+/, 1)[0]?.toLowerCase() === "bearer";
}

export async function issueAgentCredential(
  database: Database,
  input: { userId: string; name: string; role: GrantableRole },
) {
  if (!(await hasLiveGrant(database, input.userId, input.role))) {
    return null;
  }
  const token = `greenroom_${credentialSecret()}`;
  const [credential] = await database
    .insert(agentCredentials)
    .values({
      userId: input.userId,
      name: input.name,
      role: input.role,
      secretDigest: await credentialDigest(token),
    })
    .returning({
      id: agentCredentials.id,
      name: agentCredentials.name,
      role: agentCredentials.role,
      createdAt: agentCredentials.createdAt,
      lastUsedAt: agentCredentials.lastUsedAt,
      revokedAt: agentCredentials.revokedAt,
    });
  if (credential === undefined) {
    throw new Error("Agent credential insert returned no row");
  }
  return { credential, token };
}

export async function listAgentCredentials(database: Database, userId: string) {
  return database
    .select({
      id: agentCredentials.id,
      name: agentCredentials.name,
      role: agentCredentials.role,
      createdAt: agentCredentials.createdAt,
      lastUsedAt: agentCredentials.lastUsedAt,
      revokedAt: agentCredentials.revokedAt,
    })
    .from(agentCredentials)
    .where(eq(agentCredentials.userId, userId))
    .orderBy(desc(agentCredentials.createdAt));
}

export async function revokeAgentCredential(
  database: Database,
  input: { credentialId: string; userId: string },
) {
  const [credential] = await database
    .update(agentCredentials)
    .set({ revokedAt: new Date() })
    .where(and(
      eq(agentCredentials.id, input.credentialId),
      eq(agentCredentials.userId, input.userId),
      isNull(agentCredentials.revokedAt),
    ))
    .returning({
      id: agentCredentials.id,
      name: agentCredentials.name,
      role: agentCredentials.role,
      createdAt: agentCredentials.createdAt,
      lastUsedAt: agentCredentials.lastUsedAt,
      revokedAt: agentCredentials.revokedAt,
    });
  return credential ?? null;
}

export async function authenticateAgentCredential(
  database: Database,
  authorization: string,
): Promise<AgentCredentialIdentity | null> {
  const token = bearerValue(authorization);
  if (token === null || !token.startsWith("greenroom_")) {
    return null;
  }
  const [identity] = await database
    .select({
      credentialId: agentCredentials.id,
      credentialName: agentCredentials.name,
      credentialRole: agentCredentials.role,
      user: users,
    })
    .from(agentCredentials)
    .innerJoin(users, eq(agentCredentials.userId, users.id))
    .where(and(
      eq(agentCredentials.secretDigest, await credentialDigest(token)),
      isNull(agentCredentials.revokedAt),
    ));
  if (identity === undefined || !(await hasLiveGrant(database, identity.user.id, identity.credentialRole))) {
    return null;
  }
  const [used] = await database
    .update(agentCredentials)
    .set({ lastUsedAt: new Date() })
    .where(and(
      eq(agentCredentials.id, identity.credentialId),
      isNull(agentCredentials.revokedAt),
    ))
    .returning({ id: agentCredentials.id });
  if (used === undefined) {
    return null;
  }
  return {
    credential: {
      id: identity.credentialId,
      name: identity.credentialName,
      role: identity.credentialRole,
    },
    user: identity.user,
  };
}
