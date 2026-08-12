// ABOUTME: Gives organizers one filterable view of requested, overdue, delivered, and approval-ready content.
// ABOUTME: Links canonical uploads and their cross-role comment threads without duplicating task or file state.
import { useEffect, useMemo, useState } from "react";
import type { DeliverablesPayload, DeliverableStatus } from "../../../shared/api.ts";
import { LoadingState, StatusChip, TextField } from "../../components/ui.tsx";
import { Link } from "../../lib.tsx";
import { FileComments } from "./FileComments.tsx";
import "./content.css";

const eventId = "evt_devflow_conf_2027";
type Filter = "all" | DeliverableStatus;

async function loadDeliverables(): Promise<DeliverablesPayload> {
  const response = await fetch(`/api/events/${eventId}/deliverables`, { credentials: "same-origin" });
  if (!response.ok) {
    throw new Error(`Deliverables could not be loaded (${response.status}).`);
  }
  return response.json<DeliverablesPayload>();
}

function formatDate(value: string | null): string {
  if (value === null) return "No due date";
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function formatFileSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${Math.round(sizeBytes / 1024)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function statusTone(status: DeliverableStatus): "neutral" | "good" | "signal" {
  if (status === "delivered") return "good";
  if (status === "overdue") return "signal";
  return "neutral";
}

export function ContentPage() {
  const [data, setData] = useState<DeliverablesPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  useEffect(() => {
    void loadDeliverables().then(setData).catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : "Deliverables could not be loaded.");
    });
  }, []);

  const visibleItems = useMemo(() => {
    if (data === null) return [];
    const normalizedQuery = query.trim().toLowerCase();
    return data.items.filter((item) => {
      if (filter !== "all" && item.status !== filter) return false;
      if (normalizedQuery.length === 0) return true;
      return [item.speaker.name, item.speaker.email, item.task.title, item.file?.displayName ?? ""]
        .some((value) => value.toLowerCase().includes(normalizedQuery));
    });
  }, [data, filter, query]);

  if (data === null) {
    return error === null ? <LoadingState label="Loading deliverables" /> : <p role="alert">{error}</p>;
  }

  const filters: Array<{ key: Filter; label: string; count: number }> = [
    { key: "all", label: "All", count: data.metrics.total },
    { key: "requested", label: "Requested", count: data.metrics.requested },
    { key: "overdue", label: "Overdue", count: data.metrics.overdue },
    { key: "delivered", label: "Delivered", count: data.metrics.delivered },
  ];

  return (
    <div className="content-page">
      <header className="workspace-header content-header">
        <div>
          <p className="eyebrow">CONTENT / DELIVERY BOARD</p>
          <h1>Know what landed. Chase what didn’t.</h1>
          <p>Every file request, speaker, deadline, upload, and comment in one working view.</p>
        </div>
        <StatusChip tone={data.metrics.overdue > 0 ? "signal" : "good"}>
          {data.metrics.overdue} overdue
        </StatusChip>
      </header>

      <section aria-label="Deliverable totals" className="content-metrics">
        {filters.slice(1).map((item) => (
          <article key={item.key}><span>{item.label}</span><strong>{item.count}</strong></article>
        ))}
        <article><span>Awaiting approval</span><strong>{data.metrics.awaitingApproval}</strong></article>
      </section>

      <section className="workspace-section content-approvals" aria-labelledby="content-approval-heading">
        <div className="section-heading">
          <div><p className="section-label">SESSION CONTENT</p><h2 id="content-approval-heading">Awaiting approval</h2></div>
          <Link className="text-link" href="/organizer/agenda">Open agenda →</Link>
        </div>
        {data.sessionsAwaitingApproval.length === 0 ? <p className="quiet-copy">No session content is waiting for approval.</p> : (
          <ul>
            {data.sessionsAwaitingApproval.map((session) => (
              <li key={session.id}>
                <div><strong>{session.title ?? "Untitled session"}</strong><span>{session.speakers.map((speaker) => speaker.name).join(" · ")}</span></div>
                <StatusChip tone="signal">In review</StatusChip>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="workspace-section" aria-labelledby="deliverable-worklist-heading">
        <div className="section-heading content-worklist-heading">
          <div><p className="section-label">FILE REQUESTS</p><h2 id="deliverable-worklist-heading">Deliverables</h2></div>
          <span>{visibleItems.length} shown</span>
        </div>
        <div className="content-controls">
          <div aria-label="Filter deliverables by status" className="content-filters" role="group">
            {filters.map((item) => (
              <button aria-pressed={filter === item.key} className={filter === item.key ? "active" : ""} key={item.key} onClick={() => setFilter(item.key)} type="button">
                {item.label} <span>{item.count}</span>
              </button>
            ))}
          </div>
          <TextField label="Search speaker, task, or file" name="deliverable-search" onChange={(event) => setQuery(event.target.value)} type="search" value={query} />
        </div>

        {visibleItems.length === 0 ? <p className="quiet-copy">No deliverables match this view.</p> : (
          <ol className="deliverable-list">
            {visibleItems.map((item) => (
              <li className={`deliverable-card deliverable-card--${item.status}`} key={item.assignmentId}>
                <div className="deliverable-card__identity">
                  <div><strong>{item.speaker.name}</strong><a href={`mailto:${item.speaker.email}`}>{item.speaker.email}</a></div>
                  <StatusChip tone={statusTone(item.status)}>{item.status}</StatusChip>
                </div>
                <div className="deliverable-card__request">
                  <div><span>Request</span><strong>{item.task.title}</strong></div>
                  <div><span>Due</span><strong>{formatDate(item.task.dueAt)}</strong></div>
                </div>
                {item.task.instructions === null ? null : <p className="deliverable-card__instructions">{item.task.instructions}</p>}
                {item.file === null ? (
                  <p className="deliverable-card__empty">
                    {item.status === "delivered" ? "Marked complete; no task file is attached." : "No uploaded file."}
                  </p>
                ) : (
                  <div className="deliverable-card__file">
                    <a href={item.file.downloadUrl}>{item.file.displayName}</a>
                    <span>Version {item.file.version} · {formatFileSize(item.file.sizeBytes)} · {new Date(item.file.uploadedAt).toLocaleString()}</span>
                    <FileComments fileId={item.file.id} />
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
