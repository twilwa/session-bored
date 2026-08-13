// ABOUTME: Applies deny-by-default role and resource ownership decisions for every request.
// ABOUTME: Distinguishes missing identity from authenticated cross-role access with 401 and 403.
import type { Role } from "../db/schema.ts";
import type { ApiAccess } from "../shared/api.ts";

export interface AccessIdentity {
  /**
   * Every role the account's live grants confer. Access is the union of them, never one of
   * them, so granting a second area really opens that area instead of being hidden behind a
   * wider grant the account already held.
   */
  roles: readonly Role[];
}

export type AccessDecision = { allowed: true } | { allowed: false; status: 401 | 403 };

/** True when a live grant confers this area. Roles never imply one another. */
export function holdsAccess(roles: readonly Role[], requiredAccess: Role): boolean {
  return roles.includes(requiredAccess);
}

export function authorizeAccess(
  identity: AccessIdentity | null,
  requiredAccess: ApiAccess,
  ownsResource = true,
): AccessDecision {
  if (requiredAccess === "public") {
    return { allowed: true };
  }
  if (identity === null) {
    return { allowed: false, status: 401 };
  }
  if (requiredAccess !== "authenticated" && !holdsAccess(identity.roles, requiredAccess)) {
    return { allowed: false, status: 403 };
  }
  if (!ownsResource) {
    return { allowed: false, status: 403 };
  }
  return { allowed: true };
}
