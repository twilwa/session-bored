// ABOUTME: Defines the complete D1 data contract for event programs and authentication.
// ABOUTME: Assigns permanent prefixed public IDs and exact workflow vocabularies at insert.
import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const submissionStatuses = [
  "draft",
  "submitted",
  "under_review",
  "accepted",
  "maybe",
  "declined",
  "withdrawn",
] as const;
export const speakerStatuses = [
  "invited",
  "confirmed",
  "pending_employer_approval",
  "onboarding",
  "ready",
  "withdrawn",
] as const;
export const sessionContentStatuses = ["draft", "in_review", "approved"] as const;
export const scheduleStatuses = ["unplaced", "tbd", "placed"] as const;
export const roles = ["organizer", "reviewer", "speaker"] as const;

export type SubmissionStatus = (typeof submissionStatuses)[number];
export type SpeakerStatus = (typeof speakerStatuses)[number];
export type SessionContentStatus = (typeof sessionContentStatuses)[number];
export type ScheduleStatus = (typeof scheduleStatuses)[number];
export type Role = (typeof roles)[number];

export const publicIdPrefixes = [
  "usr",
  "evt",
  "trk",
  "fmt",
  "rm",
  "frm",
  "fld",
  "sub",
  "val",
  "psn",
  "spk",
  "ses",
  "rnd",
  "crt",
  "asn",
  "rev",
  "tsk",
  "fil",
  "fver",
  "cmt",
  "eml",
  "emb",
  "strk",
  "sspk",
  "ssnr",
  "rtrk",
  "rpool",
  "tassn",
  "sys",
] as const;

export type PublicIdPrefix = (typeof publicIdPrefixes)[number];

export function createPublicId(prefix: PublicIdPrefix): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

const publicId = (prefix: PublicIdPrefix) =>
  text("id")
    .primaryKey()
    .$defaultFn(() => createPublicId(prefix));
const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date());
const updatedAt = () =>
  integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date());
const deletedAt = () => integer("deleted_at", { mode: "timestamp_ms" });

export const users = sqliteTable(
  "user",
  {
    id: publicId("usr"),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
    image: text("image"),
    role: text("role", { enum: roles }).$type<Role>().notNull().default("speaker"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("user_email_unique").on(table.email),
    check("user_role_check", sql`${table.role} in ('organizer','reviewer','speaker')`),
  ],
);

export const authSessions = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    token: text("token").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("auth_session_token_unique").on(table.token),
    index("auth_session_user_idx").on(table.userId),
  ],
);

export const authAccounts = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("auth_account_user_idx").on(table.userId),
    uniqueIndex("auth_account_provider_unique").on(table.providerId, table.accountId),
  ],
);

export const authVerifications = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("auth_verification_identifier_idx").on(table.identifier)],
);

export const events = sqliteTable(
  "event",
  {
    id: publicId("evt"),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    tagline: text("tagline"),
    description: text("description"),
    startDate: text("start_date"),
    endDate: text("end_date"),
    venue: text("venue"),
    timezone: text("timezone").notNull().default("America/Los_Angeles"),
    branding: text("branding", { mode: "json" }).$type<Record<string, string>>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [uniqueIndex("event_slug_unique").on(table.slug)],
);

export const tracks = sqliteTable(
  "track",
  {
    id: publicId("trk"),
    eventId: text("event_id").notNull().references(() => events.id),
    name: text("name").notNull(),
    description: text("description"),
    color: text("color"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [
    uniqueIndex("track_event_name_unique").on(table.eventId, table.name),
    index("track_event_idx").on(table.eventId),
  ],
);

export const formats = sqliteTable(
  "format",
  {
    id: publicId("fmt"),
    eventId: text("event_id").notNull().references(() => events.id),
    name: text("name").notNull(),
    durationMinutes: integer("duration_minutes"),
    description: text("description"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [uniqueIndex("format_event_name_unique").on(table.eventId, table.name)],
);

export const rooms = sqliteTable(
  "room",
  {
    id: publicId("rm"),
    eventId: text("event_id").notNull().references(() => events.id),
    name: text("name").notNull(),
    capacity: integer("capacity"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [uniqueIndex("room_event_name_unique").on(table.eventId, table.name)],
);

export const forms = sqliteTable(
  "form",
  {
    id: publicId("frm"),
    eventId: text("event_id").notNull().references(() => events.id),
    name: text("name").notNull(),
    publicSlug: text("public_slug").notNull(),
    version: integer("version").notNull().default(1),
    status: text("status", { enum: ["draft", "published", "closed"] })
      .notNull()
      .default("draft"),
    openAt: integer("open_at", { mode: "timestamp_ms" }),
    closeAt: integer("close_at", { mode: "timestamp_ms" }),
    welcomeCopy: text("welcome_copy"),
    confirmationCopy: text("confirmation_copy"),
    confirmationEmailCopy: text("confirmation_email_copy"),
    minimumSpeakers: integer("minimum_speakers").notNull().default(1),
    maximumSpeakers: integer("maximum_speakers"),
    publishedAt: integer("published_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [
    uniqueIndex("form_public_slug_unique").on(table.publicSlug),
    uniqueIndex("form_event_name_version_unique").on(table.eventId, table.name, table.version),
    check("form_minimum_speakers_check", sql`${table.minimumSpeakers} >= 1`),
  ],
);

export const formFields = sqliteTable(
  "form_field",
  {
    id: publicId("fld"),
    formId: text("form_id").notNull().references(() => forms.id),
    key: text("key").notNull(),
    label: text("label").notNull(),
    description: text("description"),
    fieldType: text("field_type", {
      enum: ["short_text", "long_text", "dropdown", "file", "headshot"],
    }).notNull(),
    required: integer("required", { mode: "boolean" }).notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    options: text("options", { mode: "json" }).$type<string[]>(),
    conditionalFieldId: text("conditional_field_id").references(
      (): AnySQLiteColumn => formFields.id,
    ),
    conditionalOperator: text("conditional_operator", { enum: ["equals"] }),
    conditionalValue: text("conditional_value"),
    validation: text("validation", { mode: "json" }).$type<Record<string, string | number>>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [uniqueIndex("form_field_key_unique").on(table.formId, table.key)],
);

export const people = sqliteTable(
  "person",
  {
    id: publicId("psn"),
    userId: text("user_id").references(() => users.id),
    name: text("name").notNull(),
    email: text("email").notNull(),
    jobTitle: text("job_title"),
    organization: text("organization"),
    bio: text("bio"),
    headshotUrl: text("headshot_url"),
    twitter: text("twitter"),
    linkedin: text("linkedin"),
    socialLinks: text("social_links", { mode: "json" }).$type<Record<string, string>>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [
    uniqueIndex("person_email_unique").on(table.email),
    uniqueIndex("person_user_unique").on(table.userId),
  ],
);

export const submissions = sqliteTable(
  "submission",
  {
    id: publicId("sub"),
    eventId: text("event_id").notNull().references(() => events.id),
    formId: text("form_id").notNull().references(() => forms.id),
    formVersion: integer("form_version").notNull(),
    submitterPersonId: text("submitter_person_id").notNull().references(() => people.id),
    formatId: text("format_id").references(() => formats.id),
    status: text("status", { enum: submissionStatuses })
      .$type<SubmissionStatus>()
      .notNull()
      .default("draft"),
    isDraft: integer("is_draft", { mode: "boolean" }).notNull().default(true),
    title: text("title"),
    abstract: text("abstract"),
    titleAtTime: text("title_at_time"),
    orgAtTime: text("org_at_time"),
    audienceLevel: text("audience_level"),
    notesForReviewers: text("notes_for_reviewers"),
    submittedAt: integer("submitted_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [
    index("submission_event_status_idx").on(table.eventId, table.status),
    index("submission_submitter_idx").on(table.submitterPersonId),
    check(
      "submission_status_check",
      sql`${table.status} in ('draft','submitted','under_review','accepted','maybe','declined','withdrawn')`,
    ),
  ],
);

export const submissionValues = sqliteTable(
  "submission_value",
  {
    id: publicId("val"),
    submissionId: text("submission_id").notNull().references(() => submissions.id),
    fieldId: text("field_id").notNull().references(() => formFields.id),
    value: text("value", { mode: "json" }).$type<string | number | boolean | string[] | null>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [uniqueIndex("submission_value_field_unique").on(table.submissionId, table.fieldId)],
);

export const submissionTracks = sqliteTable(
  "submission_track",
  {
    id: publicId("strk"),
    submissionId: text("submission_id").notNull().references(() => submissions.id),
    trackId: text("track_id").notNull().references(() => tracks.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [uniqueIndex("submission_track_unique").on(table.submissionId, table.trackId)],
);

export const speakers = sqliteTable(
  "speaker",
  {
    id: publicId("spk"),
    personId: text("person_id").notNull().references(() => people.id),
    eventId: text("event_id").notNull().references(() => events.id),
    status: text("status", { enum: speakerStatuses })
      .$type<SpeakerStatus>()
      .notNull()
      .default("invited"),
    customFields: text("custom_fields", { mode: "json" }).$type<Record<string, string>>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [
    uniqueIndex("speaker_person_event_unique").on(table.personId, table.eventId),
    check(
      "speaker_status_check",
      sql`${table.status} in ('invited','confirmed','pending_employer_approval','onboarding','ready','withdrawn')`,
    ),
  ],
);

export const submissionSpeakers = sqliteTable(
  "submission_speaker",
  {
    id: publicId("sspk"),
    submissionId: text("submission_id").notNull().references(() => submissions.id),
    personId: text("person_id").notNull().references(() => people.id),
    roleLabel: text("role_label").notNull().default("speaker"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [uniqueIndex("submission_speaker_unique").on(table.submissionId, table.personId)],
);

export const sessions = sqliteTable(
  "program_session",
  {
    id: publicId("ses"),
    eventId: text("event_id").notNull().references(() => events.id),
    submissionId: text("submission_id").references(() => submissions.id),
    trackId: text("track_id").references(() => tracks.id),
    formatId: text("format_id").references(() => formats.id),
    roomId: text("room_id").references(() => rooms.id),
    title: text("title"),
    abstract: text("abstract"),
    contentStatus: text("content_status", { enum: sessionContentStatuses })
      .$type<SessionContentStatus>()
      .notNull()
      .default("draft"),
    scheduleStatus: text("schedule_status", { enum: scheduleStatuses })
      .$type<ScheduleStatus>()
      .notNull()
      .default("unplaced"),
    scheduledDate: text("scheduled_date"),
    startsAt: integer("starts_at", { mode: "timestamp_ms" }),
    endsAt: integer("ends_at", { mode: "timestamp_ms" }),
    directEntry: integer("direct_entry", { mode: "boolean" }).notNull().default(false),
    icsUid: text("ics_uid").notNull(),
    publishedAt: integer("published_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [
    uniqueIndex("session_ics_uid_unique").on(table.icsUid),
    uniqueIndex("session_submission_unique").on(table.submissionId),
    check("session_content_status_check", sql`${table.contentStatus} in ('draft','in_review','approved')`),
    check("session_schedule_status_check", sql`${table.scheduleStatus} in ('unplaced','tbd','placed')`),
  ],
);

export const sessionSpeakers = sqliteTable(
  "session_speaker",
  {
    id: publicId("ssnr"),
    sessionId: text("session_id").notNull().references(() => sessions.id),
    speakerId: text("speaker_id").notNull().references(() => speakers.id),
    roleLabel: text("role_label").notNull().default("speaker"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [uniqueIndex("session_speaker_unique").on(table.sessionId, table.speakerId)],
);

export const reviewRounds = sqliteTable(
  "review_round",
  {
    id: publicId("rnd"),
    eventId: text("event_id").notNull().references(() => events.id),
    name: text("name").notNull(),
    opensAt: integer("opens_at", { mode: "timestamp_ms" }),
    closesAt: integer("closes_at", { mode: "timestamp_ms" }),
    anonymized: integer("anonymized", { mode: "boolean" }).notNull().default(false),
    status: text("status", { enum: ["draft", "open", "closed"] }).notNull().default("draft"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [uniqueIndex("review_round_event_name_unique").on(table.eventId, table.name)],
);

export const scorecardCriteria = sqliteTable(
  "scorecard_criterion",
  {
    id: publicId("crt"),
    roundId: text("round_id").notNull().references(() => reviewRounds.id),
    label: text("label").notNull(),
    description: text("description"),
    criterionType: text("criterion_type", { enum: ["numeric", "dropdown", "free_text"] }).notNull(),
    options: text("options", { mode: "json" }).$type<string[]>(),
    weight: real("weight"),
    required: integer("required", { mode: "boolean" }).notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [uniqueIndex("criterion_round_label_unique").on(table.roundId, table.label)],
);

export const reviewerTracks = sqliteTable(
  "reviewer_track",
  {
    id: publicId("rtrk"),
    eventId: text("event_id").notNull().references(() => events.id),
    reviewerUserId: text("reviewer_user_id").notNull().references(() => users.id),
    trackId: text("track_id").notNull().references(() => tracks.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [uniqueIndex("reviewer_track_unique").on(table.reviewerUserId, table.trackId)],
);

export const reviewerRoundPools = sqliteTable(
  "reviewer_round_pool",
  {
    id: publicId("rpool"),
    roundId: text("round_id").notNull().references(() => reviewRounds.id),
    reviewerUserId: text("reviewer_user_id").notNull().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [uniqueIndex("reviewer_round_pool_unique").on(table.roundId, table.reviewerUserId)],
);

export const reviewAssignments = sqliteTable(
  "review_assignment",
  {
    id: publicId("asn"),
    roundId: text("round_id").notNull().references(() => reviewRounds.id),
    submissionId: text("submission_id").notNull().references(() => submissions.id),
    reviewerUserId: text("reviewer_user_id").notNull().references(() => users.id),
    status: text("status", { enum: ["assigned", "completed", "recused"] })
      .notNull()
      .default("assigned"),
    assignedAt: integer("assigned_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [
    uniqueIndex("review_assignment_unique").on(table.roundId, table.submissionId, table.reviewerUserId),
    index("review_assignment_reviewer_idx").on(table.reviewerUserId, table.status),
  ],
);

export const reviews = sqliteTable(
  "review",
  {
    id: publicId("rev"),
    assignmentId: text("assignment_id").notNull().references(() => reviewAssignments.id),
    authorUserId: text("author_user_id").notNull().references(() => users.id),
    scores: text("scores", { mode: "json" }).$type<Record<string, string | number>>(),
    comment: text("comment"),
    aggregateScore: real("aggregate_score"),
    submittedAt: integer("submitted_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [uniqueIndex("review_assignment_unique_review").on(table.assignmentId)],
);

export const tasks = sqliteTable(
  "task",
  {
    id: publicId("tsk"),
    eventId: text("event_id").notNull().references(() => events.id),
    sessionId: text("session_id").references(() => sessions.id),
    taskType: text("task_type", { enum: ["general", "file_request"] }).notNull().default("general"),
    title: text("title").notNull(),
    instructions: text("instructions"),
    dueAt: integer("due_at", { mode: "timestamp_ms" }),
    status: text("status", { enum: ["draft", "active", "complete"] }).notNull().default("draft"),
    acceptedFileTypes: text("accepted_file_types", { mode: "json" }).$type<string[]>(),
    maximumFileBytes: integer("maximum_file_bytes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [index("task_event_status_idx").on(table.eventId, table.status)],
);

export const taskAssignees = sqliteTable(
  "task_assignee",
  {
    id: publicId("tassn"),
    taskId: text("task_id").notNull().references(() => tasks.id),
    speakerId: text("speaker_id").notNull().references(() => speakers.id),
    status: text("status", { enum: ["assigned", "in_progress", "completed"] })
      .notNull()
      .default("assigned"),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [uniqueIndex("task_assignee_unique").on(table.taskId, table.speakerId)],
);

export const files = sqliteTable(
  "file",
  {
    id: publicId("fil"),
    eventId: text("event_id").notNull().references(() => events.id),
    taskId: text("task_id").references(() => tasks.id),
    sessionId: text("session_id").references(() => sessions.id),
    speakerId: text("speaker_id").references(() => speakers.id),
    displayName: text("display_name").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [index("file_event_idx").on(table.eventId)],
);

export const fileVersions = sqliteTable(
  "file_version",
  {
    id: publicId("fver"),
    fileId: text("file_id").notNull().references(() => files.id),
    version: integer("version").notNull(),
    storageKey: text("storage_key").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    checksum: text("checksum"),
    latest: integer("latest", { mode: "boolean" }).notNull().default(true),
    uploadedByUserId: text("uploaded_by_user_id").notNull().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [
    uniqueIndex("file_version_number_unique").on(table.fileId, table.version),
    uniqueIndex("file_version_storage_key_unique").on(table.storageKey),
  ],
);

export const comments = sqliteTable(
  "comment",
  {
    id: publicId("cmt"),
    submissionId: text("submission_id").references(() => submissions.id),
    fileId: text("file_id").references(() => files.id),
    parentId: text("parent_id").references((): AnySQLiteColumn => comments.id),
    authorUserId: text("author_user_id").notNull().references(() => users.id),
    body: text("body").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [
    index("comment_submission_idx").on(table.submissionId),
    index("comment_file_idx").on(table.fileId),
    check(
      "comment_single_subject_check",
      sql`(${table.submissionId} is not null and ${table.fileId} is null) or (${table.submissionId} is null and ${table.fileId} is not null)`,
    ),
  ],
);

export const emailDispatches = sqliteTable(
  "email_dispatch",
  {
    id: publicId("eml"),
    eventId: text("event_id").notNull().references(() => events.id),
    templateKey: text("template_key"),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    recipients: text("recipients", { mode: "json" }).$type<Array<{ email: string; name?: string }>>().notNull(),
    status: text("status", { enum: ["draft", "queued", "sent", "failed"] }).notNull().default("draft"),
    providerMessageIds: text("provider_message_ids", { mode: "json" }).$type<string[]>(),
    sentAt: integer("sent_at", { mode: "timestamp_ms" }),
    createdByUserId: text("created_by_user_id").notNull().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [index("email_dispatch_event_status_idx").on(table.eventId, table.status)],
);

export const embeds = sqliteTable(
  "embed",
  {
    id: publicId("emb"),
    eventId: text("event_id").notNull().references(() => events.id),
    widgetType: text("widget_type", {
      enum: ["sessions", "speakers", "agenda", "itinerary", "gallery"],
    }).notNull(),
    name: text("name").notNull(),
    config: text("config", { mode: "json" }).$type<Record<string, string | number | boolean>>(),
    publicToken: text("public_token").notNull(),
    status: text("status", { enum: ["draft", "published"] }).notNull().default("draft"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [uniqueIndex("embed_public_token_unique").on(table.publicToken)],
);

export const systemState = sqliteTable("system_state", {
  id: publicId("sys"),
  key: text("key").notNull().unique(),
  value: text("value", { mode: "json" }).$type<Record<string, string>>(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const domainTables = {
  events,
  tracks,
  formats,
  rooms,
  forms,
  formFields,
  submissions,
  submissionValues,
  people,
  speakers,
  sessions,
  reviewRounds,
  scorecardCriteria,
  reviewAssignments,
  reviews,
  tasks,
  files,
  fileVersions,
  comments,
  emailDispatches,
  embeds,
} as const;
