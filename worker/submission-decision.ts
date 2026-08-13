// ABOUTME: Applies submission status changes and their reversible downstream handoffs.
// ABOUTME: Gives review and disposition routes one idempotent decision path.
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  createPublicId,
  people,
  sessionSpeakers,
  sessions,
  speakers,
  submissions,
  submissionSpeakers,
  submissionTracks,
  taskAssignees,
  taskScopes,
  tasks,
  type SubmissionStatus,
} from "../db/schema.ts";
import { grantRole } from "./roles.ts";

const defaultOnboardingTasks = [
  "Confirm participation",
  "Upload headshot",
  "Complete bio and profile",
  "Upload final slides by 2027-05-01",
  "Sign speaker release form",
] as const;

type DecisionDatabase = ReturnType<typeof drizzle>;

interface OnboardingTask {
  id: string;
  title: string;
}

/**
 * The onboarding work every participant on a session picks up. The event's own sessionless,
 * unscoped tasks are the configured template; an event that has configured none falls back to
 * the session's own tasks, seeded on first use.
 */
async function resolveOnboardingTasks(
  database: DecisionDatabase,
  eventId: string,
  sessionId: string,
): Promise<OnboardingTask[]> {
  let onboardingTasks = await database
    .select({ id: tasks.id, title: tasks.title })
    .from(tasks)
    .leftJoin(taskScopes, eq(taskScopes.taskId, tasks.id))
    .where(
      and(
        eq(tasks.eventId, eventId),
        isNull(tasks.sessionId),
        isNull(taskScopes.taskId),
        ne(tasks.status, "complete"),
      ),
    )
    .orderBy(tasks.id);
  const configuredTemplates = onboardingTasks.length > 0
    ? onboardingTasks
    : await database
      .select({ id: tasks.id })
      .from(tasks)
      .leftJoin(taskScopes, eq(taskScopes.taskId, tasks.id))
      .where(and(
        eq(tasks.eventId, eventId),
        isNull(tasks.sessionId),
        isNull(taskScopes.taskId),
      ))
      .limit(1);
  if (configuredTemplates.length > 0) {
    return onboardingTasks;
  }
  onboardingTasks = await database
    .select({ id: tasks.id, title: tasks.title })
    .from(tasks)
    .where(eq(tasks.sessionId, sessionId))
    .orderBy(tasks.title);
  if (onboardingTasks.length > 0) {
    await database
      .update(tasks)
      .set({ status: "active" })
      .where(eq(tasks.sessionId, sessionId));
    return onboardingTasks;
  }
  await database
    .insert(tasks)
    .values(defaultOnboardingTasks.map((title) => ({
      id: createPublicId("tsk"),
      eventId,
      sessionId,
      taskType: title.includes("Upload") ? "file_request" as const : "general" as const,
      title,
      dueAt: title.includes("2027-05-01") ? new Date("2027-05-01T23:59:59Z") : null,
      status: "active" as const,
    })))
    .onConflictDoNothing();
  return database
    .select({ id: tasks.id, title: tasks.title })
    .from(tasks)
    .where(eq(tasks.sessionId, sessionId))
    .orderBy(tasks.title);
}

/**
 * Carries one named participant onto a session: adopts their event speaker identity, links
 * them to the session under their own role label, and gives them the same onboarding work as
 * everybody else on it. Archived links are restored rather than duplicated, so a participant
 * who is removed and named again keeps their completion history.
 */
async function attachParticipant(
  database: DecisionDatabase,
  participant: {
    eventId: string;
    sessionId: string;
    personId: string;
    roleLabel: string;
    sortOrder: number;
    onboardingTasks: OnboardingTask[];
  },
): Promise<string> {
  const { eventId, sessionId, personId, roleLabel, sortOrder } = participant;
  let [speaker] = await database
    .select()
    .from(speakers)
    .where(and(eq(speakers.personId, personId), eq(speakers.eventId, eventId)));
  if (speaker === undefined) {
    await database
      .insert(speakers)
      .values({ id: createPublicId("spk"), personId, eventId, status: "onboarding" })
      .onConflictDoNothing();
    [speaker] = await database
      .select()
      .from(speakers)
      .where(and(eq(speakers.personId, personId), eq(speakers.eventId, eventId)));
  }
  if (speaker === undefined) {
    throw new Error(`Speaker handoff failed for ${personId}`);
  }
  // ABOUTME: A CFP author already has an `invited` speaker row from their first draft. Being carried
  // onto a session is what starts onboarding, so promote them the same way a newly adopted
  // participant starts — otherwise the person who wrote the proposal is the one missing from the
  // roster's onboarding work and from every public surface that gates on a cleared speaker.
  if (speaker.status === "invited") {
    await database
      .update(speakers)
      .set({ status: "onboarding" })
      .where(eq(speakers.id, speaker.id));
  }
  await database
    .insert(sessionSpeakers)
    .values({
      id: createPublicId("ssnr"),
      sessionId,
      speakerId: speaker.id,
      roleLabel,
      sortOrder,
    })
    .onConflictDoNothing();
  await database
    .update(sessionSpeakers)
    .set({ roleLabel, sortOrder, deletedAt: null })
    .where(and(eq(sessionSpeakers.sessionId, sessionId), eq(sessionSpeakers.speakerId, speaker.id)));
  for (const task of participant.onboardingTasks) {
    await database
      .insert(taskAssignees)
      .values({ id: createPublicId("tassn"), taskId: task.id, speakerId: speaker.id })
      .onConflictDoNothing();
    await database
      .update(taskAssignees)
      .set({ deletedAt: null })
      .where(and(eq(taskAssignees.taskId, task.id), eq(taskAssignees.speakerId, speaker.id)));
  }
  // Being carried onto a session is the organizer's decision that this person is presenting,
  // so it also opens the speaker portal to whichever account already holds their identity.
  // Naming somebody still mints nothing: an unclaimed person has no account to grant.
  const [linkedAccount] = await database
    .select({ userId: people.userId })
    .from(people)
    .where(eq(people.id, personId));
  if (linkedAccount?.userId != null) {
    await grantRole(database, {
      userId: linkedAccount.userId,
      role: "speaker",
      source: "acceptance",
      note: "Carried onto a session in the programme.",
    });
  }
  return speaker.id;
}

/**
 * Gives an already-accepted proposal's session a participant the program team named after the
 * decision. It runs the acceptance handoff for that one person, so a late addition reaches the
 * session, the roster, and their onboarding work on exactly the same terms as the rest.
 */
export async function carryParticipantIntoSession(
  binding: D1Database,
  eventId: string,
  sessionId: string,
  participant: { personId: string; roleLabel: string; sortOrder: number },
): Promise<string> {
  const database = drizzle(binding);
  return attachParticipant(database, {
    eventId,
    sessionId,
    personId: participant.personId,
    roleLabel: participant.roleLabel,
    sortOrder: participant.sortOrder,
    onboardingTasks: await resolveOnboardingTasks(database, eventId, sessionId),
  });
}

/**
 * The onboarding work that belongs to one session. It dies with a participant's place on that
 * session, because nobody owes a trailer for a session they no longer speak at.
 */
async function sessionScopedTaskIds(
  database: DecisionDatabase,
  eventId: string,
  sessionId: string,
): Promise<string[]> {
  const rows = await database
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.eventId, eventId), eq(tasks.sessionId, sessionId)));
  return rows.map((task) => task.id);
}

/**
 * The event's configured onboarding templates - a headshot, a bio - which belong to the person
 * rather than to any one session, so they outlive leaving a session and are taken back only
 * once the person speaks nowhere at the event. Read-only, unlike `resolveOnboardingTasks`,
 * because taking work back from somebody must never seed the tasks it is about to archive.
 */
async function eventOnboardingTaskIds(
  database: DecisionDatabase,
  eventId: string,
): Promise<string[]> {
  const rows = await database
    .select({ id: tasks.id })
    .from(tasks)
    .leftJoin(taskScopes, eq(taskScopes.taskId, tasks.id))
    .where(and(
      eq(tasks.eventId, eventId),
      isNull(tasks.sessionId),
      isNull(taskScopes.taskId),
    ));
  return rows.map((task) => task.id);
}

export interface ParticipantRelease {
  /** Whether they still hold a live session at this event after being let go of this one. */
  speaksElsewhereAtEvent: boolean;
}

/**
 * Takes back what `carryParticipantIntoSession` gave, for somebody the program team or the
 * author has removed from the proposal. It archives the session link, and the onboarding work
 * that being carried onto a session created, so no speaker-facing read or write still answers
 * them. Their onboarding work survives while they still speak somewhere else at the event, and
 * everything archived here comes back untouched if they are named again — the speaker, the
 * session, the assignments, and their completion history are never erased.
 *
 * Whether the event-scoped `speaker` row itself should be withdrawn when this was their last
 * session is an open programme decision (issue #127), and it is the answer that drives the
 * public speaker directory, the roster's own row, and mail eligibility. This is where that
 * answer belongs: `speaksElsewhereAtEvent` is the fact it needs, computed once, here.
 */
export async function releaseParticipantFromSession(
  binding: D1Database,
  eventId: string,
  sessionId: string,
  personId: string,
): Promise<ParticipantRelease> {
  const database = drizzle(binding);
  const [speaker] = await database
    .select({ id: speakers.id })
    .from(speakers)
    .where(and(eq(speakers.personId, personId), eq(speakers.eventId, eventId)));
  if (speaker === undefined) {
    return { speaksElsewhereAtEvent: false };
  }
  await database
    .update(sessionSpeakers)
    .set({ deletedAt: new Date() })
    .where(and(
      eq(sessionSpeakers.sessionId, sessionId),
      eq(sessionSpeakers.speakerId, speaker.id),
      isNull(sessionSpeakers.deletedAt),
    ));
  const archiveAssignments = async (taskIds: readonly string[]) => {
    if (taskIds.length === 0) {
      return;
    }
    await database
      .update(taskAssignees)
      .set({ deletedAt: new Date() })
      .where(and(
        eq(taskAssignees.speakerId, speaker.id),
        inArray(taskAssignees.taskId, [...taskIds]),
        isNull(taskAssignees.deletedAt),
      ));
  };
  // This session's own work goes back every time, not only on the last removal. Deferring it
  // would strand it: a later removal only ever looks at the session it was given, so work from
  // a session left earlier would stay live for somebody who speaks nowhere at the event.
  await archiveAssignments(await sessionScopedTaskIds(database, eventId, sessionId));
  const stillSpeaking = await database
    .select({ id: sessionSpeakers.id })
    .from(sessionSpeakers)
    .innerJoin(sessions, eq(sessions.id, sessionSpeakers.sessionId))
    .where(and(
      eq(sessionSpeakers.speakerId, speaker.id),
      eq(sessions.eventId, eventId),
      isNull(sessionSpeakers.deletedAt),
      isNull(sessions.deletedAt),
    ))
    .limit(1);
  if (stillSpeaking.length > 0) {
    return { speaksElsewhereAtEvent: true };
  }
  await archiveAssignments(await eventOnboardingTaskIds(database, eventId));
  return { speaksElsewhereAtEvent: false };
}

async function ensureAcceptedHandoff(
  binding: D1Database,
  eventId: string,
  submissionId: string,
) {
  const database = drizzle(binding);
  const [submission] = await database
    .select()
    .from(submissions)
    .where(and(eq(submissions.id, submissionId), eq(submissions.eventId, eventId)));
  if (submission === undefined) {
    throw new Error(`Submission ${submissionId} was not found for handoff`);
  }
  const [submissionTrack] = await database
    .select({ trackId: submissionTracks.trackId })
    .from(submissionTracks)
    .where(eq(submissionTracks.submissionId, submissionId))
    .limit(1);

  let [session] = await database
    .select()
    .from(sessions)
    .where(eq(sessions.submissionId, submissionId));
  if (session === undefined) {
    await database
      .insert(sessions)
      .values({
        id: createPublicId("ses"),
        eventId,
        submissionId,
        trackId: submissionTrack?.trackId,
        formatId: submission.formatId,
        title: submission.title,
        abstract: submission.abstract,
        contentStatus: "draft",
        scheduleStatus: "unplaced",
        icsUid: `${submissionId}@greenroom`,
      })
      .onConflictDoNothing();
    [session] = await database
      .select()
      .from(sessions)
      .where(eq(sessions.submissionId, submissionId));
  }
  if (session === undefined) {
    throw new Error(`Session handoff failed for ${submissionId}`);
  }

  let participants = await database
    .select({
      personId: people.id,
      name: people.name,
      email: people.email,
      jobTitle: people.jobTitle,
      organization: people.organization,
      bio: people.bio,
      roleLabel: submissionSpeakers.roleLabel,
      sortOrder: submissionSpeakers.sortOrder,
    })
    .from(submissionSpeakers)
    .innerJoin(people, eq(submissionSpeakers.personId, people.id))
    .where(and(eq(submissionSpeakers.submissionId, submissionId), isNull(submissionSpeakers.deletedAt)))
    .orderBy(submissionSpeakers.sortOrder, submissionSpeakers.id);
  if (participants.length === 0) {
    const [submitter] = await database
      .select({
        personId: people.id,
        name: people.name,
        email: people.email,
        jobTitle: people.jobTitle,
        organization: people.organization,
        bio: people.bio,
      })
      .from(people)
      .where(eq(people.id, submission.submitterPersonId));
    participants = submitter === undefined ? [] : [{ ...submitter, roleLabel: "speaker", sortOrder: 0 }];
  }

  const onboardingTasks = await resolveOnboardingTasks(database, eventId, session.id);
  const acceptedSpeakers = [];
  for (const participant of participants) {
    const speakerId = await attachParticipant(database, {
      eventId,
      sessionId: session.id,
      personId: participant.personId,
      roleLabel: participant.roleLabel,
      sortOrder: participant.sortOrder,
      onboardingTasks,
    });
    acceptedSpeakers.push({
      id: speakerId,
      name: participant.name,
      email: participant.email,
      jobTitle: participant.jobTitle,
      organization: participant.organization,
      bio: participant.bio,
    });
  }

  return {
    submissionId,
    active: true,
    session: {
      id: session.id,
      title: session.title,
      abstract: session.abstract,
      trackId: session.trackId,
      formatId: session.formatId,
    },
    speakers: acceptedSpeakers,
    tasks: onboardingTasks,
  };
}

async function retainUnacceptedHandoff(
  binding: D1Database,
  eventId: string,
  submissionId: string,
) {
  const database = drizzle(binding);
  const [session] = await database
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.eventId, eventId),
        eq(sessions.submissionId, submissionId),
      ),
    );
  if (session === undefined) {
    return null;
  }
  await database
    .update(sessions)
    .set({ contentStatus: "draft" })
    .where(eq(sessions.id, session.id));
  await database
    .update(tasks)
    .set({ status: "draft" })
    .where(eq(tasks.sessionId, session.id));
  return {
    submissionId,
    active: false,
    retained: true,
    sessionId: session.id,
    contentStatus: "draft",
    schedulePreserved: true,
  };
}

export async function changeSubmissionStatuses(
  binding: D1Database,
  submissionIds: string[],
  status: SubmissionStatus,
  eventId?: string,
) {
  const uniqueIds = [...new Set(submissionIds)];
  const database = drizzle(binding);
  const selected = await database
    .select({ id: submissions.id, eventId: submissions.eventId })
    .from(submissions)
    .where(
      eventId === undefined
        ? inArray(submissions.id, uniqueIds)
        : and(eq(submissions.eventId, eventId), inArray(submissions.id, uniqueIds)),
    );
  if (selected.length !== uniqueIds.length) {
    return null;
  }
  const selectedById = new Map(selected.map((item) => [item.id, item]));
  const orderedSelections = uniqueIds.flatMap((id) => {
    const item = selectedById.get(id);
    return item === undefined ? [] : [item];
  });
  const handoffs = status === "accepted"
    ? await Promise.all(orderedSelections.map((item) =>
      ensureAcceptedHandoff(binding, item.eventId, item.id)
    ))
    : [];
  const retainedHandoffs = status === "accepted"
    ? []
    : (await Promise.all(orderedSelections.map((item) =>
      retainUnacceptedHandoff(binding, item.eventId, item.id)
    ))).filter((handoff) => handoff !== null);
  const updated = await database
    .update(submissions)
    .set({ status })
    .where(
      eventId === undefined
        ? inArray(submissions.id, uniqueIds)
        : and(eq(submissions.eventId, eventId), inArray(submissions.id, uniqueIds)),
    )
    .returning({ id: submissions.id, status: submissions.status });
  const updatedById = new Map(updated.map((item) => [item.id, item]));
  const ordered = uniqueIds.flatMap((id) => {
    const item = updatedById.get(id);
    return item === undefined ? [] : [item];
  });

  return { updated: ordered, handoffs, retainedHandoffs };
}
