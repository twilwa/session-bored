// ABOUTME: Resolves an account's effective role from its live grants, defaulting to attendee.
// ABOUTME: Owns granting and revoking so attribution and reversal stay in one place.
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";
import {
  type GrantSource,
  type GrantableRole,
  type Role,
  roleGrants,
} from "../db/schema.ts";

type Database = ReturnType<typeof drizzle>;

/**
 * Which grant wins when an account holds more than one. Access is a single role today, so the
 * widest reach answers, which keeps a granted organizer an organizer even if they also speak.
 */
const rolePrecedence: readonly GrantableRole[] = ["organizer", "reviewer", "speaker"];

export interface LiveGrant {
  id: string;
  userId: string;
  role: GrantableRole;
  source: GrantSource;
  grantedByUserId: string | null;
  grantedAt: Date;
  note: string | null;
}

function highestRole(grantedRoles: readonly GrantableRole[]): Role {
  for (const role of rolePrecedence) {
    if (grantedRoles.includes(role)) {
      return role;
    }
  }
  return "attendee";
}

/**
 * Every live grant held by these accounts. Scoping roles to an event later adds the event
 * filter here rather than at each call site.
 */
export async function listLiveGrants(
  database: Database,
  userIds: readonly string[],
): Promise<LiveGrant[]> {
  if (userIds.length === 0) {
    return [];
  }
  return database
    .select({
      id: roleGrants.id,
      userId: roleGrants.userId,
      role: roleGrants.role,
      source: roleGrants.source,
      grantedByUserId: roleGrants.grantedByUserId,
      grantedAt: roleGrants.grantedAt,
      note: roleGrants.note,
    })
    .from(roleGrants)
    .where(and(inArray(roleGrants.userId, [...userIds]), isNull(roleGrants.revokedAt)))
    .orderBy(desc(roleGrants.grantedAt));
}

/** The role this account may act as. An account with no live grant is an attendee. */
export async function resolveEffectiveRole(database: Database, userId: string): Promise<Role> {
  const grants = await listLiveGrants(database, [userId]);
  return highestRole(grants.map((grant) => grant.role));
}

/** The effective role of many accounts at once, keyed by user id. */
export async function resolveEffectiveRoles(
  database: Database,
  userIds: readonly string[],
): Promise<Map<string, Role>> {
  const grants = await listLiveGrants(database, userIds);
  const byUser = new Map<string, GrantableRole[]>();
  for (const grant of grants) {
    byUser.set(grant.userId, [...(byUser.get(grant.userId) ?? []), grant.role]);
  }
  return new Map(userIds.map((userId) => [userId, highestRole(byUser.get(userId) ?? [])]));
}

export async function hasLiveGrant(
  database: Database,
  userId: string,
  role: GrantableRole,
): Promise<boolean> {
  const [grant] = await database
    .select({ id: roleGrants.id })
    .from(roleGrants)
    .where(
      and(
        eq(roleGrants.userId, userId),
        eq(roleGrants.role, role),
        isNull(roleGrants.revokedAt),
      ),
    );
  return grant !== undefined;
}

/**
 * Records elevated access for an account. Re-granting a role the account already holds leaves
 * the original grant and its attribution alone, so the first decision keeps its date.
 */
export async function grantRole(
  database: Database,
  input: {
    userId: string;
    role: GrantableRole;
    source: GrantSource;
    grantedByUserId?: string | null;
    note?: string | null;
  },
): Promise<{ granted: boolean }> {
  if (await hasLiveGrant(database, input.userId, input.role)) {
    return { granted: false };
  }
  await database.insert(roleGrants).values({
    userId: input.userId,
    role: input.role,
    source: input.source,
    grantedByUserId: input.grantedByUserId ?? null,
    grantedAt: new Date(),
    note: input.note ?? null,
  });
  return { granted: true };
}

/** Ends a grant without deleting it, so the history of who decided what survives. */
export async function revokeRole(
  database: Database,
  input: { userId: string; role: GrantableRole; revokedByUserId: string },
): Promise<{ revoked: boolean }> {
  const revokedAt = new Date();
  const revoked = await database
    .update(roleGrants)
    .set({ revokedAt, revokedByUserId: input.revokedByUserId })
    .where(
      and(
        eq(roleGrants.userId, input.userId),
        eq(roleGrants.role, input.role),
        isNull(roleGrants.revokedAt),
      ),
    )
    .returning({ id: roleGrants.id });
  return { revoked: revoked.length > 0 };
}
