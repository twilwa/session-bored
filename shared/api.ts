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
  | "exports"
  | "files"
  | "forms"
  | "people"
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
  createTrack: { method: "POST", path: "/api/events/:eventId/tracks", module: "events", access: "organizer" },
  updateTrack: { method: "PATCH", path: "/api/events/:eventId/tracks/:trackId", module: "events", access: "organizer" },
  removeTrack: { method: "DELETE", path: "/api/events/:eventId/tracks/:trackId", module: "events", access: "organizer" },
  formats: { method: "GET", path: "/api/events/:eventId/formats", module: "events", access: "organizer" },
  rooms: { method: "GET", path: "/api/events/:eventId/rooms", module: "events", access: "organizer" },
  createRoom: { method: "POST", path: "/api/events/:eventId/rooms", module: "events", access: "organizer" },
  updateRoom: { method: "PATCH", path: "/api/events/:eventId/rooms/:roomId", module: "events", access: "organizer" },
  removeRoom: { method: "DELETE", path: "/api/events/:eventId/rooms/:roomId", module: "events", access: "organizer" },
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
  deliverables: {
    method: "GET",
    path: "/api/events/:eventId/deliverables",
    module: "files",
    access: "organizer",
  },
  fileComments: {
    method: "GET",
    path: "/api/content/files/:fileId/comments",
    module: "files",
    access: "authenticated",
  },
  createFileComment: {
    method: "POST",
    path: "/api/content/files/:fileId/comments",
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
  emailSender: {
    method: "GET",
    path: "/api/email-sender",
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
    updateAgendaSessionContent: {
      method: "PATCH",
      path: "/api/events/:eventId/agenda/sessions/:sessionId/content",
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
  createEmbed: { method: "POST", path: "/api/events/:eventId/embeds", module: "embeds", access: "organizer" },
  updateEmbed: { method: "PATCH", path: "/api/events/:eventId/embeds/:embedId", module: "embeds", access: "organizer" },
  removeEmbed: { method: "DELETE", path: "/api/events/:eventId/embeds/:embedId", module: "embeds", access: "organizer" },
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
  cancelDecisionNotice: {
    method: "POST",
    path: "/api/events/:eventId/decision-notices/:submissionId/cancel",
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
  exportSessions: {
    method: "GET",
    path: "/api/events/:eventId/exports/sessions.json",
    module: "exports",
    access: "organizer",
  },
  exportSpeakers: {
    method: "GET",
    path: "/api/events/:eventId/exports/speakers.json",
    module: "exports",
    access: "organizer",
  },
  exportReviews: {
    method: "GET",
    path: "/api/events/:eventId/exports/reviews.csv",
    module: "exports",
    access: "organizer",
  },
  exportSchedule: {
    method: "GET",
    path: "/api/events/:eventId/exports/schedule.ics",
    module: "exports",
    access: "organizer",
  },
} as const satisfies Record<string, RouteContract>;

/**
 * Access is platform-wide today: a grant opens an area everywhere, not on one event. Scoping
 * a grant to an event is issue #120 and would add the event to these paths, not replace them.
 */
export const peopleRouteMap = {
  people: { method: "GET", path: "/api/people", module: "people", access: "organizer" },
  grantRole: { method: "POST", path: "/api/people/:userId/grants", module: "people", access: "organizer" },
  revokeRole: { method: "DELETE", path: "/api/people/:userId/grants/:role", module: "people", access: "organizer" },
  inviteReviewer: {
    method: "POST",
    path: "/api/events/:eventId/reviewer-invites",
    module: "people",
    access: "organizer",
  },
  revokeReviewerInvite: {
    method: "DELETE",
    path: "/api/reviewer-invites/:inviteId",
    module: "people",
    access: "organizer",
  },
} as const satisfies Record<string, RouteContract>;

/** What an account has actually done here, so an organizer never grants blind. */
export interface PersonAccountEvidence {
  kind: "programmed" | "proposals" | "none";
  programmedSessions: number;
  proposals: number;
}

export interface PersonAccountGrant {
  role: "organizer" | "reviewer" | "speaker";
  source: "backfill" | "organizer" | "acceptance" | "reviewer_invite";
  note: string | null;
  grantedAt: string;
  grantedByName: string | null;
}

export interface PersonAccountSummary {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  joinedAt: string;
  signInMethods: string[];
  evidence: PersonAccountEvidence;
  grants: PersonAccountGrant[];
}

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

/**
 * The program team's own hold on a proposal's participant list. Organizers work the same
 * `submission_speaker` rows the submitter wrote, so an amendment made here survives
 * acceptance exactly as an author-entered participant does.
 */
export const submissionParticipantRouteMap = {
  submissionParticipants: {
    method: "GET",
    path: "/api/events/:eventId/submissions/:submissionId/participants",
    module: "submissions",
    access: "organizer",
  },
  addSubmissionParticipant: {
    method: "POST",
    path: "/api/events/:eventId/submissions/:submissionId/participants",
    module: "submissions",
    access: "organizer",
  },
  updateSubmissionParticipant: {
    method: "PATCH",
    path: "/api/events/:eventId/submissions/:submissionId/participants/:participantId",
    module: "submissions",
    access: "organizer",
  },
  removeSubmissionParticipant: {
    method: "DELETE",
    path: "/api/events/:eventId/submissions/:submissionId/participants/:participantId",
    module: "submissions",
    access: "organizer",
  },
} as const satisfies Record<string, RouteContract>;

/**
 * Participants as the program team sees them. Organizers already hold speaker contact
 * details across the roster, so this projection carries email; `onSession` reports whether
 * the participant has already been carried into the accepted session.
 */
export interface SubmissionParticipantSummary {
  id: `sspk_${string}`;
  personId: `psn_${string}`;
  name: string;
  email: string;
  roleLabel: string;
  jobTitle: string | null;
  organization: string | null;
  sortOrder: number;
  isSubmitter: boolean;
  onSession: boolean;
}

export interface WithdrawnOnboardingTask {
  taskId: `tsk_${string}`;
  title: string;
}

/**
 * What a removal did, and what it deliberately left standing. Removing a participant from a
 * proposal takes their access to that proposal and its session; it never withdraws the
 * event-scoped speaker row, so the person can stay on the roster, in the public speaker
 * directory, and in the mail recipient list. This reports that rather than leaving the
 * organizer to discover it.
 */
export interface ParticipantRemovalOutcome {
  name: string;
  personId: `psn_${string}`;
  speakerId: `spk_${string}` | null;
  remainsEventSpeaker: boolean;
  listedPublicly: boolean;
  speaksElsewhereAtEvent: boolean;
  /** Every live assignment this removal archived, named for the organizer who acted. */
  withdrawnOnboarding: WithdrawnOnboardingTask[];
  /**
   * Whether this person held a live `session_speaker` row when they were removed, read before
   * the link was archived. Naming somebody on a proposal never carries them onto its session,
   * so a proposal can hold a session this person could never reach.
   */
  heldSessionAccess: boolean;
}

export interface SubmissionParticipantsPayload {
  submissionId: `sub_${string}`;
  sessionId: `ses_${string}` | null;
  /** Null with no session. Approved content is read-only to its speakers, so removal took no write. */
  sessionContentStatus: SessionContentStatus | null;
  participants: SubmissionParticipantSummary[];
  removal?: ParticipantRemovalOutcome;
}

export interface RosterSpeakerSummary extends SpeakerSummary {
  personId: `psn_${string}`;
  bio: string | null;
  headshotUrl: string | null;
  twitter: string | null;
  linkedin: string | null;
  socialLinks: Record<string, string> | null;
  profile: { bioComplete: boolean; headshotComplete: boolean };
  workSummary: { total: number; incomplete: number };
}

export interface RosterTaskSummary {
  id: `tsk_${string}`;
  taskType: "general" | "file_request";
  title: string;
  instructions: string | null;
  acceptedFileTypes: string[] | null;
  maximumFileBytes: number | null;
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
  approvedContent: { title: string | null; abstract: string | null } | null;
  editedSinceApproval: boolean;
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

export type AgendaPublishSkipReason = "content_not_approved" | "not_placed";

export interface AgendaPublishSession {
  id: `ses_${string}`;
  title: string;
}

export interface AgendaPublishSkip extends AgendaPublishSession {
  reasons: AgendaPublishSkipReason[];
}

export interface AgendaPublishResult {
  status: "published";
  publishedAt: number;
  publishedCount: number;
  newlyPublishedCount: number;
  alreadyPublicCount: number;
  published: AgendaPublishSession[];
  skipped: AgendaPublishSkip[];
  message: string;
  notes: string[];
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

export interface ContentComment {
  id: `cmt_${string}`;
  body: string;
  createdAt: string;
  author: { name: string; role: Role };
}

export type DeliverableStatus = "requested" | "overdue" | "completed" | "delivered";

export interface DeliverableItem {
  assignmentId: `tassn_${string}`;
  taskId: `tsk_${string}`;
  speaker: { id: `spk_${string}`; name: string; email: string };
  task: { title: string; instructions: string | null; dueAt: string | null };
  assignment: {
    status: "assigned" | "in_progress" | "completed";
    completedAt: string | null;
  };
  status: DeliverableStatus;
  file: null | {
    id: `fil_${string}`;
    displayName: string;
    version: number;
    mimeType: string;
    sizeBytes: number;
    uploadedAt: string;
    downloadUrl: string;
    versions: PortalFileVersion[];
  };
}

export interface SessionAwaitingApproval {
  id: `ses_${string}`;
  title: string | null;
  contentStatus: "in_review";
  speakers: Array<{ id: `spk_${string}`; name: string }>;
}

export interface DeliverablesPayload {
  generatedAt: string;
  metrics: {
    total: number;
    requested: number;
    overdue: number;
    completed: number;
    delivered: number;
    awaitingApproval: number;
  };
  items: DeliverableItem[];
  sessionsAwaitingApproval: SessionAwaitingApproval[];
}

export type PortalTaskAssigneeStatus = "assigned" | "in_progress" | "completed";

export interface PortalTask {
  id: `tsk_${string}`;
  title: string;
  instructions: string | null;
  taskType: "general" | "file_request";
  dueAt: string | null;
  status: PortalTaskAssigneeStatus;
  /**
   * The types and ceiling the server will actually enforce for this request, already
   * resolved from the task's own declaration and the fallback it belongs to. Null for a
   * general task, which takes no file. Speaker-facing copy renders these values and never
   * restates a type list of its own.
   */
  acceptedFileTypes: string[] | null;
  maximumFileBytes: number | null;
  file: PortalTaskFile | null;
}

/**
 * What a file request asks a speaker for. The declaration itself is the task's
 * `acceptedFileTypes` list, so a picture request is simply one that asks for the same
 * images the speaker's headshot picker takes; a request that declares nothing is a
 * document request, which is what every request created before this choice existed meant.
 */
export type FileRequestKind = "picture" | "document";

/** The images a picture request accepts, matching the speaker headshot picker. */
export const pictureRequestFileTypes = ["png", "jpg", "jpeg", "webp"];

export function fileRequestKindOf(acceptedFileTypes: string[] | null): FileRequestKind {
  if (acceptedFileTypes === null || acceptedFileTypes.length === 0) {
    return "document";
  }
  const requested = acceptedFileTypes.map((fileType) => fileType.toLowerCase());
  return requested.every((fileType) => pictureRequestFileTypes.includes(fileType)) ? "picture" : "document";
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
export type CfpSubmissionIntent = "draft" | "submit";

export interface CfpAuthorInput {
  name?: string;
  email?: string;
  jobTitle?: string;
  organization?: string;
  bio?: string;
}

/**
 * A collaborator the submitter names alongside themselves. The author identifies a
 * collaborator by name and email exactly as they identify themselves; the role label is
 * free text so a proposal can say co-speaker, panellist, moderator, or workshop assistant.
 */
export interface CfpCollaboratorInput {
  name?: string;
  email?: string;
  roleLabel?: string;
  jobTitle?: string;
  organization?: string;
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
  collaborators?: CfpCollaboratorInput[];
  proposal: CfpProposalInput;
}

/**
 * One named participant on a proposal. The author-owned read returns emails because the
 * author supplied them; every other surface projects participants without contact details.
 */
export interface CfpParticipant {
  id: `sspk_${string}`;
  personId: `psn_${string}`;
  name: string;
  email: string;
  roleLabel: string;
  jobTitle: string | null;
  organization: string | null;
  isSubmitter: boolean;
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
  participants: CfpParticipant[];
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
  visibleInBlindReview: boolean;
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
  /**
   * This exact letter. A submission can have several over time - one live, the rest cancelled -
   * so an action taken against what the page displayed must name the letter, not the submission.
   */
  id: `eml_${string}`;
  outcome: DecisionStatus;
  /** `sending` is a claim held for the duration of one provider call. */
  deliveryStatus: "queued" | "sending" | "sent" | "failed";
  queuedAt: string;
  failureReason: string | null;
  /**
   * The address this letter will actually go to, frozen when it was queued. It is not
   * `DispositionSummary.recipientEmail`, which is the person's address as it stands now:
   * correcting the person leaves the queued letter pointing at the old one, and a surface
   * offering to send must show the address it will send to.
   */
  recipientEmail: string;
}

/**
 * Whether this deployment can send email, and the Worker secrets it still
 * needs. `RESEND_API_KEY` and `RESEND_FROM_ADDRESS` are set at deploy time by
 * whoever operates the Worker, so an organizer reading this may not be able to
 * supply them - surfaces that report it must say who can.
 */
export interface EmailSenderStatus {
  connected: boolean;
  missingSecrets: string[];
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

/** `cancelled` belongs only to a decision letter retired before it could send. */
export type EmailDispatchStatus = "draft" | "queued" | "sent" | "failed" | "cancelled";

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
  recusal: {
    method: "POST",
    path: "/api/review/submissions/:submissionId/recusal",
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
  /**
   * Reviewers who declared a conflict on this proposal, each named once. A recusal produces no
   * rating, so without this a recused proposal reads exactly like one nobody has opened.
   */
  recusedBy: string[];
  /**
   * Recused assignments on this proposal, which is the number of scorecards that are not
   * coming. One reviewer recusing in two rounds owes two, so this is not `recusedBy.length`.
   */
  recusedAssignments: number;
}

/**
 * One proposal a reviewer recused themselves from, named so the count can lead an organizer to
 * it. A recusal belongs to a round, and `recusedCount` counts assignments, so the same proposal
 * appears once per round the reviewer stepped back in — each entry says which.
 */
export interface ReviewerRecusal {
  roundId: string;
  roundName: string;
  submissionId: string;
  title: string | null;
}

export interface ReviewProgress {
  completedReadSlots: number;
  totalReadSlots: number;
  targetReviews: number;
}

/**
 * A reviewer's state on one proposal. `unreviewed` covers a proposal readable through track
 * remit that has no assignment row yet; `recused` is a declared conflict that leaves the
 * actionable queue without producing a review.
 */
export type ReviewAssignmentStatus = "assigned" | "completed" | "recused" | "unreviewed";

export interface ReviewRecusalResult {
  submissionId: string;
  roundId: string;
  assignmentId: string;
  assignmentStatus: "recused";
  reviewCreated: false;
  notificationSent: false;
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
  /** The reading reviewer's own assignment state; null for an organizer read. */
  assignmentStatus: ReviewAssignmentStatus | null;
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
  icsUid?: string;
  icsSequence?: number;
  speakers: PublicSpeakerRef[];
}

export type EmbedWidgetType = "sessions" | "speakers" | "agenda" | "itinerary" | "gallery";
export type EmbedStatus = "draft" | "published";

export interface EmbedConfig {
  track?: string;
}

export interface EmbedSummary {
  id: string;
  eventId: string;
  widgetType: EmbedWidgetType;
  name: string;
  config: EmbedConfig | null;
  publicToken: string;
  status: EmbedStatus;
  createdAt: string;
  updatedAt: string;
}

export interface EmbedListResponse {
  items: EmbedSummary[];
}

export interface PublicEmbedResponse {
  embed: EmbedSummary;
  items: Array<PublicSessionCard | PublicSpeakerCard>;
  total: number;
  filtered: number;
  facets: PublicEventFacets;
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
