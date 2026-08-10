// ABOUTME: Public schedule itinerary — chronological session list within day tabs (F-10.9).
// ABOUTME: Reuses the merged public sessions endpoint and gating; degrades gracefully with no time or room.
import { useEffect, useMemo, useState } from "react";
import { EmptyState, LoadingState } from "../../components/ui.tsx";
import type { PublicSessionCard, PublicSessionsResponse } from "../../../shared/api.ts";
import { Link, PublicHeader, getJson } from "../../lib.tsx";
import { DayTabs, SessionDetailModal } from "./ScheduleShared.tsx";
import { DEVFLOW_EVENT_ID, formatTimeRange, groupSessionsByDay, sortSessionsChronologically, truncate } from "./shared.ts";

const ABSTRACT_PREVIEW = 220;

function ItineraryCard({ session, onOpen, timezone }: { session: PublicSessionCard; onOpen: () => void; timezone: string }) {
  const abstract = session.abstract ?? "";
  const shown = abstract.length > ABSTRACT_PREVIEW ? truncate(abstract, ABSTRACT_PREVIEW) : abstract;
  return (
    <li className="itinerary-item">
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
            {session.title ?? "Untitled session"}
          </button>
        </h2>
        {shown === "" ? null : <p className="itinerary-item__abstract">{shown}</p>}
      </div>
    </li>
  );
}

export function ItineraryPage() {
  const [data, setData] = useState<PublicSessionsResponse | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [openSession, setOpenSession] = useState<PublicSessionCard | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(false);
    getJson<PublicSessionsResponse>(`/api/public/events/${DEVFLOW_EVENT_ID}/sessions`)
      .then((payload) => {
        if (!active) {
          return;
        }
        setData(payload);
        setLoading(false);
        setSelectedDay((prev) => prev ?? payload.facets.days[0] ?? null);
      })
      .catch(() => {
        if (active) {
          setError(true);
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [retryToken]);

  const facets = data?.facets ?? null;
  const timezone = facets?.event.timezone ?? "UTC";
  const { byDay, unscheduled } = useMemo(() => groupSessionsByDay(data?.items ?? []), [data]);
  const dayItems = useMemo(
    () => sortSessionsChronologically(selectedDay === null ? [] : byDay.get(selectedDay) ?? []),
    [byDay, selectedDay],
  );

  return (
    <div className="public-page">
      <PublicHeader />
      <main className="program-page program-page--list">
        <header className="program-intro">
          <p className="eyebrow">ITINERARY / {facets?.event.name ?? "DEVFLOW CONF 2027"}</p>
          <h1>Schedule</h1>
          <p>{facets?.event.venue ?? null}</p>
        </header>

        {loading ? <LoadingState label="Loading itinerary" /> : null}
        {error ? (
          <p className="program-error" role="alert">
            The itinerary could not be loaded.{" "}
            <button className="text-link" onClick={() => setRetryToken((token) => token + 1)} type="button">
              Try again
            </button>
            .
          </p>
        ) : null}

        {!loading && !error && facets ? (
          facets.days.length === 0 ? (
            <EmptyState
              description="Once sessions are scheduled, the day-by-day itinerary will appear here."
              title="Itinerary not scheduled yet"
            />
          ) : (
            <>
              <DayTabs days={facets.days} onSelect={setSelectedDay} selected={selectedDay} />

              {dayItems.length === 0 ? (
                <EmptyState
                  description="No approved sessions are placed on this day yet."
                  title="Nothing scheduled for this day"
                />
              ) : (
                <ul className="itinerary-list" aria-label={`Sessions for ${selectedDay ?? ""}`}>
                  {dayItems.map((session) => (
                    <ItineraryCard key={session.id} onOpen={() => setOpenSession(session)} session={session} timezone={timezone} />
                  ))}
                </ul>
              )}

              {unscheduled.length === 0 ? null : (
                <p className="agenda-unscheduled-note">
                  {unscheduled.length} approved session{unscheduled.length === 1 ? "" : "s"} without a scheduled day yet.{" "}
                  <Link href="/program">See the full program →</Link>
                </p>
              )}
            </>
          )
        ) : null}

        <footer className="program-foot">
          <Link className="text-link" href="/agenda">Grid view →</Link>
          <Link className="text-link" href="/program">Full program →</Link>
        </footer>
      </main>
      <SessionDetailModal onClose={() => setOpenSession(null)} session={openSession} timezone={timezone} />
    </div>
  );
}
