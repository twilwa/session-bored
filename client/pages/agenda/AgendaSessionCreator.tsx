// ABOUTME: Creates a submission-less programme session from the organizer agenda.
// ABOUTME: Returns the updated agenda to the board so creation stays inside the live SPA loop.
import { useState, type FormEvent } from "react";
import type {
  AgendaState,
  CreateAgendaSessionInput,
  CreateAgendaSessionResult,
} from "../../../shared/api.ts";
import { Button, Modal, SelectField, TextField } from "../../components/ui.tsx";
import { RequestFailure, requestJson } from "../../lib.tsx";

const eventId = "evt_devflow_conf_2027";

function failureMessage(reason: unknown): string {
  if (reason instanceof RequestFailure) {
    return reason.payload?.error?.replaceAll("_", " ") ?? `Request failed (${reason.status})`;
  }
  return reason instanceof Error ? reason.message : "The session could not be created.";
}

export function AgendaSessionCreator({
  formats,
  tracks,
  onCreated,
}: {
  formats: AgendaState["formats"];
  tracks: AgendaState["tracks"];
  onCreated: (result: CreateAgendaSessionResult) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close(): void {
    if (busy) return;
    setOpen(false);
    setError(null);
  }

  async function createSession(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const input: CreateAgendaSessionInput = {
      title: String(form.get("title") ?? ""),
      abstract: String(form.get("abstract") ?? "") || null,
      trackId: String(form.get("trackId") ?? "") || null,
      formatId: String(form.get("formatId") ?? "") || null,
    };
    try {
      const result = await requestJson<CreateAgendaSessionResult>(
        `/api/events/${eventId}/agenda/sessions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      onCreated(result);
      setOpen(false);
    } catch (reason) {
      setError(failureMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button className="agenda-session-trigger" onClick={() => setOpen(true)} tone="signal" type="button">
        Add session
      </Button>
      <Modal onClose={close} open={open} title="Add a session">
        <form className="agenda-session-form" onSubmit={(event) => void createSession(event)}>
          <p>
            Add a keynote, break, panel, or other programme item without creating a CFP submission.
            It starts as draft content in the unplaced inbox.
          </p>
          <TextField autoFocus disabled={busy} label="Session title" name="title" required />
          <label className="field" htmlFor="agenda-direct-session-abstract">
            <span className="field__label">Abstract</span>
            <textarea
              className="field__control"
              disabled={busy}
              id="agenda-direct-session-abstract"
              name="abstract"
              rows={5}
            />
          </label>
          <div className="agenda-session-form__classification">
            <SelectField disabled={busy} label="Track" name="trackId" defaultValue="">
              <option value="">No track yet</option>
              {tracks.map((track) => <option key={track.id} value={track.id}>{track.name}</option>)}
            </SelectField>
            <SelectField disabled={busy} label="Format" name="formatId" defaultValue="">
              <option value="">Standard · 30 minutes</option>
              {formats.map((format) => (
                <option key={format.id} value={format.id}>
                  {format.name}
                </option>
              ))}
            </SelectField>
          </div>
          {error === null ? null : <p className="form-error" role="alert">{error}</p>}
          <div className="modal-actions">
            <Button disabled={busy} onClick={close} tone="quiet" type="button">Cancel</Button>
            <Button disabled={busy} type="submit">{busy ? "Creating…" : "Create session"}</Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
