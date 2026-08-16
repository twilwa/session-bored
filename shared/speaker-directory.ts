// ABOUTME: Defines the private cross-event speaker directory contract shared by Worker and client.
// ABOUTME: Keeps directory identity, history, duplicate review, and merge results distinct from event rosters.
export type SpeakerDirectoryDuplicateReason = "same_email" | "same_name_and_organization";

export type SpeakerDirectorySort = "name" | "updated" | "events";

export interface SpeakerDirectoryCustomFieldFilter {
  name: string;
  value: string;
}

export interface SpeakerDirectoryFilters {
  search: string;
  tags: string[];
  customFields: SpeakerDirectoryCustomFieldFilter[];
  sort: SpeakerDirectorySort;
  direction: "asc" | "desc";
  page: number;
  pageSize: number;
}

export type SpeakerDirectorySavedFilters = Omit<SpeakerDirectoryFilters, "page" | "pageSize">;

export interface SpeakerDirectorySegment {
  id: string;
  name: string;
  filters: SpeakerDirectorySavedFilters;
  createdAt: string;
}

export interface SpeakerDirectoryListItem {
  id: string;
  name: string;
  email: string;
  jobTitle: string | null;
  organization: string | null;
  bio: string | null;
  headshotUrl: string | null;
  eventCount: number;
  sessionCount: number;
  proposalCount: number;
  events: string[];
  tags: string[];
  customFields: Record<string, string>;
  possibleDuplicateCount: number;
  updatedAt: string;
}

export interface SpeakerDirectoryListResponse {
  items: SpeakerDirectoryListItem[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  possibleDuplicateGroups: number;
  facets: {
    tags: string[];
    customFields: Array<{ name: string; values: string[] }>;
  };
  overview: {
    people: number;
    events: number;
    sessions: number;
    proposals: number;
    taggedPeople: number;
  };
  savedSegments: SpeakerDirectorySegment[];
}

export interface SpeakerDirectoryMetadata {
  tags: string[];
  customFields: Record<string, string>;
}

export interface SpeakerDirectorySession {
  id: string;
  title: string | null;
  contentStatus: "draft" | "in_review" | "approved";
}

export interface SpeakerDirectoryEvent {
  id: string;
  name: string;
  startDate: string | null;
  endDate: string | null;
  speakerStatus: string | null;
  proposalCount: number;
  sessions: SpeakerDirectorySession[];
}

export interface SpeakerDirectoryNote {
  id: string;
  body: string;
  author: string;
  createdAt: string;
}

export interface SpeakerDirectoryDuplicate {
  id: string;
  name: string;
  email: string;
  organization: string | null;
  eventCount: number;
  sessionCount: number;
  proposalCount: number;
  reasons: SpeakerDirectoryDuplicateReason[];
  accountConflict: boolean;
}

export interface SpeakerDirectoryDetailResponse {
  person: Omit<SpeakerDirectoryListItem, "events"> & {
    twitter: string | null;
    linkedin: string | null;
    socialLinks: Record<string, string> | null;
    events: SpeakerDirectoryEvent[];
  };
  possibleDuplicates: SpeakerDirectoryDuplicate[];
  notes: SpeakerDirectoryNote[];
}

export type SpeakerDirectoryMergeReference =
  | "submission"
  | "submission_speaker"
  | "speaker"
  | "session_speaker"
  | "task_assignee"
  | "file"
  | "speaker_directory_contact_tag"
  | "speaker_directory_custom_field"
  | "speaker_directory_note";

export interface SpeakerDirectoryReferenceMove {
  reference: SpeakerDirectoryMergeReference;
  rowId: string;
  fromId: string;
  toId: string;
}

export interface SpeakerDirectoryRetainedReference {
  reference: SpeakerDirectoryMergeReference;
  rowId: string;
  reason: "target_reference_exists";
}

export interface SpeakerDirectoryMergeConflict {
  reference: "speaker" | "session_speaker";
  rowId: string;
  targetRowId: string;
  reason: "event_speaker_collision" | "standing_differs" | "participation_differs";
}

export interface SpeakerDirectoryMergePlan {
  moves: SpeakerDirectoryReferenceMove[];
  retained: SpeakerDirectoryRetainedReference[];
  conflicts: SpeakerDirectoryMergeConflict[];
}

export interface SpeakerDirectoryMergeResult {
  keptPersonId: string;
  mergedPersonId: string;
  reasons: SpeakerDirectoryDuplicateReason[];
  plan: SpeakerDirectoryMergePlan;
}
