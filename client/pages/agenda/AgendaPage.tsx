// ABOUTME: Renders the organizer run-of-show with persistent drag-and-drop session placement.
// ABOUTME: Keeps live slot math, conflicts, fallback controls, five views, and publishing visible.
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import type { AgendaPlacement, AgendaSession, AgendaState } from "../../../shared/api.ts";
import { Button, LoadingState, SelectField, StatusChip, Toast } from "../../components/ui.tsx";
import "./agenda.css";

const eventId = "evt_devflow_conf_2027";
const views = ["list", "day", "week", "track", "room"] as const;
type AgendaView = (typeof views)[number];

const timeSlots = Array.from({ length: 21 }, (_, index) => {
  const minutes = 8 * 60 + index * 30;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
});

async function agendaRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  if (!response.ok) {
    const payload = await response.json<{ error?: string }>().catch(() => ({ error: undefined }));
    throw new Error(payload.error?.replaceAll("_", " ") ?? `Request failed (${response.status})`);
  }
  return response.json<T>();
}

function dayLabel(day: string, long = false): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: long ? "long" : "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${day}T12:00:00Z`));
}

function timeLabel(time: string): string {
  const [hours = 0, minutes = 0] = time.split(":").map(Number);
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" })
    .format(new Date(Date.UTC(2027, 0, 1, hours, minutes)));
}

function sessionTime(session: AgendaSession, timezone: string): string {
  if (session.startsAt === null || session.endsAt === null) return "Time TBD";
  const formatter = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  });
  return `${formatter.format(session.startsAt)}–${formatter.format(session.endsAt)}`;
}

function sessionTimeValue(session: AgendaSession, timezone: string): string | null {
  if (session.startsAt === null) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: timezone,
  }).formatToParts(session.startsAt);
  const hour = parts.find((part) => part.type === "hour")?.value;
  const minute = parts.find((part) => part.type === "minute")?.value;
  return hour === undefined || minute === undefined ? null : `${hour}:${minute}`;
}

function zonedEpoch(day: string, time: string, timezone: string): number {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  const [hour = 0, minute = 0] = time.split(":").map(Number);
  const target = Date.UTC(year, month - 1, date, hour, minute);
  let guess = target;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parts = new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: timezone,
    }).formatToParts(guess);
    const value = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((part) => part.type === type)?.value ?? 0);
    const observed = Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"));
    guess += target - observed;
  }
  return guess;
}

function SessionCard({
  session,
  timezone,
  dragging,
  onDragStart,
  onDragEnd,
  onSelect,
}: {
  session: AgendaSession;
  timezone: string;
  dragging: boolean;
  onDragStart: (event: DragEvent<HTMLElement>, sessionId: string) => void;
  onDragEnd: () => void;
  onSelect: (sessionId: string) => void;
}) {
  return (
    <article
      className={`agenda-session-card${dragging ? " agenda-session-card--dragging" : ""}`}
      data-session-id={session.id}
      data-testid={`session-card-${session.id}`}
      draggable
      onDragEnd={onDragEnd}
      onDragStart={(event) => onDragStart(event, session.id)}
    >
      <button aria-label={`Edit placement for ${session.title}`} className="agenda-session-card__edit" onClick={() => onSelect(session.id)} type="button">↗</button>
      <span className="agenda-session-card__track" style={{ borderColor: session.track?.color ?? undefined }}>
        {session.track?.name ?? "Track TBD"}
      </span>
      <h3>{session.title}</h3>
      <p>{session.scheduleStatus === "unplaced" ? "Not on a day yet" : sessionTime(session, timezone)}</p>
      <small>{session.room?.name ?? (session.scheduleStatus === "tbd" ? "Day set · room TBD" : "Room TBD")} · {session.durationMinutes}m</small>
      <div className="agenda-session-card__speakers">{session.speakers.map((speaker) => <span key={speaker.id}>{speaker.name}</span>)}</div>
    </article>
  );
}

export function AgendaPage() {
  const [agenda, setAgenda] = useState<AgendaState | null>(null);
  const [activeView, setActiveView] = useState<AgendaView>("day");
  const [activeDay, setActiveDay] = useState("");
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [selectedRoomId, setSelectedRoomId] = useState("");
  const [selectedTime, setSelectedTime] = useState("09:00");
  const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null);
  const draggingSessionIdRef = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    agendaRequest<AgendaState>(`/api/events/${eventId}/agenda`)
      .then((data) => {
        setAgenda(data);
        setActiveDay((current) => data.days.includes(current) ? current : (data.days[0] ?? ""));
        setSelectedSessionId((current) => data.sessions.some((session) => session.id === current) ? current : (data.sessions[0]?.id ?? ""));
        setSelectedRoomId((current) => data.rooms.some((room) => room.id === current) ? current : (data.rooms[0]?.id ?? ""));
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Agenda could not be loaded."));
  }, []);

  const sessionsById = useMemo<Map<string, AgendaSession>>(
    () => new Map(agenda?.sessions.map((session) => [session.id, session]) ?? []),
    [agenda],
  );
  const unscheduled = agenda?.sessions.filter((session) => session.scheduleStatus !== "placed") ?? [];
  const placed = agenda?.sessions.filter((session) => session.scheduleStatus === "placed") ?? [];

  function startDrag(event: DragEvent<HTMLElement>, sessionId: string): void {
    draggingSessionIdRef.current = sessionId;
    event.dataTransfer.setData("application/x-greenroom-session", sessionId);
    event.dataTransfer.setData("text/plain", sessionId);
    event.dataTransfer.effectAllowed = "move";
    setDraggingSessionId(sessionId);
  }

  async function savePlacement(sessionId: string, placement: AgendaPlacement, confirmation: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const nextAgenda = await agendaRequest<AgendaState>(
        `/api/events/${eventId}/agenda/sessions/${sessionId}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(placement),
        },
      );
      setAgenda(nextAgenda);
      setMessage(confirmation);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Placement could not be saved.");
    } finally {
      setBusy(false);
      draggingSessionIdRef.current = null;
      setDraggingSessionId(null);
    }
  }

  function dropIntoSlot(event: DragEvent<HTMLElement>, day: string, roomId: string, time: string): void {
    event.preventDefault();
    if (agenda === null) return;
    const sessionId = draggingSessionIdRef.current ||
      event.dataTransfer.getData("application/x-greenroom-session") ||
      draggingSessionId || event.dataTransfer.getData("text/plain");
    if (sessionId === null || !sessionsById.has(sessionId)) return;
    void savePlacement(sessionId, {
      scheduleStatus: "placed",
      scheduledDate: day,
      roomId,
      startsAt: zonedEpoch(day, time, agenda.event.timezone),
    }, `${sessionsById.get(sessionId)?.title ?? "Session"} placed at ${timeLabel(time)}.`);
  }

  function dropIntoDay(event: DragEvent<HTMLElement>, day: string): void {
    event.preventDefault();
    const sessionId = draggingSessionIdRef.current ||
      event.dataTransfer.getData("application/x-greenroom-session") ||
      draggingSessionId || event.dataTransfer.getData("text/plain");
    if (sessionId === null || !sessionsById.has(sessionId)) return;
    void savePlacement(sessionId, { scheduleStatus: "tbd", scheduledDate: day }, `${sessionsById.get(sessionId)?.title ?? "Session"} moved to ${dayLabel(day)} · TBD.`);
  }

  async function publish(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await agendaRequest<{ message: string }>(`/api/events/${eventId}/agenda/publish`, { method: "POST" });
      const refreshed = await agendaRequest<AgendaState>(`/api/events/${eventId}/agenda`);
      setAgenda(refreshed);
      setMessage(result.message);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Agenda could not be published.");
    } finally {
      setBusy(false);
    }
  }

  function useSelection(): void {
    if (agenda === null || selectedSessionId === "" || selectedRoomId === "") return;
    void savePlacement(selectedSessionId, {
      scheduleStatus: "placed",
      scheduledDate: activeDay,
      roomId: selectedRoomId,
      startsAt: zonedEpoch(activeDay, selectedTime, agenda.event.timezone),
    }, `${sessionsById.get(selectedSessionId)?.title ?? "Session"} placed.`);
  }

  if (agenda === null) {
    return (
      <section className="agenda-page">
        {error === null ? <LoadingState label="Loading agenda builder" /> : <p role="alert">{error}</p>}
      </section>
    );
  }

  const renderCard = (session: AgendaSession) => (
    <SessionCard
      dragging={draggingSessionId === session.id}
      key={session.id}
      onDragEnd={() => {
        draggingSessionIdRef.current = null;
        setDraggingSessionId(null);
      }}
      onDragStart={startDrag}
      onSelect={(sessionId) => {
        setSelectedSessionId(sessionId);
        const selected = sessionsById.get(sessionId);
        if (selected?.scheduledDate !== null && selected?.scheduledDate !== undefined) setActiveDay(selected.scheduledDate);
        if (selected?.room !== null && selected?.room !== undefined) setSelectedRoomId(selected.room.id);
        const time = selected === undefined ? null : sessionTimeValue(selected, agenda.event.timezone);
        if (time !== null && timeSlots.includes(time)) setSelectedTime(time);
      }}
      session={session}
      timezone={agenda.event.timezone}
    />
  );

  return (
    <section className="agenda-page">
      <header className="agenda-masthead">
        <div>
          <p className="eyebrow">RUN OF SHOW / LIVE EDIT</p>
          <h1>Build the room<br /><em>before they arrive.</em></h1>
          <p>Drag accepted sessions into the grid. Conflicts stay visible, never in your way.</p>
        </div>
        <div className="agenda-publish">
          <span>Public programme</span>
          <strong>{agenda.sessions.filter((session) => session.publishedAt !== null).length}/{agenda.sessions.length} current</strong>
          <Button disabled={busy} onClick={() => void publish()} tone="signal">{busy ? "Saving…" : "Publish agenda ↗"}</Button>
        </div>
      </header>

      <div className="agenda-commandbar">
        <div aria-label="Live slot math" className="agenda-slot-math">
          <strong>{agenda.metrics.unplaced}</strong> unplaced <i>·</i>
          {" "}<strong>{agenda.metrics.conflicts}</strong> conflicts <i>·</i>
          {" "}
          <strong>{agenda.metrics.tbd}</strong> TBD
        </div>
        <div aria-label="Agenda views" className="agenda-view-tabs" role="tablist">
          {views.map((view) => (
            <button aria-selected={activeView === view} className={activeView === view ? "active" : ""} key={view} onClick={() => setActiveView(view)} role="tab" type="button">
              {view}
            </button>
          ))}
        </div>
      </div>

      {error === null ? null : <p className="agenda-error" role="alert">{error}</p>}

      {agenda.conflicts.length === 0 ? null : (
        <section aria-label="Schedule conflicts" className="agenda-conflicts">
          <div className="agenda-conflicts__label"><span>!</span><strong>Clashes on the board</strong><small>Warnings only · your move was saved</small></div>
          <div className="agenda-conflicts__list">
            {agenda.conflicts.map((conflict) => {
              const fixSession = sessionsById.get(conflict.fixSessionId);
              return (
                <article className="agenda-conflict-chip" key={conflict.id}>
                  <span>{conflict.kind}</span>
                  <strong>{conflict.label}</strong>
                  <button
                    disabled={busy || fixSession === undefined}
                    onClick={() => fixSession === undefined ? undefined : void savePlacement(
                      fixSession.id,
                      { scheduleStatus: "tbd", scheduledDate: fixSession.scheduledDate ?? activeDay },
                      `${fixSession.title} moved to TBD. Conflict cleared.`,
                    )}
                    type="button"
                  >{conflict.fixLabel} →</button>
                </article>
              );
            })}
          </div>
        </section>
      )}

      {agenda.sessions.length === 0 ? (
        <section className="agenda-empty">
          <span>00</span><h2>No accepted sessions yet.</h2><p>Accept a proposal in disposition and it will arrive here ready to place.</p><a href="/organizer/disposition">Open disposition →</a>
        </section>
      ) : (
        <>
          <section aria-label="Placement controls" className="agenda-placement-console">
            <div><p className="section-label">PLACEMENT CONSOLE</p><strong>Keyboard-safe fallback</strong><small>Choose a session, or tap ↗ on any card.</small></div>
            <SelectField label="Session" onChange={(event) => setSelectedSessionId(event.target.value)} value={selectedSessionId}>
              {agenda.sessions.map((session) => <option key={session.id} value={session.id}>{session.title}</option>)}
            </SelectField>
            <SelectField label="Day" onChange={(event) => setActiveDay(event.target.value)} value={activeDay}>
              {agenda.days.map((day) => <option key={day} value={day}>{dayLabel(day, true)}</option>)}
            </SelectField>
            <SelectField label="Time" onChange={(event) => setSelectedTime(event.target.value)} value={selectedTime}>
              {timeSlots.map((time) => <option key={time} value={time}>{timeLabel(time)}</option>)}
            </SelectField>
            <SelectField label="Room" onChange={(event) => setSelectedRoomId(event.target.value)} value={selectedRoomId}>
              {agenda.rooms.map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}
            </SelectField>
            <div className="agenda-placement-console__actions">
              <Button disabled={busy} onClick={useSelection}>Place</Button>
              <Button disabled={busy} onClick={() => void savePlacement(selectedSessionId, { scheduleStatus: "tbd", scheduledDate: activeDay }, "Session moved to TBD.")} tone="quiet">TBD</Button>
              <Button disabled={busy} onClick={() => void savePlacement(selectedSessionId, { scheduleStatus: "unplaced" }, "Session returned to the unplaced queue.")} tone="quiet">Unplace</Button>
            </div>
          </section>

          <div className="agenda-workbench">
            <aside className="agenda-tray">
              <div className="agenda-tray__heading"><span>INBOX</span><strong>Drag to place</strong><small>{unscheduled.length} waiting / TBD</small></div>
              <div className="agenda-tray__cards">{unscheduled.length === 0 ? <p>Everything has a room and time.</p> : unscheduled.map(renderCard)}</div>
            </aside>

            <main className="agenda-board">
              {activeView === "day" ? (
                <>
                  <nav aria-label="Agenda days" className="agenda-days">
                    {agenda.days.map((day, index) => <button className={activeDay === day ? "active" : ""} key={day} onClick={() => setActiveDay(day)} type="button"><span>0{index + 1}</span><strong>{dayLabel(day, true)}</strong><small>{day}</small></button>)}
                  </nav>
                  <div className="agenda-day-grid" style={{ gridTemplateColumns: `82px repeat(${agenda.rooms.length}, minmax(180px, 1fr))` }}>
                    <div className="agenda-grid-corner">PT</div>
                    {agenda.rooms.map((room) => <div className="agenda-room-heading" key={room.id}><strong>{room.name}</strong><small>{placed.filter((session) => session.scheduledDate === activeDay && session.room?.id === room.id).length} sessions</small></div>)}
                    {timeSlots.map((time) => [
                      <div className="agenda-time" key={`time-${time}`}>{timeLabel(time)}</div>,
                      ...agenda.rooms.map((room) => {
                        const slotSessions = placed.filter((session) => session.scheduledDate === activeDay && session.room?.id === room.id && sessionTimeValue(session, agenda.event.timezone) === time);
                        return (
                          <div
                            className={`agenda-drop-slot${draggingSessionId === null ? "" : " agenda-drop-slot--ready"}`}
                            data-testid={`agenda-slot-${activeDay}-${room.id}-${time}`}
                            key={`${room.id}-${time}`}
                            onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }}
                            onDrop={(event) => dropIntoSlot(event, activeDay, room.id, time)}
                          >{slotSessions.map(renderCard)}</div>
                        );
                      }),
                    ])}
                  </div>
                </>
              ) : null}

              {activeView === "week" ? (
                <div className="agenda-column-view agenda-column-view--days">
                  {agenda.days.map((day) => (
                    <section key={day} onDragOver={(event) => event.preventDefault()} onDrop={(event) => dropIntoDay(event, day)}>
                      <header><span>{day.slice(-2)}</span><div><strong>{dayLabel(day, true)}</strong><small>Drop here for TBD</small></div></header>
                      {agenda.sessions.filter((session) => session.scheduledDate === day).map(renderCard)}
                    </section>
                  ))}
                </div>
              ) : null}

              {activeView === "track" ? (
                <div className="agenda-column-view">
                  {[...agenda.tracks, { id: "none", name: "Track TBD", color: null }].map((track) => (
                    <section key={track.id}><header><span style={{ background: track.color ?? undefined }} /><div><strong>{track.name}</strong><small>{agenda.sessions.filter((session) => session.track?.id === track.id || (track.id === "none" && session.track === null)).length} sessions</small></div></header>{agenda.sessions.filter((session) => session.track?.id === track.id || (track.id === "none" && session.track === null)).map(renderCard)}</section>
                  ))}
                </div>
              ) : null}

              {activeView === "room" ? (
                <div className="agenda-column-view">
                  {[...agenda.rooms, { id: "none", name: "Room TBD" }].map((room) => (
                    <section key={room.id}><header><span>⌂</span><div><strong>{room.name}</strong><small>{agenda.sessions.filter((session) => session.room?.id === room.id || (room.id === "none" && session.room === null)).length} sessions</small></div></header>{agenda.sessions.filter((session) => session.room?.id === room.id || (room.id === "none" && session.room === null)).map(renderCard)}</section>
                  ))}
                </div>
              ) : null}

              {activeView === "list" ? (
                <div className="agenda-list-view">
                  <table>
                    <caption>All accepted sessions</caption>
                    <thead><tr><th>Session</th><th>Day / time</th><th>Room</th><th>Track</th><th>State</th></tr></thead>
                    <tbody>{agenda.sessions.map((session) => <tr key={session.id}><td><button onClick={() => setSelectedSessionId(session.id)} type="button">{session.title}</button><small>{session.speakers.map((speaker) => speaker.name).join(", ")}</small></td><td>{session.scheduledDate === null ? "—" : dayLabel(session.scheduledDate)}<small>{sessionTime(session, agenda.event.timezone)}</small></td><td>{session.room?.name ?? "TBD"}</td><td>{session.track?.name ?? "TBD"}</td><td><StatusChip tone={session.scheduleStatus === "placed" ? "good" : session.scheduleStatus === "tbd" ? "signal" : "neutral"}>{session.scheduleStatus}</StatusChip></td></tr>)}</tbody>
                  </table>
                </div>
              ) : null}
            </main>
          </div>
        </>
      )}
      <Toast message={message} />
    </section>
  );
}
