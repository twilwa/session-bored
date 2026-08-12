// ABOUTME: Manages the agenda's event rooms and tracks in a bounded organizer modal.
// ABOUTME: Uses collapsed resource rows and explains reference-safe removal in organizer terms.
import { useState, type FormEvent } from "react";
import type { AgendaSession, AgendaState } from "../../../shared/api.ts";
import { Button, EmptyState, Modal, TextField } from "../../components/ui.tsx";

const eventId = "evt_devflow_conf_2027";
type ResourceKind = "room" | "track";
type AgendaResource = { id: string; name: string };

interface EditorState {
  kind: ResourceKind;
  resource: AgendaResource | null;
}

interface RemovalState {
  kind: ResourceKind;
  resource: AgendaResource;
}

async function resourceRequest<T>(path: string, init: RequestInit): Promise<T | null> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && init.body !== null) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...init, credentials: "same-origin", headers });
  const payload = response.status === 204
    ? null
    : await response.json<{ error?: string; message?: string } & T>().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.message ?? payload?.error?.replaceAll("_", " ") ?? `Request failed (${response.status})`);
  }
  return payload;
}

function resourcePath(kind: ResourceKind, resourceId?: string): string {
  const collection = kind === "room" ? "rooms" : "tracks";
  return `/api/events/${eventId}/${collection}${resourceId === undefined ? "" : `/${resourceId}`}`;
}

function sessionUseCount(kind: ResourceKind, resourceId: string, sessions: AgendaSession[]): number {
  return sessions.filter((session) =>
    kind === "room" ? session.room?.id === resourceId : session.track?.id === resourceId
  ).length;
}

export function AgendaResourceManager({
  rooms,
  tracks,
  sessions,
  onChanged,
}: {
  rooms: AgendaState["rooms"];
  tracks: AgendaState["tracks"];
  sessions: AgendaSession[];
  onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [removal, setRemoval] = useState<RemovalState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close(): void {
    setOpen(false);
    setExpanded(null);
    setEditor(null);
    setRemoval(null);
    setError(null);
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (editor === null) return;
    setBusy(true);
    setError(null);
    const data = new FormData(event.currentTarget);
    const name = String(data.get("name") ?? "");
    try {
      const resource = await resourceRequest<AgendaResource>(
        resourcePath(editor.kind, editor.resource?.id),
        {
          method: editor.resource === null ? "POST" : "PATCH",
          body: JSON.stringify({ name }),
        },
      );
      await onChanged();
      const savedId = resource?.id ?? editor.resource?.id;
      setExpanded(savedId === undefined ? null : `${editor.kind}:${savedId}`);
      setEditor(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "This record could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    if (removal === null) return;
    setBusy(true);
    setError(null);
    try {
      await resourceRequest(resourcePath(removal.kind, removal.resource.id), { method: "DELETE" });
      await onChanged();
      setExpanded(null);
      setRemoval(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "This record could not be removed.");
    } finally {
      setBusy(false);
    }
  }

  function resourceList(kind: ResourceKind, resources: AgendaResource[]) {
    const label = kind === "room" ? "room" : "track";
    return (
      <section aria-labelledby={`agenda-${label}-settings`} className="agenda-resource-section">
        <div className="agenda-resource-section__heading">
          <div>
            <p className="section-label">{label === "room" ? "AGENDA GRID" : "CFP ROUTING"}</p>
            <h3 id={`agenda-${label}-settings`}>{label === "room" ? "Rooms" : "Tracks"}</h3>
          </div>
          <Button onClick={() => { setEditor({ kind, resource: null }); setError(null); }} tone="signal" type="button">
            Add {label}
          </Button>
        </div>
        {resources.length === 0 ? (
          <EmptyState
            description={label === "room" ? "Add a room before placing sessions." : "Add a track before routing proposals."}
            title={`No ${label}s yet`}
          />
        ) : (
          <div className="agenda-resource-list">
            {resources.map((resource) => {
              const expandedResource = expanded === `${kind}:${resource.id}`;
              const useCount = sessionUseCount(kind, resource.id, sessions);
              return (
                <article className="agenda-resource-row" key={resource.id}>
                  <div className="agenda-resource-row__summary">
                    <button
                      aria-expanded={expandedResource}
                      aria-label={`${expandedResource ? "Hide" : "Show"} details for ${resource.name}`}
                      className="disclosure-control"
                      onClick={() => setExpanded(expandedResource ? null : `${kind}:${resource.id}`)}
                      type="button"
                    >{expandedResource ? "⌄" : ">"}</button>
                    <strong>{resource.name}</strong>
                    <small>{useCount} agenda {useCount === 1 ? "session" : "sessions"}</small>
                  </div>
                  {expandedResource ? (
                    <div className="agenda-resource-row__details">
                      <p>{kind === "room"
                        ? "Assigned sessions must move to another room or TBD before this room can be removed."
                        : "This track is offered on the CFP. Proposals, sessions, and reviewer remits must be reassigned before removal."}</p>
                      <div>
                        <Button aria-label={`Edit ${resource.name}`} onClick={() => { setEditor({ kind, resource }); setError(null); }} tone="quiet" type="button">Edit</Button>
                        <Button aria-label={`Remove ${resource.name}`} className="button--danger" onClick={() => { setRemoval({ kind, resource }); setError(null); }} tone="quiet" type="button">Remove</Button>
                      </div>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </section>
    );
  }

  const editorLabel = editor?.kind === "room" ? "room" : "track";
  const removalLabel = removal?.kind === "room" ? "room" : "track";
  return (
    <>
      <Button className="agenda-resource-trigger" onClick={() => setOpen(true)} tone="quiet" type="button">
        Manage rooms and tracks
      </Button>
      <Modal onClose={close} open={open} title="Rooms and tracks">
        {editor !== null ? (
          <form className="agenda-resource-editor" onSubmit={(event) => void save(event)}>
            <div><p className="section-label">{editor.resource === null ? "CREATE" : "RENAME"}</p><h3>{editor.resource === null ? `Add a ${editorLabel}` : `Edit ${editor.resource.name}`}</h3></div>
            <TextField autoFocus defaultValue={editor.resource?.name ?? ""} label={`${editorLabel === "room" ? "Room" : "Track"} name`} name="name" required />
            {error === null ? null : <p className="form-error" role="alert">{error}</p>}
            <div className="modal-actions">
              <Button onClick={() => { setEditor(null); setError(null); }} tone="quiet" type="button">Back</Button>
              <Button disabled={busy} type="submit">{busy ? "Saving…" : editor.resource === null ? `Create ${editorLabel}` : `Save ${editorLabel}`}</Button>
            </div>
          </form>
        ) : removal !== null ? (
          <section className="agenda-resource-removal">
            <div><p className="section-label">REFERENCE CHECK</p><h3>Remove {removal.resource.name}?</h3></div>
            <p>{removal.kind === "room"
              ? "Removing an unused room removes it from the agenda grid. Sessions assigned to it will block removal."
              : "Removing an unused track removes it from the agenda and stops offering it on the CFP. Proposals, program sessions, and reviewer remits using it will block removal."}</p>
            {error === null ? null : <p className="form-error" role="alert">{error}</p>}
            <div className="modal-actions">
              <Button onClick={() => { setRemoval(null); setError(null); }} tone="quiet" type="button">Back</Button>
              <Button className="button--danger" disabled={busy} onClick={() => void remove()} type="button">{busy ? "Checking…" : `Remove ${removalLabel}`}</Button>
            </div>
          </section>
        ) : (
          <div className="agenda-resource-manager">
            <p>Rooms shape the agenda grid. Tracks route the CFP and organize sessions across the workspace.</p>
            {resourceList("room", rooms)}
            {resourceList("track", tracks)}
          </div>
        )}
      </Modal>
    </>
  );
}
