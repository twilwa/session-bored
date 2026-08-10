// ABOUTME: Populates D1 idempotently from the exact DevFlow Conf 2027 grading fixture.
// ABOUTME: Provisions usable Better Auth passwords and linked domain records for every role.
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import fixture from "../fixtures/sample-data.json";
import {
  events,
  formFields,
  formVersionFields,
  formVersions,
  formats,
  forms,
  people,
  reviewAssignments,
  reviewerRoundPools,
  reviewerTracks,
  reviewRounds,
  rooms,
  scorecardCriteria,
  sessionSpeakers,
  sessions,
  speakers,
  submissionSpeakers,
  submissions,
  submissionTracks,
  systemState,
  taskAssignees,
  tasks,
  tracks,
  users,
  type Role,
} from "../db/schema.ts";
import { createAuth } from "./auth.ts";

export const fixtureIds = {
  event: "evt_devflow_conf_2027",
  form: "frm_devflow_cfp_2027",
  people: {
    organizer: "psn_jordan_alvarez",
    speaker: "psn_priya_raman",
    speaker2: "psn_marcus_okafor",
    reviewer: "psn_sam_whitfield",
  },
  speakers: {
    speaker: "spk_priya_devflow_2027",
    speaker2: "spk_marcus_devflow_2027",
  },
  submissions: ["sub_ci_monorepo", "sub_ai_verification", "sub_docs_retrieval"],
  round: "rnd_initial_review",
  assignment: "asn_sam_ci_monorepo",
  session: "ses_docs_retrieval",
} as const;

interface SeedIdentity {
  name: string;
  email: string;
  password: string;
}

async function ensureIdentity(
  env: CloudflareBindings,
  identity: SeedIdentity,
  role: Role,
): Promise<string> {
  const database = drizzle(env.DB);
  const [existing] = await database.select({ id: users.id }).from(users).where(eq(users.email, identity.email));
  if (existing === undefined) {
    await createAuth(env).api.signUpEmail({
      body: {
        name: identity.name,
        email: identity.email,
        password: identity.password,
      },
    });
  }
  await database.update(users).set({ role }).where(eq(users.email, identity.email));
  const [seeded] = await database.select({ id: users.id }).from(users).where(eq(users.email, identity.email));
  if (seeded === undefined) {
    throw new Error(`Identity was not created for ${identity.email}`);
  }
  return seeded.id;
}

export async function ensureSeeded(env: CloudflareBindings): Promise<void> {
  const database = drizzle(env.DB);
  const [marker] = await database
    .select({ id: systemState.id })
    .from(systemState)
    .where(eq(systemState.key, "fixture.devflow-2027.v1"));
  if (marker !== undefined) {
    return;
  }

  const organizerUserId = await ensureIdentity(env, fixture.identities.organizer, "organizer");
  const reviewerUserId = await ensureIdentity(env, fixture.identities.reviewer, "reviewer");
  const speakerUserId = await ensureIdentity(env, fixture.identities.speaker, "speaker");
  const speaker2UserId = await ensureIdentity(env, fixture.identities.speaker2, "speaker");

  await database
    .insert(events)
    .values({
      id: fixtureIds.event,
      slug: "devflow-conf-2027",
      name: fixture.event.name,
      tagline: fixture.event.tagline,
      description: fixture.event.description,
      startDate: "2027-05-12",
      endDate: "2027-05-14",
      venue: fixture.event.location,
      timezone: "America/Los_Angeles",
      branding: { primaryColor: "#6d5dfc", accentColor: "#b9ff66" },
    })
    .onConflictDoNothing();

  const trackRows = fixture.event.tracks.map((name, index) => ({
    id: `trk_${["ai_engineering", "platform_infra", "developer_experience"][index]}`,
    eventId: fixtureIds.event,
    name,
    sortOrder: index,
  }));
  await database.insert(tracks).values(trackRows).onConflictDoNothing();

  const formatRows = fixture.event.session_formats.map((name, index) => ({
    id: `fmt_${["keynote_45", "talk_30", "lightning_10", "workshop_120", "panel_45"][index]}`,
    eventId: fixtureIds.event,
    name,
    durationMinutes: [45, 30, 10, 120, 45][index],
    sortOrder: index,
  }));
  await database.insert(formats).values(formatRows).onConflictDoNothing();

  const roomRows = fixture.event.rooms.map((name, index) => ({
    id: `rm_${["main_stage", "room_2a", "room_2b", "workshop_lab"][index]}`,
    eventId: fixtureIds.event,
    name,
    sortOrder: index,
  }));
  await database.insert(rooms).values(roomRows).onConflictDoNothing();

  await database
    .insert(forms)
    .values({
      id: fixtureIds.form,
      eventId: fixtureIds.event,
      name: "Call for Speakers 2027",
      publicSlug: "devflow-conf-2027",
      version: 1,
      status: "published",
      openAt: new Date("2026-08-01T00:00:00Z"),
      closeAt: new Date("2027-04-30T23:59:59Z"),
      welcomeCopy: "Share practical lessons with the DevFlow community.",
      confirmationCopy: "Thanks — your proposal is safely in the review queue.",
      confirmationEmailCopy: "We received {talk_title} for DevFlow Conf 2027.",
      minimumSpeakers: 1,
      publishedAt: new Date("2026-08-01T00:00:00Z"),
    })
    .onConflictDoNothing();

  await database
    .insert(formFields)
    .values([
      {
        id: "fld_session_title",
        formId: fixtureIds.form,
        key: "session_title",
        label: "Session title",
        fieldType: "short_text",
        required: true,
        sortOrder: 0,
      },
      {
        id: "fld_abstract",
        formId: fixtureIds.form,
        key: "abstract",
        label: "Abstract",
        fieldType: "long_text",
        required: true,
        sortOrder: 1,
      },
      {
        id: "fld_track",
        formId: fixtureIds.form,
        key: "track",
        label: "Track",
        fieldType: "dropdown",
        options: fixture.event.tracks,
        required: true,
        sortOrder: 2,
      },
      {
        id: "fld_format",
        formId: fixtureIds.form,
        key: "format",
        label: "Format",
        fieldType: "dropdown",
        options: fixture.event.session_formats,
        required: true,
        sortOrder: 3,
      },
      {
        id: "fld_speaker_bio",
        formId: fixtureIds.form,
        key: "speaker_bio",
        label: "Speaker bio",
        fieldType: "long_text",
        required: false,
        sortOrder: 4,
      },
      {
        id: "fld_key_takeaway",
        formId: fixtureIds.form,
        key: "key_takeaway",
        label: "Key takeaway",
        fieldType: "short_text",
        required: true,
        sortOrder: 5,
      },
      {
        id: "fld_audience_level",
        formId: fixtureIds.form,
        key: "audience_level",
        label: "Audience level",
        fieldType: "dropdown",
        options: ["Beginner", "Intermediate", "Advanced"],
        required: false,
        sortOrder: 6,
      },
      {
        id: "fld_workshop_prerequisites",
        formId: fixtureIds.form,
        key: "workshop_prerequisites",
        label: "Workshop prerequisites",
        fieldType: "long_text",
        required: false,
        sortOrder: 7,
        conditionalFieldId: "fld_format",
        conditionalOperator: "equals",
        conditionalValue: "Workshop (120 min)",
      },
    ])
    .onConflictDoNothing();

  const seedFormVersionId = `${fixtureIds.form}:v1`;
  await database
    .insert(formVersions)
    .values({
      id: seedFormVersionId,
      formId: fixtureIds.form,
      version: 1,
      status: "published",
      openAt: new Date("2026-08-01T00:00:00Z"),
      closeAt: new Date("2027-04-30T23:59:59Z"),
      welcomeCopy: "Share practical lessons with the DevFlow community.",
      confirmationCopy: "Thanks — your proposal is safely in the review queue.",
      confirmationEmailCopy: "We received {talk_title} for DevFlow Conf 2027.",
      minimumSpeakers: 1,
      publishedAt: new Date("2026-08-01T00:00:00Z"),
    })
    .onConflictDoNothing();
  const seedFields = await database.select().from(formFields).where(eq(formFields.formId, fixtureIds.form));
  for (const field of seedFields) {
    await database
      .insert(formVersionFields)
      .values({
        id: field.id,
        formVersionId: seedFormVersionId,
        stableFieldId: field.id,
        key: field.key,
        label: field.label,
        description: field.description,
        fieldType: field.fieldType as "short_text" | "long_text" | "dropdown",
        required: field.required,
        sortOrder: field.sortOrder,
        options: field.options,
        validation: field.validation,
      })
      .onConflictDoNothing();
  }
  for (const field of seedFields) {
    if (field.conditionalFieldId === null) {
      continue;
    }
    await database
      .update(formVersionFields)
      .set({
        conditionalFieldId: field.conditionalFieldId,
        conditionalOperator: field.conditionalOperator,
        conditionalValue: field.conditionalValue,
      })
      .where(eq(formVersionFields.id, field.id));
  }

  await database
    .insert(people)
    .values([
      {
        id: fixtureIds.people.organizer,
        userId: organizerUserId,
        name: fixture.identities.organizer.name,
        email: fixture.identities.organizer.email,
      },
      {
        id: fixtureIds.people.reviewer,
        userId: reviewerUserId,
        name: fixture.identities.reviewer.name,
        email: fixture.identities.reviewer.email,
      },
      {
        id: fixtureIds.people.speaker,
        userId: speakerUserId,
        name: fixture.identities.speaker.name,
        email: fixture.identities.speaker.email,
        jobTitle: fixture.identities.speaker.title,
        organization: fixture.identities.speaker.company,
        bio: fixture.identities.speaker.bio,
        twitter: fixture.identities.speaker.twitter,
        linkedin: fixture.identities.speaker.linkedin,
        socialLinks: {
          twitter: fixture.identities.speaker.twitter,
          linkedin: fixture.identities.speaker.linkedin,
        },
      },
      {
        id: fixtureIds.people.speaker2,
        userId: speaker2UserId,
        name: fixture.identities.speaker2.name,
        email: fixture.identities.speaker2.email,
        jobTitle: fixture.identities.speaker2.title,
        organization: fixture.identities.speaker2.company,
        bio: fixture.identities.speaker2.bio,
      },
    ])
    .onConflictDoNothing();

  await database
    .insert(speakers)
    .values([
      {
        id: fixtureIds.speakers.speaker,
        personId: fixtureIds.people.speaker,
        eventId: fixtureIds.event,
        status: "onboarding",
        customFields: { dietary: fixture.identities.speaker.dietary, tshirt: fixture.identities.speaker.tshirt },
      },
      {
        id: fixtureIds.speakers.speaker2,
        personId: fixtureIds.people.speaker2,
        eventId: fixtureIds.event,
        status: "confirmed",
      },
    ])
    .onConflictDoNothing();

  for (const [index, submission] of fixture.submissions.entries()) {
    const submissionId = fixtureIds.submissions[index];
    if (submissionId === undefined) {
      throw new Error(`Fixture ID missing for ${submission.title}`);
    }
    const speakerPersonId = index === 2 ? fixtureIds.people.speaker2 : fixtureIds.people.speaker;
    const speakerIdentity = index === 2 ? fixture.identities.speaker2 : fixture.identities.speaker;
    const [format] = await database.select({ id: formats.id }).from(formats).where(
      and(eq(formats.eventId, fixtureIds.event), eq(formats.name, submission.format)),
    );
    const [track] = await database.select({ id: tracks.id }).from(tracks).where(
      and(eq(tracks.eventId, fixtureIds.event), eq(tracks.name, submission.track)),
    );
    if (format === undefined || track === undefined) {
      throw new Error(`Fixture taxonomy missing for ${submission.title}`);
    }
    await database
      .insert(submissions)
      .values({
        id: submissionId,
        eventId: fixtureIds.event,
        formId: fixtureIds.form,
        formVersion: 1,
        submitterPersonId: speakerPersonId,
        formatId: format.id,
        status: index === 0 ? "under_review" : "submitted",
        isDraft: false,
        title: submission.title,
        abstract: submission.abstract,
        titleAtTime: speakerIdentity.title,
        orgAtTime: speakerIdentity.company,
        audienceLevel: submission.audience_level,
        notesForReviewers: "notes_for_reviewers" in submission ? submission.notes_for_reviewers : null,
        submittedAt: new Date("2027-01-10T18:00:00Z"),
      })
      .onConflictDoNothing();
    await database
      .insert(submissionTracks)
      .values({ id: `strk_fixture_${index}`, submissionId, trackId: track.id })
      .onConflictDoNothing();
    await database
      .insert(submissionSpeakers)
      .values({ id: `sspk_fixture_${index}`, submissionId, personId: speakerPersonId })
      .onConflictDoNothing();
  }

  const publicSessionFixture = fixture.submissions[2];
  if (publicSessionFixture === undefined) {
    throw new Error("Public session fixture is missing");
  }
  await database
    .insert(reviewRounds)
    .values({
      id: fixtureIds.round,
      eventId: fixtureIds.event,
      name: "Initial review",
      opensAt: new Date("2027-01-01T00:00:00Z"),
      closesAt: new Date("2027-02-15T23:59:59Z"),
      status: "open",
    })
    .onConflictDoNothing();
  await database
    .insert(scorecardCriteria)
    .values([
      {
        id: "crt_overall_rating",
        roundId: fixtureIds.round,
        label: "Overall rating",
        criterionType: "numeric",
        weight: 1,
        required: true,
      },
      {
        id: "crt_recommendation",
        roundId: fixtureIds.round,
        label: "Recommendation",
        criterionType: "dropdown",
        options: ["Accept", "Maybe", "Decline"],
        required: true,
      },
      {
        id: "crt_notes",
        roundId: fixtureIds.round,
        label: "Reviewer notes",
        criterionType: "free_text",
      },
    ])
    .onConflictDoNothing();
  await database
    .insert(reviewerRoundPools)
    .values({ id: "rpool_sam_initial", roundId: fixtureIds.round, reviewerUserId })
    .onConflictDoNothing();
  await database
    .insert(reviewerTracks)
    .values({
      id: "rtrk_sam_platform",
      eventId: fixtureIds.event,
      reviewerUserId,
      trackId: "trk_platform_infra",
    })
    .onConflictDoNothing();
  await database
    .insert(reviewAssignments)
    .values({
      id: fixtureIds.assignment,
      roundId: fixtureIds.round,
      submissionId: fixtureIds.submissions[0],
      reviewerUserId,
      status: "assigned",
    })
    .onConflictDoNothing();

  await database
    .insert(sessions)
    .values({
      id: fixtureIds.session,
      eventId: fixtureIds.event,
      submissionId: fixtureIds.submissions[2],
      trackId: "trk_developer_experience",
      formatId: "fmt_lightning_10",
      title: publicSessionFixture.title,
      abstract: publicSessionFixture.abstract,
      contentStatus: "approved",
      scheduleStatus: "tbd",
      scheduledDate: "2027-05-13",
      icsUid: "ses_docs_retrieval@session-bored",
    })
    .onConflictDoNothing();
  await database
    .insert(sessionSpeakers)
    .values({ id: "ssnr_docs_marcus", sessionId: fixtureIds.session, speakerId: fixtureIds.speakers.speaker2 })
    .onConflictDoNothing();

  for (const [index, title] of fixture.tasks_for_speakers.entries()) {
    const taskId = `tsk_fixture_${index}`;
    await database
      .insert(tasks)
      .values({
        id: taskId,
        eventId: fixtureIds.event,
        taskType: title.includes("Upload") ? "file_request" : "general",
        title,
        dueAt: title.includes("2027-05-01") ? new Date("2027-05-01T23:59:59Z") : null,
        status: "active",
      })
      .onConflictDoNothing();
    await database
      .insert(taskAssignees)
      .values({ id: `tassn_fixture_${index}`, taskId, speakerId: fixtureIds.speakers.speaker })
      .onConflictDoNothing();
  }

  await database
    .insert(systemState)
    .values({ id: "sys_fixture_devflow_2027_v1", key: "fixture.devflow-2027.v1", value: { seeded: "true" } })
    .onConflictDoNothing();
}

export { fixture };
