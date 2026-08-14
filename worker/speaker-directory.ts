// ABOUTME: Builds the private all-event speaker index and conservative duplicate groups.
// ABOUTME: Aggregates canonical people, proposals, event speakers, and sessions without changing roster rules.
import { and, asc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  directoryMerges,
  events,
  people,
  sessions,
  sessionSpeakers,
  speakers,
  submissions,
  submissionSpeakers,
} from "../db/schema.ts";
import type {
  SpeakerDirectoryDuplicateReason,
  SpeakerDirectoryEvent,
  SpeakerDirectoryListItem,
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
  const [personRows, speakerRows, proposalRows, sessionRows] = await Promise.all([
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
      .where(and(isNull(people.deletedAt), isNull(speakers.deletedAt), isNull(events.deletedAt))),
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
  ]);

  const speakerRowsByPersonId = byPersonId(speakerRows);
  const proposalRowsByPersonId = byPersonId(proposalRows);
  const sessionRowsByPersonId = byPersonId(sessionRows);
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
