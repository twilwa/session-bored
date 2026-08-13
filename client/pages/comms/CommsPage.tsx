// ABOUTME: Organizer communications surface for event templates, previews, draft review, and dispatch history.
// ABOUTME: Preview and queue actions stay silent; every send remains one explicit organizer click.
import { useEffect, useMemo, useState } from "react";
import type {
  CommsTemplateDescriptor,
  DispositionSummary,
  EmailDispatchSummary,
} from "../../../shared/api.ts";
import { EmailSenderNotice, useEmailSenderStatus } from "../../components/email-sender.tsx";
import { Button, DataTable, LoadingState, Modal, StatusChip, TextField, Toast } from "../../components/ui.tsx";
import { navigate } from "../../lib.tsx";
import "./comms.css";

const eventId = "evt_devflow_conf_2027";
const automaticMergeFields = new Set(["eventName", "recipientName", "recipientEmail"]);

interface CommunicationRecipient {
  id: string;
  name: string;
  email: string;
}

interface TemplateEditor {
  key: string | null;
  name: string;
  subject: string;
  body: string;
}

/** A letter the organizer is retiring, and the correction that should replace it. */
interface Cancellation {
  submissionId: string;
  recipientName: string;
  recipientEmail: string;
  /**
   * What the field was prefilled with. The prefill is the *letter's* frozen address, which is
   * not always the person's - correcting them on the roster leaves the letter behind. Sending it
   * back unchanged would write the letter's stale address over the corrected person, so the
   * correction only travels when the organizer actually typed one.
   */
  prefilledEmail: string;
  reason: string;
}

function requestErrorMessage(status: number, payload: unknown): string {
  if (typeof payload === "object" && payload !== null) {
    const error = "error" in payload && typeof payload.error === "string" ? payload.error : null;
    const fields = "fields" in payload && Array.isArray(payload.fields)
      ? payload.fields.filter((field): field is string => typeof field === "string")
      : [];
    if (error === "missing_merge_fields") {
      return `Missing merge fields: ${fields.join(", ")}.`;
    }
    if (error === "invalid_merge_field_syntax") {
      return "Merge fields must use matching braces, for example {{recipientName}}.";
    }
    if (error === "email_not_configured") {
      return "No email sender is configured, so nothing was sent. The draft remains ready for review.";
    }
    if (error === "recipient_email_taken") {
      return "Another person already uses that address, so nothing was changed and the letter is still queued.";
    }
    if (error === "invalid_recipient_email") {
      return "That is not an email address, so nothing was changed and the letter is still queued.";
    }
    if (error === "notice_not_cancellable") {
      return "This letter has already been sent, so it is history and cannot be cancelled.";
    }
    if (error === "notice_already_cancelled") {
      return "This letter was already cancelled.";
    }
    if (error === "notice_id_required") {
      return "This page could not say which letter to send. Reload Communications and try again.";
    }
    if (error === "notice_superseded") {
      return "This letter was cancelled and replaced while this page was open. Reload to see the letter that is waiting now.";
    }
    // A send the provider rejected answers 502 and names its own reason, which is
    // the only thing that tells an organizer what to fix.
    if ("status" in payload && payload.status === "failed") {
      return `The email sender rejected this message: ${"error" in payload && typeof payload.error === "string" ? payload.error : "no reason given"}`;
    }
  }
  return `Communications request failed (${status}).`;
}

async function readJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  if (!response.ok) {
    const payload = await response.json<unknown>().catch(() => null);
    throw new Error(requestErrorMessage(response.status, payload));
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
  const [undeliveredNotices, setUndeliveredNotices] = useState<DispositionSummary[]>([]);
  const [templates, setTemplates] = useState<CommsTemplateDescriptor[]>([]);
  const [recipients, setRecipients] = useState<CommunicationRecipient[]>([]);
  const [previewKey, setPreviewKey] = useState<string>("");
  const [previewFields, setPreviewFields] = useState<Record<string, string>>({});
  const [previewResult, setPreviewResult] = useState<{ subject: string; text: string } | null>(null);
  const [selectedRecipientIds, setSelectedRecipientIds] = useState<string[]>([]);
  const [templateEditor, setTemplateEditor] = useState<TemplateEditor | null>(null);
  const [cancellation, setCancellation] = useState<Cancellation | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, { subject: string; body: string }>>({});
  const senderStatus = useEmailSenderStatus();

  async function load(): Promise<void> {
    const [dispatchPayload, dispositionPayload, templatePayload, recipientPayload] = await Promise.all([
      readJson<{ items: EmailDispatchSummary[] }>(`/api/events/${eventId}/email-dispatches`),
      readJson<{ items: DispositionSummary[] }>(`/api/events/${eventId}/disposition`),
      readJson<{ items: CommsTemplateDescriptor[] }>(`/api/events/${eventId}/comms/templates`),
      readJson<{ items: CommunicationRecipient[] }>(`/api/events/${eventId}/comms/recipients`),
    ]);
    setDispatches(dispatchPayload.items);
    setUndeliveredNotices(dispositionPayload.items.filter((item) =>
      item.notice !== null && item.notice.deliveryStatus !== "sent"
    ));
    setTemplates(templatePayload.items);
    setRecipients(recipientPayload.items);
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
  const manualMergeFields = activeTemplate?.mergeFields.filter((field) => !automaticMergeFields.has(field)) ?? [];

  function toggleRecipient(recipientId: string): void {
    setSelectedRecipientIds((current) => current.includes(recipientId)
      ? current.filter((id) => id !== recipientId)
      : [...current, recipientId]);
    setPreviewResult(null);
  }

  function startTemplateEditor(template: CommsTemplateDescriptor | null): void {
    setTemplateEditor(template === null
      ? { key: null, name: "", subject: "", body: "" }
      : {
        key: template.key,
        name: template.name,
        subject: template.subject ?? "",
        body: template.body ?? "",
      });
  }

  async function saveTemplate(): Promise<void> {
    if (templateEditor === null) return;
    setBusy(true);
    try {
      const path = templateEditor.key === null
        ? `/api/events/${eventId}/comms/templates`
        : `/api/events/${eventId}/comms/templates/${templateEditor.key}`;
      const result = await readJson<{ item: CommsTemplateDescriptor }>(path, {
        method: templateEditor.key === null ? "POST" : "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: templateEditor.name,
          subject: templateEditor.subject,
          body: templateEditor.body,
        }),
      });
      await load();
      setPreviewKey(result.item.key);
      setPreviewFields({});
      setPreviewResult(null);
      setTemplateEditor(null);
      setMessage(templateEditor.key === null ? "Template created." : "Template updated.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Template could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  async function removeTemplate(template: CommsTemplateDescriptor): Promise<void> {
    if (!template.editable || !globalThis.confirm(`Remove “${template.name}”? Sent messages will remain in the log.`)) {
      return;
    }
    setBusy(true);
    try {
      await readJson(`/api/events/${eventId}/comms/templates/${template.key}`, { method: "DELETE" });
      const remaining = templates.filter((item) => item.key !== template.key);
      setPreviewKey(remaining[0]?.key ?? "");
      setPreviewFields({});
      setPreviewResult(null);
      setTemplateEditor(null);
      await load();
      setMessage("Template removed. Dispatch history was preserved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Template could not be removed.");
    } finally {
      setBusy(false);
    }
  }

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

  async function sendNotice(submissionId: string, noticeId: string): Promise<void> {
    setBusy(true);
    try {
      // Name the letter this page is showing. If it was cancelled and replaced since the page
      // loaded, the server refuses rather than sending a different letter under this review.
      await readJson(`/api/events/${eventId}/decision-notices/${submissionId}/retry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ noticeId }),
      });
      setMessage("Decision letter sent.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Sending the decision letter failed.");
    } finally {
      // A rejected attempt still changes the letter's recorded state, so reload either way
      // rather than leaving the page showing a letter as untried.
      await load().catch(() => undefined);
      setBusy(false);
    }
  }

  function startCancellation(item: DispositionSummary): void {
    const prefilledEmail = item.notice?.recipientEmail ?? item.recipientEmail;
    setCancellation({
      submissionId: item.id,
      recipientName: item.recipientName,
      recipientEmail: prefilledEmail,
      prefilledEmail,
      reason: "",
    });
  }

  /**
   * Retires the letter, optionally correcting the address it was queued to. "requeue" then hands
   * the organizer to Disposition with a fresh letter rendered from the corrected record - which
   * they still have to review and dispatch. Cancelling never queues or sends anything itself.
   */
  async function cancelNotice(pending: Cancellation, then: "requeue" | "stay"): Promise<void> {
    setBusy(true);
    try {
      const edited = pending.recipientEmail.trim() !== pending.prefilledEmail;
      await readJson(`/api/events/${eventId}/decision-notices/${pending.submissionId}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reason: pending.reason,
          ...(edited ? { recipientEmail: pending.recipientEmail } : {}),
        }),
      });
      setCancellation(null);
      if (then === "requeue") {
        navigate(`/organizer/disposition?requeue=${pending.submissionId}`);
        return;
      }
      await load();
      setMessage("The letter was cancelled. It stays in the dispatch log, marked cancelled.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The letter could not be cancelled.");
    } finally {
      setBusy(false);
    }
  }

  async function runPreview(): Promise<void> {
    if (activeTemplate === undefined) return;
    if (selectedRecipientIds.length === 0) {
      setMessage("Choose at least one recipient before rendering a preview.");
      return;
    }
    setBusy(true);
    try {
      const rendered = await readJson<{ subject: string; text: string }>(
        `/api/events/${eventId}/comms/templates/${previewKey}/preview`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            recipientId: selectedRecipientIds[0],
            mergeFields: previewFields,
          }),
        },
      );
      setPreviewResult(rendered);
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Preview could not be rendered.");
    } finally {
      setBusy(false);
    }
  }

  async function queuePreview(): Promise<void> {
    if (activeTemplate === undefined || previewResult === null || selectedRecipientIds.length === 0) return;
    setBusy(true);
    try {
      const result = await readJson<{ drafts: Array<{ dispatchId: string }> }>(
        `/api/events/${eventId}/comms/templates/${activeTemplate.key}/drafts`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ recipientIds: selectedRecipientIds, mergeFields: previewFields }),
        },
      );
      await load();
      setMessage(`${result.drafts.length} draft${result.drafts.length === 1 ? "" : "s"} queued for review.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Drafts could not be queued.");
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
          <p>Messages are drafted for review, never sent automatically. Every send here is one explicit click.</p>
        </div>
        <Button disabled={busy} onClick={() => void draftReminders()} tone="signal">Draft reminders for overdue tasks</Button>
      </header>

      <EmailSenderNotice status={senderStatus} />

      {undeliveredNotices.length === 0 ? null : (
        <section className="workspace-section comms-undelivered" aria-label="Decision letters not yet delivered">
          <div className="section-heading"><div><p className="section-label">NEEDS ATTENTION</p><h2>{undeliveredNotices.length} decision letter{undeliveredNotices.length === 1 ? "" : "s"} {undeliveredNotices.length === 1 ? "has" : "have"} not gone out</h2></div></div>
          <div className="comms-draft-list">
            {undeliveredNotices.map((item) => {
              // This list is built from proposals that have a letter, so `notice` is always set.
              // Binding it here is what lets the send action name the letter it is showing.
              const notice = item.notice;
              if (notice === null) return null;
              return (
              <article className="comms-draft" key={item.id}>
                {/* The address the letter carries, not the person's current one. Correcting the
                    person leaves this pointing at the old address, and this card offers to send. */}
                <p><strong>{item.recipientName}</strong> &lt;{notice.recipientEmail}&gt;</p>
                <p className="quiet-copy">{item.title ?? "Untitled proposal"} · {notice.outcome}</p>
                <p className="comms-undelivered-state">
                  {notice.deliveryStatus === "failed"
                    ? "Send failed"
                    : "Waiting to send — no delivery has been attempted"}
                </p>
                {notice.deliveryStatus === "failed"
                  ? <p className="comms-undelivered-reason">{notice.failureReason ?? "The sender recorded no reason."}</p>
                  : null}
                {senderStatus?.connected === false
                  ? <p className="comms-undelivered-blocked">It will go out once an email sender is connected. See the delivery status above.</p>
                  : null}
                <div className="comms-draft__actions">
                  {senderStatus?.connected === false ? null : (
                    <Button disabled={busy || senderStatus === null} onClick={() => void sendNotice(item.id, notice.id)} tone="signal">
                      Send now
                    </Button>
                  )}
                  <Button
                    disabled={busy}
                    onClick={() => startCancellation(item)}
                    tone="quiet"
                  >
                    Wrong recipient?
                  </Button>
                </div>
              </article>
              );
            })}
          </div>
        </section>
      )}

      {cancellation === null ? null : (
        <Modal
          onClose={() => setCancellation(null)}
          open
          title={`Cancel the letter to ${cancellation.recipientName}`}
        >
          <p>
            This letter has not been sent, so cancelling it tells nobody anything. It stays in the
            dispatch log below, marked cancelled, with the reason you give here.
          </p>
          <TextField
            label="Correct the recipient's address"
            name="cancel-recipient-email"
            onChange={(event) => setCancellation({ ...cancellation, recipientEmail: event.target.value })}
            type="email"
            value={cancellation.recipientEmail}
          />
          <p className="quiet-copy">
            This updates the address Greenroom holds for {cancellation.recipientName}, so every later
            letter goes to the right place. Leave it unchanged to cancel without correcting anything.
          </p>
          <TextField
            label="Why is it being cancelled?"
            name="cancel-reason"
            onChange={(event) => setCancellation({ ...cancellation, reason: event.target.value })}
            value={cancellation.reason}
          />
          <div className="comms-draft__actions">
            <Button
              disabled={busy}
              onClick={() => void cancelNotice(cancellation, "requeue")}
              tone="signal"
            >
              Cancel and re-queue
            </Button>
            <Button disabled={busy} onClick={() => void cancelNotice(cancellation, "stay")}>
              Cancel this letter only
            </Button>
          </div>
          <p className="quiet-copy">
            Re-queueing takes you to Disposition with a fresh letter rendered from the corrected
            record. Nothing is queued until you review it there and dispatch it.
          </p>
        </Modal>
      )}

      <section className="workspace-section" aria-label="Template library">
        <div className="section-heading">
          <div>
            <p className="section-label">EVENT COPY</p>
            <h2>Message templates</h2>
          </div>
          <Button disabled={busy} onClick={() => startTemplateEditor(null)} tone="signal">New template</Button>
        </div>
        <p className="comms-template-help">
          Built-ins are maintained by Greenroom and stay read-only. Event templates belong only to this event and can be edited or removed here.
        </p>
        {templateEditor === null ? null : (
          <div className="comms-template-editor">
            <div className="comms-template-editor__heading">
              <div>
                <p className="section-label">{templateEditor.key === null ? "CREATE" : "EDIT"}</p>
                <h3>{templateEditor.key === null ? "Write an event template" : "Edit event template"}</h3>
              </div>
              <Button disabled={busy} onClick={() => setTemplateEditor(null)} tone="quiet">Cancel</Button>
            </div>
            <TextField
              label="Template name"
              onChange={(event) => setTemplateEditor({ ...templateEditor, name: event.target.value })}
              value={templateEditor.name}
            />
            <TextField
              label="Subject template"
              onChange={(event) => setTemplateEditor({ ...templateEditor, subject: event.target.value })}
              value={templateEditor.subject}
            />
            <label className="field">
              <span className="field__label">Body template</span>
              <textarea
                className="field__control comms-template-editor__body"
                onChange={(event) => setTemplateEditor({ ...templateEditor, body: event.target.value })}
                value={templateEditor.body}
              />
              <span className="field__hint">
                Automatic fields: {"{{eventName}}"}, {"{{recipientName}}"}, {"{{recipientEmail}}"}. Any other {"{{field}}"} becomes a required preview value.
              </span>
            </label>
            <Button disabled={busy} onClick={() => void saveTemplate()} tone="signal">
              {templateEditor.key === null ? "Create template" : "Save template"}
            </Button>
          </div>
        )}
      </section>

      <section className="workspace-section" aria-label="Message review queue">
        <div className="section-heading"><div><p className="section-label">REVIEW BEFORE SENDING</p><h2>{drafts.length} drafted message{drafts.length === 1 ? "" : "s"}</h2></div></div>
        {drafts.length === 0
          ? <p className="quiet-copy">No messages waiting for review.</p>
          : (
            <div className="comms-draft-list">
              {drafts.map((draft) => {
                const edit = edits[draft.id] ?? { subject: draft.subject, body: draft.body };
                return (
                  <article className="comms-draft" key={draft.id}>
                    <p><strong>{draft.recipients.map((recipient) => recipient.name ?? recipient.email).join(", ")}</strong></p>
                    <p className="quiet-copy">{draft.recipients.map((recipient) => recipient.email).join(", ")}</p>
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
        <div className="section-heading">
          <div><p className="section-label">PREVIEW → QUEUE</p><h2>Build the message</h2></div>
          {activeTemplate?.editable
            ? (
              <div className="comms-template-actions">
                <Button disabled={busy} onClick={() => startTemplateEditor(activeTemplate)} tone="quiet">Edit template</Button>
                <Button disabled={busy} onClick={() => void removeTemplate(activeTemplate)} tone="quiet">Remove template</Button>
              </div>
            )
            : null}
        </div>
        <div className="comms-preview">
          <label className="field">
            <span className="field__label">Template</span>
            <select
              className="field__control"
              onChange={(event) => {
                setPreviewKey(event.target.value);
                setPreviewFields({});
                setPreviewResult(null);
                setTemplateEditor(null);
              }}
              value={previewKey}
            >
              {templates.map((template) => (
                <option key={template.key} value={template.key}>
                  {template.name}{template.editable ? " — event template" : " — built-in"}
                </option>
              ))}
            </select>
          </label>
          {activeTemplate === undefined ? null : (
            <p className="comms-template-kind">
              {activeTemplate.editable ? "Event template · editable" : "Greenroom built-in · read-only"}
            </p>
          )}
          <fieldset className="comms-recipient-picker">
            <legend>Recipients</legend>
            {recipients.length === 0 ? <p className="quiet-copy">No event speakers have an email address.</p> : recipients.map((recipient) => (
              <label key={recipient.id}>
                <input
                  aria-label={`${recipient.name} <${recipient.email}>`}
                  checked={selectedRecipientIds.includes(recipient.id)}
                  onChange={() => toggleRecipient(recipient.id)}
                  type="checkbox"
                />
                <span><strong>{recipient.name}</strong><small>{recipient.email}</small></span>
              </label>
            ))}
          </fieldset>
          {manualMergeFields.map((field) => (
            <TextField
              key={field}
              label={field}
              onChange={(event) => {
                setPreviewFields({ ...previewFields, [field]: event.target.value });
                setPreviewResult(null);
              }}
              value={previewFields[field] ?? ""}
            />
          ))}
          <Button disabled={busy} onClick={() => void runPreview()}>Render preview</Button>
          {previewResult === null ? null : (
            <article className="comms-preview__result">
              <h3>{previewResult.subject}</h3>
              <p>{previewResult.text}</p>
              <Button disabled={busy} onClick={() => void queuePreview()} tone="signal">
                Queue {selectedRecipientIds.length} draft{selectedRecipientIds.length === 1 ? "" : "s"}
              </Button>
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
              { key: "outcome", label: "Detail", render: (row) => row.status === "sent" ? row.sentAt ?? "" : row.failureReason ?? "" },
            ]}
            rows={sentLog}
          />
        </section>
      )}
      <Toast message={message} />
    </>
  );
}
