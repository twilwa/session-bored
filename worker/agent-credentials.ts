// ABOUTME: Issues and authenticates revocable agent credentials against their originating role grants.
// ABOUTME: Stores only credential digests and returns one issued role instead of the account's grant union.
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";
import { agentCredentials, roleGrants, users, type GrantableRole } from "../db/schema.ts";

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
  const credentialId = `acred_${crypto.randomUUID().replaceAll("-", "")}`;
  const token = `greenroom_${credentialSecret()}`;
  const secretDigest = await credentialDigest(token);
  const createdAt = Date.now();
  const [credential] = await database
    .insert(agentCredentials)
    .select(database
      .select({
        id: sql`${credentialId}`.as("id"),
        userId: roleGrants.userId,
        name: sql`${input.name}`.as("name"),
        role: roleGrants.role,
        roleGrantId: roleGrants.id,
        secretDigest: sql`${secretDigest}`.as("secret_digest"),
        lastUsedAt: sql`NULL`.as("last_used_at"),
        revokedAt: sql`NULL`.as("revoked_at"),
        createdAt: sql`${createdAt}`.as("created_at"),
        updatedAt: sql`${createdAt}`.as("updated_at"),
      })
      .from(roleGrants)
      .where(and(
        eq(roleGrants.userId, input.userId),
        eq(roleGrants.role, input.role),
        isNull(roleGrants.revokedAt),
      ))
      .limit(1))
    .returning({
      id: agentCredentials.id,
      name: agentCredentials.name,
      role: agentCredentials.role,
      createdAt: agentCredentials.createdAt,
      lastUsedAt: agentCredentials.lastUsedAt,
      revokedAt: agentCredentials.revokedAt,
    });
  if (credential === undefined) {
    return null;
  }
  return { credential: { ...credential, active: true }, token };
}

export async function listAgentCredentials(database: Database, userId: string) {
  const credentials = await database
    .select({
      id: agentCredentials.id,
      name: agentCredentials.name,
      role: agentCredentials.role,
      createdAt: agentCredentials.createdAt,
      lastUsedAt: agentCredentials.lastUsedAt,
      revokedAt: agentCredentials.revokedAt,
      liveRoleGrantId: roleGrants.id,
    })
    .from(agentCredentials)
    .leftJoin(roleGrants, and(
      eq(agentCredentials.roleGrantId, roleGrants.id),
      eq(agentCredentials.userId, roleGrants.userId),
      eq(agentCredentials.role, roleGrants.role),
      isNull(roleGrants.revokedAt),
    ))
    .where(eq(agentCredentials.userId, userId))
    .orderBy(desc(agentCredentials.createdAt));
  return credentials.map(({ liveRoleGrantId, ...credential }) => ({
    ...credential,
    active: credential.revokedAt === null && liveRoleGrantId !== null,
  }));
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
  return credential === undefined ? null : { ...credential, active: false };
}

export async function markAgentCredentialUsed(
  database: Database,
  credentialId: string,
): Promise<boolean> {
  const [used] = await database
    .update(agentCredentials)
    .set({ lastUsedAt: new Date() })
    .where(and(
      eq(agentCredentials.id, credentialId),
      isNull(agentCredentials.revokedAt),
      sql`EXISTS (
        SELECT 1 FROM ${roleGrants}
        WHERE ${roleGrants.id} = ${agentCredentials.roleGrantId}
          AND ${roleGrants.userId} = ${agentCredentials.userId}
          AND ${roleGrants.role} = ${agentCredentials.role}
          AND ${roleGrants.revokedAt} IS NULL
      )`,
    ))
    .returning({ id: agentCredentials.id });
  return used !== undefined;
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
    .innerJoin(roleGrants, and(
      eq(agentCredentials.roleGrantId, roleGrants.id),
      eq(agentCredentials.userId, roleGrants.userId),
      eq(agentCredentials.role, roleGrants.role),
      isNull(roleGrants.revokedAt),
    ))
    .where(and(
      eq(agentCredentials.secretDigest, await credentialDigest(token)),
      isNull(agentCredentials.revokedAt),
    ));
  if (identity === undefined) {
    return null;
  }
  if (!await markAgentCredentialUsed(database, identity.credentialId)) {
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
