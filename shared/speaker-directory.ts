// ABOUTME: Defines the private cross-event speaker directory contract shared by Worker and client.
// ABOUTME: Keeps directory identity, history, duplicate review, and merge results distinct from event rosters.
export type SpeakerDirectoryDuplicateReason = "same_email" | "same_name_and_organization";

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
  possibleDuplicateCount: number;
  updatedAt: string;
}

export interface SpeakerDirectoryListResponse {
  items: SpeakerDirectoryListItem[];
  possibleDuplicateGroups: number;
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
}

export interface SpeakerDirectoryMergeResult {
  keptPersonId: string;
  mergedPersonId: string;
  reasons: SpeakerDirectoryDuplicateReason[];
}
