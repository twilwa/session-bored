// ABOUTME: Public agenda widget — per-day time x room grid built from the approved session list (F-10.6/7/8).
// ABOUTME: Reuses the merged public sessions endpoint and gating; TBD time/room render honestly, never hidden.
import { Fragment, useEffect, useMemo, useState } from "react";
import { EmptyState, LoadingState } from "../../components/ui.tsx";
import type { PublicSessionCard, PublicSessionsResponse } from "../../../shared/api.ts";
import { Link, PublicHeader, getJson } from "../../lib.tsx";
import { DayTabs, SessionDetailModal } from "./ScheduleShared.tsx";
import { DEVFLOW_EVENT_ID, agendaCellKey, buildAgendaGrid, groupSessionsByDay } from "./shared.ts";

function AgendaSessionBlock({ session, onOpen }: { session: PublicSessionCard; onOpen: () => void }) {
  return (
    <button className="agenda-grid__session" onClick={onOpen} type="button">
      <span className="agenda-grid__session-track">{session.track ?? "Track TBD"}</span>
      <span className="agenda-grid__session-title">{session.title ?? "Untitled session"}</span>
    </button>
  );
}

export function AgendaPage() {
  const [data, setData] = useState<PublicSessionsResponse | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [openSession, setOpenSession] = useState<PublicSessionCard | null>(null);

  useEffect(() => {
    let active = true;
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
  }, []);

  const facets = data?.facets ?? null;
  const { byDay, unscheduled } = useMemo(() => groupSessionsByDay(data?.items ?? []), [data]);
  const dayItems = selectedDay === null ? [] : byDay.get(selectedDay) ?? [];
  const grid = useMemo(() => buildAgendaGrid(dayItems, facets?.rooms ?? []), [dayItems, facets]);

  return (
    <div className="public-page">
      <PublicHeader />
      <main className="program-page program-page--list">
        <header className="program-intro">
          <p className="eyebrow">AGENDA / {facets?.event.name ?? "DEVFLOW CONF 2027"}</p>
          <h1>Agenda</h1>
          <p>{facets?.event.venue ?? null}</p>
        </header>

        {loading ? <LoadingState label="Loading agenda" /> : null}
        {error ? (
          <p className="program-error" role="alert">
            The agenda could not be loaded. <Link href="/agenda">Try again</Link>.
          </p>
        ) : null}

        {!loading && !error && facets ? (
          facets.days.length === 0 ? (
            <EmptyState
              description="Once sessions are scheduled, the day-by-day agenda will appear here."
              title="Agenda not scheduled yet"
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
                <>
                  <p className="agenda-grid-hint">Scroll sideways to see every room →</p>
                  <div className="agenda-grid-scroll" role="region" aria-label={`Agenda grid for ${selectedDay ?? ""}`} tabIndex={0}>
                  <div
                    className="agenda-grid"
                    style={{
                      gridTemplateColumns: `96px repeat(${grid.columns.length}, minmax(180px, 1fr))`,
                      gridTemplateRows: `44px repeat(${grid.rows.length}, auto)`,
                    }}
                  >
                    <div className="agenda-grid__corner" style={{ gridColumn: 1, gridRow: 1 }} />
                    {grid.columns.map((column, columnIndex) => (
                      <div
                        className="agenda-grid__col-header"
                        key={column.key}
                        style={{ gridColumn: columnIndex + 2, gridRow: 1 }}
                      >
                        {column.label}
                      </div>
                    ))}
                    {grid.rows.map((row, rowIndex) => (
                      <Fragment key={row.key}>
                        <div className="agenda-grid__row-header" style={{ gridColumn: 1, gridRow: rowIndex + 2 }}>
                          {row.label}
                        </div>
                        {grid.columns.map((column, columnIndex) => {
                          const cellSessions = grid.cells.get(agendaCellKey(row.key, column.key)) ?? [];
                          return (
                            <div
                              className="agenda-grid__cell"
                              key={column.key}
                              style={{ gridColumn: columnIndex + 2, gridRow: rowIndex + 2 }}
                            >
                              {cellSessions.map((session) => (
                                <AgendaSessionBlock key={session.id} onOpen={() => setOpenSession(session)} session={session} />
                              ))}
                            </div>
                          );
                        })}
                      </Fragment>
                    ))}
                  </div>
                  </div>
                </>
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
          <Link className="text-link" href="/schedule">Itinerary view →</Link>
          <Link className="text-link" href="/program">Full program →</Link>
        </footer>
      </main>
      <SessionDetailModal onClose={() => setOpenSession(null)} session={openSession} />
    </div>
  );
}
