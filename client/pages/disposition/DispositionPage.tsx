// ABOUTME: Lets organizers decide silently, review decision letters, and queue one deliberate batch.
// ABOUTME: Shows acceptance handoffs and flags decisions that diverge from a queued notice.
import { useEffect, useMemo, useState } from "react";
import type {
  DecisionBatchPreview,
  DecisionStatus,
  DispositionSummary,
} from "../../../shared/api.ts";
import { Button, LoadingState, StatusChip, Toast } from "../../components/ui.tsx";
import { requestJson } from "../../lib.tsx";
import "./disposition.css";

const eventId = "evt_devflow_conf_2027";
const decisionStatuses: DecisionStatus[] = ["accepted", "maybe", "declined"];
const decisionDispatchTimeoutMs = 5 * 60_000;

async function readJson<T>(path: string, init?: RequestInit, timeoutMs?: number): Promise<T> {
  try {
    return await requestJson<T>(path, init, timeoutMs);
  } catch (error) {
    if (error instanceof Error && error.message === "Request timed out. Try again.") {
      throw error;
    }
    throw new Error(`Disposition request failed (${error instanceof Error ? error.message : "unknown"}).`);
  }
}

function statusLabel(status: string): string {
  return status.replaceAll("_", " ");
}

function isDecisionStatus(status: string): status is DecisionStatus {
  return decisionStatuses.some((decision) => decision === status);
}

export function DispositionPage() {
  const [items, setItems] = useState<DispositionSummary[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkStatus, setBulkStatus] = useState<DecisionStatus>("accepted");
  const [preview, setPreview] = useState<DecisionBatchPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function load(): Promise<void> {
    const payload = await readJson<{ items: DispositionSummary[] }>(
      `/api/events/${eventId}/disposition`,
    );
    setItems(payload.items);
  }

  useEffect(() => {
    void load().catch((error: unknown) => {
      setMessage(error instanceof Error ? error.message : "Disposition could not be loaded.");
      setItems([]);
    });
  }, []);

  const selectedItems = useMemo(
    () => items?.filter((item) => selected.has(item.id)) ?? [],
    [items, selected],
  );

  function toggle(id: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function changeStatus(submissionIds: string[], status: DecisionStatus): Promise<void> {
    if (submissionIds.length === 0 || items === null) return;
    const previous = items;
    setItems(items.map((item) => submissionIds.includes(item.id) ? { ...item, status } : item));
    setBusy(true);
    try {
      await readJson(`/api/events/${eventId}/disposition`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ submissionIds, status }),
      });
      await load();
      setMessage(`${submissionIds.length} decision${submissionIds.length === 1 ? "" : "s"} saved silently.`);
    } catch (error) {
      setItems(previous);
      setMessage(error instanceof Error ? error.message : "Decision change failed.");
    } finally {
      setBusy(false);
    }
  }

  async function buildPreview(): Promise<void> {
    if (selectedItems.length === 0) return;
    setBusy(true);
    try {
      const batch = await readJson<DecisionBatchPreview>(
        `/api/events/${eventId}/decision-batches`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ submissionIds: selectedItems.map((item) => item.id) }),
        },
      );
      setPreview(batch);
      setMessage("Preview ready. Nothing has been sent or queued.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Preview could not be built.");
    } finally {
      setBusy(false);
    }
  }

  async function dispatch(): Promise<void> {
    if (preview === null) return;
    setBusy(true);
    try {
      const result = await readJson<{ queuedCount: number; skippedCount: number }>(
        `/api/events/${eventId}/decision-batches/${preview.id}/dispatch`,
        { method: "POST" },
        decisionDispatchTimeoutMs,
      );
      setPreview({ ...preview, status: "queued" });
      await load();
      setMessage(
        `${result.queuedCount} notice${result.queuedCount === 1 ? "" : "s"} queued; ${result.skippedCount} already queued. No email provider is connected.`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Batch dispatch failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header className="workspace-header disposition-header">
        <div>
          <p className="eyebrow">PROGRAM COMMITTEE / DISPOSITION</p>
          <h1>Decide quietly.<br />Tell deliberately.</h1>
          <p>Status changes never notify speakers. Letters enter the queue only from a reviewed batch.</p>
        </div>
        <StatusChip tone="signal">Email sender not connected</StatusChip>
      </header>

      <section className="disposition-rule" aria-label="Decision safety rule">
        <strong>Silent means silent.</strong>
        <span>Accept, maybe, decline, reverse, and re-accept as often as the committee needs.</span>
        <span>No status change calls a notification hook.</span>
      </section>

      <section className="workspace-section disposition-controls">
        <div>
          <p className="section-label">BULK DECISION</p>
          <strong>{selected.size} selected</strong>
        </div>
        <label className="disposition-select">
          <span>Outcome</span>
          <select onChange={(event) => setBulkStatus(event.target.value as DecisionStatus)} value={bulkStatus}>
            {decisionStatuses.map((status) => <option key={status} value={status}>{statusLabel(status)}</option>)}
          </select>
        </label>
        <Button
          aria-describedby={selected.size === 0 ? "disposition-selection-help" : undefined}
          disabled={busy || selected.size === 0}
          onClick={() => void changeStatus([...selected], bulkStatus)}
        >
          Apply silently
        </Button>
        <Button
          aria-describedby={selected.size === 0 ? "disposition-selection-help" : undefined}
          disabled={busy || selected.size === 0}
          onClick={() => void buildPreview()}
          tone="signal"
        >
          Preview decision batch
        </Button>
        {selected.size === 0 ? (
          <p className="disposition-selection-help" id="disposition-selection-help">
            Select at least one proposal to apply a decision or preview a batch.
          </p>
        ) : null}
      </section>

      {items === null ? <LoadingState label="Loading disposition table" /> : (
        <section className="workspace-section disposition-table-wrap">
          <table className="data-table disposition-table">
            <caption>Submission disposition</caption>
            <thead><tr><th>Select</th><th>Proposal</th><th>Decision</th><th>Notice</th><th>Handoff</th></tr></thead>
            <tbody>
              {items.map((item) => (
                <tr className={item.diverged ? "disposition-row--diverged" : ""} key={item.id}>
                  <td><input aria-label={`Select ${item.title ?? "proposal"}`} checked={selected.has(item.id)} onChange={() => toggle(item.id)} type="checkbox" /></td>
                  <td><strong>{item.title ?? "Untitled proposal"}</strong><small>{item.recipientName} · {item.track ?? "Track TBD"} · {item.format ?? "Format TBD"}</small></td>
                  <td>
                    <select aria-label={`Decision for ${item.title ?? "proposal"}`} disabled={busy} onChange={(event) => void changeStatus([item.id], event.target.value as DecisionStatus)} value={item.status}>
                      {isDecisionStatus(item.status) ? null : <option disabled value={item.status}>No decision ({statusLabel(item.status)})</option>}
                      {decisionStatuses.map((status) => <option key={status} value={status}>{statusLabel(status)}</option>)}
                    </select>
                  </td>
                  <td>
                    {item.notice === null ? <span className="quiet-copy">Not queued</span> : (
                      <div className="notice-state">
                        <StatusChip tone={item.diverged ? "signal" : "good"}>{item.notice.deliveryStatus}</StatusChip>
                        <small>Snapshot: {item.notice.outcome}</small>
                        {item.diverged ? <strong>Decision changed after dispatch</strong> : null}
                      </div>
                    )}
                  </td>
                  <td>
                    {item.handoff === null ? <span className="quiet-copy">Created on accept</span> : (
                      <div className="notice-state">
                        <StatusChip tone={item.handoff.active ? "good" : "neutral"}>{item.handoff.active ? "active" : "retained"}</StatusChip>
                        <code>{item.handoff.sessionId}</code>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {preview === null ? null : (
        <section className="workspace-section decision-preview" aria-label="Decision batch preview">
          <div className="section-heading">
            <div><p className="section-label">REVIEW BEFORE DISPATCH</p><h2>{preview.items.length} rendered letter{preview.items.length === 1 ? "" : "s"}</h2></div>
            <StatusChip tone={preview.status === "queued" ? "good" : "signal"}>{preview.status}</StatusChip>
          </div>
          <p className="decision-preview__warning"><strong>No email has been sent.</strong> Dispatch records each notice in Greenroom's queue. The communications lane will connect the real sender.</p>
          <div className="decision-letter-grid">
            {preview.items.map((item) => (
              <article className="decision-letter" key={item.id}>
                <p><span>TO</span>{item.recipientName} &lt;{item.recipientEmail}&gt;</p>
                <p><span>OUTCOME</span>{item.outcome}</p>
                <h3>{item.subject}</h3>
                <p>{item.body}</p>
              </article>
            ))}
          </div>
          <Button disabled={busy} onClick={() => void dispatch()} tone="signal">Dispatch to queue once</Button>
        </section>
      )}
      <Toast message={message} />
    </>
  );
}
