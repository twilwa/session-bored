// ABOUTME: Applies deny-by-default role and resource ownership decisions for every request.
// ABOUTME: Distinguishes missing identity from authenticated cross-role access with 401 and 403.
import type { Role } from "../db/schema.ts";
import type { ApiAccess } from "../shared/api.ts";

export interface AccessIdentity {
  role: Role;
}

export type AccessDecision = { allowed: true } | { allowed: false; status: 401 | 403 };

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
  if (requiredAccess !== "authenticated" && identity.role !== requiredAccess) {
    return { allowed: false, status: 403 };
  }
  if (!ownsResource) {
    return { allowed: false, status: 403 };
  }
  return { allowed: true };
}
