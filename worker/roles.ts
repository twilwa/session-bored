// ABOUTME: Resolves an account's effective role from its live grants, defaulting to attendee.
// ABOUTME: Owns granting and revoking so attribution and reversal stay in one place.
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";
import {
  type GrantSource,
  type GrantableRole,
  type Role,
  roleGrants,
  users,
} from "../db/schema.ts";

type Database = ReturnType<typeof drizzle>;

/**
 * The order roles are reported in, widest reach first, so the one role a surface can show
 * describes the account by its furthest reach. It never narrows access: what an account may
 * reach is the union of its live grants, which is what `resolveGrantedRoles` answers.
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

/** The roles these grants confer, widest first. No live grant means the account is an attendee. */
function grantedRoles(liveGrants: readonly GrantableRole[]): Role[] {
  const roles = rolePrecedence.filter((role) => liveGrants.includes(role));
  return roles.length === 0 ? ["attendee"] : roles;
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

/**
 * Every role this account may act as, widest first. Authorization reads this rather than one
 * role, so a reviewer who is also granted speaker reaches both areas and neither grant hides
 * the other. An account with no live grant is an attendee.
 */
export async function resolveGrantedRoles(database: Database, userId: string): Promise<Role[]> {
  const grants = await listLiveGrants(database, [userId]);
  return grantedRoles(grants.map((grant) => grant.role));
}

/**
 * The one role that *describes* an account on screen - its widest live grant. Deciding access
 * from this is the bug it exists to avoid: ask `holdsAccess` for that, always.
 */
export function describingRole(roles: readonly Role[]): Role {
  return roles[0] ?? "attendee";
}

/** The widest role this account holds, for describing it. An account with no live grant is an attendee. */
export async function resolveEffectiveRole(database: Database, userId: string): Promise<Role> {
  return describingRole(await resolveGrantedRoles(database, userId));
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
  return new Map(userIds.map((userId) => [userId, grantedRoles(byUser.get(userId) ?? [])[0]!]));
}

export interface GrantedAccount {
  id: string;
  name: string;
  email: string;
}

/**
 * Every account holding a live grant of this role, with the identity a screen shows. Committee
 * setup reads it so a reviewer whose grant predates its remit rows is listed and editable
 * there even without a single track or round: a grant that no screen can complete is a role
 * that cannot be made to work (issue #147). Grants are platform-wide for now, so this answers
 * the same list for every event until #120 scopes them.
 */
export async function listAccountsHoldingRole(
  database: Database,
  role: GrantableRole,
): Promise<GrantedAccount[]> {
  return database
    .selectDistinct({ id: users.id, name: users.name, email: users.email })
    .from(roleGrants)
    .innerJoin(users, eq(roleGrants.userId, users.id))
    .where(and(eq(roleGrants.role, role), isNull(roleGrants.revokedAt)));
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
