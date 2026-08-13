// ABOUTME: Declares the protected workspace pages that are served through the Worker.
// ABOUTME: Keeps the page access gates and asset-routing registration in one audited route table.
import type { ApiAccess } from "../shared/api.ts";

export const protectedPageRoutes = [
  { path: "/organizer", access: "organizer" },
  { path: "/reviewer", access: "reviewer" },
  { path: "/speaker", access: "speaker" },
  { path: "/submitter", access: "authenticated" },
] as const satisfies ReadonlyArray<{ path: string; access: ApiAccess }>;
