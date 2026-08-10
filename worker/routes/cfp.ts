// ABOUTME: Serves the public CFP lifecycle from call details through author-owned edits.
// ABOUTME: Keeps incomplete drafts writable while enforcing form rules and deadlines on the server.
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import {
  createPublicId,
  events,
  formFields,
  formVersionFields,
  formVersions,
  formats,
  forms,
  people,
  speakers,
  submissionAuthorAccess,
  submissionSpeakers,
  submissions,
  submissionTracks,
  submissionValues,
  tracks,
} from "../../db/schema.ts";
import { sendSubmissionConfirmationEmail } from "../email/submission-confirmation.ts";

export interface CfpAvailability {
  canWrite: boolean;
  message: string;
  state: "closed" | "open" | "upcoming" | "unpublished";
}

interface CfpWindow {
  status: string;
  openAt: Date | null;
  closeAt: Date | null;
}

interface SubmissionField {
  id: string;
  key: string;
  label: string;
  required: boolean;
  conditionalFieldId?: string | null;
  conditionalOperator?: "equals" | null;
  conditionalValue?: string | null;
}

export interface CfpSubmissionInput {
  intent: "draft" | "save" | "submit";
  speaker: {
    name?: string | undefined;
    email?: string | undefined;
    jobTitle?: string | undefined;
    organization?: string | undefined;
    bio?: string | undefined;
  };
  proposal: {
    title?: string | undefined;
    abstract?: string | undefined;
    track?: string | undefined;
    format?: string | undefined;
    audienceLevel?: string | undefined;
    notesForReviewers?: string | undefined;
    answers?: Record<string, string | number | boolean | string[] | null>;
  };
}

export type CfpValidationErrors = Record<string, string>;

export function getCfpAvailability(form: CfpWindow, now = new Date()): CfpAvailability {
  if (form.status === "closed") {
    return {
      canWrite: false,
      state: "closed",
      message: "This call for speakers is closed. New submissions and edits are no longer accepted.",
    };
  }
  if (form.status !== "published") {
    return {
      canWrite: false,
      state: "unpublished",
      message: "This call for speakers is not currently published.",
    };
  }
  if (form.openAt !== null && now.getTime() < form.openAt.getTime()) {
    return {
      canWrite: false,
      state: "upcoming",
      message: `This call for speakers opens at ${form.openAt.toISOString()}.`,
    };
  }
  if (form.closeAt !== null && now.getTime() >= form.closeAt.getTime()) {
    return {
      canWrite: false,
      state: "closed",
      message: `This call for speakers closed at ${form.closeAt.toISOString()}. New submissions and edits are no longer accepted.`,
    };
  }
  return {
    canWrite: true,
    state: "open",
    message: "This call for speakers is open for submissions.",
  };
}

function fieldValue(field: SubmissionField, input: CfpSubmissionInput): unknown {
  switch (field.key) {
    case "session_title":
      return input.proposal.title;
    case "abstract":
      return input.proposal.abstract;
    case "track":
      return input.proposal.track;
    case "format":
      return input.proposal.format;
    case "speaker_bio":
      return input.speaker.bio;
    case "audience_level":
      return input.proposal.audienceLevel;
    case "notes_for_reviewers":
      return input.proposal.notesForReviewers;
    default:
      return input.proposal.answers?.[field.key];
  }
}

function isBlank(value: unknown): boolean {
  return value === undefined
    || value === null
    || (typeof value === "string" && value.trim() === "")
    || (Array.isArray(value) && value.length === 0);
}

function isFieldVisible(
  fields: readonly SubmissionField[],
  field: SubmissionField,
  input: CfpSubmissionInput,
  visited = new Set<string>(),
): boolean {
  if (field.conditionalFieldId === undefined || field.conditionalFieldId === null) {
    return true;
  }
  if (visited.has(field.id)) {
    return false;
  }
  const controllingField = fields.find((candidate) => candidate.id === field.conditionalFieldId);
  if (controllingField === undefined) {
    return false;
  }
  const nextVisited = new Set(visited).add(field.id);
  return isFieldVisible(fields, controllingField, input, nextVisited)
    && field.conditionalOperator === "equals"
    && fieldValue(controllingField, input) === field.conditionalValue;
}

export function validateCfpSubmission(
  fields: readonly SubmissionField[],
  input: CfpSubmissionInput,
): CfpValidationErrors {
  const errors: CfpValidationErrors = {};
  if (input.speaker.name?.trim() === "" || input.speaker.name === undefined) {
    errors.speakerName = "Your name is required to save this proposal.";
  }
  const email = input.speaker.email?.trim() ?? "";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    errors.speakerEmail = "Enter a valid email address so you can return to this proposal.";
  }
  if (input.intent === "draft") {
    return errors;
  }
  for (const field of fields) {
    if (isFieldVisible(fields, field, input) && field.required && isBlank(fieldValue(field, input))) {
      errors[field.key] = `${field.label} is required.`;
    }
  }
  return errors;
}

type CfpDatabase = ReturnType<typeof drizzle>;

interface CfpRecordSet {
  event: typeof events.$inferSelect;
  fields: Array<typeof formVersionFields.$inferSelect>;
  form: typeof forms.$inferSelect;
}

function normalizeInput(value: unknown): CfpSubmissionInput | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.intent !== "draft" && record.intent !== "save" && record.intent !== "submit") {
    return null;
  }
  const speaker = typeof record.speaker === "object" && record.speaker !== null
    ? record.speaker as Record<string, unknown>
    : {};
  const proposal = typeof record.proposal === "object" && record.proposal !== null
    ? record.proposal as Record<string, unknown>
    : {};
  const textValue = (candidate: unknown) => typeof candidate === "string" ? candidate : undefined;
  const answers = typeof proposal.answers === "object" && proposal.answers !== null && !Array.isArray(proposal.answers)
    ? proposal.answers as Record<string, string | number | boolean | string[] | null>
    : {};
  return {
    intent: record.intent,
    speaker: {
      name: textValue(speaker.name),
      email: textValue(speaker.email),
      jobTitle: textValue(speaker.jobTitle),
      organization: textValue(speaker.organization),
      bio: textValue(speaker.bio),
    },
    proposal: {
      title: textValue(proposal.title),
      abstract: textValue(proposal.abstract),
      track: textValue(proposal.track),
      format: textValue(proposal.format),
      audienceLevel: textValue(proposal.audienceLevel),
      notesForReviewers: textValue(proposal.notesForReviewers),
      answers,
    },
  };
}

async function getCfp(database: CfpDatabase, slug: string, pinnedVersion?: number): Promise<CfpRecordSet | null> {
  const [form] = await database.select().from(forms).where(eq(forms.publicSlug, slug));
  if (form === undefined) {
    return null;
  }
  const [version] = await database
    .select()
    .from(formVersions)
    .where(and(
      eq(formVersions.formId, form.id),
      eq(formVersions.version, pinnedVersion ?? form.version),
    ));
  if (version === undefined) {
    return null;
  }
  const [event, fields] = await Promise.all([
    database.select().from(events).where(eq(events.id, form.eventId)).then((rows) => rows[0]),
    database
      .select()
      .from(formVersionFields)
      .where(eq(formVersionFields.formVersionId, version.id))
      .orderBy(asc(formVersionFields.sortOrder)),
  ]);
  return event === undefined ? null : {
    event,
    fields,
    form: {
      ...form,
      version: version.version,
      status: form.status === "closed" ? "closed" : version.status,
      openAt: version.openAt,
      closeAt: form.closeAt !== null && (version.closeAt === null || form.closeAt < version.closeAt)
        ? form.closeAt
        : version.closeAt,
      welcomeCopy: version.welcomeCopy,
      confirmationCopy: version.confirmationCopy,
      confirmationEmailCopy: version.confirmationEmailCopy,
      minimumSpeakers: version.minimumSpeakers,
      maximumSpeakers: version.maximumSpeakers,
      publishedAt: version.publishedAt,
    },
  };
}

function availabilityError(availability: CfpAvailability): {
  error: "cfp_closed" | "cfp_not_open" | "cfp_unpublished";
  message: string;
} {
  return {
    error: availability.state === "closed"
      ? "cfp_closed"
      : availability.state === "upcoming" ? "cfp_not_open" : "cfp_unpublished",
    message: availability.message,
  };
}

async function createAuthorKey(): Promise<{ key: string; hash: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const key = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  return { key, hash: await hashAuthorKey(key) };
}

async function hashAuthorKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function authorizeSubmission(
  database: CfpDatabase,
  submissionId: string,
  key: string | undefined,
  userId?: string,
): Promise<boolean> {
  if (key !== undefined && key !== "") {
    const [access] = await database
      .select({ submissionId: submissionAuthorAccess.submissionId })
      .from(submissionAuthorAccess)
      .where(
        and(
          eq(submissionAuthorAccess.submissionId, submissionId),
          eq(submissionAuthorAccess.authorKeyHash, await hashAuthorKey(key)),
        ),
      );
    if (access !== undefined) {
      await database
        .update(submissionAuthorAccess)
        .set({ lastUsedAt: new Date() })
        .where(eq(submissionAuthorAccess.submissionId, submissionId));
      return true;
    }
  }
  if (userId === undefined) {
    return false;
  }
  const [owned] = await database
    .select({ id: submissions.id })
    .from(submissions)
    .innerJoin(people, eq(submissions.submitterPersonId, people.id))
    .where(and(eq(submissions.id, submissionId), eq(people.userId, userId)));
  return owned !== undefined;
}

async function resolveTaxonomy(
  database: CfpDatabase,
  eventId: string,
  input: CfpSubmissionInput,
): Promise<{
  errors: CfpValidationErrors;
  formatId: string | null;
  trackId: string | null;
}> {
  const [format, track] = await Promise.all([
    input.proposal.format === undefined || input.proposal.format.trim() === ""
      ? Promise.resolve(undefined)
      : database
        .select({ id: formats.id })
        .from(formats)
        .where(and(eq(formats.eventId, eventId), eq(formats.name, input.proposal.format)))
        .then((rows) => rows[0]),
    input.proposal.track === undefined || input.proposal.track.trim() === ""
      ? Promise.resolve(undefined)
      : database
        .select({ id: tracks.id })
        .from(tracks)
        .where(and(eq(tracks.eventId, eventId), eq(tracks.name, input.proposal.track)))
        .then((rows) => rows[0]),
  ]);
  const errors: CfpValidationErrors = {};
  if (input.intent === "submit" && input.proposal.format !== undefined && format === undefined) {
    errors.format = "Choose a format offered by this event.";
  }
  if (input.intent === "submit" && input.proposal.track !== undefined && track === undefined) {
    errors.track = "Choose a track offered by this event.";
  }
  return { errors, formatId: format?.id ?? null, trackId: track?.id ?? null };
}

async function findOrCreateSpeaker(
  database: CfpDatabase,
  eventId: string,
  input: CfpSubmissionInput,
  userId?: string,
): Promise<{ personId: string; speakerId: string }> {
  const email = input.speaker.email?.trim().toLowerCase() ?? "";
  let [person] = await database.select().from(people).where(eq(people.email, email));
  if (person === undefined) {
    const personId = createPublicId("psn");
    await database.insert(people).values({
      id: personId,
      userId,
      name: input.speaker.name?.trim() ?? "",
      email,
      jobTitle: input.speaker.jobTitle?.trim() || null,
      organization: input.speaker.organization?.trim() || null,
      bio: input.speaker.bio?.trim() || null,
    });
    [person] = await database.select().from(people).where(eq(people.id, personId));
  }
  if (person === undefined) {
    throw new Error("Speaker identity could not be saved");
  }
  let [speaker] = await database
    .select()
    .from(speakers)
    .where(and(eq(speakers.personId, person.id), eq(speakers.eventId, eventId)));
  if (speaker === undefined) {
    const speakerId = createPublicId("spk");
    await database.insert(speakers).values({ id: speakerId, personId: person.id, eventId });
    [speaker] = await database.select().from(speakers).where(eq(speakers.id, speakerId));
  }
  if (speaker === undefined) {
    throw new Error("Event speaker could not be saved");
  }
  return { personId: person.id, speakerId: speaker.id };
}

function answersForFields(
  fields: Array<typeof formVersionFields.$inferSelect>,
  input: CfpSubmissionInput,
): Array<{ fieldId: string; value: string | number | boolean | string[] | null }> {
  return fields.flatMap((field) => {
    if (!isFieldVisible(fields, field, input)) {
      return [];
    }
    const value = fieldValue(field, input);
    return value === undefined
      ? []
      : [{ fieldId: field.stableFieldId, value: value as string | number | boolean | string[] | null }];
  });
}

async function replaceProposalRelations(
  database: CfpDatabase,
  submissionId: string,
  fields: Array<typeof formVersionFields.$inferSelect>,
  input: CfpSubmissionInput,
  trackId: string | null,
): Promise<void> {
  await database.delete(submissionTracks).where(eq(submissionTracks.submissionId, submissionId));
  if (trackId !== null) {
    await database.insert(submissionTracks).values({
      id: createPublicId("strk"),
      submissionId,
      trackId,
    });
  }
  await database.delete(submissionValues).where(eq(submissionValues.submissionId, submissionId));
  const values = answersForFields(fields, input);
  if (values.length > 0) {
    await database.insert(submissionValues).values(
      values.map((answer) => ({
        id: createPublicId("val"),
        submissionId,
        fieldId: answer.fieldId,
        value: answer.value,
      })),
    );
  }
}

async function readSubmission(
  database: CfpDatabase,
  cfp: CfpRecordSet,
  submissionId: string,
) {
  const [item] = await database
    .select({
      id: submissions.id,
      formVersion: submissions.formVersion,
      status: submissions.status,
      isDraft: submissions.isDraft,
      title: submissions.title,
      abstract: submissions.abstract,
      audienceLevel: submissions.audienceLevel,
      notesForReviewers: submissions.notesForReviewers,
      submittedAt: submissions.submittedAt,
      updatedAt: submissions.updatedAt,
      personId: people.id,
      speakerName: people.name,
      speakerEmail: people.email,
      jobTitle: people.jobTitle,
      organization: people.organization,
      bio: people.bio,
      format: formats.name,
    })
    .from(submissions)
    .innerJoin(people, eq(submissions.submitterPersonId, people.id))
    .leftJoin(formats, eq(submissions.formatId, formats.id))
    .where(and(eq(submissions.id, submissionId), eq(submissions.formId, cfp.form.id)));
  if (item === undefined) {
    return null;
  }
  const [[track], valueRows, [speaker]] = await Promise.all([
    database
      .select({ name: tracks.name })
      .from(submissionTracks)
      .innerJoin(tracks, eq(submissionTracks.trackId, tracks.id))
      .where(eq(submissionTracks.submissionId, submissionId)),
    database
      .select({ key: formFields.key, value: submissionValues.value })
      .from(submissionValues)
      .innerJoin(formFields, eq(submissionValues.fieldId, formFields.id))
      .where(eq(submissionValues.submissionId, submissionId)),
    database
      .select({ id: speakers.id })
      .from(speakers)
      .where(and(eq(speakers.personId, item.personId), eq(speakers.eventId, cfp.event.id))),
  ]);
  return {
    id: item.id,
    formVersion: item.formVersion,
    status: item.status,
    isDraft: item.isDraft,
    title: item.title,
    abstract: item.abstract,
    track: track?.name ?? null,
    format: item.format,
    audienceLevel: item.audienceLevel,
    notesForReviewers: item.notesForReviewers,
    answers: Object.fromEntries(valueRows.map((answer) => [answer.key, answer.value])),
    submittedAt: item.submittedAt,
    updatedAt: item.updatedAt,
    speaker: {
      id: item.personId,
      speakerId: speaker?.id ?? null,
      name: item.speakerName,
      email: item.speakerEmail,
      jobTitle: item.jobTitle,
      organization: item.organization,
      bio: item.bio,
    },
  };
}

function submissionPaths(slug: string, submissionId: string, key?: string) {
  const accessPath = `/api/public/cfp/${slug}/submissions/${submissionId}`;
  return {
    accessPath,
    editUrl: key === undefined
      ? `/cfp/${slug}/submissions/${submissionId}`
      : `/cfp/${slug}/submissions/${submissionId}?key=${encodeURIComponent(key)}`,
  };
}

const cfpRoutes = new Hono<{
  Bindings: CloudflareBindings;
  Variables: { authUser: { id: string; email: string } | null };
}>();

cfpRoutes.post("/:slug/submissions", async (context) => {
  const database = drizzle(context.env.DB);
  const cfp = await getCfp(database, context.req.param("slug"));
  if (cfp === null) {
    return context.json({ error: "not_found", message: "This call for speakers could not be found." }, 404);
  }
  const availability = getCfpAvailability(cfp.form);
  if (!availability.canWrite) {
    return context.json(availabilityError(availability), 409);
  }
  const input = normalizeInput(await context.req.json().catch(() => null));
  if (input === null) {
    return context.json({ error: "invalid_request", message: "The proposal data could not be read." }, 400);
  }
  const taxonomy = await resolveTaxonomy(database, cfp.event.id, input);
  const validation = { ...validateCfpSubmission(cfp.fields, input), ...taxonomy.errors };
  if (Object.keys(validation).length > 0) {
    return context.json(
      { error: "validation_failed", message: "Add your return details before saving, and complete required fields before submitting.", fields: validation },
      422,
    );
  }
  const authUser = context.get("authUser");
  const normalizedEmail = input.speaker.email?.trim().toLowerCase() ?? "";
  if (authUser !== null && authUser.email.toLowerCase() !== normalizedEmail) {
    return context.json({
      error: "account_email_mismatch",
      message: "Use the email address on your signed-in account for an account-owned proposal.",
      fields: { speakerEmail: "This email must match your signed-in account." },
    }, 422);
  }
  const [personWithEmail] = await database
    .select({ userId: people.userId })
    .from(people)
    .where(eq(people.email, normalizedEmail));
  if (authUser !== null && personWithEmail !== undefined && personWithEmail.userId !== authUser.id) {
    return context.json({
      error: "anonymous_identity_exists",
      message: "This email already has anonymous proposals. Keep using their private links; signing in does not claim them.",
    }, 409);
  }
  if (authUser === null && personWithEmail?.userId !== null && personWithEmail?.userId !== undefined) {
    return context.json({
      error: "account_sign_in_required",
      message: "This email belongs to an account. Sign in to add a proposal to its dashboard.",
    }, 409);
  }
  const author = await findOrCreateSpeaker(database, cfp.event.id, input, authUser?.id);
  const submissionId = createPublicId("sub");
  const access = authUser === null ? await createAuthorKey() : null;
  await database.insert(submissions).values({
    id: submissionId,
    eventId: cfp.event.id,
    formId: cfp.form.id,
    formVersion: cfp.form.version,
    submitterPersonId: author.personId,
    formatId: taxonomy.formatId,
    status: input.intent === "submit" ? "submitted" : "draft",
    isDraft: input.intent !== "submit",
    title: input.proposal.title?.trim() || null,
    abstract: input.proposal.abstract?.trim() || null,
    titleAtTime: input.intent === "submit" ? input.speaker.jobTitle?.trim() || null : null,
    orgAtTime: input.intent === "submit" ? input.speaker.organization?.trim() || null : null,
    audienceLevel: input.proposal.audienceLevel?.trim() || null,
    notesForReviewers: input.proposal.notesForReviewers?.trim() || null,
    submittedAt: input.intent === "submit" ? new Date() : null,
  });
  if (access !== null) {
    await database.insert(submissionAuthorAccess).values({ submissionId, authorKeyHash: access.hash });
  }
  await database.insert(submissionSpeakers).values({
    id: createPublicId("sspk"),
    submissionId,
    personId: author.personId,
    roleLabel: "speaker",
  });
  await replaceProposalRelations(database, submissionId, cfp.fields, input, taxonomy.trackId);
  const submission = await readSubmission(database, cfp, submissionId);
  if (input.intent === "submit") {
    await sendSubmissionConfirmationEmail({
      env: context.env,
      database,
      eventId: cfp.event.id as `evt_${string}`,
      eventName: cfp.event.name,
      recipientEmail: input.speaker.email,
      recipientName: input.speaker.name?.trim() || "there",
      submissionTitle: submission?.title ?? input.proposal.title ?? "your proposal",
      formConfirmationCopy: cfp.form.confirmationEmailCopy,
      returnUrl: `${context.env.APP_ORIGIN}${
        submissionPaths(context.req.param("slug"), submissionId, access?.key).editUrl
      }`,
    }).catch((error) =>
      console.error(JSON.stringify({
        message: "submission_confirmation_failed",
        submissionId,
        error: error instanceof Error ? error.message : String(error),
      }))
    );
  }
  return context.json(
    {
      ...submissionPaths(context.req.param("slug"), submissionId, access?.key),
      editKey: access?.key,
      message: input.intent === "submit"
        ? cfp.form.confirmationCopy ?? "Your proposal was submitted."
        : "Draft saved. Keep the private return link to continue later.",
      submission,
    },
    201,
  );
});

cfpRoutes.get("/:slug/submissions/:submissionId", async (context) => {
  const database = drizzle(context.env.DB);
  const submissionId = context.req.param("submissionId");
  if (!await authorizeSubmission(database, submissionId, context.req.query("key"), context.get("authUser")?.id)) {
    return context.json({ error: "not_found", message: "This private proposal link is incomplete or invalid." }, 404);
  }
  const [pinned] = await database
    .select({ formVersion: submissions.formVersion })
    .from(submissions)
    .where(eq(submissions.id, submissionId));
  const cfp = await getCfp(database, context.req.param("slug"), pinned?.formVersion);
  if (cfp === null) {
    return context.json({ error: "not_found", message: "This call for speakers could not be found." }, 404);
  }
  const submission = await readSubmission(database, cfp, submissionId);
  if (submission === null) {
    return context.json({ error: "not_found", message: "This proposal could not be found." }, 404);
  }
  const currentCfp = await getCfp(database, context.req.param("slug"));
  return context.json({
    availability: getCfpAvailability(cfp.form),
    ...submissionPaths(context.req.param("slug"), submissionId),
    form: { ...cfp.form, fields: cfp.fields },
    newerVersionAvailable: currentCfp !== null && currentCfp.form.version > cfp.form.version
      ? {
        version: currentCfp.form.version,
        startUrl: `/cfp/${context.req.param("slug")}`,
      }
      : null,
    submission,
  });
});

cfpRoutes.patch("/:slug/submissions/:submissionId", async (context) => {
  const database = drizzle(context.env.DB);
  const submissionId = context.req.param("submissionId");
  if (!await authorizeSubmission(database, submissionId, context.req.query("key"), context.get("authUser")?.id)) {
    return context.json({ error: "not_found", message: "This private proposal link is incomplete or invalid." }, 404);
  }
  const [pinned] = await database
    .select({ formVersion: submissions.formVersion })
    .from(submissions)
    .where(eq(submissions.id, submissionId));
  const cfp = await getCfp(database, context.req.param("slug"), pinned?.formVersion);
  if (cfp === null) {
    return context.json({ error: "not_found", message: "This call for speakers could not be found." }, 404);
  }
  const availability = getCfpAvailability(cfp.form);
  if (!availability.canWrite) {
    return context.json(availabilityError(availability), 409);
  }
  const existing = await readSubmission(database, cfp, submissionId);
  if (existing === null) {
    return context.json({ error: "not_found", message: "This proposal could not be found." }, 404);
  }
  const input = normalizeInput(await context.req.json().catch(() => null));
  if (input === null) {
    return context.json({ error: "invalid_request", message: "The proposal data could not be read." }, 400);
  }
  if (input.speaker.email?.trim().toLowerCase() !== existing.speaker.email.toLowerCase()) {
    return context.json({
      error: "validation_failed",
      message: "The author email is part of this proposal's identity and cannot be changed.",
      fields: { speakerEmail: "Use the email that created this proposal." },
    }, 422);
  }
  const taxonomy = await resolveTaxonomy(database, cfp.event.id, input);
  const validation = { ...validateCfpSubmission(cfp.fields, input), ...taxonomy.errors };
  if (Object.keys(validation).length > 0) {
    return context.json(
      { error: "validation_failed", message: "Complete every required field before submitting. Your existing saved work is unchanged.", fields: validation },
      422,
    );
  }
  const [author] = await database
    .select({ userId: people.userId })
    .from(people)
    .where(eq(people.id, existing.speaker.id));
  if (author?.userId === null || author?.userId === context.get("authUser")?.id) {
    await database
      .update(people)
      .set({
        name: input.speaker.name?.trim() ?? existing.speaker.name,
        jobTitle: input.speaker.jobTitle?.trim() || null,
        organization: input.speaker.organization?.trim() || null,
        bio: input.speaker.bio?.trim() || null,
      })
      .where(eq(people.id, existing.speaker.id));
  }
  const becomesSubmitted = input.intent === "submit" && existing.status === "draft";
  await database
    .update(submissions)
    .set({
      formatId: taxonomy.formatId,
      status: becomesSubmitted ? "submitted" : existing.status,
      isDraft: becomesSubmitted ? false : existing.isDraft,
      title: input.proposal.title?.trim() || null,
      abstract: input.proposal.abstract?.trim() || null,
      titleAtTime: becomesSubmitted ? input.speaker.jobTitle?.trim() || null : undefined,
      orgAtTime: becomesSubmitted ? input.speaker.organization?.trim() || null : undefined,
      audienceLevel: input.proposal.audienceLevel?.trim() || null,
      notesForReviewers: input.proposal.notesForReviewers?.trim() || null,
      submittedAt: becomesSubmitted ? new Date() : undefined,
    })
    .where(eq(submissions.id, submissionId));
  await replaceProposalRelations(database, submissionId, cfp.fields, input, taxonomy.trackId);
  const submission = await readSubmission(database, cfp, submissionId);
  if (becomesSubmitted) {
    await sendSubmissionConfirmationEmail({
      env: context.env,
      database,
      eventId: cfp.event.id as `evt_${string}`,
      eventName: cfp.event.name,
      recipientEmail: existing.speaker.email,
      recipientName: input.speaker.name?.trim() || existing.speaker.name || "there",
      submissionTitle: submission?.title ?? existing.title ?? "your proposal",
      formConfirmationCopy: cfp.form.confirmationEmailCopy,
      returnUrl: `${context.env.APP_ORIGIN}${
        submissionPaths(context.req.param("slug"), submissionId, context.req.query("key")).editUrl
      }`,
    }).catch((error) =>
      console.error(JSON.stringify({
        message: "submission_confirmation_failed",
        submissionId,
        error: error instanceof Error ? error.message : String(error),
      }))
    );
  }
  return context.json({
    availability,
    ...submissionPaths(context.req.param("slug"), submissionId),
    message: becomesSubmitted
      ? cfp.form.confirmationCopy ?? "Your proposal was submitted."
      : "Your changes are saved.",
    submission,
  });
});

cfpRoutes.get("/:slug", async (context) => {
  const database = drizzle(context.env.DB);
  const cfp = await getCfp(database, context.req.param("slug"));
  if (cfp === null || cfp.form.status === "draft") {
    return context.json({ error: "not_found" }, 404);
  }
  const [eventTracks, eventFormats] = await Promise.all([
    database.select({ name: tracks.name }).from(tracks).where(eq(tracks.eventId, cfp.event.id)),
    database.select({ name: formats.name }).from(formats).where(eq(formats.eventId, cfp.event.id)),
  ]);
  return context.json({
    event: cfp.event,
    form: cfp.form,
    tracks: eventTracks.map((track) => track.name),
    formats: eventFormats.map((format) => format.name),
    fields: cfp.fields,
  });
});

export default cfpRoutes;
