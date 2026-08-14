// ABOUTME: Shows an anonymous attendee exactly the public sessions saved on this device.
// ABOUTME: Offers removal, calendar download, and a copyable link for the current selection.
import { useEffect, useMemo, useState } from "react";
import type { PublicSessionCard, PublicSessionsResponse } from "../../../shared/api.ts";
import { EmptyState, LoadingState, Toast } from "../../components/ui.tsx";
import { Link, PublicHeader, getJson } from "../../lib.tsx";
import { ItinerarySessionCard } from "./ItinerarySessionCard.tsx";
import { DayTabs, SessionDetailModal } from "./ScheduleShared.tsx";
import { personalScheduleSnapshotPath, usePersonalSchedule } from "./personal-schedule.ts";
import { DEVFLOW_EVENT_ID, sortSessionsChronologically } from "./shared.ts";

function copyWithSelection(value: string): boolean {
  const control = document.createElement("textarea");
  control.value = value;
  control.readOnly = true;
  control.style.position = "fixed";
  control.style.opacity = "0";
  document.body.appendChild(control);
  control.select();
  const copied = document.execCommand("copy");
  control.remove();
  return copied;
}

export function PersonalSchedulePage() {
  const [data, setData] = useState<PublicSessionsResponse | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [openSession, setOpenSession] = useState<PublicSessionCard | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const { sessionIds, storageStatus, toggleSession } = usePersonalSchedule(DEVFLOW_EVENT_ID);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(false);
    getJson<PublicSessionsResponse>(`/api/public/events/${DEVFLOW_EVENT_ID}/sessions`)
      .then((payload) => {
        if (active) {
          setData(payload);
          setLoading(false);
        }
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
  const savedItems = useMemo(
    () => sortSessionsChronologically((data?.items ?? []).filter((session) => sessionIds.includes(session.id))),
    [data, sessionIds],
  );
  const visibleItems = selectedDay === null
    ? savedItems
    : savedItems.filter((session) => session.scheduledDate === selectedDay);
  const calendarPath = personalScheduleSnapshotPath(DEVFLOW_EVENT_ID, savedItems.map((session) => session.id));
  const pickLabel = savedItems.length === 0 ? "No picks" : `${savedItems.length} pick${savedItems.length === 1 ? "" : "s"}`;
  const currentPickLabel = `${savedItems.length} current pick${savedItems.length === 1 ? "" : "s"}`;
  const storageDescription = storageStatus === "account"
    ? "Saved to your account · available on any device"
    : storageStatus === "error"
      ? "Account sync needs retry · your latest change may not be saved"
      : storageStatus === "unsaved"
        ? "Not saved yet · these picks stay on this page until the server answers"
        : storageStatus === "checking"
          ? "Checking for your account…"
          : "Saved on this device · no account needed";

  async function copyCalendarLink(): Promise<void> {
    const calendarUrl = new URL(calendarPath, window.location.origin).toString();
    try {
      await navigator.clipboard.writeText(calendarUrl);
      setMessage(`Calendar link for ${currentPickLabel} copied.`);
    } catch {
      setMessage(copyWithSelection(calendarUrl)
        ? `Calendar link for ${currentPickLabel} copied.`
        : "The calendar link could not be copied.");
    }
  }

  return (
    <div className="public-page">
      <PublicHeader />
      <main className="program-page program-page--list">
        <header className="program-intro">
          <p className="eyebrow">MY SCHEDULE / {facets?.event.name ?? "DEVFLOW CONF 2027"}</p>
          <h1>{pickLabel}</h1>
          <p>{storageDescription}</p>
        </header>

        {loading ? <LoadingState label="Loading your schedule" /> : null}
        {error ? (
          <p className="program-error" role="alert">
            Your schedule could not be loaded.{" "}
            <button className="text-link" onClick={() => setRetryToken((token) => token + 1)} type="button">
              Try again
            </button>
            .
          </p>
        ) : null}

        {!loading && !error && facets ? (
          savedItems.length === 0 ? (
            <EmptyState
              description="Star a session on any day and it will appear here."
              title="Nothing saved yet"
            />
          ) : (
            <>
              <div className="schedule-tabs">
                <DayTabs days={facets.days} onSelect={setSelectedDay} selected={selectedDay} />
                <button
                  aria-pressed={selectedDay === null}
                  className={selectedDay === null ? "my-schedule-link my-schedule-link--active" : "my-schedule-link"}
                  onClick={() => setSelectedDay(null)}
                  type="button"
                >
                  All days <span>{savedItems.length}</span>
                </button>
              </div>
              {visibleItems.length === 0 ? (
                <EmptyState description="Your saved sessions are on another day." title="No picks on this day" />
              ) : (
                <ul className="itinerary-list" aria-label="My saved sessions">
                  {visibleItems.map((session) => (
                    <ItinerarySessionCard
                      key={session.id}
                      onOpen={() => setOpenSession(session)}
                      onToggleSaved={() => toggleSession(session.id)}
                      removeLabel
                      saved
                      session={session}
                      timezone={timezone}
                    />
                  ))}
                </ul>
              )}
              <div className="personal-schedule-actions">
                <a className="button button--signal" download="my-schedule.ics" href={calendarPath}>Add to calendar (.ics)</a>
                <button className="button button--quiet" onClick={() => void copyCalendarLink()} type="button">Copy calendar link ({currentPickLabel})</button>
                <span>{savedItems.length} session{savedItems.length === 1 ? "" : "s"} · {storageDescription.toLowerCase()}</span>
              </div>
            </>
          )
        ) : null}

        <footer className="program-foot">
          <Link className="text-link" href="/schedule">← Full itinerary</Link>
          <Link className="text-link" href="/program">Full program →</Link>
        </footer>
      </main>
      <SessionDetailModal onClose={() => setOpenSession(null)} session={openSession} timezone={timezone} />
      <Toast message={message} />
    </div>
  );
}
