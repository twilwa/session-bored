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
} as const satisfies Record<string, RouteContract>;

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
