// ABOUTME: Gives the program team the proposal's participant list with add, amend, and remove.
// ABOUTME: Shows whether each participant has already been carried onto the accepted session.
import { useEffect, useState, type FormEvent } from "react";
import type { ParticipantRemovalOutcome, SubmissionParticipantsPayload } from "../../../shared/api.ts";
import { PendingPublicationNotice } from "../../components/PendingPublicationNotice.tsx";
import { Button } from "../../components/ui.tsx";
import { reviewRequest } from "./reviewClient.tsx";

const emptyDraft = { name: "", email: "", roleLabel: "" };

/**
 * Says what the removal did and, just as plainly, what it left standing. Removal is scoped to
 * the proposal by design: it never withdraws the event speaker, so the organizer is told that
 * outright and pointed at the roster, which is where withdrawing from the event happens.
 *
 * What it says was taken is only what this person actually held: a proposal is read-only to a
 * named participant, a session they were never carried onto was never theirs to lose, and an
 * approved session is read-only to the speakers who are on it.
 */
export function RemovalNotice(
  { removal, sessionContentStatus }: {
    removal: ParticipantRemovalOutcome;
    sessionContentStatus: SubmissionParticipantsPayload["sessionContentStatus"];
  },
) {
  const withdrawnOnboarding = removal.withdrawnOnboarding.length === 0
    ? <p>No onboarding work was withdrawn.</p>
    : (
      <>
        <p>They no longer owe this onboarding work:</p>
        <ul>
          {removal.withdrawnOnboarding.map((task) => <li key={task.taskId}>{task.title}</li>)}
        </ul>
        <p>Naming them on this proposal again restores this work and its history.</p>
      </>
    );
  if (!removal.remainsEventSpeaker) {
    return (
      <section aria-label="What removing this participant did" className="participants__removal" role="status">
        <strong>{removal.name} is no longer on this proposal</strong>
        <p>They lost access to it, and they hold no live speaker record at this event.</p>
        {withdrawnOnboarding}
      </section>
    );
  }
  const standing = [
    "on the event roster",
    removal.listedPublicly ? "listed in the public speaker directory" : null,
    "selectable as a recipient in Communications",
    removal.speaksElsewhereAtEvent ? "still on the programme for their other sessions here" : null,
  ].filter((entry): entry is string => entry !== null);
  const lost = !removal.heldSessionAccess
    ? "They lost read access to it."
    : sessionContentStatus === "approved"
    ? "They lost read access to it, and the read-only access they had to its approved session."
    : "They lost read access to it, and the read and write access they had to its session.";
  return (
    <section aria-label="What removing this participant did" className="participants__removal" role="status">
      <strong>{removal.name} is no longer on this proposal</strong>
      <p>
        {lost} They are still a speaker at this event:{" "}
        {standing.join(", ")}. Removing a participant here never withdraws them from the event.
      </p>
      {withdrawnOnboarding}
      <p>
        To take them off the event entirely, remove them on the{" "}
        <a href="/organizer/roster">roster</a>.
      </p>
    </section>
  );
}

export function SubmissionParticipants({
  eventId,
  submissionId,
}: {
  eventId: string;
  submissionId: string;
}) {
  const [payload, setPayload] = useState<SubmissionParticipantsPayload | null>(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = `/api/events/${eventId}/submissions/${submissionId}/participants`;

  useEffect(() => {
    setPayload(null);
    setError(null);
    setAdding(false);
    setDraft(emptyDraft);
    reviewRequest<SubmissionParticipantsPayload>(path)
      .then(setPayload)
      .catch((loadError: unknown) =>
        setError(loadError instanceof Error ? loadError.message : "Participants could not be loaded.")
      );
  }, [path]);

  async function write(request: () => Promise<SubmissionParticipantsPayload>): Promise<void> {
    setError(null);
    try {
      setPayload(await request());
    } catch (writeError: unknown) {
      setError(writeError instanceof Error ? writeError.message : "The participant list could not be changed.");
    }
  }

  async function addParticipant(event: FormEvent): Promise<void> {
    event.preventDefault();
    await write(async () => {
      const next = await reviewRequest<SubmissionParticipantsPayload>(path, {
        method: "POST",
        body: JSON.stringify(draft),
      });
      setDraft(emptyDraft);
      setAdding(false);
      return next;
    });
  }

  if (payload === null) {
    return (
      <div className="participants">
        <p>{error ?? "Loading participants…"}</p>
      </div>
    );
  }

  return (
    <div className="participants">
      {payload.participants.map((participant) => (
        <div className="participant" key={participant.id}>
          <strong>{participant.name}</strong>
          <label className="participant__role">
            <span>Role</span>
            <input
              defaultValue={participant.roleLabel}
              onBlur={(event) => {
                const roleLabel = event.target.value.trim();
                if (roleLabel === "" || roleLabel === participant.roleLabel) {
                  return;
                }
                void write(() =>
                  reviewRequest<SubmissionParticipantsPayload>(`${path}/${participant.id}`, {
                    method: "PATCH",
                    body: JSON.stringify({ roleLabel }),
                  })
                );
              }}
            />
          </label>
          <small>{[participant.jobTitle, participant.organization].filter(Boolean).join(" · ")}</small>
          <small>{participant.email}</small>
          <div className="participant__state">
            {participant.isSubmitter ? <span>Submitter</span> : null}
            {payload.sessionId === null
              ? null
              : <span>{participant.onSession ? "On the session" : "Not on the session"}</span>}
          </div>
          {participant.publicationPending && payload.sessionId !== null && payload.sessionTitle !== null
            ? <PendingPublicationNotice sessions={[{ id: payload.sessionId, title: payload.sessionTitle }]} />
            : null}
          {participant.isSubmitter ? null : (
            <button
              className="button button--quiet"
              onClick={() =>
                void write(() =>
                  reviewRequest<SubmissionParticipantsPayload>(`${path}/${participant.id}`, { method: "DELETE" })
                )}
              type="button"
            >
              Remove
            </button>
          )}
        </div>
      ))}
      {error === null ? null : <p className="participants__error" role="alert">{error}</p>}
      {payload.removal === undefined
        ? null
        : <RemovalNotice removal={payload.removal} sessionContentStatus={payload.sessionContentStatus} />}
      {adding ? (
        <form className="participants__add" onSubmit={(event) => void addParticipant(event)}>
          {payload.sessionPublishedAt === null ? null : (
            <p className="participants__note">
              This session is already public. Their place on this session will stay private until you review and
              republish the agenda.
            </p>
          )}
          <label>
            <span>Name</span>
            <input onChange={(event) => setDraft({ ...draft, name: event.target.value })} required value={draft.name} />
          </label>
          <label>
            <span>Email</span>
            <input
              onChange={(event) => setDraft({ ...draft, email: event.target.value })}
              required
              type="email"
              value={draft.email}
            />
          </label>
          <label>
            <span>Role</span>
            <input
              onChange={(event) => setDraft({ ...draft, roleLabel: event.target.value })}
              placeholder="speaker"
              value={draft.roleLabel}
            />
          </label>
          <Button type="submit">Add participant</Button>
          <button className="button button--quiet" onClick={() => setAdding(false)} type="button">Cancel</button>
        </form>
      ) : (
        <button className="button button--quiet" onClick={() => setAdding(true)} type="button">
          Add a participant
        </button>
      )}
      {payload.sessionId === null ? null : (
        <p className="participants__note">
          This proposal is accepted. A participant added here joins the session and its onboarding work
          {payload.sessionPublishedAt === null ? "." : ", but their place on it stays off public surfaces until the agenda is republished."}
          {" "}A removed participant leaves the session and keeps their completed work, and stays a speaker
          at this event until they are removed on the roster.
        </p>
      )}
    </div>
  );
}
