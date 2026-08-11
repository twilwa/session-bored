// ABOUTME: Publishes the typed route and payload contract shared by Worker and client lanes.
// ABOUTME: Covers every PRD module while identifying public, organizer, reviewer, and speaker access.
import type { Role, ScheduleStatus, SessionContentStatus, SpeakerStatus, SubmissionStatus } from "../db/schema.ts";

export type ApiAccess = Role | "authenticated" | "public";
export type ApiMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
export type ApiModule =
  | "agenda"
  | "auth"
  | "communications"
  | "embeds"
  | "events"
  | "files"
  | "forms"
  | "public"
  | "reviews"
  | "sessions"
  | "speakers"
  | "submissions"
  | "tasks";

export interface RouteContract {
  readonly method: ApiMethod;
  readonly path: `/api/${string}`;
  readonly module: ApiModule;
  readonly access: ApiAccess;
}

export const routeMap = {
  session: { method: "GET", path: "/api/session", module: "auth", access: "authenticated" },
  events: { method: "GET", path: "/api/events", module: "events", access: "organizer" },
  event: { method: "GET", path: "/api/events/:eventId", module: "events", access: "organizer" },
  tracks: { method: "GET", path: "/api/events/:eventId/tracks", module: "events", access: "organizer" },
  formats: { method: "GET", path: "/api/events/:eventId/formats", module: "events", access: "organizer" },
  rooms: { method: "GET", path: "/api/events/:eventId/rooms", module: "events", access: "organizer" },
  forms: { method: "GET", path: "/api/events/:eventId/forms", module: "forms", access: "organizer" },
  form: { method: "GET", path: "/api/forms/:formId", module: "forms", access: "organizer" },
  submissions: {
    method: "GET",
    path: "/api/events/:eventId/submissions",
    module: "submissions",
    access: "organizer",
  },
  submission: {
    method: "GET",
    path: "/api/submissions/:submissionId",
    module: "submissions",
    access: "organizer",
  },
  reviewerAssignments: {
    method: "GET",
    path: "/api/reviewer/assignments",
    module: "reviews",
    access: "reviewer",
  },
  reviewerSubmission: {
    method: "GET",
    path: "/api/reviewer/submissions/:submissionId",
    module: "reviews",
    access: "reviewer",
  },
  reviews: { method: "GET", path: "/api/events/:eventId/reviews", module: "reviews", access: "organizer" },
  speakers: {
    method: "GET",
    path: "/api/events/:eventId/speakers",
    module: "speakers",
    access: "organizer",
  },
  speakerContent: {
    method: "GET",
    path: "/api/speaker/content",
    module: "speakers",
    access: "speaker",
  },
  speakerSubmission: {
    method: "GET",
    path: "/api/speaker/submissions/:submissionId",
    module: "submissions",
    access: "speaker",
  },
  submitterSubmissions: {
    method: "GET",
    path: "/api/submitter/submissions",
    module: "submissions",
    access: "authenticated",
  },
  portalProfile: {
    method: "PATCH",
    path: "/api/portal/profile",
    module: "speakers",
    access: "speaker",
  },
  portalHeadshot: {
    method: "POST",
    path: "/api/portal/profile/headshot",
    module: "speakers",
    access: "speaker",
  },
  portalSession: {
    method: "PATCH",
    path: "/api/portal/sessions/:sessionId",
    module: "sessions",
    access: "speaker",
  },
  portalTaskStatus: {
    method: "PATCH",
    path: "/api/portal/tasks/:taskId",
    module: "tasks",
    access: "speaker",
  },
  portalTaskFile: {
    method: "POST",
    path: "/api/portal/tasks/:taskId/files",
    module: "files",
    access: "speaker",
  },
  portalFile: {
    method: "GET",
    path: "/api/portal/files/:fileId",
    module: "files",
    access: "authenticated",
  },
  publicHeadshot: {
    method: "GET",
    path: "/api/public/portal/speakers/:speakerId/headshot",
    module: "public",
    access: "public",
  },
  sessions: {
    method: "GET",
    path: "/api/events/:eventId/sessions",
    module: "sessions",
    access: "organizer",
  },
  tasks: { method: "GET", path: "/api/events/:eventId/tasks", module: "tasks", access: "organizer" },
  files: { method: "GET", path: "/api/events/:eventId/files", module: "files", access: "organizer" },
  emailDispatches: {
    method: "GET",
    path: "/api/events/:eventId/email-dispatches",
    module: "communications",
    access: "organizer",
  },
    agenda: { method: "GET", path: "/api/events/:eventId/agenda", module: "agenda", access: "organizer" },
    updateAgendaSession: {
      method: "PATCH",
      path: "/api/events/:eventId/agenda/sessions/:sessionId",
      module: "agenda",
      access: "organizer",
    },
    publishAgenda: {
      method: "POST",
      path: "/api/events/:eventId/agenda/publish",
      module: "agenda",
      access: "organizer",
    },
  embeds: { method: "GET", path: "/api/events/:eventId/embeds", module: "embeds", access: "organizer" },
  publicCfp: { method: "GET", path: "/api/public/cfp/:slug", module: "public", access: "public" },
  publicSessions: {
    method: "GET",
    path: "/api/public/events/:eventId/sessions",
    module: "public",
    access: "public",
  },
  publicSpeakers: {
    method: "GET",
    path: "/api/public/events/:eventId/speakers",
    module: "public",
    access: "public",
  },
  publicAgenda: {
    method: "GET",
    path: "/api/public/events/:eventId/agenda",
    module: "public",
    access: "public",
  },
  publicEmbed: { method: "GET", path: "/api/public/embeds/:token", module: "public", access: "public" },
  disposition: {
    method: "GET",
    path: "/api/events/:eventId/disposition",
    module: "submissions",
    access: "organizer",
  },
  updateDisposition: {
    method: "PATCH",
    path: "/api/events/:eventId/disposition",
    module: "submissions",
    access: "organizer",
  },
  decisionBatches: {
    method: "POST",
    path: "/api/events/:eventId/decision-batches",
    module: "communications",
    access: "organizer",
  },
  dispatchDecisionBatch: {
    method: "POST",
    path: "/api/events/:eventId/decision-batches/:batchId/dispatch",
    module: "communications",
    access: "organizer",
  },
  retryDecisionNotice: {
    method: "POST",
    path: "/api/events/:eventId/decision-notices/:submissionId/retry",
    module: "communications",
    access: "organizer",
  },
  updateEmailDispatch: {
    method: "PATCH",
    path: "/api/events/:eventId/email-dispatches/:dispatchId",
    module: "communications",
    access: "organizer",
  },
  discardEmailDispatch: {
    method: "DELETE",
    path: "/api/events/:eventId/email-dispatches/:dispatchId",
    module: "communications",
    access: "organizer",
  },
  sendEmailDispatch: {
    method: "POST",
    path: "/api/events/:eventId/email-dispatches/:dispatchId/send",
    module: "communications",
    access: "organizer",
  },
  draftReminders: {
    method: "POST",
    path: "/api/events/:eventId/email-dispatches/reminders/draft",
    module: "communications",
    access: "organizer",
  },
  commsTemplates: {
    method: "GET",
    path: "/api/events/:eventId/comms/templates",
    module: "communications",
    access: "organizer",
  },
  commsRecipients: {
    method: "GET",
    path: "/api/events/:eventId/comms/recipients",
    module: "communications",
    access: "organizer",
  },
  createCommsTemplate: {
    method: "POST",
    path: "/api/events/:eventId/comms/templates",
    module: "communications",
    access: "organizer",
  },
  updateCommsTemplate: {
    method: "PATCH",
    path: "/api/events/:eventId/comms/templates/:key",
    module: "communications",
    access: "organizer",
  },
  removeCommsTemplate: {
    method: "DELETE",
    path: "/api/events/:eventId/comms/templates/:key",
    module: "communications",
    access: "organizer",
  },
  queueCommsTemplateDrafts: {
    method: "POST",
    path: "/api/events/:eventId/comms/templates/:key/drafts",
    module: "communications",
    access: "organizer",
  },
  previewCommsTemplate: {
    method: "POST",
    path: "/api/events/:eventId/comms/templates/:key/preview",
    module: "communications",
    access: "organizer",
  },
  sendCalendarInvite: {
    method: "POST",
    path: "/api/events/:eventId/sessions/:sessionId/calendar-invite",
    module: "communications",
    access: "organizer",
  },
} as const satisfies Record<string, RouteContract>;

export const rosterRouteMap = {
  roster: { method: "GET", path: "/api/events/:eventId/roster", module: "speakers", access: "organizer" },
  addSpeaker: { method: "POST", path: "/api/events/:eventId/speakers", module: "speakers", access: "organizer" },
  updateSpeaker: { method: "PATCH", path: "/api/events/:eventId/speakers/:speakerId", module: "speakers", access: "organizer" },
  tasks: { method: "GET", path: "/api/events/:eventId/tasks", module: "tasks", access: "organizer" },
  createTask: { method: "POST", path: "/api/events/:eventId/tasks", module: "tasks", access: "organizer" },
  missingInformation: {
    method: "GET",
    path: "/api/events/:eventId/missing-information",
    module: "speakers",
    access: "organizer",
  },
  inviteSpeaker: {
    method: "POST",
    path: "/api/events/:eventId/speakers/:speakerId/invitation",
    module: "communications",
    access: "organizer",
  },
} as const satisfies Record<string, RouteContract>;

export interface RosterSpeakerSummary extends SpeakerSummary {
  personId: `psn_${string}`;
  bio: string | null;
  headshotUrl: string | null;
  profile: { bioComplete: boolean; headshotComplete: boolean };
  taskSummary: { total: number; incomplete: number };
}

export interface RosterTaskSummary {
  id: `tsk_${string}`;
  taskType: "general" | "file_request";
  title: string;
  instructions: string | null;
  dueAt: string | null;
  status: "draft" | "active" | "complete";
  assignees: Array<{
    id: `tassn_${string}`;
    speakerId: `spk_${string}`;
    speakerName: string;
    status: "assigned" | "in_progress" | "completed";
  }>;
}

export interface MissingInformationItem {
  speakerId: `spk_${string}`;
  name: string;
  email: string;
  status: SpeakerStatus;
  missingCount: number;
  mostOverdueDays: number;
  missing: Array<{
    kind: "bio" | "file" | "form" | "headshot" | "task";
    label: string;
    taskId: `tsk_${string}` | null;
    dueAt: string | null;
    overdueDays: number;
  }>;
}

export interface EventSummary {
  id: `evt_${string}`;
  slug: string;
  name: string;
  tagline: string | null;
  startDate: string | null;
  endDate: string | null;
  venue: string | null;
  timezone: string;
}

export interface SubmissionSummary {
  id: `sub_${string}`;
  title: string | null;
  status: SubmissionStatus;
  track: string | null;
  format: string | null;
  speaker: string;
}

export interface SubmitterSubmissionSummary {
  id: `sub_${string}`;
  formSlug: string;
  title: string | null;
  status: SubmissionStatus;
  isDraft: boolean;
  submittedAt: string | null;
  updatedAt: string;
}

export interface SpeakerSummary {
  id: `spk_${string}`;
  name: string;
  email: string;
  jobTitle: string | null;
  organization: string | null;
  status: SpeakerStatus;
}

export interface SessionSummary {
  id: `ses_${string}`;
  title: string | null;
  contentStatus: SessionContentStatus;
  scheduleStatus: ScheduleStatus;
  track: string | null;
  format: string | null;
  room: string | null;
  speakers: string[];
}

export type AgendaPlacement =
  | { scheduleStatus: "unplaced" }
  | { scheduleStatus: "tbd"; scheduledDate: string }
  | { scheduleStatus: "placed"; scheduledDate: string; roomId: string; startsAt: number };

export interface AgendaSession {
  id: `ses_${string}`;
  title: string;
  abstract: string | null;
  contentStatus: SessionContentStatus;
  scheduleStatus: ScheduleStatus;
  scheduledDate: string | null;
  startsAt: number | null;
  endsAt: number | null;
  publishedAt: number | null;
  durationMinutes: number;
  track: null | { id: string; name: string; color: string | null };
  room: null | { id: string; name: string };
  speakers: Array<{ id: string; name: string }>;
}

export interface AgendaConflict {
  id: string;
  kind: "room" | "speaker";
  name: string;
  label: string;
  sessionIds: [string, string];
  fixSessionId: string;
  fixLabel: string;
}

export interface AgendaState {
  event: {
    id: string;
    name: string;
    startDate: string;
    endDate: string;
    timezone: string;
  };
  days: string[];
  rooms: Array<{ id: string; name: string }>;
  tracks: Array<{ id: string; name: string; color: string | null }>;
  sessions: AgendaSession[];
  conflicts: AgendaConflict[];
  metrics: { unplaced: number; conflicts: number; tbd: number };
}

export interface PortalProfile {
  speakerId: `spk_${string}`;
  personId: `psn_${string}`;
  name: string;
  email: string;
  jobTitle: string | null;
  organization: string | null;
  bio: string | null;
  headshotUrl: string | null;
  twitter: string | null;
  linkedin: string | null;
  socialLinks: Record<string, string> | null;
  status: SpeakerStatus;
}

export interface PortalSession {
  id: `ses_${string}`;
  title: string | null;
  abstract: string | null;
  contentStatus: SessionContentStatus;
  editable: boolean;
}

export interface PortalTaskFile {
  taskId: `tsk_${string}`;
  fileId: `fil_${string}`;
  displayName: string;
  version: number;
}

export interface PortalFileVersion {
  version: number;
  displayName: string;
  sizeBytes: number;
  uploadedAt: string;
  current: boolean;
  downloadUrl: string;
}

export interface PortalFile {
  taskId: `tsk_${string}`;
  fileId: `fil_${string}`;
  taskTitle: string;
  displayName: string;
  version: number;
  archived: boolean;
  downloadUrl: string;
  versions: PortalFileVersion[];
}

export type PortalTaskAssigneeStatus = "assigned" | "in_progress" | "completed";

export interface PortalTask {
  id: `tsk_${string}`;
  title: string;
  instructions: string | null;
  taskType: "general" | "file_request";
  dueAt: string | null;
  status: PortalTaskAssigneeStatus;
  acceptedFileTypes: string[] | null;
  maximumFileBytes: number | null;
  file: PortalTaskFile | null;
}

/**
 * What a speaker is allowed to know about their own proposal. Committee vocabulary
 * (`maybe`, and any decision before its letter is dispatched) never reaches a speaker,
 * so the portal reads this instead of `submission.status`.
 */
export type SpeakerFacingSubmissionStatus =
  | "draft"
  | "submitted"
  | "in_review"
  | "accepted"
  | "not_selected"
  | "withdrawn";

export const speakerFacingSubmissionLabels: Record<SpeakerFacingSubmissionStatus, string> = {
  draft: "Draft",
  submitted: "Submitted",
  in_review: "In review",
  accepted: "Accepted",
  not_selected: "Not selected",
  withdrawn: "Withdrawn",
};

/**
 * A decision reaches the speaker only once it has actually been communicated: either the
 * organizer dispatched its decision letter, or the acceptance already produced the session
 * and onboarding work the speaker is looking at in their own portal. Everything still under
 * deliberation reads as "In review".
 */
export function speakerFacingSubmissionStatus(submission: {
  status: SubmissionStatus;
  decisionNotified: boolean;
  hasOwnSession: boolean;
}): SpeakerFacingSubmissionStatus {
  switch (submission.status) {
    case "draft":
      return "draft";
    case "submitted":
      return "submitted";
    case "withdrawn":
      return "withdrawn";
    case "accepted":
      return submission.decisionNotified || submission.hasOwnSession ? "accepted" : "in_review";
    case "declined":
      return submission.decisionNotified ? "not_selected" : "in_review";
    default:
      return "in_review";
  }
}

export interface PortalSubmissionSummary {
  id: `sub_${string}`;
  title: string | null;
  speakerStatus: SpeakerFacingSubmissionStatus;
}

export interface SpeakerContentPayload {
  profile: PortalProfile | null;
  submissions: PortalSubmissionSummary[];
  sessions: PortalSession[];
  tasks: PortalTask[];
  files: PortalFile[];
}

export interface FoundationStub<T> {
  status: "foundation_stub";
  module: ApiModule;
  items: T[];
}

export const cfpRouteMap = {
  createSubmission: {
    method: "POST",
    path: "/api/public/cfp/:slug/submissions",
    module: "submissions",
    access: "public",
  },
  readOwnSubmission: {
    method: "GET",
    path: "/api/public/cfp/:slug/submissions/:submissionId",
    module: "submissions",
    access: "public",
  },
  editOwnSubmission: {
    method: "PATCH",
    path: "/api/public/cfp/:slug/submissions/:submissionId",
    module: "submissions",
    access: "public",
  },
} as const satisfies Record<string, RouteContract>;

export type CfpAvailabilityState = "closed" | "open" | "upcoming" | "unpublished";
export type CfpSubmissionIntent = "draft" | "save" | "submit";

export interface CfpAuthorInput {
  name?: string;
  email?: string;
  jobTitle?: string;
  organization?: string;
  bio?: string;
}

export interface CfpProposalInput {
  title?: string;
  abstract?: string;
  track?: string;
  format?: string;
  audienceLevel?: string;
  notesForReviewers?: string;
  answers?: Record<string, string | number | boolean | string[] | null>;
}

export interface CfpSubmissionWrite {
  intent: CfpSubmissionIntent;
  speaker: CfpAuthorInput;
  proposal: CfpProposalInput;
}

export interface CfpOwnSubmission {
  id: `sub_${string}`;
  formVersion: number;
  status: SubmissionStatus;
  isDraft: boolean;
  title: string | null;
  abstract: string | null;
  track: string | null;
  format: string | null;
  audienceLevel: string | null;
  notesForReviewers: string | null;
  answers: Record<string, string | number | boolean | string[] | null>;
  submittedAt: string | null;
  updatedAt: string;
  speaker: {
    id: `psn_${string}`;
    speakerId: `spk_${string}`;
    name: string;
    email: string;
    jobTitle: string | null;
    organization: string | null;
    bio: string | null;
  };
}

export const cfpBuilderRouteMap = {
  listForms: {
    method: "GET",
    path: "/api/cfp-builder/events/:eventId/forms",
    module: "forms",
    access: "organizer",
  },
  createForm: {
    method: "POST",
    path: "/api/cfp-builder/events/:eventId/forms",
    module: "forms",
    access: "organizer",
  },
  readForm: {
    method: "GET",
    path: "/api/cfp-builder/forms/:formId",
    module: "forms",
    access: "organizer",
  },
  saveForm: {
    method: "PUT",
    path: "/api/cfp-builder/forms/:formId",
    module: "forms",
    access: "organizer",
  },
  publishForm: {
    method: "POST",
    path: "/api/cfp-builder/forms/:formId/publish",
    module: "forms",
    access: "organizer",
  },
  closeForm: {
    method: "POST",
    path: "/api/cfp-builder/forms/:formId/close",
    module: "forms",
    access: "organizer",
  },
  readSubmissionForm: {
    method: "GET",
    path: "/api/cfp-builder/submissions/:submissionId",
    module: "submissions",
    access: "organizer",
  },
} as const satisfies Record<string, RouteContract>;

export type CfpBuilderFieldType = "dropdown" | "long_text" | "short_text";
export type CfpBuilderVersionStatus = "closed" | "draft" | "published";

export interface CfpBuilderField {
  id?: string;
  key: string;
  label: string;
  description: string | null;
  fieldType: CfpBuilderFieldType;
  required: boolean;
  sortOrder: number;
  options: string[] | null;
  conditional: {
    fieldKey: string;
    operator: "equals";
    value: string;
  } | null;
}

export interface CfpBuilderVersion {
  id: string;
  formId: string;
  version: number;
  status: CfpBuilderVersionStatus;
  openAt: string | null;
  closeAt: string | null;
  welcomeCopy: string | null;
  confirmationCopy: string | null;
  confirmationEmailCopy: string | null;
  minimumSpeakers: number;
  maximumSpeakers: number | null;
  publishedAt: string | null;
}

export interface CfpBuilderFormSummary {
  id: string;
  eventId: string;
  name: string;
  publicSlug: string;
  version: number;
  status: CfpBuilderVersionStatus;
}

export interface CfpBuilderFormDetail {
  form: CfpBuilderFormSummary;
  selectedVersion: CfpBuilderVersion;
  versions: CfpBuilderVersion[];
  fields: CfpBuilderField[];
  publicUrl: string;
}

export interface CfpBuilderVersionInput {
  welcomeCopy: string | null;
  confirmationCopy: string | null;
  confirmationEmailCopy: string | null;
  openAt: string | null;
  closeAt: string | null;
  minimumSpeakers: number;
  maximumSpeakers: number | null;
  fields: CfpBuilderField[];
}

export type DecisionStatus = "accepted" | "maybe" | "declined";

export interface DecisionNoticeSummary {
  outcome: DecisionStatus;
  deliveryStatus: "queued" | "sent" | "failed";
  queuedAt: string;
}

export interface DispositionSummary {
  id: `sub_${string}`;
  title: string | null;
  status: SubmissionStatus;
  recipientName: string;
  recipientEmail: string;
  track: string | null;
  format: string | null;
  handoff: null | {
    sessionId: `ses_${string}`;
    active: boolean;
    retained: boolean;
  };
  notice: DecisionNoticeSummary | null;
  diverged: boolean;
}

export interface DecisionBatchPreview {
  id: `eml_${string}`;
  status: "draft" | "queued";
  items: Array<{
    id: `eml_${string}`;
    submissionId: `sub_${string}`;
    recipientName: string;
    recipientEmail: string;
    outcome: DecisionStatus;
    subject: string;
    body: string;
  }>;
}

export type EmailDispatchStatus = "draft" | "queued" | "sent" | "failed";

export interface EmailDispatchRecipient {
  email: string;
  name?: string;
}

export interface EmailDispatchSummary {
  id: `eml_${string}`;
  templateKey: string | null;
  subject: string;
  body: string;
  recipients: EmailDispatchRecipient[];
  status: EmailDispatchStatus;
  providerMessageIds: string[] | null;
  failureReason: string | null;
  sentAt: string | null;
  createdAt: string;
}

export interface CommsTemplateDescriptor {
  key: string;
  name: string;
  mergeFields: readonly string[];
  editable: boolean;
  subject: string | null;
  body: string | null;
}

export const reviewRouteMap = {
  queue: { method: "GET", path: "/api/review/queue", module: "reviews", access: "reviewer" },
  submission: {
    method: "GET",
    path: "/api/review/submissions/:submissionId",
    module: "reviews",
    access: "authenticated",
  },
  comments: {
    method: "POST",
    path: "/api/review/submissions/:submissionId/comments",
    module: "reviews",
    access: "authenticated",
  },
  score: {
    method: "POST",
    path: "/api/review/submissions/:submissionId/reviews",
    module: "reviews",
    access: "reviewer",
  },
  status: {
    method: "PATCH",
    path: "/api/review/submissions/:submissionId/status",
    module: "reviews",
    access: "organizer",
  },
  worklist: {
    method: "GET",
    path: "/api/review/events/:eventId/worklist",
    module: "reviews",
    access: "organizer",
  },
  config: {
    method: "GET",
    path: "/api/review/events/:eventId/config",
    module: "reviews",
    access: "organizer",
  },
  reviewers: {
    method: "POST",
    path: "/api/review/events/:eventId/reviewers",
    module: "reviews",
    access: "organizer",
  },
  rounds: {
    method: "POST",
    path: "/api/review/events/:eventId/rounds",
    module: "reviews",
    access: "organizer",
  },
  criteria: {
    method: "POST",
    path: "/api/review/rounds/:roundId/criteria",
    module: "reviews",
    access: "organizer",
  },
  criterionUpdate: {
    method: "PATCH",
    path: "/api/review/criteria/:criterionId",
    module: "reviews",
    access: "organizer",
  },
  criterionRemove: {
    method: "DELETE",
    path: "/api/review/criteria/:criterionId",
    module: "reviews",
    access: "organizer",
  },
  assignments: {
    method: "POST",
    path: "/api/review/rounds/:roundId/assignments",
    module: "reviews",
    access: "organizer",
  },
} as const satisfies Record<string, RouteContract>;

export type ReviewSort = "coverage" | "score";

export interface ReviewWorklistItem {
  submissionId: string;
  title: string | null;
  status: SubmissionStatus;
  submittedAt: string | null;
  tracks: string[];
  ratingCount: number;
  averageScore: number | null;
}

export interface ReviewProgress {
  completedReadSlots: number;
  totalReadSlots: number;
  targetReviews: number;
}

export interface ReviewCriterion {
  id: string;
  roundId: string;
  label: string;
  description: string | null;
  criterionType: "numeric" | "dropdown" | "free_text";
  options: string[] | null;
  weight: number | null;
  required: boolean;
}

export type AIReviewAssistance =
  | { status: "disabled" }
  | { status: "available" }
  | { status: "unavailable" }
  | {
    status: "ready";
    suggestionId: string;
    attribution: string;
    summary: string;
    suggestedScores: Record<string, string | number>;
    reasoning: Record<string, string>;
    cached: boolean;
  };

export interface ReviewComment {
  id: string;
  body: string;
  createdAt: string;
  author: { id: string; name: string };
}

export interface ReviewSubmissionDetail {
  id: string;
  eventId: string;
  title: string | null;
  abstract: string | null;
  status: SubmissionStatus;
  audienceLevel: string | null;
  notesForReviewers: string | null;
  format: { id: string; name: string | null } | null;
  round: { id: string; name: string; anonymized: boolean } | null;
  tracks: Array<{ id: string; name: string }>;
  answers: Array<{
    key: string;
    label: string;
    value: string | number | boolean | string[] | null;
  }>;
  participants: Array<{
    id: string;
    name: string;
    jobTitle: string | null;
    organization: string | null;
    roleLabel: string;
  }>;
  criteria: ReviewCriterion[];
  reviews: Array<{
    id: string;
    scores: Record<string, string | number> | null;
    comment: string | null;
    aggregateScore: number | null;
    submittedAt: string | null;
    author: { id: string; name: string };
    round: { id: string; name: string };
  }>;
  comments: ReviewComment[];
}

export interface PublicSpeakerRef {
  id: string;
  name: string;
  jobTitle: string | null;
  organization: string | null;
}

export interface PublicSessionCard {
  id: string;
  title: string | null;
  abstract: string | null;
  track: string | null;
  format: string | null;
  room: string | null;
  scheduledDate: string | null;
  startsAt: number | null;
  endsAt: number | null;
  scheduleStatus: string;
  speakers: PublicSpeakerRef[];
}

export interface PublicSpeakerCard {
  id: string;
  name: string;
  jobTitle: string | null;
  organization: string | null;
  bio: string | null;
  headshotUrl: string | null;
  twitter: string | null;
  linkedin: string | null;
  sessionCount: number;
}

export interface PublicSpeakerSession {
  id: string;
  title: string | null;
  scheduledDate: string | null;
  startsAt: number | null;
  endsAt: number | null;
  room: string | null;
  track: string | null;
}

export interface PublicSpeakerDetail extends PublicSpeakerCard {
  sessions: PublicSpeakerSession[];
}

export interface PublicEventFacets {
  event: {
    id: string;
    name: string;
    tagline: string | null;
    startDate: string | null;
    endDate: string | null;
    venue: string | null;
    timezone: string;
  };
  tracks: string[];
  formats: string[];
  rooms: string[];
  days: string[];
}

export interface PublicSessionsResponse {
  items: PublicSessionCard[];
  total: number;
  filtered: number;
  facets: PublicEventFacets;
}

export interface PublicSpeakersResponse {
  items: PublicSpeakerCard[];
  total: number;
  filtered: number;
  facets: PublicEventFacets;
}

export interface PublicSpeakerDetailResponse {
  speaker: PublicSpeakerDetail;
  facets: PublicEventFacets;
}
