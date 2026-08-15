// ABOUTME: Serves organizer-only all-event speaker directory list, detail, and merge actions.
// ABOUTME: Archives detected duplicates while atomically preserving their active product relationships.
import { and, eq, inArray, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { files, people, speakers, type Role, type SpeakerStatus } from "../../db/schema.ts";
import type {
  SpeakerDirectoryDetailResponse,
  SpeakerDirectoryDuplicate,
  SpeakerDirectoryListResponse,
  SpeakerDirectoryMergeResult,
} from "../../shared/speaker-directory.ts";
import { holdsAccess } from "../access.ts";
import type { AuthSession } from "../auth.ts";
import { duplicateReasonsFor, loadSpeakerDirectory } from "../speaker-directory.ts";

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

speakerDirectoryRoutes.get("/api/speaker-directory", requireOrganizer, async (context) => {
  const directory = await loadSpeakerDirectory(drizzle(context.env.DB));
  const response: SpeakerDirectoryListResponse = {
    items: directory.items,
    possibleDuplicateGroups: directory.groups.length,
  };
  return context.json(response);
});

speakerDirectoryRoutes.get("/api/speaker-directory/:personId", requireOrganizer, async (context) => {
  const directory = await loadSpeakerDirectory(drizzle(context.env.DB));
  const personId = context.req.param("personId");
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
  };
  return context.json(response);
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
