// ABOUTME: Serves organizer-only speaker directory filters, profiles, metadata, and merge actions.
// ABOUTME: Keeps private contact context separate while preserving active product relationships.
import { and, eq, inArray, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import {
  files,
  people,
  sessionSpeakers,
  speakerDirectoryContactTags,
  speakerDirectoryCustomFields,
  speakerDirectoryNotes,
  speakerDirectorySegments,
  speakers,
  submissions,
  submissionSpeakers,
  taskAssignees,
  type Role,
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
import { chunkIds } from "../d1-limits.ts";
import {
  duplicateReasonsFor,
  filterSpeakerDirectory,
  loadSpeakerDirectory,
  loadSpeakerDirectoryNotes,
} from "../speaker-directory.ts";
import {
  applySpeakerMerge,
  planSpeakerMergeReferences,
  SpeakerMergePlanStaleError,
} from "../speaker-merge.ts";

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
  if (mergedPerson.userId !== null && keptPerson.userId !== mergedPerson.userId) {
    return context.json({ error: "account_conflict" }, 409);
  }

  const personIds = [keptPerson.id, mergedPerson.id];
  const [speakerRows, submissionRows, submissionSpeakerRows, contactTagRows, customFieldRows, noteRows] = await Promise.all([
    database.select({
      id: speakers.id,
      personId: speakers.personId,
      eventId: speakers.eventId,
      status: speakers.status,
      deletedAt: speakers.deletedAt,
    })
      .from(speakers)
      .where(inArray(speakers.personId, personIds)),
    database.select({ id: submissions.id, personId: submissions.submitterPersonId })
      .from(submissions)
      .where(eq(submissions.submitterPersonId, mergedPerson.id)),
    database.select({
      id: submissionSpeakers.id,
      submissionId: submissionSpeakers.submissionId,
      personId: submissionSpeakers.personId,
    }).from(submissionSpeakers).where(inArray(submissionSpeakers.personId, personIds)),
    database.select({
      personId: speakerDirectoryContactTags.personId,
      tagId: speakerDirectoryContactTags.tagId,
    }).from(speakerDirectoryContactTags).where(inArray(speakerDirectoryContactTags.personId, personIds)),
    database.select({
      id: speakerDirectoryCustomFields.id,
      personId: speakerDirectoryCustomFields.personId,
      normalizedName: speakerDirectoryCustomFields.normalizedName,
    }).from(speakerDirectoryCustomFields).where(inArray(speakerDirectoryCustomFields.personId, personIds)),
    database.select({ id: speakerDirectoryNotes.id, personId: speakerDirectoryNotes.personId })
      .from(speakerDirectoryNotes)
      .where(inArray(speakerDirectoryNotes.personId, personIds)),
  ]);
  const speakerIds = speakerRows.map((speaker) => speaker.id);
  const speakerIdChunks = chunkIds(speakerIds);
  const [sessionSpeakerRows, taskAssigneeRows, fileRows] = await Promise.all([
    Promise.all(speakerIdChunks.map((ids) => database.select({
      id: sessionSpeakers.id,
      sessionId: sessionSpeakers.sessionId,
      speakerId: sessionSpeakers.speakerId,
      roleLabel: sessionSpeakers.roleLabel,
      sortOrder: sessionSpeakers.sortOrder,
      publicationHoldAt: sessionSpeakers.publicationHoldAt,
      deletedAt: sessionSpeakers.deletedAt,
    }).from(sessionSpeakers).where(inArray(sessionSpeakers.speakerId, ids)))).then((rows) => rows.flat()),
    Promise.all(speakerIdChunks.map((ids) => database.select({
      id: taskAssignees.id,
      taskId: taskAssignees.taskId,
      speakerId: taskAssignees.speakerId,
    }).from(taskAssignees).where(inArray(taskAssignees.speakerId, ids)))).then((rows) => rows.flat()),
    Promise.all(speakerIdChunks.map((ids) => database.select({
      id: files.id,
      taskId: files.taskId,
      speakerId: files.speakerId,
      deletedAt: files.deletedAt,
    }).from(files).where(inArray(files.speakerId, ids)))).then((rows) => rows.flatMap((rowsForIds) => (
      rowsForIds.filter((row): row is typeof row & { speakerId: string } => row.speakerId !== null)
    ))),
  ]);
  const plan = planSpeakerMergeReferences({
    keptPersonId: keptPerson.id,
    mergedPersonId: mergedPerson.id,
    submissions: submissionRows,
    submissionSpeakers: submissionSpeakerRows,
    speakers: speakerRows,
    sessionSpeakers: sessionSpeakerRows,
    taskAssignees: taskAssigneeRows,
    files: fileRows,
    contactTags: contactTagRows,
    customFields: customFieldRows,
    notes: noteRows,
  });
  if (plan.conflicts.length > 0) {
    return context.json({
      error: "merge_requires_resolution",
      conflicts: plan.conflicts,
      note: "Resolve the same-event speaker records or conflicting session participation before merging these records.",
    }, 409);
  }

  try {
    await applySpeakerMerge({
      database: context.env.DB,
      plan,
      keptPersonId: keptPerson.id,
      mergedPersonId: mergedPerson.id,
      mergedByUserId: organizer.id,
      reasons,
      mergedProfile: mergedPerson,
      timestamp: Date.now(),
    });
  } catch (error) {
    if (error instanceof SpeakerMergePlanStaleError) {
      return context.json({
        error: "merge_plan_stale",
        note: "The records changed while this merge was being prepared. Review them again before merging.",
      }, 409);
    }
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
    plan,
  };
  return context.json(response);
});

export default speakerDirectoryRoutes;
