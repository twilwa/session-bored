// ABOUTME: Builds the private all-event speaker index and conservative duplicate groups.
// ABOUTME: Aggregates canonical people, proposals, event speakers, and sessions without changing roster rules.
import { and, asc, eq, isNull, sql } from "drizzle-orm";
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

export function duplicateReasonsFor(
  first: DuplicateIdentity,
  second: DuplicateIdentity,
): SpeakerDirectoryDuplicateReason[] {
  if (first.id === second.id) return [];
  const reasons: SpeakerDirectoryDuplicateReason[] = [];
  if (normalized(first.email) === normalized(second.email)) {
    reasons.push("same_email");
  }
  if (
    normalized(first.name) === normalized(second.name)
    && first.organization !== null
    && second.organization !== null
    && normalized(first.organization) !== ""
    && normalized(first.organization) === normalized(second.organization)
  ) {
    reasons.push("same_name_and_organization");
  }
  return reasons;
}

export function possibleDuplicateGroups(peopleToCompare: DuplicateIdentity[]): PossibleDuplicateGroup[] {
  const adjacency = new Map<string, Set<string>>(peopleToCompare.map((person) => [person.id, new Set()]));
  const reasonsByPair = new Map<string, SpeakerDirectoryDuplicateReason[]>();
  for (let firstIndex = 0; firstIndex < peopleToCompare.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < peopleToCompare.length; secondIndex += 1) {
      const first = peopleToCompare[firstIndex]!;
      const second = peopleToCompare[secondIndex]!;
      const reasons = duplicateReasonsFor(first, second);
      if (reasons.length === 0) continue;
      adjacency.get(first.id)?.add(second.id);
      adjacency.get(second.id)?.add(first.id);
      reasonsByPair.set([first.id, second.id].sort().join("\u0000"), reasons);
    }
  }

  const visited = new Set<string>();
  const groups: PossibleDuplicateGroup[] = [];
  for (const personId of [...adjacency.keys()].sort()) {
    if (visited.has(personId) || adjacency.get(personId)?.size === 0) continue;
    const pending = [personId];
    const personIds: string[] = [];
    const groupReasons = new Set<SpeakerDirectoryDuplicateReason>();
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      personIds.push(current);
      for (const neighbor of adjacency.get(current) ?? []) {
        const pairReasons = reasonsByPair.get([current, neighbor].sort().join("\u0000")) ?? [];
        for (const reason of pairReasons) groupReasons.add(reason);
        if (!visited.has(neighbor)) pending.push(neighbor);
      }
    }
    groups.push({
      personIds: personIds.sort(),
      reasons: [...groupReasons].sort(),
    });
  }
  return groups;
}

type Database = ReturnType<typeof drizzle>;

/**
 * Resolves a normalized email to the person new work should attach to. When the email's
 * person row was merged away, the recorded merge leads to the person the organizer kept,
 * so adopting a duplicate's address never links live work to an archived record.
 */
export async function resolvePersonByEmail(
  database: Database,
  normalizedEmail: string,
): Promise<typeof people.$inferSelect | undefined> {
  const [person] = await database
    .select()
    .from(people)
    .where(sql`lower(${people.email}) = ${normalizedEmail}`);
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

interface DirectorySnapshot {
  items: SpeakerDirectoryListItem[];
  people: Array<DuplicateIdentity & {
    userId: string | null;
    twitter: string | null;
    linkedin: string | null;
    socialLinks: Record<string, string> | null;
  }>;
  eventHistory: Map<string, SpeakerDirectoryEvent[]>;
  groups: PossibleDuplicateGroup[];
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

  const eligibleIds = new Set([
    ...speakerRows.map((row) => row.personId),
    ...proposalRows.map((row) => row.personId),
  ]);
  const directoryPeople = personRows.filter((person) => eligibleIds.has(person.id));
  const groups = possibleDuplicateGroups(directoryPeople);
  const duplicateCountById = new Map<string, number>();
  for (const group of groups) {
    for (const personId of group.personIds) duplicateCountById.set(personId, group.personIds.length - 1);
  }

  const eventHistory = new Map<string, SpeakerDirectoryEvent[]>();
  for (const person of directoryPeople) {
    const speakerEvents = speakerRows.filter((row) => row.personId === person.id);
    const proposalEvents = proposalRows.filter((row) => row.personId === person.id);
    const sessionEvents = sessionRows.filter((row) => row.personId === person.id);
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

  return { items, people: directoryPeople, eventHistory, groups };
}
