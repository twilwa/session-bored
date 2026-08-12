// ABOUTME: Renders one public itinerary session with its device-local personal-schedule control.
// ABOUTME: Keeps browsing and personal views visually and behaviorally consistent.
import type { PublicSessionCard } from "../../../shared/api.ts";
import { formatSpeakerLine, formatTimeRange, truncate } from "./shared.ts";

const ABSTRACT_PREVIEW = 220;

export function ItinerarySessionCard({
  session,
  onOpen,
  timezone,
  saved,
  onToggleSaved,
  removeLabel = false,
}: {
  session: PublicSessionCard;
  onOpen: () => void;
  timezone: string;
  saved: boolean;
  onToggleSaved: () => void;
  removeLabel?: boolean;
}) {
  const abstract = session.abstract ?? "";
  const shown = abstract.length > ABSTRACT_PREVIEW ? truncate(abstract, ABSTRACT_PREVIEW) : abstract;
  const title = session.title ?? "Untitled session";
  const action = saved ? (removeLabel ? "Remove" : "Saved") : "Save";
  const direction = saved && removeLabel ? "from" : "to";

  return (
    <li className={saved ? "itinerary-item itinerary-item--saved" : "itinerary-item"}>
      <div className="itinerary-item__time">
        <span>{formatTimeRange(session.startsAt, session.endsAt, timezone)}</span>
        <span className="itinerary-item__room">{session.room ?? "Room TBD"}</span>
      </div>
      <div className="itinerary-item__body">
        <p className="itinerary-item__track">
          {[session.track, session.format].filter((value) => value !== null && value !== "").join(" · ") || "Session"}
        </p>
        <h2>
          <button className="itinerary-item__title" onClick={onOpen} type="button">
            {title}
          </button>
        </h2>
        {shown === "" ? null : <p className="itinerary-item__abstract">{shown}</p>}
        <p className="itinerary-item__speakers">{formatSpeakerLine(session.speakers)}</p>
      </div>
      <button
        aria-label={`${action} ${title} ${direction} my schedule`}
        aria-pressed={saved}
        className={saved ? "itinerary-item__save itinerary-item__save--active" : "itinerary-item__save"}
        onClick={onToggleSaved}
        type="button"
      >
        <span aria-hidden="true" className="itinerary-item__star">{saved ? "★" : "☆"}</span>
        <span>{action}</span>
      </button>
    </li>
  );
}
