// ABOUTME: Builds the private all-event speaker index, metadata facets, and duplicate groups.
// ABOUTME: Aggregates canonical people, organizer metadata, and programme history without changing rosters.
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  directoryMerges,
  events,
  people,
  speakerDirectoryContactTags,
  speakerDirectoryCustomFields,
  speakerDirectoryNotes,
  speakerDirectoryTags,
  sessions,
  sessionSpeakers,
  speakers,
  submissions,
  submissionSpeakers,
  users,
} from "../db/schema.ts";
import type {
  SpeakerDirectoryDuplicateReason,
  SpeakerDirectoryEvent,
  SpeakerDirectoryFilters,
  SpeakerDirectoryListItem,
  SpeakerDirectoryNote,
} from "../shared/speaker-directory.ts";

export interface DuplicateIdentity {
  id: string;
  name: string;
  email: string;
  organization: string | null;
}

export interface PossibleDuplicateGroup {
  personIds: string[];
  reasons: SpeakerDirectoryDuplicateReason[];
}

function normalized(value: string): string {
  return value.normalize("NFKC").trim().replaceAll(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function sharedEmailKey(person: DuplicateIdentity): string {
  return normalized(person.email);
}

function sharedNameAndOrganizationKey(person: DuplicateIdentity): string | null {
  if (person.organization === null) return null;
  const organization = normalized(person.organization);
  if (organization === "") return null;
  return JSON.stringify([normalized(person.name), organization]);
}

export function duplicateReasonsFor(
  first: DuplicateIdentity,
  second: DuplicateIdentity,
): SpeakerDirectoryDuplicateReason[] {
  if (first.id === second.id) return [];
  const reasons: SpeakerDirectoryDuplicateReason[] = [];
  if (sharedEmailKey(first) === sharedEmailKey(second)) {
    reasons.push("same_email");
  }
  const nameAndOrganization = sharedNameAndOrganizationKey(first);
  if (nameAndOrganization !== null && nameAndOrganization === sharedNameAndOrganizationKey(second)) {
    reasons.push("same_name_and_organization");
  }
  return reasons;
}

export interface DuplicateIndex {
  groups: PossibleDuplicateGroup[];
  reasonsByPersonId: Map<string, Map<string, SpeakerDirectoryDuplicateReason[]>>;
}

function bucketsSharing(
  peopleToCompare: DuplicateIdentity[],
  keyOf: (person: DuplicateIdentity) => string | null,
): string[][] {
  const buckets = new Map<string, string[]>();
  for (const person of peopleToCompare) {
    const key = keyOf(person);
    if (key === null) continue;
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [person.id]);
    else bucket.push(person.id);
  }
  return [...buckets.values()].filter((bucket) => bucket.length > 1);
}

/**
 * Collects everyone sharing each comparison key, so a person's duplicates are found by lookup
 * rather than by measuring them against every other record. The reasons recorded for a pair are
 * the same ones `duplicateReasonsFor` answers for it.
 */
export function indexPossibleDuplicates(peopleToCompare: DuplicateIdentity[]): DuplicateIndex {
  const reasonsByPersonId = new Map<string, Map<string, SpeakerDirectoryDuplicateReason[]>>(
    peopleToCompare.map((person) => [person.id, new Map<string, SpeakerDirectoryDuplicateReason[]>()]),
  );
  const matches: Array<[SpeakerDirectoryDuplicateReason, string[][]]> = [
    ["same_email", bucketsSharing(peopleToCompare, sharedEmailKey)],
    ["same_name_and_organization", bucketsSharing(peopleToCompare, sharedNameAndOrganizationKey)],
  ];
  for (const [reason, buckets] of matches) {
    for (const bucket of buckets) {
      for (const personId of bucket) {
        const pairs = reasonsByPersonId.get(personId)!;
        for (const otherId of bucket) {
          if (otherId === personId) continue;
          const reasons = pairs.get(otherId);
          if (reasons === undefined) pairs.set(otherId, [reason]);
          else if (!reasons.includes(reason)) reasons.push(reason);
        }
      }
    }
  }

  const visited = new Set<string>();
  const groups: PossibleDuplicateGroup[] = [];
  for (const personId of [...reasonsByPersonId.keys()].sort()) {
    if (visited.has(personId) || reasonsByPersonId.get(personId)!.size === 0) continue;
    const pending = [personId];
    const personIds: string[] = [];
    const groupReasons = new Set<SpeakerDirectoryDuplicateReason>();
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      personIds.push(current);
      for (const [neighbor, pairReasons] of reasonsByPersonId.get(current) ?? []) {
        for (const reason of pairReasons) groupReasons.add(reason);
        if (!visited.has(neighbor)) pending.push(neighbor);
      }
    }
    groups.push({
      personIds: personIds.sort(),
      reasons: [...groupReasons].sort(),
    });
  }
  return { groups, reasonsByPersonId };
}

export function possibleDuplicateGroups(peopleToCompare: DuplicateIdentity[]): PossibleDuplicateGroup[] {
  return indexPossibleDuplicates(peopleToCompare).groups;
}

type FilterableDirectoryItem = Pick<
  SpeakerDirectoryListItem,
  | "id"
  | "name"
  | "email"
  | "organization"
  | "jobTitle"
  | "events"
  | "tags"
  | "customFields"
  | "eventCount"
  | "updatedAt"
>;

export interface FilteredSpeakerDirectory<Item extends FilterableDirectoryItem> {
  items: Item[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

/**
 * Applies every organizer criterion before sorting and slicing one stable page. Values use the
 * same normalization as duplicate review so casing and incidental spacing do not change a match.
 */
export function filterSpeakerDirectory<Item extends FilterableDirectoryItem>(
  items: Item[],
  filters: SpeakerDirectoryFilters,
): FilteredSpeakerDirectory<Item> {
  const search = normalized(filters.search);
  const tags = filters.tags.map(normalized).filter((tag) => tag !== "");
  const customFields = filters.customFields
    .map((field) => ({ name: normalized(field.name), value: normalized(field.value) }))
    .filter((field) => field.name !== "" && field.value !== "");
  const matching = items.filter((item) => {
    const itemTags = new Set(item.tags.map(normalized));
    if (!tags.every((tag) => itemTags.has(tag))) return false;
    const itemFields = new Map(
      Object.entries(item.customFields).map(([name, value]) => [normalized(name), normalized(value)]),
    );
    if (!customFields.every((field) => itemFields.get(field.name) === field.value)) return false;
    if (search === "") return true;
    return [
      item.name,
      item.email,
      item.organization,
      item.jobTitle,
      ...item.events,
      ...item.tags,
      ...Object.keys(item.customFields),
      ...Object.values(item.customFields),
    ].some((value) => value !== null && normalized(value).includes(search));
  });
  const direction = filters.direction === "desc" ? -1 : 1;
  matching.sort((first, second) => {
    let order: number;
    if (filters.sort === "updated") order = first.updatedAt.localeCompare(second.updatedAt);
    else if (filters.sort === "events") order = first.eventCount - second.eventCount;
    else order = first.name.localeCompare(second.name);
    if (order === 0) order = first.id.localeCompare(second.id);
    return order * direction;
  });
  const pageSize = Math.max(1, Math.min(100, Math.trunc(filters.pageSize)));
  const pageCount = Math.max(1, Math.ceil(matching.length / pageSize));
  const page = Math.max(1, Math.min(pageCount, Math.trunc(filters.page)));
  const offset = (page - 1) * pageSize;
  return {
    items: matching.slice(offset, offset + pageSize),
    total: matching.length,
    page,
    pageSize,
    pageCount,
  };
}

type Database = ReturnType<typeof drizzle>;

/**
 * Resolves a normalized email to the person new work should attach to. When the email's
 * person row was merged away, the recorded merge leads to the person the organizer kept,
 * so adopting a duplicate's address never links live work to an archived record.
 *
 * Every writer stores an address already lowercased, so the match is an equality against the
 * column `person_email_unique` covers. Comparing `lower(email)` instead would read past that
 * index on every person-adoption door, and against a column whose uniqueness is not
 * case-folded it could answer a different row than a caller's own lookup did.
 */
export async function resolvePersonByEmail(
  database: Database,
  normalizedEmail: string,
): Promise<typeof people.$inferSelect | undefined> {
  const [person] = await database
    .select()
    .from(people)
    .where(eq(people.email, normalizedEmail.trim().toLowerCase()));
  if (person === undefined) return undefined;
  const visited = new Set([person.id]);
  let current = person;
  while (current.deletedAt !== null) {
    const [merge] = await database
      .select({ keptPersonId: directoryMerges.keptPersonId })
      .from(directoryMerges)
      .where(eq(directoryMerges.mergedPersonId, current.id));
    if (merge === undefined || visited.has(merge.keptPersonId)) return current;
    visited.add(merge.keptPersonId);
    const [kept] = await database.select().from(people).where(eq(people.id, merge.keptPersonId));
    if (kept === undefined) return current;
    current = kept;
  }
  return current;
}

type DirectoryPerson = DuplicateIdentity & {
  userId: string | null;
  twitter: string | null;
  linkedin: string | null;
  socialLinks: Record<string, string> | null;
};

interface DirectorySnapshot {
  items: SpeakerDirectoryListItem[];
  people: DirectoryPerson[];
  itemsById: Map<string, SpeakerDirectoryListItem>;
  peopleById: Map<string, DirectoryPerson>;
  eventHistory: Map<string, SpeakerDirectoryEvent[]>;
  duplicateReasonsByPersonId: Map<string, Map<string, SpeakerDirectoryDuplicateReason[]>>;
  groups: PossibleDuplicateGroup[];
}

function byPersonId<Row extends { personId: string }>(rows: Row[]): Map<string, Row[]> {
  const grouped = new Map<string, Row[]>();
  for (const row of rows) {
    const existing = grouped.get(row.personId);
    if (existing === undefined) grouped.set(row.personId, [row]);
    else existing.push(row);
  }
  return grouped;
}

export async function loadSpeakerDirectory(database: Database): Promise<DirectorySnapshot> {
  const [personRows, speakerRows, proposalRows, sessionRows, tagRows, customFieldRows] = await Promise.all([
    database.select({
      id: people.id,
      userId: people.userId,
      name: people.name,
      email: people.email,
      jobTitle: people.jobTitle,
      organization: people.organization,
      bio: people.bio,
      headshotUrl: people.headshotUrl,
      twitter: people.twitter,
      linkedin: people.linkedin,
      socialLinks: people.socialLinks,
      updatedAt: people.updatedAt,
    }).from(people).where(isNull(people.deletedAt)).orderBy(asc(people.name), asc(people.email)),
    database.select({
      personId: people.id,
      eventId: events.id,
      eventName: events.name,
      startDate: events.startDate,
      endDate: events.endDate,
      status: speakers.status,
    })
      .from(speakers)
      .innerJoin(people, eq(speakers.personId, people.id))
      .innerJoin(events, eq(speakers.eventId, events.id))
      .where(and(isNull(people.deletedAt), isNull(events.deletedAt))),
    database.select({
      personId: people.id,
      submissionId: submissions.id,
      eventId: events.id,
      eventName: events.name,
      startDate: events.startDate,
      endDate: events.endDate,
    })
      .from(submissionSpeakers)
      .innerJoin(people, eq(submissionSpeakers.personId, people.id))
      .innerJoin(submissions, eq(submissionSpeakers.submissionId, submissions.id))
      .innerJoin(events, eq(submissions.eventId, events.id))
      .where(and(
        isNull(people.deletedAt),
        isNull(submissionSpeakers.deletedAt),
        isNull(submissions.deletedAt),
        isNull(events.deletedAt),
      )),
    database.select({
      personId: people.id,
      eventId: events.id,
      eventName: events.name,
      startDate: events.startDate,
      endDate: events.endDate,
      sessionId: sessions.id,
      title: sessions.title,
      contentStatus: sessions.contentStatus,
    })
      .from(sessionSpeakers)
      .innerJoin(speakers, eq(sessionSpeakers.speakerId, speakers.id))
      .innerJoin(people, eq(speakers.personId, people.id))
      .innerJoin(sessions, eq(sessionSpeakers.sessionId, sessions.id))
      .innerJoin(events, eq(sessions.eventId, events.id))
      .where(and(
        isNull(people.deletedAt),
        isNull(speakers.deletedAt),
        isNull(sessionSpeakers.deletedAt),
        isNull(sessions.deletedAt),
        isNull(events.deletedAt),
      )),
    database.select({
      personId: speakerDirectoryContactTags.personId,
      name: speakerDirectoryTags.name,
    })
      .from(speakerDirectoryContactTags)
      .innerJoin(speakerDirectoryTags, eq(speakerDirectoryContactTags.tagId, speakerDirectoryTags.id)),
    database.select({
      personId: speakerDirectoryCustomFields.personId,
      name: speakerDirectoryCustomFields.name,
      value: speakerDirectoryCustomFields.value,
    }).from(speakerDirectoryCustomFields),
  ]);

  const speakerRowsByPersonId = byPersonId(speakerRows);
  const proposalRowsByPersonId = byPersonId(proposalRows);
  const sessionRowsByPersonId = byPersonId(sessionRows);
  const tagRowsByPersonId = byPersonId(tagRows);
  const customFieldRowsByPersonId = byPersonId(customFieldRows);
  const eligibleIds = new Set([...speakerRowsByPersonId.keys(), ...proposalRowsByPersonId.keys()]);
  const directoryPeople = personRows.filter((person) => eligibleIds.has(person.id));
  const { groups, reasonsByPersonId } = indexPossibleDuplicates(directoryPeople);
  const duplicateCountById = new Map<string, number>();
  for (const group of groups) {
    for (const personId of group.personIds) duplicateCountById.set(personId, group.personIds.length - 1);
  }

  const eventHistory = new Map<string, SpeakerDirectoryEvent[]>();
  for (const person of directoryPeople) {
    const speakerEvents = speakerRowsByPersonId.get(person.id) ?? [];
    const proposalEvents = proposalRowsByPersonId.get(person.id) ?? [];
    const sessionEvents = sessionRowsByPersonId.get(person.id) ?? [];
    const eventIds = new Set([
      ...speakerEvents.map((row) => row.eventId),
      ...proposalEvents.map((row) => row.eventId),
    ]);
    const history = [...eventIds].map((eventId): SpeakerDirectoryEvent => {
      const event = speakerEvents.find((row) => row.eventId === eventId)
        ?? proposalEvents.find((row) => row.eventId === eventId)!;
      return {
        id: eventId,
        name: event.eventName,
        startDate: event.startDate,
        endDate: event.endDate,
        speakerStatus: speakerEvents.find((row) => row.eventId === eventId)?.status ?? null,
        proposalCount: new Set(
          proposalEvents.filter((row) => row.eventId === eventId).map((row) => row.submissionId),
        ).size,
        sessions: sessionEvents
          .filter((row) => row.eventId === eventId)
          .map((row) => ({ id: row.sessionId, title: row.title, contentStatus: row.contentStatus })),
      };
    }).sort((first, second) => {
      const dateOrder = (second.startDate ?? "").localeCompare(first.startDate ?? "");
      return dateOrder === 0 ? first.name.localeCompare(second.name) : dateOrder;
    });
    eventHistory.set(person.id, history);
  }

  const items = directoryPeople.map((person): SpeakerDirectoryListItem => {
    const history = eventHistory.get(person.id) ?? [];
    return {
      id: person.id,
      name: person.name,
      email: person.email,
      jobTitle: person.jobTitle,
      organization: person.organization,
      bio: person.bio,
      headshotUrl: person.headshotUrl,
      eventCount: history.length,
      sessionCount: history.reduce((count, event) => count + event.sessions.length, 0),
      proposalCount: history.reduce((count, event) => count + event.proposalCount, 0),
      events: history.map((event) => event.name),
      tags: (tagRowsByPersonId.get(person.id) ?? [])
        .map((tag) => tag.name)
        .sort((first, second) => first.localeCompare(second)),
      customFields: Object.fromEntries(
        (customFieldRowsByPersonId.get(person.id) ?? [])
          .sort((first, second) => first.name.localeCompare(second.name))
          .map((field) => [field.name, field.value]),
      ),
      possibleDuplicateCount: duplicateCountById.get(person.id) ?? 0,
      updatedAt: person.updatedAt.toISOString(),
    };
  });

  return {
    items,
    people: directoryPeople,
    itemsById: new Map(items.map((item) => [item.id, item])),
    peopleById: new Map(directoryPeople.map((person) => [person.id, person])),
    eventHistory,
    duplicateReasonsByPersonId: reasonsByPersonId,
    groups,
  };
}

export async function loadSpeakerDirectoryNotes(
  database: Database,
  personId: string,
): Promise<SpeakerDirectoryNote[]> {
  const rows = await database.select({
    id: speakerDirectoryNotes.id,
    body: speakerDirectoryNotes.body,
    author: users.name,
    createdAt: speakerDirectoryNotes.createdAt,
  })
    .from(speakerDirectoryNotes)
    .innerJoin(users, eq(speakerDirectoryNotes.authorUserId, users.id))
    .where(and(
      eq(speakerDirectoryNotes.personId, personId),
      isNull(speakerDirectoryNotes.deletedAt),
    ))
    .orderBy(desc(speakerDirectoryNotes.createdAt));
  return rows.map((note) => ({
    id: note.id,
    body: note.body,
    author: note.author,
    createdAt: note.createdAt.toISOString(),
  }));
}
