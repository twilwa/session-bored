// ABOUTME: Lets organizers edit, version, publish, and inspect CFP form contracts.
// ABOUTME: Preserves immutable field snapshots so historical submission answers retain their meaning.
import { and, asc, desc, eq, isNull, notInArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import {
  createPublicId,
  events,
  formFields,
  forms,
  formVersionFields,
  formVersions,
  formats,
  people,
  speakers,
  submissionSpeakers,
  submissions,
  submissionTracks,
  submissionValues,
  tracks,
  type Role,
} from "../../db/schema.ts";
import { holdsAccess } from "../access.ts";

type BuilderEnvironment = {
  Bindings: CloudflareBindings;
  Variables: { roles: Role[] | null };
};

type BuilderDatabase = ReturnType<typeof drizzle>;
type BuilderFieldType = "dropdown" | "long_text" | "short_text";

interface BuilderFieldInput {
  key: string;
  label: string;
  description: string | null;
  fieldType: BuilderFieldType;
  required: boolean;
  visibleInBlindReview: boolean;
  options: string[] | null;
  conditional: {
    fieldKey: string;
    operator: "equals";
    value: string;
  } | null;
}

interface BuilderVersionInput {
  welcomeCopy: string | null;
  confirmationCopy: string | null;
  confirmationEmailCopy: string | null;
  openAt: Date | null;
  closeAt: Date | null;
  minimumSpeakers: number;
  maximumSpeakers: number | null;
  fields: BuilderFieldInput[];
}

const requiredContractFieldKeys = ["session_title", "abstract", "track"] as const;

function hasPublishableContract(fields: Array<typeof formVersionFields.$inferSelect>): boolean {
  return requiredContractFieldKeys.every((key) => {
    const field = fields.find((candidate) => candidate.key === key);
    return field !== undefined
      && field.required
      && field.conditionalFieldId === null
      && (key !== "track" || field.fieldType === "dropdown");
  });
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function dateOrNull(value: unknown): Date | null | undefined {
  if (value === null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function normalizeBuilderInput(value: unknown): BuilderVersionInput | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.fields)) {
    return null;
  }
  const openAt = dateOrNull(record.openAt);
  const closeAt = dateOrNull(record.closeAt);
  if (openAt === undefined || closeAt === undefined) {
    return null;
  }
  const minimumSpeakers = record.minimumSpeakers;
  const maximumSpeakers = record.maximumSpeakers;
  if (
    typeof minimumSpeakers !== "number"
    || !Number.isInteger(minimumSpeakers)
    || minimumSpeakers < 1
    || (maximumSpeakers !== null
      && (typeof maximumSpeakers !== "number"
        || !Number.isInteger(maximumSpeakers)
        || maximumSpeakers < minimumSpeakers))
  ) {
    return null;
  }
  const fields: BuilderFieldInput[] = [];
  for (const [index, candidate] of record.fields.entries()) {
    if (typeof candidate !== "object" || candidate === null) {
      return null;
    }
    const field = candidate as Record<string, unknown>;
    if (
      typeof field.key !== "string"
      || !/^[a-z][a-z0-9_]*$/.test(field.key)
      || typeof field.label !== "string"
      || field.label.trim() === ""
      || (field.fieldType !== "short_text" && field.fieldType !== "long_text" && field.fieldType !== "dropdown")
      || typeof field.required !== "boolean"
    ) {
      return null;
    }
    const options = field.fieldType === "dropdown" && field.key !== "track" && field.key !== "format"
      ? Array.isArray(field.options) && field.options.every((option) => typeof option === "string" && option.trim() !== "")
        ? field.options.map((option) => (option as string).trim())
        : null
      : null;
    if (
      field.fieldType === "dropdown"
      && field.key !== "track"
      && field.key !== "format"
      && (options === null || options.length === 0)
    ) {
      return null;
    }
    let conditional: BuilderFieldInput["conditional"] = null;
    if (field.conditional !== undefined && field.conditional !== null) {
      if (typeof field.conditional !== "object") {
        return null;
      }
      const condition = field.conditional as Record<string, unknown>;
      if (
        typeof condition.fieldKey !== "string"
        || condition.operator !== "equals"
        || typeof condition.value !== "string"
        || condition.value === ""
      ) {
        return null;
      }
      conditional = { fieldKey: condition.fieldKey, operator: "equals", value: condition.value };
    }
    fields.push({
      key: field.key,
      label: field.label.trim(),
      description: textOrNull(field.description),
      fieldType: field.fieldType,
      required: field.required,
      visibleInBlindReview: field.visibleInBlindReview === true,
      options,
      conditional,
    });
    if (fields.findIndex((item) => item.key === field.key) !== index) {
      return null;
    }
  }
  const keys = new Set(fields.map((field) => field.key));
  if (fields.some((field) => field.conditional !== null && (
    field.conditional.fieldKey === field.key || !keys.has(field.conditional.fieldKey)
  ))) {
    return null;
  }
  return {
    welcomeCopy: textOrNull(record.welcomeCopy),
    confirmationCopy: textOrNull(record.confirmationCopy),
    confirmationEmailCopy: textOrNull(record.confirmationEmailCopy),
    openAt,
    closeAt,
    minimumSpeakers,
    maximumSpeakers,
    fields,
  };
}

async function ensureStableFields(
  database: BuilderDatabase,
  formId: string,
  fields: BuilderFieldInput[],
): Promise<Map<string, string>> {
  const existing = await database.select().from(formFields).where(eq(formFields.formId, formId));
  const stableIds = new Map(existing.map((field) => [field.key, field.id]));
  for (const [sortOrder, field] of fields.entries()) {
    if (stableIds.has(field.key)) {
      continue;
    }
    const id = createPublicId("fld");
    await database.insert(formFields).values({
      id,
      formId,
      key: field.key,
      label: field.label,
      description: field.description,
      fieldType: field.fieldType,
      required: field.required,
      sortOrder,
      options: field.options,
    });
    stableIds.set(field.key, id);
  }
  return stableIds;
}

async function replaceVersionFields(
  database: BuilderDatabase,
  versionId: string,
  formId: string,
  fields: BuilderFieldInput[],
): Promise<void> {
  const stableIds = await ensureStableFields(database, formId, fields);
  const existing = await database
    .select()
    .from(formVersionFields)
    .where(eq(formVersionFields.formVersionId, versionId));
  const idsByKey = new Map(existing.map((field) => [field.key, field.id]));
  for (const field of fields) {
    if (!idsByKey.has(field.key)) {
      idsByKey.set(field.key, createPublicId("fld"));
    }
  }
  if (existing.length > 0) {
    await database
      .update(formVersionFields)
      .set({ conditionalFieldId: null, conditionalOperator: null, conditionalValue: null })
      .where(eq(formVersionFields.formVersionId, versionId));
    const retainedIds = fields.map((field) => idsByKey.get(field.key) as string);
    if (retainedIds.length === 0) {
      await database.delete(formVersionFields).where(eq(formVersionFields.formVersionId, versionId));
    } else {
      await database
        .delete(formVersionFields)
        .where(and(
          eq(formVersionFields.formVersionId, versionId),
          notInArray(formVersionFields.id, retainedIds),
        ));
    }
  }
  for (const [sortOrder, field] of fields.entries()) {
    const id = idsByKey.get(field.key) as string;
    const values = {
      stableFieldId: stableIds.get(field.key) as string,
      key: field.key,
      label: field.label,
      description: field.description,
      fieldType: field.fieldType,
      required: field.required,
      visibleInBlindReview: field.visibleInBlindReview,
      sortOrder,
      options: field.options,
      conditionalFieldId: null,
      conditionalOperator: null,
      conditionalValue: null,
    } as const;
    if (existing.some((item) => item.id === id)) {
      await database.update(formVersionFields).set(values).where(eq(formVersionFields.id, id));
    } else {
      await database.insert(formVersionFields).values({ id, formVersionId: versionId, ...values });
    }
  }
  for (const field of fields) {
    if (field.conditional === null) {
      continue;
    }
    await database
      .update(formVersionFields)
      .set({
        conditionalFieldId: idsByKey.get(field.conditional.fieldKey) as string,
        conditionalOperator: "equals",
        conditionalValue: field.conditional.value,
      })
      .where(eq(formVersionFields.id, idsByKey.get(field.key) as string));
  }
}

async function saveVersion(
  database: BuilderDatabase,
  form: typeof forms.$inferSelect,
  input: BuilderVersionInput,
) {
  const [latest] = await database
    .select()
    .from(formVersions)
    .where(eq(formVersions.formId, form.id))
    .orderBy(desc(formVersions.version))
    .limit(1);
  const versionNumber = latest?.status === "draft" ? latest.version : (latest?.version ?? 0) + 1;
  const versionId = latest?.status === "draft" ? latest.id : `${form.id}:v${versionNumber}`;
  const values = {
    openAt: input.openAt,
    closeAt: input.closeAt,
    welcomeCopy: input.welcomeCopy,
    confirmationCopy: input.confirmationCopy,
    confirmationEmailCopy: input.confirmationEmailCopy,
    minimumSpeakers: input.minimumSpeakers,
    maximumSpeakers: input.maximumSpeakers,
  };
  if (latest?.status === "draft") {
    await database.update(formVersions).set(values).where(eq(formVersions.id, versionId));
  } else {
    await database.insert(formVersions).values({
      id: versionId,
      formId: form.id,
      version: versionNumber,
      status: "draft",
      ...values,
    });
  }
  await replaceVersionFields(database, versionId, form.id, input.fields);
  const [version] = await database.select().from(formVersions).where(eq(formVersions.id, versionId));
  return version;
}

function findFormVersion(
  versions: Array<typeof formVersions.$inferSelect>,
  requestedValue: string | undefined,
  currentVersion: number,
) {
  const requestedVersion = Number(requestedValue);
  return Number.isInteger(requestedVersion) && requestedVersion > 0
    ? versions.find((version) => version.version === requestedVersion)
    : versions.find((version) => version.status === "draft")
      ?? versions.find((version) => version.version === currentVersion);
}

async function renderSubmission(database: BuilderDatabase, submissionId: string) {
  const [item] = await database
    .select({
      id: submissions.id,
      formId: submissions.formId,
      formVersion: submissions.formVersion,
      status: submissions.status,
      title: submissions.title,
      abstract: submissions.abstract,
      audienceLevel: submissions.audienceLevel,
      notesForReviewers: submissions.notesForReviewers,
      submittedAt: submissions.submittedAt,
      updatedAt: submissions.updatedAt,
      formName: forms.name,
      personId: people.id,
      speakerName: people.name,
      speakerEmail: people.email,
      organization: people.organization,
      jobTitle: people.jobTitle,
      bio: people.bio,
      format: formats.name,
    })
    .from(submissions)
    .innerJoin(forms, eq(submissions.formId, forms.id))
    .innerJoin(people, eq(submissions.submitterPersonId, people.id))
    .leftJoin(formats, eq(submissions.formatId, formats.id))
    .where(eq(submissions.id, submissionId));
  if (item === undefined) {
    return null;
  }
  const [version] = await database
    .select()
    .from(formVersions)
    .where(and(
      eq(formVersions.formId, item.formId),
      eq(formVersions.version, item.formVersion),
    ));
  if (version === undefined) {
    return null;
  }
  const [fields, values, [track], [speaker]] = await Promise.all([
    database
      .select()
      .from(formVersionFields)
      .where(eq(formVersionFields.formVersionId, version.id))
      .orderBy(asc(formVersionFields.sortOrder)),
    database
      .select({ key: formFields.key, value: submissionValues.value })
      .from(submissionValues)
      .innerJoin(formFields, eq(submissionValues.fieldId, formFields.id))
      .where(eq(submissionValues.submissionId, submissionId)),
    database
      .select({ name: tracks.name })
      .from(submissionTracks)
      .innerJoin(tracks, eq(submissionTracks.trackId, tracks.id))
      .where(eq(submissionTracks.submissionId, submissionId)),
    database
      .select({ id: speakers.id })
      .from(submissionSpeakers)
      .innerJoin(speakers, eq(submissionSpeakers.personId, speakers.personId))
      .where(and(eq(submissionSpeakers.submissionId, submissionId), isNull(submissionSpeakers.deletedAt))),
  ]);
  const answers = new Map(values.map((value) => [value.key, value.value]));
  const valueForKey = (key: string) => {
    switch (key) {
      case "session_title": return item.title;
      case "abstract": return item.abstract;
      case "track": return track?.name ?? null;
      case "format": return item.format;
      case "speaker_bio": return item.bio;
      case "audience_level": return item.audienceLevel;
      case "notes_for_reviewers": return item.notesForReviewers;
      default: return answers.get(key) ?? null;
    }
  };
  return {
    submission: {
      id: item.id,
      status: item.status,
      formId: item.formId,
      formVersion: item.formVersion,
      submittedAt: item.submittedAt,
      updatedAt: item.updatedAt,
    },
    form: {
      id: item.formId,
      name: item.formName,
      version: version.version,
      status: version.status,
    },
    speaker: {
      id: item.personId,
      speakerId: speaker?.id ?? null,
      name: item.speakerName,
      email: item.speakerEmail,
      jobTitle: item.jobTitle,
      organization: item.organization,
    },
    answers: fields.map((field) => ({
      key: field.key,
      label: field.label,
      fieldType: field.fieldType,
      value: valueForKey(field.key),
    })),
  };
}

const cfpBuilderRoutes = new Hono<BuilderEnvironment>();

cfpBuilderRoutes.use("*", async (context, next) => {
  if (!holdsAccess(context.get("roles") ?? [], "organizer")) {
    return context.json({ error: context.get("roles") === null ? "authentication_required" : "forbidden" }, context.get("roles") === null ? 401 : 403);
  }
  await next();
});

cfpBuilderRoutes.get("/events/:eventId/forms", async (context) => {
  const items = await drizzle(context.env.DB)
    .select()
    .from(forms)
    .where(eq(forms.eventId, context.req.param("eventId")));
  return context.json({ items });
});

cfpBuilderRoutes.get("/forms/:formId", async (context) => {
  const database = drizzle(context.env.DB);
  const [form] = await database.select().from(forms).where(eq(forms.id, context.req.param("formId")));
  if (form === undefined) {
    return context.json({ error: "not_found", message: "This CFP form could not be found." }, 404);
  }
  const versions = await database
    .select()
    .from(formVersions)
    .where(eq(formVersions.formId, form.id))
    .orderBy(desc(formVersions.version));
  const selectedVersion = findFormVersion(versions, context.req.query("version"), form.version);
  if (selectedVersion === undefined) {
    return context.json({ error: "not_found", message: "This CFP form version could not be found." }, 404);
  }
  const selectedFields = await database
    .select()
    .from(formVersionFields)
    .where(eq(formVersionFields.formVersionId, selectedVersion.id))
    .orderBy(asc(formVersionFields.sortOrder));
  const keysById = new Map(selectedFields.map((field) => [field.id, field.key]));
  const fields = selectedFields.map((field) => ({
    id: field.id,
    key: field.key,
    label: field.label,
    description: field.description,
    fieldType: field.fieldType,
    required: field.required,
    visibleInBlindReview: field.visibleInBlindReview,
    sortOrder: field.sortOrder,
    options: field.options,
    conditional: field.conditionalFieldId === null ? null : {
      fieldKey: keysById.get(field.conditionalFieldId) ?? "",
      operator: field.conditionalOperator,
      value: field.conditionalValue,
    },
  }));
  return context.json({
    form,
    selectedVersion,
    versions,
    fields,
    publicUrl: `/cfp/${form.publicSlug}`,
  });
});

cfpBuilderRoutes.get("/forms/:formId/preview", async (context) => {
  const database = drizzle(context.env.DB);
  const [form] = await database.select().from(forms).where(eq(forms.id, context.req.param("formId")));
  if (form === undefined) {
    return context.json({ error: "not_found", message: "This CFP form could not be found." }, 404);
  }
  const versions = await database
    .select()
    .from(formVersions)
    .where(eq(formVersions.formId, form.id))
    .orderBy(desc(formVersions.version));
  const selectedVersion = findFormVersion(versions, context.req.query("version"), form.version);
  if (selectedVersion === undefined) {
    return context.json({ error: "not_found", message: "This CFP form version could not be found." }, 404);
  }
  const [event, selectedFields, eventTracks, eventFormats] = await Promise.all([
    database.select().from(events).where(eq(events.id, form.eventId)).then((rows) => rows[0]),
    database
      .select()
      .from(formVersionFields)
      .where(eq(formVersionFields.formVersionId, selectedVersion.id))
      .orderBy(asc(formVersionFields.sortOrder)),
    database.select({ name: tracks.name }).from(tracks).where(eq(tracks.eventId, form.eventId)),
    database.select({ name: formats.name }).from(formats).where(eq(formats.eventId, form.eventId)),
  ]);
  if (event === undefined) {
    return context.json({ error: "not_found", message: "This CFP event could not be found." }, 404);
  }
  return context.json({
    event,
    form: {
      ...form,
      version: selectedVersion.version,
      status: selectedVersion.status,
      openAt: selectedVersion.openAt,
      closeAt: selectedVersion.closeAt,
      welcomeCopy: selectedVersion.welcomeCopy,
      confirmationCopy: selectedVersion.confirmationCopy,
      confirmationEmailCopy: selectedVersion.confirmationEmailCopy,
      minimumSpeakers: selectedVersion.minimumSpeakers,
      maximumSpeakers: selectedVersion.maximumSpeakers,
      publishedAt: selectedVersion.publishedAt,
    },
    tracks: eventTracks.map((track) => track.name),
    formats: eventFormats.map((format) => format.name),
    fields: selectedFields,
  });
});

cfpBuilderRoutes.put("/forms/:formId", async (context) => {
  const database = drizzle(context.env.DB);
  const [form] = await database.select().from(forms).where(eq(forms.id, context.req.param("formId")));
  if (form === undefined) {
    return context.json({ error: "not_found", message: "This CFP form could not be found." }, 404);
  }
  const input = normalizeBuilderInput(await context.req.json().catch(() => null));
  if (input === null) {
    return context.json({ error: "invalid_request", message: "Check the form fields and submission settings." }, 400);
  }
  const version = await saveVersion(database, form, input);
  return context.json({ version });
});

cfpBuilderRoutes.post("/events/:eventId/forms", async (context) => {
  const body = await context.req.json<Record<string, unknown>>().catch(() => null);
  const input = normalizeBuilderInput(body);
  const name = textOrNull(body?.name);
  const publicSlug = textOrNull(body?.publicSlug);
  if (
    input === null
    || name === null
    || publicSlug === null
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(publicSlug)
  ) {
    return context.json({ error: "invalid_request", message: "Add a form name and a URL-safe public slug." }, 400);
  }
  const database = drizzle(context.env.DB);
  const [event] = await database.select({ id: events.id }).from(events).where(eq(events.id, context.req.param("eventId")));
  if (event === undefined) {
    return context.json({ error: "not_found", message: "This event could not be found." }, 404);
  }
  const [slugConflict] = await database.select({ id: forms.id }).from(forms).where(eq(forms.publicSlug, publicSlug));
  if (slugConflict !== undefined) {
    return context.json({ error: "slug_in_use", message: "Choose another public URL." }, 409);
  }
  const formId = createPublicId("frm");
  await database.insert(forms).values({
    id: formId,
    eventId: event.id,
    name,
    publicSlug,
    version: 1,
    status: "draft",
    openAt: input.openAt,
    closeAt: input.closeAt,
    welcomeCopy: input.welcomeCopy,
    confirmationCopy: input.confirmationCopy,
    confirmationEmailCopy: input.confirmationEmailCopy,
    minimumSpeakers: input.minimumSpeakers,
    maximumSpeakers: input.maximumSpeakers,
  });
  const versionId = `${formId}:v1`;
  await database.insert(formVersions).values({
    id: versionId,
    formId,
    version: 1,
    status: "draft",
    openAt: input.openAt,
    closeAt: input.closeAt,
    welcomeCopy: input.welcomeCopy,
    confirmationCopy: input.confirmationCopy,
    confirmationEmailCopy: input.confirmationEmailCopy,
    minimumSpeakers: input.minimumSpeakers,
    maximumSpeakers: input.maximumSpeakers,
  });
  await replaceVersionFields(database, versionId, formId, input.fields);
  const [form] = await database.select().from(forms).where(eq(forms.id, formId));
  const [version] = await database.select().from(formVersions).where(eq(formVersions.id, versionId));
  return context.json({ form, version, publicUrl: `/cfp/${publicSlug}` }, 201);
});

cfpBuilderRoutes.post("/forms/:formId/publish", async (context) => {
  const database = drizzle(context.env.DB);
  const [form] = await database.select().from(forms).where(eq(forms.id, context.req.param("formId")));
  if (form === undefined) {
    return context.json({ error: "not_found", message: "This CFP form could not be found." }, 404);
  }
  const [draft] = await database
    .select()
    .from(formVersions)
    .where(and(eq(formVersions.formId, form.id), eq(formVersions.status, "draft")))
    .orderBy(desc(formVersions.version))
    .limit(1);
  if (draft === undefined) {
    return context.json({ error: "no_draft", message: "Save form changes before publishing." }, 409);
  }
  const draftFields = await database
    .select()
    .from(formVersionFields)
    .where(eq(formVersionFields.formVersionId, draft.id));
  if (!hasPublishableContract(draftFields)) {
    return context.json({
      error: "invalid_form_contract",
      message: "Session title, abstract, and track must remain always-visible required fields before publishing.",
    }, 422);
  }
  const publishedAt = new Date();
  await database
    .update(formVersions)
    .set({ status: "published", publishedAt })
    .where(eq(formVersions.id, draft.id));
  await database
    .update(forms)
    .set({
      version: draft.version,
      status: "published",
      openAt: draft.openAt,
      closeAt: draft.closeAt,
      welcomeCopy: draft.welcomeCopy,
      confirmationCopy: draft.confirmationCopy,
      confirmationEmailCopy: draft.confirmationEmailCopy,
      minimumSpeakers: draft.minimumSpeakers,
      maximumSpeakers: draft.maximumSpeakers,
      publishedAt,
    })
    .where(eq(forms.id, form.id));
  const [version] = await database.select().from(formVersions).where(eq(formVersions.id, draft.id));
  return context.json({ version, publicUrl: `/cfp/${form.publicSlug}` });
});

cfpBuilderRoutes.post("/forms/:formId/close", async (context) => {
  const database = drizzle(context.env.DB);
  const [form] = await database.select().from(forms).where(eq(forms.id, context.req.param("formId")));
  if (form === undefined) {
    return context.json({ error: "not_found", message: "This CFP form could not be found." }, 404);
  }
  await database
    .update(formVersions)
    .set({ status: "closed" })
    .where(and(
      eq(formVersions.formId, form.id),
      eq(formVersions.version, form.version),
      eq(formVersions.status, "published"),
    ));
  await database.update(forms).set({ status: "closed" }).where(eq(forms.id, form.id));
  const [version] = await database
    .select()
    .from(formVersions)
    .where(and(eq(formVersions.formId, form.id), eq(formVersions.version, form.version)));
  return version === undefined
    ? context.json({ error: "not_found", message: "The published version could not be found." }, 404)
    : context.json({ version, publicUrl: `/cfp/${form.publicSlug}` });
});

cfpBuilderRoutes.post("/forms/:formId/reopen", async (context) => {
  const database = drizzle(context.env.DB);
  const [form] = await database.select().from(forms).where(eq(forms.id, context.req.param("formId")));
  if (form === undefined) {
    return context.json({ error: "not_found", message: "This CFP form could not be found." }, 404);
  }
  if (form.status !== "closed") {
    return context.json({ error: "not_closed", message: "This CFP is already open." }, 409);
  }
  const [closedVersion] = await database
    .select()
    .from(formVersions)
    .where(and(
      eq(formVersions.formId, form.id),
      eq(formVersions.version, form.version),
      eq(formVersions.status, "closed"),
    ));
  if (closedVersion === undefined) {
    return context.json({ error: "not_found", message: "The closed version could not be found." }, 404);
  }
  if (closedVersion.closeAt !== null && closedVersion.closeAt.getTime() <= Date.now()) {
    return context.json({
      error: "cfp_window_closed",
      message: "This published version's close time has passed. Save and publish a draft with a later close time to reopen the call.",
    }, 409);
  }
  await database
    .update(formVersions)
    .set({ status: "published" })
    .where(eq(formVersions.id, closedVersion.id));
  await database.update(forms).set({ status: "published" }).where(eq(forms.id, form.id));
  const [version] = await database.select().from(formVersions).where(eq(formVersions.id, closedVersion.id));
  return context.json({ version, publicUrl: `/cfp/${form.publicSlug}` });
});

cfpBuilderRoutes.get("/submissions/:submissionId", async (context) => {
  const rendered = await renderSubmission(drizzle(context.env.DB), context.req.param("submissionId"));
  return rendered === null
    ? context.json({ error: "not_found", message: "This submission or its form version could not be found." }, 404)
    : context.json(rendered);
});

export default cfpBuilderRoutes;
