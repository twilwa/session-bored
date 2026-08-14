// ABOUTME: Explains that participant changes remain private until the organizer republishes.
// ABOUTME: Links proposal and roster views to the agenda's deliberate publication action.

export interface PendingPublicationSession {
  id: string;
  title: string;
  awaitingContentApproval: boolean;
}

function titlesOf(sessions: readonly PendingPublicationSession[]): string {
  return sessions.map((session) => session.title).join(", ");
}

export function PendingPublicationNotice(
  { sessions }: { sessions: readonly PendingPublicationSession[] },
) {
  if (sessions.length === 0) return null;
  const republishable = sessions.filter((session) => !session.awaitingContentApproval);
  const awaitingApproval = sessions.filter((session) => session.awaitingContentApproval);
  return (
    <section className="pending-publication" role="status">
      <strong>Pending publication</strong>
      {republishable.length === 0 ? null : (
        <p>
          The participant change for {titlesOf(republishable)} stays off every public page and embed until you
          confirm it.
        </p>
      )}
      {awaitingApproval.length === 0 ? null : (
        <p>
          {titlesOf(awaitingApproval)} {awaitingApproval.length === 1 ? "is" : "are"} off the public programme
          while the session content is unapproved. Approve the content again, then republish, to bring this
          participant back with it.
        </p>
      )}
      <a href="/organizer/agenda">Review and republish agenda →</a>
    </section>
  );
}
