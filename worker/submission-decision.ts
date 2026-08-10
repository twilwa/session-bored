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

const defaultOnboardingTasks = [
  "Confirm participation",
  "Upload headshot",
  "Complete bio and profile",
  "Upload final slides by 2027-05-01",
  "Sign speaker release form",
] as const;

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
    .where(eq(submissionSpeakers.submissionId, submissionId))
    .orderBy(submissionSpeakers.sortOrder);
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

  const acceptedSpeakers = [];
  for (const participant of participants) {
    let [speaker] = await database
      .select()
      .from(speakers)
      .where(and(eq(speakers.personId, participant.personId), eq(speakers.eventId, eventId)));
    if (speaker === undefined) {
      await database
        .insert(speakers)
        .values({
          id: createPublicId("spk"),
          personId: participant.personId,
          eventId,
          status: "onboarding",
        })
        .onConflictDoNothing();
      [speaker] = await database
        .select()
        .from(speakers)
        .where(and(eq(speakers.personId, participant.personId), eq(speakers.eventId, eventId)));
    }
    if (speaker === undefined) {
      throw new Error(`Speaker handoff failed for ${participant.personId}`);
    }
    await database
      .insert(sessionSpeakers)
      .values({
        id: createPublicId("ssnr"),
        sessionId: session.id,
        speakerId: speaker.id,
        roleLabel: participant.roleLabel,
        sortOrder: participant.sortOrder,
      })
      .onConflictDoNothing();
    acceptedSpeakers.push({
      id: speaker.id,
      name: participant.name,
      email: participant.email,
      jobTitle: participant.jobTitle,
      organization: participant.organization,
      bio: participant.bio,
    });
  }

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
  if (configuredTemplates.length === 0) {
    onboardingTasks = await database
      .select({ id: tasks.id, title: tasks.title })
      .from(tasks)
      .where(eq(tasks.sessionId, session.id))
      .orderBy(tasks.title);
    if (onboardingTasks.length === 0) {
      await database
        .insert(tasks)
        .values(defaultOnboardingTasks.map((title) => ({
          id: createPublicId("tsk"),
          eventId,
          sessionId: session.id,
          taskType: title.includes("Upload") ? "file_request" as const : "general" as const,
          title,
          dueAt: title.includes("2027-05-01") ? new Date("2027-05-01T23:59:59Z") : null,
          status: "active" as const,
        })))
        .onConflictDoNothing();
      onboardingTasks = await database
        .select({ id: tasks.id, title: tasks.title })
        .from(tasks)
        .where(eq(tasks.sessionId, session.id))
        .orderBy(tasks.title);
    } else {
      await database
        .update(tasks)
        .set({ status: "active" })
        .where(eq(tasks.sessionId, session.id));
    }
  }
  for (const task of onboardingTasks) {
    for (const speaker of acceptedSpeakers) {
      await database
        .insert(taskAssignees)
        .values({
          id: createPublicId("tassn"),
          taskId: task.id,
          speakerId: speaker.id,
        })
        .onConflictDoNothing();
    }
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
