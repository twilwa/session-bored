// ABOUTME: Explains that participant changes remain private until the organizer republishes.
// ABOUTME: Links proposal and roster views to the agenda's deliberate publication action.

export interface PendingPublicationSession {
  id: string;
  title: string;
}

export function PendingPublicationNotice(
  { sessions }: { sessions: readonly PendingPublicationSession[] },
) {
  if (sessions.length === 0) return null;
  return (
    <section className="pending-publication" role="status">
      <strong>Pending publication</strong>
      <p>
        The participant change for {sessions.map((session) => session.title).join(", ")} stays off every public
        page and embed until you confirm it.
      </p>
      <a href="/organizer/agenda">Review and republish agenda →</a>
    </section>
  );
}
