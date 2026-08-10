// ABOUTME: Organizer communications surface - the dispatch log and the F-11.7 reminder review queue.
// ABOUTME: Drafts never send themselves; every send here is one explicit organizer click.
import { useEffect, useMemo, useState } from "react";
import type {
  CommsTemplateDescriptor,
  DispositionSummary,
  EmailDispatchSummary,
} from "../../../shared/api.ts";
import { Button, DataTable, LoadingState, StatusChip, TextField, Toast } from "../../components/ui.tsx";
import "./comms.css";

const eventId = "evt_devflow_conf_2027";

async function readJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  if (!response.ok) {
    throw new Error(`Communications request failed (${response.status}).`);
  }
  return response.json<T>();
}

function statusTone(status: string): "neutral" | "good" | "signal" {
  if (status === "sent") return "good";
  if (status === "failed") return "signal";
  return "neutral";
}

export function CommsPage() {
  const [dispatches, setDispatches] = useState<EmailDispatchSummary[] | null>(null);
  const [failedNotices, setFailedNotices] = useState<DispositionSummary[]>([]);
  const [templates, setTemplates] = useState<CommsTemplateDescriptor[]>([]);
  const [previewKey, setPreviewKey] = useState<string>("");
  const [previewFields, setPreviewFields] = useState<Record<string, string>>({});
  const [previewResult, setPreviewResult] = useState<{ subject: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, { subject: string; body: string }>>({});

  async function load(): Promise<void> {
    const [dispatchPayload, dispositionPayload, templatePayload] = await Promise.all([
      readJson<{ items: EmailDispatchSummary[] }>(`/api/events/${eventId}/email-dispatches`),
      readJson<{ items: DispositionSummary[] }>(`/api/events/${eventId}/disposition`),
      readJson<{ items: CommsTemplateDescriptor[] }>(`/api/events/${eventId}/comms/templates`),
    ]);
    setDispatches(dispatchPayload.items);
    setFailedNotices(dispositionPayload.items.filter((item) => item.notice?.deliveryStatus === "failed"));
    setTemplates(templatePayload.items);
    if (previewKey === "" && templatePayload.items[0] !== undefined) {
      setPreviewKey(templatePayload.items[0].key);
    }
  }

  useEffect(() => {
    void load().catch((error: unknown) => {
      setMessage(error instanceof Error ? error.message : "Communications could not be loaded.");
      setDispatches([]);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const drafts = useMemo(() => dispatches?.filter((item) => item.status === "draft") ?? [], [dispatches]);
  const sentLog = useMemo(() => dispatches?.filter((item) => item.status !== "draft") ?? [], [dispatches]);
  const activeTemplate = templates.find((template) => template.key === previewKey);

  async function draftReminders(): Promise<void> {
    setBusy(true);
    try {
      const result = await readJson<{ drafted: unknown[]; skipped: number }>(
        `/api/events/${eventId}/email-dispatches/reminders/draft`,
        { method: "POST" },
      );
      await load();
      setMessage(`${result.drafted.length} reminder draft${result.drafted.length === 1 ? "" : "s"} queued for review. ${result.skipped} skipped.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Drafting reminders failed.");
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit(dispatchId: string): Promise<void> {
    const edit = edits[dispatchId];
    if (edit === undefined) return;
    setBusy(true);
    try {
      await readJson(`/api/events/${eventId}/email-dispatches/${dispatchId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(edit),
      });
      await load();
      setMessage("Draft updated.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Draft could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  async function approveAndSend(dispatchId: string): Promise<void> {
    setBusy(true);
    try {
      const result = await readJson<{ sentCount: number; failedCount: number }>(
        `/api/events/${eventId}/email-dispatches/${dispatchId}/send`,
        { method: "POST" },
      );
      await load();
      setMessage(`Sent to ${result.sentCount}, failed for ${result.failedCount}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Send failed.");
    } finally {
      setBusy(false);
    }
  }

  async function discard(dispatchId: string): Promise<void> {
    setBusy(true);
    try {
      await readJson(`/api/events/${eventId}/email-dispatches/${dispatchId}`, { method: "DELETE" });
      await load();
      setMessage("Draft discarded.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Draft could not be discarded.");
    } finally {
      setBusy(false);
    }
  }

  async function retryNotice(submissionId: string): Promise<void> {
    setBusy(true);
    try {
      await readJson(`/api/events/${eventId}/decision-notices/${submissionId}/retry`, { method: "POST" });
      await load();
      setMessage("Retry attempted.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Retry failed.");
    } finally {
      setBusy(false);
    }
  }

  async function runPreview(): Promise<void> {
    if (activeTemplate === undefined) return;
    setBusy(true);
    try {
      const rendered = await readJson<{ subject: string; text: string }>(
        `/api/events/${eventId}/comms/templates/${previewKey}/preview`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mergeFields: previewFields }),
        },
      );
      setPreviewResult(rendered);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Preview could not be rendered.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header className="workspace-header comms-header">
        <div>
          <p className="eyebrow">COMMUNICATIONS</p>
          <h1>Draft it.<br />Approve it. Then it sends.</h1>
          <p>Reminders are drafted for review, never sent automatically. Every send here is one explicit click.</p>
        </div>
        <Button disabled={busy} onClick={() => void draftReminders()} tone="signal">Draft reminders for overdue tasks</Button>
      </header>

      {failedNotices.length === 0 ? null : (
        <section className="workspace-section comms-failed" aria-label="Failed decision letters">
          <div className="section-heading"><div><p className="section-label">NEEDS ATTENTION</p><h2>{failedNotices.length} decision letter{failedNotices.length === 1 ? "" : "s"} failed to send</h2></div></div>
          <div className="comms-draft-list">
            {failedNotices.map((item) => (
              <article className="comms-draft" key={item.id}>
                <p><strong>{item.recipientName}</strong> &lt;{item.recipientEmail}&gt;</p>
                <p className="quiet-copy">{item.title ?? "Untitled proposal"} · {item.notice?.outcome}</p>
                <Button disabled={busy} onClick={() => void retryNotice(item.id)} tone="signal">Retry send</Button>
              </article>
            ))}
          </div>
        </section>
      )}

      <section className="workspace-section" aria-label="Reminder review queue">
        <div className="section-heading"><div><p className="section-label">REVIEW BEFORE SENDING</p><h2>{drafts.length} drafted reminder{drafts.length === 1 ? "" : "s"}</h2></div></div>
        {drafts.length === 0
          ? <p className="quiet-copy">No reminders waiting for review.</p>
          : (
            <div className="comms-draft-list">
              {drafts.map((draft) => {
                const edit = edits[draft.id] ?? { subject: draft.subject, body: draft.body };
                return (
                  <article className="comms-draft" key={draft.id}>
                    <p><strong>{draft.recipients.map((recipient) => recipient.name ?? recipient.email).join(", ")}</strong></p>
                    <TextField
                      label="Subject"
                      onChange={(event) => setEdits({ ...edits, [draft.id]: { ...edit, subject: event.target.value } })}
                      value={edit.subject}
                    />
                    <label className="field">
                      <span className="field__label">Body</span>
                      <textarea
                        className="field__control"
                        onChange={(event) => setEdits({ ...edits, [draft.id]: { ...edit, body: event.target.value } })}
                        rows={4}
                        value={edit.body}
                      />
                    </label>
                    <div className="comms-draft__actions">
                      <Button disabled={busy} onClick={() => void saveEdit(draft.id)} tone="quiet">Save edit</Button>
                      <Button disabled={busy} onClick={() => void approveAndSend(draft.id)} tone="signal">Approve and send</Button>
                      <Button disabled={busy} onClick={() => void discard(draft.id)} tone="quiet">Discard</Button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
      </section>

      <section className="workspace-section" aria-label="Template preview">
        <div className="section-heading"><div><p className="section-label">TEMPLATES</p><h2>Merge-field preview</h2></div></div>
        <div className="comms-preview">
          <label className="field">
            <span className="field__label">Template</span>
            <select
              className="field__control"
              onChange={(event) => { setPreviewKey(event.target.value); setPreviewResult(null); }}
              value={previewKey}
            >
              {templates.map((template) => <option key={template.key} value={template.key}>{template.key}</option>)}
            </select>
          </label>
          {activeTemplate?.mergeFields.map((field) => (
            <TextField
              key={field}
              label={field}
              onChange={(event) => setPreviewFields({ ...previewFields, [field]: event.target.value })}
              value={previewFields[field] ?? ""}
            />
          ))}
          <Button disabled={busy} onClick={() => void runPreview()}>Render preview</Button>
          {previewResult === null ? null : (
            <article className="comms-preview__result">
              <h3>{previewResult.subject}</h3>
              <p>{previewResult.text}</p>
            </article>
          )}
        </div>
      </section>

      {dispatches === null ? <LoadingState label="Loading communications" /> : (
        <section className="workspace-section" aria-label="Dispatch log">
          <DataTable
            caption="Dispatch log"
            columns={[
              { key: "template", label: "Template", render: (row) => row.templateKey ?? "—" },
              { key: "recipient", label: "Recipient", render: (row) => row.recipients.map((recipient) => recipient.email).join(", ") },
              { key: "subject", label: "Subject", render: (row) => row.subject },
              { key: "status", label: "Status", render: (row) => <StatusChip tone={statusTone(row.status)}>{row.status}</StatusChip> },
              { key: "outcome", label: "Detail", render: (row) => row.status === "failed" ? row.failureReason ?? "" : row.sentAt ?? "" },
            ]}
            rows={sentLog}
          />
        </section>
      )}
      <Toast message={message} />
    </>
  );
}
