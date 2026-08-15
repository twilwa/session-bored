// ABOUTME: Explains that participant changes remain private until the organizer republishes.
// ABOUTME: Links proposal and roster views to the agenda's deliberate publication action.

export interface PendingPublicationSession {
  id: string;
  title: string;
  awaitingContentApproval: boolean;
  awaitingPlacement: boolean;
}

function titlesOf(sessions: readonly PendingPublicationSession[]): string {
  return sessions.map((session) => session.title).join(", ");
}

// A publish skips a session on either count, so a notice that names only one of them promises a
// republish that will not run. Each group names every step still standing before it can.
const blockedGroups = [
  {
    key: "content",
    matches: (session: PendingPublicationSession) =>
      session.awaitingContentApproval && !session.awaitingPlacement,
    state: "the session content is unapproved",
    remedy: "Approve the content again, then republish",
  },
  {
    key: "placement",
    matches: (session: PendingPublicationSession) =>
      session.awaitingPlacement && !session.awaitingContentApproval,
    state: "the session is off the schedule",
    remedy: "Put the session back on the schedule, then republish",
  },
  {
    key: "placement-and-content",
    matches: (session: PendingPublicationSession) =>
      session.awaitingPlacement && session.awaitingContentApproval,
    state: "the session is off the schedule and its content is unapproved",
    remedy: "Put it back on the schedule and approve the content again, then republish",
  },
] as const;

export function PendingPublicationNotice(
  { sessions }: { sessions: readonly PendingPublicationSession[] },
) {
  if (sessions.length === 0) return null;
  const republishable = sessions.filter((session) =>
    !session.awaitingContentApproval && !session.awaitingPlacement
  );
  return (
    <section className="pending-publication" role="status">
      <strong>Pending publication</strong>
      {republishable.length === 0 ? null : (
        <p>
          The participant change for {titlesOf(republishable)} stays off every public page and embed until you
          confirm it.
        </p>
      )}
      {blockedGroups.map((group) => {
        const blocked = sessions.filter(group.matches);
        if (blocked.length === 0) return null;
        return (
          <p key={group.key}>
            {titlesOf(blocked)} {blocked.length === 1 ? "is" : "are"} off the public programme while{" "}
            {group.state}. {group.remedy}, to bring this participant back with it.
          </p>
        );
      })}
      <a href="/organizer/agenda">Review and republish agenda →</a>
    </section>
  );
}
