// ABOUTME: Gives organizers a version-safe CFP form editor for copy, fields, conditions, and publishing.
// ABOUTME: Makes immutable publication history visible while keeping the stable public URL easy to share.
import { useEffect, useMemo, useState, type DragEvent } from "react";
import type {
  CfpBuilderField,
  CfpBuilderFieldType,
  CfpBuilderFormDetail,
  CfpBuilderFormSummary,
  CfpBuilderVersionInput,
} from "../../../shared/api.ts";
import { Button, LoadingState, StatusChip, Toast } from "../../components/ui.tsx";
import "./cfp-builder.css";

const eventId = "evt_devflow_conf_2027";
const requiredContractFieldKeys = new Set(["session_title", "abstract", "track"]);

interface NamedRecord {
  id: string;
  name: string;
}

function fieldKey(label: string, index: number): string {
  const key = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `${key === "" ? "custom_field" : key}_${index + 1}`;
}

function dateTimeInput(value: string | null): string {
  if (value === null) {
    return "";
  }
  const date = new Date(value);
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return localDate.toISOString().slice(0, 16);
}

function isoDate(value: string): string | null {
  return value === "" ? null : new Date(value).toISOString();
}

async function readJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin" });
  if (!response.ok) {
    const body = await response.json<{ message?: string }>().catch((): { message?: string } => ({}));
    throw new Error(body.message ?? "The CFP form could not be loaded.");
  }
  return response.json<T>();
}

async function writeJson<T>(path: string, method: "POST" | "PUT", body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin" };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(path, init);
  const result = await response.json<T & { message?: string }>();
  if (!response.ok) {
    throw new Error(result.message ?? "The CFP form could not be saved.");
  }
  return result;
}

function versionInput(detail: CfpBuilderFormDetail): CfpBuilderVersionInput {
  return {
    welcomeCopy: detail.selectedVersion.welcomeCopy,
    confirmationCopy: detail.selectedVersion.confirmationCopy,
    confirmationEmailCopy: detail.selectedVersion.confirmationEmailCopy,
    openAt: detail.selectedVersion.openAt,
    closeAt: detail.selectedVersion.closeAt,
    minimumSpeakers: detail.selectedVersion.minimumSpeakers,
    maximumSpeakers: detail.selectedVersion.maximumSpeakers,
    fields: detail.fields.map((field) => requiredContractFieldKeys.has(field.key)
      ? { ...field, required: true, conditional: null }
      : field),
  };
}

function orderedVersionInput(draft: CfpBuilderVersionInput): CfpBuilderVersionInput {
  return {
    ...draft,
    fields: draft.fields.map((field, sortOrder) => ({ ...field, sortOrder })),
  };
}

function defaultFields(): CfpBuilderField[] {
  return [
    { key: "session_title", label: "Session title", description: null, fieldType: "short_text", required: true, sortOrder: 0, options: null, conditional: null },
    { key: "abstract", label: "Abstract", description: null, fieldType: "long_text", required: true, sortOrder: 1, options: null, conditional: null },
    { key: "track", label: "Track", description: null, fieldType: "dropdown", required: true, sortOrder: 2, options: null, conditional: null },
    { key: "format", label: "Format", description: null, fieldType: "dropdown", required: true, sortOrder: 3, options: null, conditional: null },
    { key: "speaker_bio", label: "Speaker bio", description: null, fieldType: "long_text", required: false, sortOrder: 4, options: null, conditional: null },
  ];
}

export function CfpBuilderPage() {
  const [forms, setForms] = useState<CfpBuilderFormSummary[] | null>(null);
  const [detail, setDetail] = useState<CfpBuilderFormDetail | null>(null);
  const [draft, setDraft] = useState<CfpBuilderVersionInput | null>(null);
  const [tracks, setTracks] = useState<string[]>([]);
  const [formats, setFormats] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newSlug, setNewSlug] = useState("");

  async function loadForm(formId: string, version?: number): Promise<void> {
    const suffix = version === undefined ? "" : `?version=${version}`;
    const next = await readJson<CfpBuilderFormDetail>(`/api/cfp-builder/forms/${formId}${suffix}`);
    setDetail(next);
    setDraft(versionInput(next));
  }

  async function loadForms(preferredFormId?: string): Promise<void> {
    const result = await readJson<{ items: CfpBuilderFormSummary[] }>(
      `/api/cfp-builder/events/${eventId}/forms`,
    );
    setForms(result.items);
    const formId = preferredFormId ?? detail?.form.id ?? result.items[0]?.id;
    if (formId !== undefined) {
      await loadForm(formId);
    }
  }

  useEffect(() => {
    Promise.all([
      readJson<{ items: NamedRecord[] }>(`/api/events/${eventId}/tracks`),
      readJson<{ items: NamedRecord[] }>(`/api/events/${eventId}/formats`),
      readJson<{ items: CfpBuilderFormSummary[] }>(`/api/cfp-builder/events/${eventId}/forms`),
    ]).then(async ([trackData, formatData, formData]) => {
      setTracks(trackData.items.map((item) => item.name));
      setFormats(formatData.items.map((item) => item.name));
      setForms(formData.items);
      const first = formData.items[0];
      if (first !== undefined) {
        await loadForm(first.id);
      }
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "The CFP builder could not be loaded."));
  }, []);

  const readOnly = detail !== null
    && detail.selectedVersion.status !== "draft"
    && detail.selectedVersion.version !== detail.form.version;
  const previewUrl = detail === null || detail.selectedVersion.status !== "draft"
    ? null
    : `${detail.publicUrl}?preview=${encodeURIComponent(detail.form.id)}&version=${detail.selectedVersion.version}`;
  const conditionOptions = useMemo(() => new Map((draft?.fields ?? []).map((field) => [
    field.key,
    field.key === "track" ? tracks : field.key === "format" ? formats : field.options ?? [],
  ])), [draft?.fields, tracks, formats]);

  function replaceField(index: number, values: Partial<CfpBuilderField>): void {
    setDraft((current) => current === null ? null : {
      ...current,
      fields: current.fields.map((field, fieldIndex) => fieldIndex === index ? { ...field, ...values } : field),
    });
  }

  function moveField(from: number, to: number): void {
    setDraft((current) => {
      if (current === null || from === to || to < 0 || to >= current.fields.length) {
        return current;
      }
      const fields = [...current.fields];
      const [field] = fields.splice(from, 1);
      if (field === undefined) {
        return current;
      }
      fields.splice(to, 0, field);
      return { ...current, fields: fields.map((item, sortOrder) => ({ ...item, sortOrder })) };
    });
  }

  function dropField(event: DragEvent<HTMLElement>, index: number): void {
    event.preventDefault();
    if (draggedIndex !== null) {
      moveField(draggedIndex, index);
    }
    setDraggedIndex(null);
  }

  async function save(): Promise<void> {
    if (detail === null || draft === null || readOnly) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await writeJson(`/api/cfp-builder/forms/${detail.form.id}`, "PUT", orderedVersionInput(draft));
      await loadForm(detail.form.id);
      setToast(detail.selectedVersion.status === "draft" ? "Draft changes saved." : "Versioned draft created. Published submissions remain on their original form.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The form could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  async function publish(): Promise<void> {
    if (detail === null || draft === null || detail.selectedVersion.status !== "draft") {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await writeJson(`/api/cfp-builder/forms/${detail.form.id}`, "PUT", orderedVersionInput(draft));
      await writeJson(`/api/cfp-builder/forms/${detail.form.id}/publish`, "POST");
      await loadForms(detail.form.id);
      setToast(`Version ${detail.selectedVersion.version} published at the stable public URL.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The form could not be published.");
    } finally {
      setBusy(false);
    }
  }

  async function closeForm(): Promise<void> {
    if (detail === null || !window.confirm("Close this CFP? New submissions and edits will be locked across every version.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await writeJson(`/api/cfp-builder/forms/${detail.form.id}/close`, "POST");
      await loadForms(detail.form.id);
      setToast("CFP closed. The public page remains available in a locked state.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The CFP could not be closed.");
    } finally {
      setBusy(false);
    }
  }

  async function reopenForm(): Promise<void> {
    if (detail === null) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await writeJson(`/api/cfp-builder/forms/${detail.form.id}/reopen`, "POST");
      await loadForms(detail.form.id);
      setToast("CFP reopened. The published version is accepting proposals again.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The CFP could not be reopened.");
    } finally {
      setBusy(false);
    }
  }

  async function copyPublicUrl(): Promise<void> {
    if (detail === null) {
      return;
    }
    await navigator.clipboard.writeText(new URL(detail.publicUrl, window.location.origin).href);
    setToast("Public CFP URL copied.");
  }

  async function createForm(): Promise<void> {
    if (newName.trim() === "" || newSlug.trim() === "") {
      setError("Add a form name and public URL slug.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await writeJson<{ form: CfpBuilderFormSummary }>(
        `/api/cfp-builder/events/${eventId}/forms`,
        "POST",
        {
          name: newName,
          publicSlug: newSlug,
          welcomeCopy: "Tell us what you want to share with the community.",
          confirmationCopy: "Your proposal is safely saved.",
          confirmationEmailCopy: "We received {talk_title}.",
          openAt: null,
          closeAt: null,
          minimumSpeakers: 1,
          maximumSpeakers: null,
          fields: defaultFields(),
        },
      );
      setCreating(false);
      setNewName("");
      setNewSlug("");
      await loadForms(result.form.id);
      setToast("Draft CFP form created. It stays private until you publish it.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The form could not be created.");
    } finally {
      setBusy(false);
    }
  }

  if (forms === null || (forms.length > 0 && (detail === null || draft === null))) {
    return <LoadingState label="Loading CFP form builder" />;
  }

  return (
    <div className="cfp-builder" data-testid="cfp-builder">
      <header className="workspace-header cfp-builder__header">
        <div>
          <p className="eyebrow">CALL FOR SPEAKERS / FORM BUILDER</p>
          <h1>Shape the call.</h1>
          <p>Published answers stay bound to the exact questions speakers saw.</p>
        </div>
        <Button onClick={() => setCreating((value) => !value)} tone="quiet">+ New form</Button>
      </header>

      {creating ? (
        <section className="workspace-section cfp-builder__create" aria-label="Create CFP form">
          <label className="field"><span className="field__label">Form name</span><input className="field__control" onChange={(event) => setNewName(event.target.value)} value={newName} /></label>
          <label className="field"><span className="field__label">Public URL slug</span><input className="field__control" onChange={(event) => setNewSlug(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} placeholder="partner-track" value={newSlug} /></label>
          <Button disabled={busy} onClick={() => void createForm()} tone="signal">Create private draft</Button>
        </section>
      ) : null}

      {forms.length === 0 || detail === null || draft === null ? (
        <section className="workspace-section"><h2>No forms yet</h2><p>Create a private draft to start building the call.</p></section>
      ) : (
        <>
          <section className="cfp-builder__toolbar" aria-label="Form controls">
            <label className="field">
              <span className="field__label">Form</span>
              <select className="field__control" data-testid="cfp-builder-form-select" onChange={(event) => void loadForm(event.target.value)} value={detail.form.id}>
                {forms.map((form) => <option key={form.id} value={form.id}>{form.name}</option>)}
              </select>
            </label>
            <div className="cfp-builder__identity">
              <span>Stable public URL</span>
              <code>{detail.publicUrl}</code>
            </div>
            <StatusChip tone={detail.selectedVersion.status === "published" ? "good" : detail.selectedVersion.status === "draft" ? "signal" : "neutral"}>
              v{detail.selectedVersion.version} · {detail.selectedVersion.status}
            </StatusChip>
            <Button onClick={() => void copyPublicUrl()} tone="quiet">Copy URL</Button>
            <a className="button button--quiet" href={detail.publicUrl} target="_blank">View public ↗</a>
          </section>

          <div className="cfp-builder__layout">
            <div>
              {readOnly ? <div className="cfp-builder__notice">You are browsing an immutable older version. Choose the current version to make changes.</div> : detail.selectedVersion.status === "published" ? <div className="cfp-builder__notice">Saving changes creates version {detail.selectedVersion.version + 1}. Version {detail.selectedVersion.version} and its submissions stay unchanged.</div> : null}
              {error === null ? null : <div className="cfp-builder__error" role="alert">{error}</div>}

              <section className="workspace-section cfp-builder__settings">
                <div className="section-heading"><div><p className="section-label">COPY & WINDOW</p><h2>What speakers see</h2></div></div>
                <label className="field cfp-builder__wide"><span className="field__label">Welcome copy</span><textarea className="field__control" disabled={readOnly} onChange={(event) => setDraft({ ...draft, welcomeCopy: event.target.value })} rows={4} value={draft.welcomeCopy ?? ""} /></label>
                <label className="field"><span className="field__label">Opens</span><input className="field__control" disabled={readOnly} onChange={(event) => setDraft({ ...draft, openAt: isoDate(event.target.value) })} type="datetime-local" value={dateTimeInput(draft.openAt)} /></label>
                <label className="field"><span className="field__label">Closes</span><input className="field__control" disabled={readOnly} onChange={(event) => setDraft({ ...draft, closeAt: isoDate(event.target.value) })} type="datetime-local" value={dateTimeInput(draft.closeAt)} /></label>
                <label className="field cfp-builder__wide"><span className="field__label">Confirmation page copy</span><textarea className="field__control" disabled={readOnly} onChange={(event) => setDraft({ ...draft, confirmationCopy: event.target.value })} rows={3} value={draft.confirmationCopy ?? ""} /></label>
                <label className="field cfp-builder__wide"><span className="field__label">Confirmation email copy</span><textarea className="field__control" disabled={readOnly} onChange={(event) => setDraft({ ...draft, confirmationEmailCopy: event.target.value })} rows={3} value={draft.confirmationEmailCopy ?? ""} /></label>
              </section>

              <section className="workspace-section">
                <div className="section-heading">
                  <div><p className="section-label">FIELDS / {String(draft.fields.length).padStart(2, "0")}</p><h2>Proposal questions</h2></div>
                  <Button disabled={readOnly} onClick={() => setDraft({
                    ...draft,
                    fields: [...draft.fields, {
                      key: fieldKey("Custom field", draft.fields.length),
                      label: "Custom field",
                      description: null,
                      fieldType: "short_text",
                      required: false,
                      sortOrder: draft.fields.length,
                      options: null,
                      conditional: null,
                    }],
                  })} tone="signal">+ Add field</Button>
                </div>
                <p className="cfp-builder__drag-help">Drag field cards to reorder them. Move buttons provide the same action by keyboard.</p>
                <div className="cfp-builder__fields">
                  {draft.fields.map((field, index) => {
                    const controllingOptions = field.conditional === null ? [] : conditionOptions.get(field.conditional.fieldKey) ?? [];
                    const requiredContractField = requiredContractFieldKeys.has(field.key);
                    return (
                      <article
                        className="cfp-field-card"
                        data-field-key={field.key}
                        draggable={!readOnly}
                        key={`${field.key}-${index}`}
                        onDragOver={(event) => event.preventDefault()}
                        onDragStart={() => setDraggedIndex(index)}
                        onDrop={(event) => dropField(event, index)}
                      >
                        <div className="cfp-field-card__handle"><span aria-hidden="true">⠿</span><strong>{String(index + 1).padStart(2, "0")}</strong><code>{field.key}</code></div>
                        <div className="cfp-field-card__grid">
                          <label className="field"><span className="field__label">Label</span><input className="field__control" disabled={readOnly} onChange={(event) => replaceField(index, { label: event.target.value })} value={field.label} /></label>
                          <label className="field"><span className="field__label">Field type</span><select className="field__control" disabled={readOnly || field.key === "track" || field.key === "format"} onChange={(event) => replaceField(index, { fieldType: event.target.value as CfpBuilderFieldType, options: event.target.value === "dropdown" ? [] : null })} value={field.fieldType}><option value="short_text">Short text</option><option value="long_text">Long text</option><option value="dropdown">Dropdown</option></select></label>
                          <label className="field cfp-field-card__wide"><span className="field__label">Help text</span><input className="field__control" disabled={readOnly} onChange={(event) => replaceField(index, { description: event.target.value || null })} value={field.description ?? ""} /></label>
                          {field.fieldType !== "dropdown" || field.key === "track" || field.key === "format" ? null : <label className="field cfp-field-card__wide"><span className="field__label">Dropdown options, one per line</span><textarea className="field__control" disabled={readOnly} onChange={(event) => replaceField(index, { options: event.target.value.split("\n").map((option) => option.trim()).filter(Boolean) })} rows={3} value={(field.options ?? []).join("\n")} /></label>}
                          <label className="field"><span className="field__label">Show only when</span><select className="field__control" disabled={readOnly || requiredContractField} onChange={(event) => replaceField(index, { conditional: event.target.value === "" ? null : { fieldKey: event.target.value, operator: "equals", value: "" } })} value={field.conditional?.fieldKey ?? ""}><option value="">Always visible</option>{draft.fields.filter((candidate) => candidate.key !== field.key && candidate.fieldType === "dropdown").map((candidate) => <option key={candidate.key} value={candidate.key}>{candidate.label}</option>)}</select></label>
                          {field.conditional === null ? null : <label className="field"><span className="field__label">Equals</span><select className="field__control" disabled={readOnly} onChange={(event) => replaceField(index, { conditional: { ...field.conditional!, value: event.target.value } })} value={field.conditional.value}><option value="">Choose value</option>{controllingOptions.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>}
                        </div>
                        <div className="cfp-field-card__actions">
                          <label><input checked={field.required} disabled={readOnly || requiredContractField} onChange={(event) => replaceField(index, { required: event.target.checked })} type="checkbox" /> Required to submit</label>
                          <button disabled={readOnly || index === 0} onClick={() => moveField(index, index - 1)} type="button">↑ Move up</button>
                          <button disabled={readOnly || index === draft.fields.length - 1} onClick={() => moveField(index, index + 1)} type="button">↓ Move down</button>
                          <button disabled={readOnly || requiredContractField} onClick={() => setDraft({ ...draft, fields: draft.fields.filter((_, fieldIndex) => fieldIndex !== index) })} type="button">Remove</button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>

              {readOnly ? null : (
                <section className="cfp-builder__savebar">
                  <div>
                    <strong>{detail.selectedVersion.status === "draft" ? `Editing draft v${detail.selectedVersion.version}` : `Published v${detail.selectedVersion.version} stays immutable`}</strong>
                    <span>{detail.form.status === "closed" ? `The public call is closed. Reopening restores published v${detail.form.version}; this draft stays private.` : "Save first, then publish when the public version is ready."}</span>
                  </div>
                  <Button disabled={busy} onClick={() => void save()} tone="quiet">{busy ? "Saving…" : "Save changes"}</Button>
                  {previewUrl === null ? null : <a className="button button--quiet" href={previewUrl} rel="noreferrer" target="_blank">Preview as speaker ↗</a>}
                  {detail.selectedVersion.status === "draft" ? <Button disabled={busy} onClick={() => void publish()} tone="signal">Publish version {detail.selectedVersion.version}</Button> : null}
                  {detail.form.status === "published" ? <Button disabled={busy} onClick={() => void closeForm()} tone="quiet">Close CFP</Button> : null}
                  {detail.form.status === "closed" ? <Button disabled={busy} onClick={() => void reopenForm()} tone="signal">Reopen CFP</Button> : null}
                </section>
              )}
            </div>

            <aside className="workspace-section cfp-builder__versions">
              <p className="section-label">VERSION HISTORY</p>
              <h2>Every question, intact.</h2>
              <p>Submissions always render against the version shown when they were written.</p>
              <ol>
                {detail.versions.map((version) => (
                  <li className={version.version === detail.selectedVersion.version ? "active" : ""} key={version.id}>
                    <button onClick={() => void loadForm(detail.form.id, version.version)} type="button">
                      <strong>Version {version.version}</strong>
                      <span>{version.status}</span>
                      <small>{version.publishedAt === null ? "Not published" : new Date(version.publishedAt).toLocaleDateString()}</small>
                    </button>
                  </li>
                ))}
              </ol>
            </aside>
          </div>
        </>
      )}
      <Toast message={toast} />
    </div>
  );
}
