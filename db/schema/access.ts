// ABOUTME: Records which accounts an organizer has granted elevated access, and reviewer invitations.
// ABOUTME: An account with no live grant is an attendee, so attendee is never a stored value.
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date());
const updatedAt = () =>
  integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date());

/** The roles an organizer can grant. `attendee` is the absence of a grant, so it is never stored. */
export const grantableRoles = ["organizer", "reviewer", "speaker"] as const;
export type GrantableRole = (typeof grantableRoles)[number];

/** Which mechanism created a grant, so an organizer can tell a migration's guess from a colleague's decision. */
export const grantSources = ["backfill", "organizer", "acceptance", "reviewer_invite"] as const;
export type GrantSource = (typeof grantSources)[number];

export const roleGrants = sqliteTable(
  "role_grant",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => `rgrant_${crypto.randomUUID().replaceAll("-", "")}`),
    userId: text("user_id").notNull(),
    role: text("role", { enum: grantableRoles }).$type<GrantableRole>().notNull(),
    source: text("source", { enum: grantSources }).$type<GrantSource>().notNull(),
    grantedByUserId: text("granted_by_user_id"),
    grantedAt: integer("granted_at", { mode: "timestamp_ms" }).notNull(),
    note: text("note"),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    revokedByUserId: text("revoked_by_user_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("role_grant_user_idx").on(table.userId, table.revokedAt),
    // One live grant per role per account. Scoping roles to an event later widens this
    // index with the new column rather than reshaping the table.
    uniqueIndex("role_grant_live_unique")
      .on(table.userId, table.role)
      .where(sql`${table.revokedAt} is null`),
    check("role_grant_role_check", sql`${table.role} in ('organizer','reviewer','speaker')`),
    check(
      "role_grant_source_check",
      sql`${table.source} in ('backfill','organizer','acceptance','reviewer_invite')`,
    ),
  ],
);

/** A revocable bearer credential that acts as its account through exactly one live grant. */
export const agentCredentials = sqliteTable(
  "agent_credential",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => `acred_${crypto.randomUUID().replaceAll("-", "")}`),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    role: text("role", { enum: grantableRoles }).$type<GrantableRole>().notNull(),
    roleGrantId: text("role_grant_id").references(() => roleGrants.id),
    secretDigest: text("secret_digest").notNull(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("agent_credential_secret_unique").on(table.secretDigest),
    index("agent_credential_user_idx").on(table.userId, table.revokedAt),
    check("agent_credential_role_check", sql`${table.role} in ('organizer','reviewer','speaker')`),
  ],
);

/**
 * An organizer's offer of reviewer access to an email address. The invitation is the
 * organizer's grant; signing up does not redeem it. Redemption requires proving the address,
 * so it happens on email verification and never before.
 */
export const reviewerInvites = sqliteTable(
  "reviewer_invite",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => `rinv_${crypto.randomUUID().replaceAll("-", "")}`),
    email: text("email").notNull(),
    eventId: text("event_id").notNull(),
    trackIds: text("track_ids", { mode: "json" }).$type<string[]>().notNull(),
    roundIds: text("round_ids", { mode: "json" }).$type<string[]>().notNull(),
    invitedByUserId: text("invited_by_user_id").notNull(),
    redeemedAt: integer("redeemed_at", { mode: "timestamp_ms" }),
    redeemedByUserId: text("redeemed_by_user_id"),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    revokedByUserId: text("revoked_by_user_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("reviewer_invite_email_idx").on(table.email),
    uniqueIndex("reviewer_invite_open_unique")
      .on(table.email, table.eventId)
      .where(sql`${table.redeemedAt} is null and ${table.revokedAt} is null`),
  ],
);
