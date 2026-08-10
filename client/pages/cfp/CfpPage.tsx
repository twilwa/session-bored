// ABOUTME: Renders Greenroom's anonymous, mobile-first call-for-speakers portal and proposal form.
// ABOUTME: Preserves drafts through private return links and shows server validation and deadline locks inline.
import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import type {
  CfpAvailabilityState,
  CfpOwnSubmission,
  CfpSubmissionIntent,
  CfpSubmissionWrite,
} from "../../../shared/api.ts";
import { observePublicSession, PublicHeader, updatePublicSession } from "../../lib.tsx";
import { SubmitterAccountPanel, type SubmitterAccountUser } from "../submitter/SubmitterAccountPanel.tsx";
import { formatFullDateTime } from "../public/shared.ts";
import "./cfp.css";

interface EventRecord {
  id: string;
  name: string;
  tagline: string | null;
  description: string | null;
  startDate: string | null;
  endDate: string | null;
  venue: string | null;
  timezone: string;
}

interface FormRecord {
  closeAt: string | null;
  confirmationCopy: string | null;
  minimumSpeakers: number;
  openAt: string | null;
  status: string;
  version: number;
  welcomeCopy: string | null;
}

interface FormFieldRecord {
  id: string;
  key: string;
  label: string;
  description: string | null;
  fieldType: "dropdown" | "headshot" | "file" | "long_text" | "short_text";
  required: boolean;
  sortOrder: number;
  options: string[] | null;
  conditionalFieldId: string | null;
  conditionalValue: string | null;
}

interface CfpPayload {
  event: EventRecord;
  form: FormRecord;
  tracks: string[];
  formats: string[];
  fields: FormFieldRecord[];
}

interface Availability {
  canWrite: boolean;
  message: string;
  state: CfpAvailabilityState;
}

interface SubmissionResponse {
  accessPath: string;
  availability?: Availability;
  editKey?: string;
  editUrl: string;
  message: string;
  form?: FormRecord & { fields: FormFieldRecord[] };
  newerVersionAvailable?: { version: number; startUrl: string } | null;
  submission: CfpOwnSubmission;
}

interface SavedReference {
  id: string;
  editUrl: string;
  status: string;
  title: string;
}

interface FormState {
  speaker: {
    name: string;
    email: string;
    jobTitle: string;
    organization: string;
    bio: string;
  };
  proposal: {
    title: string;
    abstract: string;
    track: string;
    format: string;
    audienceLevel: string;
    notesForReviewers: string;
    answers: Record<string, string | number | boolean | string[] | null>;
  };
}

const emptyForm: FormState = {
  speaker: { name: "", email: "", jobTitle: "", organization: "", bio: "" },
  proposal: {
    title: "",
    abstract: "",
    track: "",
    format: "",
    audienceLevel: "",
    notesForReviewers: "",
    answers: {},
  },
};

const savedReferenceKey = "greenroom.cfp.proposals";

function readSavedReferences(): SavedReference[] {
  try {
    const value = JSON.parse(localStorage.getItem(savedReferenceKey) ?? "[]") as unknown;
    return Array.isArray(value) ? value as SavedReference[] : [];
  } catch {
    return [];
  }
}

function rememberSubmission(reference: SavedReference): SavedReference[] {
  const references = readSavedReferences().filter((item) => item.id !== reference.id);
  const next = [reference, ...references].slice(0, 12);
  localStorage.setItem(savedReferenceKey, JSON.stringify(next));
  return next;
}

async function readJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin" });
  if (!response.ok) {
    const body = await response.json<{ message?: string }>().catch((): { message?: string } => ({}));
    throw new Error(body.message ?? "The call for speakers could not be loaded.");
  }
  return response.json<T>();
}

// ABOUTME: The deadline reads in the event's own timezone, not the viewer's — a submitter in any
// timezone must see the exact same instant the CFP actually closes, matching every other public surface.
function eventMoment(value: string | null, timeZone: string): { label: string; zone: string } | null {
  if (value === null) {
    return null;
  }
  return { label: formatFullDateTime(new Date(value).getTime(), timeZone), zone: timeZone };
}

function localAvailability(form: FormRecord): Availability {
  const now = Date.now();
  if (form.status === "closed") {
    return {
      canWrite: false,
      state: "closed",
      message: "This call for speakers is closed. New submissions and edits are no longer accepted.",
    };
  }
  if (form.status !== "published") {
    return { canWrite: false, state: "unpublished", message: "This call for speakers is not currently published." };
  }
  if (form.openAt !== null && now < new Date(form.openAt).getTime()) {
    return { canWrite: false, state: "upcoming", message: "This call for speakers has not opened yet." };
  }
  if (form.closeAt !== null && now >= new Date(form.closeAt).getTime()) {
    return {
      canWrite: false,
      state: "closed",
      message: "Submissions are closed. New proposals and edits are no longer accepted.",
    };
  }
  return { canWrite: true, state: "open", message: "Submissions are open." };
}

function stateFromSubmission(submission: CfpOwnSubmission): FormState {
  return {
    speaker: {
      name: submission.speaker.name,
      email: submission.speaker.email,
      jobTitle: submission.speaker.jobTitle ?? "",
      organization: submission.speaker.organization ?? "",
      bio: submission.speaker.bio ?? "",
    },
    proposal: {
      title: submission.title ?? "",
      abstract: submission.abstract ?? "",
      track: submission.track ?? "",
      format: submission.format ?? "",
      audienceLevel: submission.audienceLevel ?? "",
      notesForReviewers: submission.notesForReviewers ?? "",
      answers: submission.answers,
    },
  };
}

function fieldValue(field: FormFieldRecord, state: FormState): string {
  const value = (() => {
    switch (field.key) {
      case "session_title": return state.proposal.title;
      case "abstract": return state.proposal.abstract;
      case "track": return state.proposal.track;
      case "format": return state.proposal.format;
      case "speaker_bio": return state.speaker.bio;
      case "audience_level": return state.proposal.audienceLevel;
      case "notes_for_reviewers": return state.proposal.notesForReviewers;
      default: return state.proposal.answers[field.key];
    }
  })();
  return typeof value === "string" ? value : "";
}

function updateField(field: FormFieldRecord, value: string, state: FormState): FormState {
  switch (field.key) {
    case "session_title": return { ...state, proposal: { ...state.proposal, title: value } };
    case "abstract": return { ...state, proposal: { ...state.proposal, abstract: value } };
    case "track": return { ...state, proposal: { ...state.proposal, track: value } };
    case "format": return { ...state, proposal: { ...state.proposal, format: value } };
    case "speaker_bio": return { ...state, speaker: { ...state.speaker, bio: value } };
    case "audience_level": return { ...state, proposal: { ...state.proposal, audienceLevel: value } };
    case "notes_for_reviewers": return { ...state, proposal: { ...state.proposal, notesForReviewers: value } };
    default:
      return {
        ...state,
        proposal: {
          ...state.proposal,
          answers: { ...state.proposal.answers, [field.key]: value },
        },
      };
  }
}

export function isProposalFieldVisible(
  fields: FormFieldRecord[],
  field: FormFieldRecord,
  state: FormState,
  visited = new Set<string>(),
): boolean {
  if (field.conditionalFieldId === null) {
    return true;
  }
  if (visited.has(field.id)) {
    return false;
  }
  const controllingField = fields.find((candidate) => candidate.id === field.conditionalFieldId);
  if (controllingField === undefined) {
    return false;
  }
  return isProposalFieldVisible(fields, controllingField, state, new Set(visited).add(field.id))
    && fieldValue(controllingField, state) === field.conditionalValue;
}

function ProposalField({
  field,
  fields,
  state,
  tracks,
  formats,
  error,
  disabled,
  onChange,
}: {
  field: FormFieldRecord;
  fields: FormFieldRecord[];
  state: FormState;
  tracks: string[];
  formats: string[];
  error: string | undefined;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  if (!isProposalFieldVisible(fields, field, state)) {
    return null;
  }
  const id = `cfp-${field.key}`;
  const options = field.key === "track" ? tracks : field.key === "format" ? formats : field.options ?? [];
  const control = field.fieldType === "dropdown" ? (
    <select
      aria-describedby={error === undefined ? undefined : `${id}-error`}
      aria-invalid={error === undefined ? undefined : true}
      disabled={disabled}
      id={id}
      onChange={(event) => onChange(event.target.value)}
      value={fieldValue(field, state)}
    >
      <option value="">Choose one</option>
      {options.map((option) => <option key={option} value={option}>{option}</option>)}
    </select>
  ) : field.fieldType === "long_text" ? (
    <textarea
      aria-describedby={error === undefined ? undefined : `${id}-error`}
      aria-invalid={error === undefined ? undefined : true}
      disabled={disabled}
      id={id}
      onChange={(event) => onChange(event.target.value)}
      rows={field.key === "abstract" ? 7 : 4}
      value={fieldValue(field, state)}
    />
  ) : (
    <input
      aria-describedby={error === undefined ? undefined : `${id}-error`}
      aria-invalid={error === undefined ? undefined : true}
      disabled={disabled}
      id={id}
      onChange={(event) => onChange(event.target.value)}
      type="text"
      value={fieldValue(field, state)}
    />
  );
  return (
    <label className="proposal-field" htmlFor={id}>
      <span className="proposal-field__label">
        {field.label}
        <small>{field.required ? "Required to submit" : "Optional"}</small>
      </span>
      {field.description === null ? null : <span className="proposal-field__hint">{field.description}</span>}
      {control}
      {error === undefined ? null : <span className="proposal-field__error" id={`${id}-error`} role="alert">{error}</span>}
    </label>
  );
}

function SubmissionReceipt({
  accountOwned,
  kind,
  message,
  privateUrl,
  submission,
  onContinue,
}: {
  accountOwned: boolean;
  kind: "draft" | "submitted";
  message: string;
  privateUrl: string;
  submission: CfpOwnSubmission;
  onContinue: () => void;
}) {
  const [copied, setCopied] = useState(false);
  async function copyLink(): Promise<void> {
    await navigator.clipboard.writeText(privateUrl);
    setCopied(true);
  }
  return (
    <section className="submission-receipt" aria-live="polite">
      <p className="eyebrow">PRIVATE PROPOSAL RECORD</p>
      <h2>{kind === "draft" ? "Draft saved" : "Proposal submitted"}</h2>
      <p>{message}</p>
      <dl>
        <div><dt>Reference</dt><dd>{submission.id}</dd></div>
        <div><dt>Status</dt><dd>{submission.status.replace("_", " ")}</dd></div>
      </dl>
      <p className="submission-receipt__warning">
        {accountOwned
          ? "This proposal is on your private dashboard. Sign in to return and edit before the deadline."
          : "Keep this private link. It is the key to return and edit before the deadline."}
      </p>
      <div className="submission-receipt__actions">
        {accountOwned
          ? <a className="button button--signal" href="/submitter">Open my proposals</a>
          : (
            <>
              <a className="button button--signal" href={privateUrl}>Private return link</a>
              <button className="button button--quiet" onClick={() => void copyLink()} type="button">
                {copied ? "Link copied" : "Copy link"}
              </button>
            </>
          )}
        <button className="button button--quiet" onClick={onContinue} type="button">
          {kind === "draft" ? "Continue editing" : "Edit proposal"}
        </button>
      </div>
    </section>
  );
}

export function CfpPage({ path }: { path: string }) {
  const segments = path.split("/").filter(Boolean);
  const slug = segments[1] ?? "devflow-conf-2027";
  const submissionId = segments[2] === "submissions" ? segments[3] ?? null : null;
  const [cfp, setCfp] = useState<CfpPayload | null>(null);
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [state, setState] = useState<FormState>(emptyForm);
  const [submission, setSubmission] = useState<CfpOwnSubmission | null>(null);
  const [editKey, setEditKey] = useState<string | null>(null);
  const [privateUrl, setPrivateUrl] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pageError, setPageError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<"draft" | "submitted" | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedReferences, setSavedReferences] = useState<SavedReference[]>([]);
  const [accountUser, setAccountUser] = useState<SubmitterAccountUser | null>(null);

  function applyAccountUser(user: SubmitterAccountUser): void {
    setAccountUser(user);
    setState((current) => ({
      ...current,
      speaker: {
        ...current.speaker,
        name: current.speaker.name || user.name,
        email: user.email,
      },
    }));
  }

  function authenticateAccountUser(user: SubmitterAccountUser): void {
    applyAccountUser(user);
    updatePublicSession(user);
  }
  const [newerVersionAvailable, setNewerVersionAvailable] = useState<{
    version: number;
    startUrl: string;
  } | null>(null);

  useEffect(() => {
    const stopObservingSession = observePublicSession((user) => {
      if (user === null) {
        setAccountUser(null);
      } else {
        applyAccountUser(user);
      }
    });
    setSavedReferences(readSavedReferences());
    const key = new URLSearchParams(window.location.search).get("key");
    setEditKey(key);
    const cfpRequest = readJson<CfpPayload>(`/api/public/cfp/${slug}`);
    const submissionRequest = submissionId === null
      ? Promise.resolve(null)
      : readJson<SubmissionResponse>(
        `/api/public/cfp/${slug}/submissions/${submissionId}${key === null ? "" : `?key=${encodeURIComponent(key)}`}`,
      );
    fetch("/api/session", { credentials: "same-origin" })
      .then((response) => response.ok ? response.json<{ user: SubmitterAccountUser }>() : null)
      .then((session) => {
        if (session !== null) {
          applyAccountUser(session.user);
        }
      })
      .catch(() => undefined);
    Promise.all([cfpRequest, submissionRequest])
      .then(([cfpData, ownSubmission]) => {
        setCfp(ownSubmission?.form === undefined
          ? cfpData
          : { ...cfpData, form: ownSubmission.form, fields: ownSubmission.form.fields });
        setAvailability(ownSubmission?.availability ?? localAvailability(cfpData.form));
        setNewerVersionAvailable(ownSubmission?.newerVersionAvailable ?? null);
        if (ownSubmission !== null) {
          setSubmission(ownSubmission.submission);
          setState(stateFromSubmission(ownSubmission.submission));
          setPrivateUrl(window.location.href);
        }
      })
      .catch((error: unknown) => setPageError(error instanceof Error ? error.message : "The CFP could not be loaded."));
    return stopObservingSession;
  }, [slug, submissionId]);

  const deadline = useMemo(
    () => eventMoment(cfp?.form.closeAt ?? null, cfp?.event.timezone ?? "UTC"),
    [cfp?.form.closeAt, cfp?.event.timezone],
  );
  const orderedFields = useMemo(
    () => [...(cfp?.fields ?? [])].sort((left, right) => left.sortOrder - right.sortOrder),
    [cfp?.fields],
  );

  function updateSpeaker(field: keyof FormState["speaker"]) {
    return (event: ChangeEvent<HTMLInputElement>) => {
      setState((current) => ({ ...current, speaker: { ...current.speaker, [field]: event.target.value } }));
    };
  }

  async function save(intent: CfpSubmissionIntent): Promise<void> {
    if (cfp === null || availability?.canWrite !== true) {
      return;
    }
    setBusy(true);
    setErrors({});
    setPageError(null);
    setSaveMessage(null);
    const input: CfpSubmissionWrite = { intent, speaker: state.speaker, proposal: state.proposal };
    const isExisting = submission !== null;
    const requestPath = isExisting
      ? `/api/public/cfp/${slug}/submissions/${submission.id}${editKey === null ? "" : `?key=${encodeURIComponent(editKey)}`}`
      : `/api/public/cfp/${slug}/submissions`;
    try {
      const response = await fetch(requestPath, {
        method: isExisting ? "PATCH" : "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      const body = await response.json<SubmissionResponse & { fields?: Record<string, string> }>();
      if (!response.ok) {
        setErrors(body.fields ?? {});
        setPageError(body.message ?? "The proposal could not be saved.");
        if (response.status === 409) {
          setAvailability({ canWrite: false, state: "closed", message: body.message });
        }
        return;
      }
      const key = body.editKey ?? editKey;
      const editUrl = key === null
        ? body.editUrl
        : `${body.editUrl.split("?")[0]}?key=${encodeURIComponent(key)}`;
      const absoluteUrl = new URL(editUrl, window.location.origin).href;
      setSubmission(body.submission);
      setState(stateFromSubmission(body.submission));
      setEditKey(key);
      setPrivateUrl(absoluteUrl);
      setSaveMessage(body.message);
      if (accountUser === null) {
        setSavedReferences(rememberSubmission({
          id: body.submission.id,
          editUrl: absoluteUrl,
          status: body.submission.status,
          title: body.submission.title ?? "Untitled proposal",
        }));
      }
      if (!isExisting) {
        window.history.replaceState({}, "", editUrl);
      }
      if (!isExisting || intent === "submit") {
        setReceipt(body.submission.status === "draft" ? "draft" : "submitted");
      }
    } catch {
      setPageError("The proposal could not be saved. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (pageError !== null && cfp === null) {
    return <div className="public-page"><PublicHeader /><main className="cfp-loading"><p role="alert">{pageError}</p></main></div>;
  }
  if (cfp === null || availability === null) {
    return <div className="public-page"><PublicHeader /><main className="cfp-loading" aria-label="Loading call for speakers">Loading the call…</main></div>;
  }
  const isExisting = submission !== null;
  const locked = !availability.canWrite;
  return (
    <div className="public-page cfp-portal">
      <PublicHeader />
      <main>
        <section className="cfp-masthead">
          <div>
            <p className="eyebrow">CALL FOR SPEAKERS · {availability.state}</p>
            <h1>{cfp.event.name}</h1>
            <p className="cfp-masthead__tagline">{cfp.event.tagline}</p>
            <p className="cfp-masthead__description">{cfp.event.description}</p>
          </div>
          <aside className="cfp-deadline" aria-label="Submission deadline">
            <span>Submission deadline</span>
            <strong>{deadline?.label ?? "No deadline set"}</strong>
            <small data-testid="deadline-local">Event time · {deadline?.zone ?? "zone unavailable"}</small>
          </aside>
        </section>

        <section className="cfp-brief">
          <div>
            <p className="section-label">THE CALL</p>
            <h2>Bring the lesson that changed your work.</h2>
            <p>{cfp.form.welcomeCopy}</p>
          </div>
          <div className="cfp-taxonomy">
            <article><span>Tracks</span>{cfp.tracks.map((track) => <strong key={track}>{track}</strong>)}</article>
            <article><span>Formats</span>{cfp.formats.map((format) => <strong key={format}>{format}</strong>)}</article>
          </div>
          <div className="cfp-guidelines">
            <p className="section-label">SUBMISSION NOTES</p>
            <ul>
              <li>One speaker is enough. Add collaborators later if the program team requests them.</li>
              <li>Save a draft as soon as you have an identity and an idea. Proposal fields can stay unfinished.</li>
              <li>Required fields are checked only when you submit.</li>
              <li>Your job title and organization are frozen with the submitted proposal.</li>
            </ul>
          </div>
        </section>

        <SubmitterAccountPanel onAuthenticated={authenticateAccountUser} user={accountUser} />

        {savedReferences.length === 0 ? null : (
          <section className="cfp-own-list" aria-label="Your proposals on this device">
            <div><p className="section-label">YOUR PROPOSALS ON THIS DEVICE</p><p>These private links are stored only in this browser.</p></div>
            <ul>{savedReferences.map((reference) => (
              <li key={reference.id}>
                <a href={reference.editUrl}>{reference.title}</a>
                <span>{reference.status.replace("_", " ")} · {reference.id}</span>
              </li>
            ))}</ul>
          </section>
        )}

        {receipt !== null && submission !== null && privateUrl !== null ? (
          <SubmissionReceipt
            accountOwned={accountUser !== null && editKey === null}
            kind={receipt}
            message={saveMessage ?? "Your proposal is safely stored."}
            onContinue={() => setReceipt(null)}
            privateUrl={privateUrl}
            submission={submission}
          />
        ) : (
          <section className="cfp-form-section">
            <header>
              <div>
                <p className="section-label">{isExisting ? `PROPOSAL / ${submission.id}` : "START A PROPOSAL"}</p>
                <h2>{isExisting ? "Shape your proposal." : "Start before it is perfect."}</h2>
              </div>
              {isExisting ? <span className="cfp-status">{submission.status.replace("_", " ")}</span> : null}
            </header>

            {locked ? <div className="cfp-closed" role="status"><strong>Editing is closed.</strong><p>{availability.message}</p></div> : null}
            {newerVersionAvailable === null || submission === null ? null : (
              <div className="cfp-save-message" role="status">
                <strong>A newer form version is available.</strong>
                <p>
                  Continue with version {submission.formVersion} to keep every saved answer under its original questions,
                  or start a new version {newerVersionAvailable.version} proposal. Starting new leaves this draft untouched.
                </p>
                <div className="submission-receipt__actions">
                  <button className="button button--quiet" onClick={() => setNewerVersionAvailable(null)} type="button">
                    Continue with version {submission.formVersion}
                  </button>
                  <a className="button button--signal" href={newerVersionAvailable.startUrl}>
                    Start a new version {newerVersionAvailable.version} proposal
                  </a>
                </div>
              </div>
            )}
            {pageError === null ? null : <div className="cfp-form-error" role="alert">{pageError}</div>}
            {saveMessage === null || receipt !== null ? null : <div className="cfp-save-message" role="status">{saveMessage}</div>}

            <form noValidate onSubmit={(event) => event.preventDefault()}>
              <fieldset disabled={locked || busy}>
                <legend>About you</legend>
                <div className="cfp-identity-grid">
                  <label className="proposal-field" htmlFor="cfp-speaker-name">
                    <span className="proposal-field__label">Your name <small>Required to save</small></span>
                    <input aria-invalid={errors.speakerName === undefined ? undefined : true} id="cfp-speaker-name" onChange={updateSpeaker("name")} value={state.speaker.name} />
                    {errors.speakerName === undefined ? null : <span className="proposal-field__error" role="alert">{errors.speakerName}</span>}
                  </label>
                  <label className="proposal-field" htmlFor="cfp-speaker-email">
                    <span className="proposal-field__label">Email <small>Required to save</small></span>
                    <input aria-invalid={errors.speakerEmail === undefined ? undefined : true} disabled={isExisting || accountUser !== null || locked || busy} id="cfp-speaker-email" onChange={updateSpeaker("email")} type="email" value={state.speaker.email} />
                    <span className="proposal-field__hint">{accountUser === null ? "Used as your lasting speaker identity. No account required." : "Matches your signed-in account and keeps this proposal on your dashboard."}</span>
                    {errors.speakerEmail === undefined ? null : <span className="proposal-field__error" role="alert">{errors.speakerEmail}</span>}
                  </label>
                  <label className="proposal-field" htmlFor="cfp-speaker-title">
                    <span className="proposal-field__label">Job title <small>Optional</small></span>
                    <input id="cfp-speaker-title" onChange={updateSpeaker("jobTitle")} value={state.speaker.jobTitle} />
                  </label>
                  <label className="proposal-field" htmlFor="cfp-speaker-organization">
                    <span className="proposal-field__label">Organization <small>Optional</small></span>
                    <input id="cfp-speaker-organization" onChange={updateSpeaker("organization")} value={state.speaker.organization} />
                  </label>
                </div>
              </fieldset>

              <fieldset disabled={locked || busy}>
                <legend>Your session</legend>
                <div className="cfp-proposal-fields">
                  {orderedFields.map((field) => (
                    <ProposalField
                      disabled={locked || busy}
                      error={errors[field.key]}
                      field={field}
                      fields={orderedFields}
                      formats={cfp.formats}
                      key={field.id}
                      onChange={(value) => setState((current) => updateField(field, value, current))}
                      state={state}
                      tracks={cfp.tracks}
                    />
                  ))}
                  <label className="proposal-field" htmlFor="cfp-notes">
                    <span className="proposal-field__label">Notes for reviewers <small>Optional</small></span>
                    <textarea id="cfp-notes" onChange={(event) => setState((current) => ({ ...current, proposal: { ...current.proposal, notesForReviewers: event.target.value } }))} rows={4} value={state.proposal.notesForReviewers} />
                  </label>
                </div>
              </fieldset>

              {locked ? null : (
                <div className="cfp-form-actions">
                  {isExisting && submission.status !== "draft" ? (
                    <button className="button button--quiet" disabled={busy} onClick={() => void save("submit")} type="button">
                      {busy ? "Saving…" : "Save changes"}
                    </button>
                  ) : (
                    <button className="button button--quiet" disabled={busy} onClick={() => void save("draft")} type="button">
                      {busy ? "Saving…" : "Save draft"}
                    </button>
                  )}
                  {submission?.status === "draft" || submission === null ? (
                    <button className="button button--signal" disabled={busy} onClick={() => void save("submit")} type="button">
                      {busy ? "Submitting…" : "Submit proposal"}
                    </button>
                  ) : null}
                  <p>Drafts accept unfinished proposal fields. Submitting checks every required field on the server.</p>
                </div>
              )}
            </form>
          </section>
        )}
      </main>
    </div>
  );
}
