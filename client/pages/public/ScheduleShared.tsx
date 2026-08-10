// ABOUTME: Day-tab navigation and the session detail overlay shared by the agenda grid and itinerary.
// ABOUTME: One detail view backs both surfaces so a session reads identically everywhere (F-10.14).
import { Modal } from "../../components/ui.tsx";
import type { PublicSessionCard } from "../../../shared/api.ts";
import { formatDayLabel, formatSpeakerLine, formatTimeRange } from "./shared.ts";

export function DayTabs({
  days,
  selected,
  onSelect,
}: {
  days: string[];
  selected: string | null;
  onSelect: (day: string) => void;
}) {
  if (days.length === 0) {
    return null;
  }
  return (
    <nav aria-label="Select a day" className="day-tabs">
      {days.map((day) => (
        <button
          aria-pressed={day === selected}
          className={day === selected ? "day-tab day-tab--active" : "day-tab"}
          key={day}
          onClick={() => onSelect(day)}
          type="button"
        >
          {formatDayLabel(day)}
        </button>
      ))}
    </nav>
  );
}

export function SessionDetailModal({
  session,
  onClose,
}: {
  session: PublicSessionCard | null;
  onClose: () => void;
}) {
  return (
    <Modal onClose={onClose} open={session !== null} title={session?.title ?? "Untitled session"}>
      {session === null ? null : (
        <div className="session-detail">
          <p className="session-detail__meta">
            {[session.track, session.format].filter((value) => value !== null && value !== "").join(" · ") || "Session"}
          </p>
          <dl className="session-detail__facts">
            <div>
              <dt>When</dt>
              <dd>
                {session.scheduledDate === null ? "Schedule TBD" : formatDayLabel(session.scheduledDate)}
                {" · "}
                {formatTimeRange(session.startsAt, session.endsAt)}
              </dd>
            </div>
            <div>
              <dt>Room</dt>
              <dd>{session.room ?? "Room TBD"}</dd>
            </div>
          </dl>
          {session.abstract === null || session.abstract === "" ? null : (
            <p className="session-detail__abstract">{session.abstract}</p>
          )}
          <p className="session-detail__speakers">{formatSpeakerLine(session.speakers)}</p>
          <button className="text-link session-detail__close" onClick={onClose} type="button">
            ← Back
          </button>
        </div>
      )}
    </Modal>
  );
}
