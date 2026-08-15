// ABOUTME: Serves organizer-only speaker directory filters, profiles, metadata, and merge actions.
// ABOUTME: Keeps private contact context separate while preserving active product relationships.
import { and, eq, inArray, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import {
  files,
  people,
  speakerDirectoryNotes,
  speakerDirectorySegments,
  speakers,
  type Role,
  type SpeakerStatus,
} from "../../db/schema.ts";
import type {
  SpeakerDirectoryDetailResponse,
  SpeakerDirectoryDuplicate,
  SpeakerDirectoryFilters,
  SpeakerDirectoryListResponse,
  SpeakerDirectoryMergeResult,
  SpeakerDirectoryMetadata,
  SpeakerDirectoryNote,
  SpeakerDirectorySavedFilters,
  SpeakerDirectorySegment,
  SpeakerDirectorySort,
} from "../../shared/speaker-directory.ts";
import { holdsAccess } from "../access.ts";
import type { AuthSession } from "../auth.ts";
import {
  duplicateReasonsFor,
  filterSpeakerDirectory,
  loadSpeakerDirectory,
  loadSpeakerDirectoryNotes,
} from "../speaker-directory.ts";

type SpeakerDirectoryEnvironment = {
  Bindings: CloudflareBindings;
  Variables: {
    authUser: AuthSession["user"] | null;
    roles: Role[] | null;
  };
};

const speakerDirectoryRoutes = new Hono<SpeakerDirectoryEnvironment>();

const requireOrganizer = createMiddleware<SpeakerDirectoryEnvironment>(async (context, next) => {
  const roles = context.get("roles");
  if (roles === null) return context.json({ error: "authentication_required" }, 401);
  if (!holdsAccess(roles, "organizer")) return context.json({ error: "forbidden" }, 403);
  await next();
});

function positiveInteger(value: string | null, fallback: number): number {
  if (value === null || !/^\d+$/.test(value)) return fallback;
  return Math.max(1, Number.parseInt(value, 10));
}

function directoryFilters(url: string): SpeakerDirectoryFilters {
  const parameters = new URL(url).searchParams;
  const sortValue = parameters.get("sort");
  const sort: SpeakerDirectorySort = sortValue === "updated" || sortValue === "events"
    ? sortValue
    : "name";
  const customFields = parameters.getAll("field").flatMap((value) => {
    const separator = value.indexOf(":");
    if (separator < 1 || separator === value.length - 1) return [];
    return [{ name: value.slice(0, separator), value: value.slice(separator + 1) }];
  });
  return {
    search: parameters.get("q") ?? "",
    tags: parameters.getAll("tag"),
    customFields,
    sort,
    direction: parameters.get("direction") === "desc" ? "desc" : "asc",
    page: positiveInteger(parameters.get("page"), 1),
    pageSize: Math.min(100, positiveInteger(parameters.get("pageSize"), 25)),
  };
}

speakerDirectoryRoutes.get("/api/speaker-directory", requireOrganizer, async (context) => {
  const database = drizzle(context.env.DB);
  const [directory, segmentRows] = await Promise.all([
    loadSpeakerDirectory(database),
    database.select().from(speakerDirectorySegments).orderBy(speakerDirectorySegments.name),
  ]);
  const filtered = filterSpeakerDirectory(directory.items, directoryFilters(context.req.url));
  const tags = [...new Set(directory.items.flatMap((person) => person.tags))]
    .sort((first, second) => first.localeCompare(second));
  const fieldValues = new Map<string, Set<string>>();
  for (const person of directory.items) {
    for (const [name, value] of Object.entries(person.customFields)) {
      const values = fieldValues.get(name);
      if (values === undefined) fieldValues.set(name, new Set([value]));
      else values.add(value);
    }
  }
  const response: SpeakerDirectoryListResponse = {
    ...filtered,
    possibleDuplicateGroups: directory.groups.length,
    facets: {
      tags,
      customFields: [...fieldValues.entries()]
        .sort(([first], [second]) => first.localeCompare(second))
        .map(([name, values]) => ({
          name,
          values: [...values].sort((first, second) => first.localeCompare(second)),
        })),
    },
    overview: {
      people: directory.items.length,
      events: new Set(
        [...directory.eventHistory.values()].flatMap((history) => history.map((event) => event.id)),
      ).size,
      sessions: directory.items.reduce((sum, person) => sum + person.sessionCount, 0),
      proposals: directory.items.reduce((sum, person) => sum + person.proposalCount, 0),
      taggedPeople: directory.items.filter((person) => person.tags.length > 0).length,
    },
    savedSegments: segmentRows.map((segment) => ({
      id: segment.id,
      name: segment.name,
      filters: segment.filters,
      createdAt: segment.createdAt.toISOString(),
    })),
  };
  return context.json(response);
});

function savedFilters(value: unknown): SpeakerDirectorySavedFilters | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<SpeakerDirectorySavedFilters>;
  if (
    typeof candidate.search !== "string"
    || !Array.isArray(candidate.tags)
    || candidate.tags.some((tag) => typeof tag !== "string")
    || !Array.isArray(candidate.customFields)
    || candidate.customFields.some((field) => (
      field === null
      || typeof field !== "object"
      || typeof field.name !== "string"
      || typeof field.value !== "string"
    ))
    || (candidate.sort !== "name" && candidate.sort !== "updated" && candidate.sort !== "events")
    || (candidate.direction !== "asc" && candidate.direction !== "desc")
    || candidate.search.length > 200
    || candidate.tags.length > 20
    || candidate.customFields.length > 20
  ) return null;
  return {
    search: candidate.search.trim(),
    tags: candidate.tags.map(displayText),
    customFields: candidate.customFields.map((field) => ({
      name: displayText(field.name),
      value: displayText(field.value),
    })),
    sort: candidate.sort,
    direction: candidate.direction,
  };
}

speakerDirectoryRoutes.post("/api/speaker-directory/segments", requireOrganizer, async (context) => {
  const organizer = context.get("authUser");
  if (organizer === null) return context.json({ error: "authentication_required" }, 401);
  const payload = await context.req.json<{ name?: unknown; filters?: unknown }>().catch(() => null);
  const name = typeof payload?.name === "string" ? displayText(payload.name) : "";
  const filters = savedFilters(payload?.filters);
  if (name === "" || name.length > 60 || filters === null) {
    return context.json({ error: "invalid_directory_segment" }, 400);
  }
  const database = drizzle(context.env.DB);
  const [created] = await database.insert(speakerDirectorySegments).values({
    name,
    normalizedName: normalizedText(name),
    filters,
    createdByUserId: organizer.id,
  }).onConflictDoNothing().returning();
  if (created === undefined) return context.json({ error: "segment_name_conflict" }, 409);
  const response: SpeakerDirectorySegment = {
    id: created.id,
    name: created.name,
    filters: created.filters,
    createdAt: created.createdAt.toISOString(),
  };
  return context.json(response, 201);
});

speakerDirectoryRoutes.get("/api/speaker-directory/:personId", requireOrganizer, async (context) => {
  const database = drizzle(context.env.DB);
  const personId = context.req.param("personId");
  const [directory, notes] = await Promise.all([
    loadSpeakerDirectory(database),
    loadSpeakerDirectoryNotes(database, personId),
  ]);
  const summary = directory.itemsById.get(personId);
  const person = directory.peopleById.get(personId);
  if (summary === undefined || person === undefined) return context.json({ error: "not_found" }, 404);

  const reasonsByCandidateId = directory.duplicateReasonsByPersonId.get(personId)
    ?? new Map<string, SpeakerDirectoryDuplicate["reasons"]>();
  const possibleDuplicates: SpeakerDirectoryDuplicate[] = directory.people.flatMap((candidate) => {
    const reasons = reasonsByCandidateId.get(candidate.id);
    if (reasons === undefined) return [];
    const candidateSummary = directory.itemsById.get(candidate.id)!;
    return [{
      id: candidate.id,
      name: candidate.name,
      email: candidate.email,
      organization: candidate.organization,
      eventCount: candidateSummary.eventCount,
      sessionCount: candidateSummary.sessionCount,
      proposalCount: candidateSummary.proposalCount,
      reasons,
      accountConflict: person.userId !== null && candidate.userId !== null && person.userId !== candidate.userId,
    }];
  });
  const response: SpeakerDirectoryDetailResponse = {
    person: {
      ...summary,
      twitter: person.twitter,
      linkedin: person.linkedin,
      socialLinks: person.socialLinks,
      events: directory.eventHistory.get(personId) ?? [],
    },
    possibleDuplicates,
    notes,
  };
  return context.json(response);
});

function displayText(value: string): string {
  return value.normalize("NFKC").trim().replaceAll(/\s+/g, " ");
}

function normalizedText(value: string): string {
  return displayText(value).toLocaleLowerCase("en-US");
}

speakerDirectoryRoutes.put("/api/speaker-directory/:personId/metadata", requireOrganizer, async (context) => {
  const payload = await context.req.json<{ tags?: unknown; customFields?: unknown }>().catch(() => null);
  if (
    payload === null
    || !Array.isArray(payload.tags)
    || payload.tags.some((tag) => typeof tag !== "string")
    || payload.customFields === null
    || typeof payload.customFields !== "object"
    || Array.isArray(payload.customFields)
  ) {
    return context.json({ error: "invalid_directory_metadata" }, 400);
  }
  const tagByNormalizedName = new Map<string, string>();
  for (const rawTag of payload.tags as string[]) {
    const name = displayText(rawTag);
    if (name === "" || name.length > 40) {
      return context.json({ error: "invalid_directory_metadata" }, 400);
    }
    tagByNormalizedName.set(normalizedText(name), name);
  }
  const fieldByNormalizedName = new Map<string, { name: string; value: string }>();
  for (const [rawName, rawValue] of Object.entries(payload.customFields as Record<string, unknown>)) {
    if (typeof rawValue !== "string") {
      return context.json({ error: "invalid_directory_metadata" }, 400);
    }
    const name = displayText(rawName);
    const value = displayText(rawValue);
    if (name === "" || name.length > 40 || value === "" || value.length > 200) {
      return context.json({ error: "invalid_directory_metadata" }, 400);
    }
    fieldByNormalizedName.set(normalizedText(name), { name, value });
  }
  if (tagByNormalizedName.size > 20 || fieldByNormalizedName.size > 20) {
    return context.json({ error: "invalid_directory_metadata" }, 400);
  }

  const database = drizzle(context.env.DB);
  const directory = await loadSpeakerDirectory(database);
  const personId = context.req.param("personId");
  if (!directory.itemsById.has(personId)) return context.json({ error: "not_found" }, 404);
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  for (const [normalizedName, name] of tagByNormalizedName) {
    statements.push(context.env.DB.prepare(
      "insert into speaker_directory_tag (id, name, normalized_name, created_at, updated_at) values (?, ?, ?, ?, ?) on conflict (normalized_name) do nothing",
    ).bind(`dtag_${crypto.randomUUID().replaceAll("-", "")}`, name, normalizedName, now, now));
  }
  statements.push(context.env.DB.prepare(
    "delete from speaker_directory_contact_tag where person_id = ?",
  ).bind(personId));
  for (const normalizedName of tagByNormalizedName.keys()) {
    statements.push(context.env.DB.prepare(
      "insert into speaker_directory_contact_tag (person_id, tag_id, created_at) select ?, id, ? from speaker_directory_tag where normalized_name = ?",
    ).bind(personId, now, normalizedName));
  }
  statements.push(context.env.DB.prepare(
    "delete from speaker_directory_custom_field where person_id = ?",
  ).bind(personId));
  for (const [normalizedName, field] of fieldByNormalizedName) {
    statements.push(context.env.DB.prepare(
      "insert into speaker_directory_custom_field (id, person_id, name, normalized_name, value, normalized_value, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      `dcf_${crypto.randomUUID().replaceAll("-", "")}`,
      personId,
      field.name,
      normalizedName,
      field.value,
      normalizedText(field.value),
      now,
      now,
    ));
  }
  await context.env.DB.batch(statements);
  const refreshed = await loadSpeakerDirectory(database);
  const saved = refreshed.itemsById.get(personId)!;
  const response: SpeakerDirectoryMetadata = {
    tags: saved.tags,
    customFields: saved.customFields,
  };
  return context.json(response);
});

speakerDirectoryRoutes.post("/api/speaker-directory/:personId/notes", requireOrganizer, async (context) => {
  const organizer = context.get("authUser");
  if (organizer === null) return context.json({ error: "authentication_required" }, 401);
  const payload = await context.req.json<{ body?: unknown }>().catch(() => null);
  const body = typeof payload?.body === "string" ? payload.body.trim() : "";
  if (body === "" || body.length > 2_000) {
    return context.json({ error: "invalid_directory_note" }, 400);
  }
  const database = drizzle(context.env.DB);
  const personId = context.req.param("personId");
  const directory = await loadSpeakerDirectory(database);
  if (!directory.itemsById.has(personId)) return context.json({ error: "not_found" }, 404);
  const id = `dnote_${crypto.randomUUID().replaceAll("-", "")}`;
  const createdAt = new Date();
  await database.insert(speakerDirectoryNotes).values({
    id,
    personId,
    authorUserId: organizer.id,
    body,
    createdAt,
    updatedAt: createdAt,
  });
  const response: SpeakerDirectoryNote = {
    id,
    body,
    author: organizer.name,
    createdAt: createdAt.toISOString(),
  };
  return context.json(response, 201);
});

const speakerStatusOrder: Record<SpeakerStatus, number> = {
  withdrawn: 0,
  invited: 1,
  pending_employer_approval: 2,
  confirmed: 3,
  onboarding: 4,
  ready: 5,
};

function preferredText(kept: string | null, merged: string | null): string | null {
  return kept !== null && kept.trim() !== "" ? kept : merged;
}

/**
 * Withdrawal is terminal, so it is decided before the ladder rather than sitting at the bottom
 * of it. Withdrawing is the roster's own decision about a person at an event, and a merge is a
 * statement about identity: taking the further-along of two rows would let a duplicate's
 * `invited` row - the one a first CFP draft mints - quietly put a withdrawn speaker back on the
 * roster and, at `confirmed` or beyond, back on every public surface.
 */
function mergedSpeakerStanding(
  kept: { status: SpeakerStatus; deletedAt: Date | null },
  merged: { status: SpeakerStatus; deletedAt: Date | null },
  now: number,
): { status: SpeakerStatus; deletedAt: number | null } {
  if (kept.status === "withdrawn" || merged.status === "withdrawn") {
    const archivedAt = [kept.deletedAt, merged.deletedAt]
      .filter((value): value is Date => value !== null)
      .map((value) => value.getTime());
    return { status: "withdrawn", deletedAt: archivedAt.length === 0 ? now : Math.min(...archivedAt) };
  }
  return {
    status: speakerStatusOrder[merged.status] > speakerStatusOrder[kept.status]
      ? merged.status
      : kept.status,
    deletedAt: null,
  };
}

speakerDirectoryRoutes.post("/api/speaker-directory/:personId/merge", requireOrganizer, async (context) => {
  const organizer = context.get("authUser");
  if (organizer === null) return context.json({ error: "authentication_required" }, 401);
  const payload = await context.req.json<{ duplicatePersonId?: unknown }>().catch(() => null);
  const keptPersonId = context.req.param("personId");
  const duplicatePersonId = payload?.duplicatePersonId;
  if (typeof duplicatePersonId !== "string" || duplicatePersonId === keptPersonId) {
    return context.json({ error: "invalid_merge" }, 400);
  }

  const database = drizzle(context.env.DB);
  const [keptPerson, mergedPerson] = await Promise.all([
    database.select().from(people).where(and(eq(people.id, keptPersonId), isNull(people.deletedAt))).then((rows) => rows[0]),
    database.select().from(people)
      .where(and(eq(people.id, duplicatePersonId), isNull(people.deletedAt)))
      .then((rows) => rows[0]),
  ]);
  if (keptPerson === undefined || mergedPerson === undefined) return context.json({ error: "not_found" }, 404);
  const reasons = duplicateReasonsFor(keptPerson, mergedPerson);
  if (reasons.length === 0) return context.json({ error: "not_duplicate_candidate" }, 409);
  if (
    keptPerson.userId !== null
    && mergedPerson.userId !== null
    && keptPerson.userId !== mergedPerson.userId
  ) {
    return context.json({ error: "account_conflict" }, 409);
  }

  // Both sides include archived speaker rows. Withdrawing on the roster archives the row it
  // withdraws, so reading only live ones would skip the duplicate's withdrawal - and leave its
  // sessions, onboarding work, and files hanging off a speaker row no surface can reach.
  const [mergedSpeakers, keptSpeakers] = await Promise.all([
    database.select().from(speakers).where(eq(speakers.personId, mergedPerson.id)),
    database.select().from(speakers).where(eq(speakers.personId, keptPerson.id)),
  ]);
  const speakerIds = [...new Set([...mergedSpeakers, ...keptSpeakers].map((speaker) => speaker.id))];
  const headshotOwners = speakerIds.length === 0 ? [] : await database
    .select({ speakerId: files.speakerId })
    .from(files)
    .where(and(eq(files.kind, "headshot"), inArray(files.speakerId, speakerIds)));
  const speakersWithHeadshot = new Set(headshotOwners.map((row) => row.speakerId));
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];

  if (mergedPerson.userId !== null) {
    statements.push(context.env.DB.prepare(
      "update person set user_id = null, updated_at = ? where id = ? and deleted_at is null",
    ).bind(now, mergedPerson.id));
  }

  const socialLinks = {
    ...(mergedPerson.socialLinks ?? {}),
    ...(keptPerson.socialLinks ?? {}),
  };
  const keptHasHeadshotUrl = keptPerson.headshotUrl !== null && keptPerson.headshotUrl.trim() !== "";
  let headshotUrl = keptHasHeadshotUrl ? keptPerson.headshotUrl : mergedPerson.headshotUrl;
  if (!keptHasHeadshotUrl && headshotUrl !== null) {
    const urlSpeakerId = /^\/api\/public\/portal\/speakers\/([^/?]+)\/headshot/.exec(headshotUrl)?.[1];
    const archivedSpeaker = mergedSpeakers.find((speaker) => speaker.id === urlSpeakerId);
    const successor = archivedSpeaker === undefined
      ? undefined
      : keptSpeakers.find((speaker) => speaker.eventId === archivedSpeaker.eventId);
    if (
      archivedSpeaker !== undefined && successor !== undefined
      && speakersWithHeadshot.has(archivedSpeaker.id) && !speakersWithHeadshot.has(successor.id)
    ) {
      headshotUrl = headshotUrl.replace(`/speakers/${archivedSpeaker.id}/`, `/speakers/${successor.id}/`);
    }
  }
  statements.push(context.env.DB.prepare(
    "update person set user_id = ?, job_title = ?, organization = ?, bio = ?, headshot_url = ?, twitter = ?, linkedin = ?, social_links = ?, updated_at = ? where id = ? and deleted_at is null",
  ).bind(
    keptPerson.userId ?? mergedPerson.userId,
    preferredText(keptPerson.jobTitle, mergedPerson.jobTitle),
    preferredText(keptPerson.organization, mergedPerson.organization),
    preferredText(keptPerson.bio, mergedPerson.bio),
    headshotUrl,
    preferredText(keptPerson.twitter, mergedPerson.twitter),
    preferredText(keptPerson.linkedin, mergedPerson.linkedin),
    Object.keys(socialLinks).length === 0 ? null : JSON.stringify(socialLinks),
    now,
    keptPerson.id,
  ));
  statements.push(
    context.env.DB.prepare(
      "update submission set submitter_person_id = ?, updated_at = ? where submitter_person_id = ?",
    ).bind(keptPerson.id, now, mergedPerson.id),
    context.env.DB.prepare(
      "update submission_speaker as kept set deleted_at = null, updated_at = ? where kept.person_id = ? and exists (select 1 from submission_speaker as merged where merged.submission_id = kept.submission_id and merged.person_id = ? and merged.deleted_at is null)",
    ).bind(now, keptPerson.id, mergedPerson.id),
    context.env.DB.prepare(
      "update submission_speaker as merged set deleted_at = ?, updated_at = ? where merged.person_id = ? and merged.deleted_at is null and exists (select 1 from submission_speaker as kept where kept.submission_id = merged.submission_id and kept.person_id = ?)",
    ).bind(now, now, mergedPerson.id, keptPerson.id),
    context.env.DB.prepare(
      "update submission_speaker as merged set person_id = ?, updated_at = ? where merged.person_id = ? and not exists (select 1 from submission_speaker as kept where kept.submission_id = merged.submission_id and kept.person_id = ?)",
    ).bind(keptPerson.id, now, mergedPerson.id, keptPerson.id),
  );

  for (const mergedSpeaker of mergedSpeakers) {
    const keptSpeaker = keptSpeakers.find((speaker) => speaker.eventId === mergedSpeaker.eventId);
    if (keptSpeaker === undefined) {
      statements.push(context.env.DB.prepare(
        "update speaker set person_id = ?, updated_at = ? where id = ?",
      ).bind(keptPerson.id, now, mergedSpeaker.id));
      continue;
    }

    const standing = mergedSpeakerStanding(keptSpeaker, mergedSpeaker, now);
    const customFields = {
      ...(mergedSpeaker.customFields ?? {}),
      ...(keptSpeaker.customFields ?? {}),
    };
    statements.push(
      context.env.DB.prepare(
        "update speaker set status = ?, custom_fields = ?, deleted_at = ?, updated_at = ? where id = ?",
      ).bind(
        standing.status,
        Object.keys(customFields).length === 0 ? null : JSON.stringify(customFields),
        standing.deletedAt,
        now,
        keptSpeaker.id,
      ),
      context.env.DB.prepare(
        "update session_speaker as kept set deleted_at = null, updated_at = ? where kept.speaker_id = ? and exists (select 1 from session_speaker as merged where merged.session_id = kept.session_id and merged.speaker_id = ? and merged.deleted_at is null)",
      ).bind(now, keptSpeaker.id, mergedSpeaker.id),
      context.env.DB.prepare(
        "update session_speaker as merged set deleted_at = ?, updated_at = ? where merged.speaker_id = ? and merged.deleted_at is null and exists (select 1 from session_speaker as kept where kept.session_id = merged.session_id and kept.speaker_id = ?)",
      ).bind(now, now, mergedSpeaker.id, keptSpeaker.id),
      context.env.DB.prepare(
        "update session_speaker as merged set speaker_id = ?, updated_at = ? where merged.speaker_id = ? and not exists (select 1 from session_speaker as kept where kept.session_id = merged.session_id and kept.speaker_id = ?)",
      ).bind(keptSpeaker.id, now, mergedSpeaker.id, keptSpeaker.id),
      // Null provenance means the person owes this work independently of any session. If either
      // identity carried that standing, a later session removal must not archive the merged work.
      context.env.DB.prepare(
        "update task_assignee as kept set status = case when kept.status = 'completed' or exists (select 1 from task_assignee as merged where merged.task_id = kept.task_id and merged.speaker_id = ? and merged.status = 'completed') then 'completed' when kept.status = 'in_progress' or exists (select 1 from task_assignee as merged where merged.task_id = kept.task_id and merged.speaker_id = ? and merged.status = 'in_progress') then 'in_progress' else 'assigned' end, completed_at = coalesce(kept.completed_at, (select merged.completed_at from task_assignee as merged where merged.task_id = kept.task_id and merged.speaker_id = ?)), granted_by_session_id = case when kept.granted_by_session_id is null or exists (select 1 from task_assignee as merged where merged.task_id = kept.task_id and merged.speaker_id = ? and merged.granted_by_session_id is null) then null else kept.granted_by_session_id end, deleted_at = null, updated_at = ? where kept.speaker_id = ? and exists (select 1 from task_assignee as merged where merged.task_id = kept.task_id and merged.speaker_id = ? and merged.deleted_at is null)",
      ).bind(
        mergedSpeaker.id,
        mergedSpeaker.id,
        mergedSpeaker.id,
        mergedSpeaker.id,
        now,
        keptSpeaker.id,
        mergedSpeaker.id,
      ),
      // `task_assignee_unique` leaves nowhere to carry an archived duplicate assignment that the
      // kept speaker already holds, so what it knows is folded in instead: work the person did
      // under the other record stays done, without that archived row reviving the kept one.
      context.env.DB.prepare(
        "update task_assignee as kept set status = case when kept.status = 'completed' or exists (select 1 from task_assignee as merged where merged.task_id = kept.task_id and merged.speaker_id = ? and merged.status = 'completed') then 'completed' when kept.status = 'in_progress' or exists (select 1 from task_assignee as merged where merged.task_id = kept.task_id and merged.speaker_id = ? and merged.status = 'in_progress') then 'in_progress' else kept.status end, completed_at = coalesce(kept.completed_at, (select merged.completed_at from task_assignee as merged where merged.task_id = kept.task_id and merged.speaker_id = ?)), granted_by_session_id = case when kept.granted_by_session_id is null or exists (select 1 from task_assignee as merged where merged.task_id = kept.task_id and merged.speaker_id = ? and merged.granted_by_session_id is null) then null else kept.granted_by_session_id end, updated_at = ? where kept.speaker_id = ? and exists (select 1 from task_assignee as merged where merged.task_id = kept.task_id and merged.speaker_id = ? and merged.deleted_at is not null)",
      ).bind(
        mergedSpeaker.id,
        mergedSpeaker.id,
        mergedSpeaker.id,
        mergedSpeaker.id,
        now,
        keptSpeaker.id,
        mergedSpeaker.id,
      ),
      context.env.DB.prepare(
        "update task_assignee as merged set deleted_at = ?, updated_at = ? where merged.speaker_id = ? and merged.deleted_at is null and exists (select 1 from task_assignee as kept where kept.task_id = merged.task_id and kept.speaker_id = ?)",
      ).bind(now, now, mergedSpeaker.id, keptSpeaker.id),
      context.env.DB.prepare(
        "update task_assignee as merged set speaker_id = ?, updated_at = ? where merged.speaker_id = ? and not exists (select 1 from task_assignee as kept where kept.task_id = merged.task_id and kept.speaker_id = ?)",
      ).bind(keptSpeaker.id, now, mergedSpeaker.id, keptSpeaker.id),
      context.env.DB.prepare(
        "update file as merged set deleted_at = ?, updated_at = ? where merged.speaker_id = ? and merged.kind != 'headshot' and merged.deleted_at is null and merged.task_id is not null and exists (select 1 from file as kept where kept.speaker_id = ? and kept.task_id = merged.task_id and kept.kind != 'headshot' and kept.deleted_at is null)",
      ).bind(now, now, mergedSpeaker.id, keptSpeaker.id),
      context.env.DB.prepare(
        "update file set speaker_id = ?, updated_at = ? where speaker_id = ? and kind != 'headshot'",
      ).bind(keptSpeaker.id, now, mergedSpeaker.id),
      context.env.DB.prepare(
        "update file set speaker_id = ?, updated_at = ? where speaker_id = ? and kind = 'headshot' and not exists (select 1 from file as kept_headshot where kept_headshot.speaker_id = ? and kept_headshot.kind = 'headshot')",
      ).bind(keptSpeaker.id, now, mergedSpeaker.id, keptSpeaker.id),
      context.env.DB.prepare(
        "update speaker set deleted_at = ?, updated_at = ? where id = ? and deleted_at is null",
      ).bind(now, now, mergedSpeaker.id),
    );
  }

  // Both person ids are read back from live rows so a merge that raced another one - the same pair
  // in the opposite direction, archiving the record this batch is keeping - hits the column's not
  // null constraint and rolls the whole batch back, rather than half-applying into a merge cycle.
  const mergeId = `pmg_${crypto.randomUUID().replaceAll("-", "")}`;
  statements.push(
    context.env.DB.prepare(
      "insert into directory_merge (id, kept_person_id, merged_person_id, merged_by_user_id, reasons, merged_profile, created_at) values (?, (select id from person where id = ? and deleted_at is null), (select id from person where id = ? and deleted_at is null), ?, ?, ?, ?)",
    ).bind(
      mergeId,
      keptPerson.id,
      mergedPerson.id,
      organizer.id,
      JSON.stringify(reasons),
      JSON.stringify(mergedPerson),
      now,
    ),
    context.env.DB.prepare(
      "update person set deleted_at = ?, updated_at = ? where id = ? and deleted_at is null",
    ).bind(now, now, mergedPerson.id),
  );

  try {
    await context.env.DB.batch(statements);
  } catch (error) {
    const stillLive = await database
      .select({ id: people.id })
      .from(people)
      .where(and(inArray(people.id, [keptPerson.id, mergedPerson.id]), isNull(people.deletedAt)));
    if (stillLive.length === 2) throw error;
    return context.json({ error: "merge_conflict" }, 409);
  }
  const response: SpeakerDirectoryMergeResult = {
    keptPersonId: keptPerson.id,
    mergedPersonId: mergedPerson.id,
    reasons,
  };
  return context.json(response);
});

export default speakerDirectoryRoutes;
