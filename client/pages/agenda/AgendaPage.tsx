// ABOUTME: Renders the organizer scheduling board: grid first, live drop feedback, clashes, undo.
// ABOUTME: Keeps placement non-blocking and every verb on the card it acts on.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from "react";
import type { AgendaConflict, AgendaPlacement, AgendaSession, AgendaState } from "../../../shared/api.ts";
import { Button, LoadingState, SelectField, StatusChip } from "../../components/ui.tsx";
import {
  nearestFreeStart,
  overlapColumns,
  placementOf,
  predictDrop,
  sessionTimeValue,
  shortTitle,
  timeSlots,
  zonedEpoch,
  type DropPrediction,
  type DropTarget,
  type OverlapColumn,
} from "./board.ts";
import "./agenda.css";

const eventId = "evt_devflow_conf_2027";
const views = ["list", "day", "week", "track", "room"] as const;
type AgendaView = (typeof views)[number];

interface CardMenu {
  sessionId: string;
  top: number;
  left: number;
}

interface BoardToast {
  message: string;
  detail: string | null;
  clashes: number;
  undo: AgendaPlacement | null;
  undoSessionId: string | null;
  publicationCleared: boolean;
}

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

function epochLabel(epoch: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: timezone })
    .format(epoch);
}

function sessionTime(session: AgendaSession, timezone: string): string {
  if (session.startsAt === null || session.endsAt === null) return "Time TBD";
  return `${epochLabel(session.startsAt, timezone)}–${epochLabel(session.endsAt, timezone)}`;
}

function menuPosition(sessionId: string, anchor: DOMRect): CardMenu {
  return {
    sessionId,
    top: Math.min(anchor.bottom + 4, window.innerHeight - 200),
    left: Math.max(8, Math.min(anchor.left - 190, window.innerWidth - 236)),
  };
}

function contentLabel(session: AgendaSession): string {
  return session.contentStatus === "approved" ? "Approved" : session.contentStatus === "in_review" ? "In review" : "Draft";
}

function SessionCard({
  session,
  timezone,
  dragging,
  conflicting,
  selected,
  column,
  menuOpen,
  onDragStart,
  onDragEnd,
  onSelect,
  onOpenMenu,
}: {
  session: AgendaSession;
  timezone: string;
  dragging: boolean;
  conflicting: boolean;
  selected: boolean;
  column: OverlapColumn | undefined;
  menuOpen: boolean;
  onDragStart: (event: DragEvent<HTMLElement>, sessionId: string) => void;
  onDragEnd: () => void;
  onSelect: (sessionId: string) => void;
  onOpenMenu: (sessionId: string, anchor: HTMLElement) => void;
}) {
  const width = column === undefined ? undefined : 100 / column.count;
  const split = column !== undefined && column.count > 1;
  return (
    <article
      aria-current={selected ? "true" : undefined}
      aria-label={conflicting ? `Schedule conflict: ${session.title}` : undefined}
      aria-roledescription="draggable session"
      className={[
        "agenda-session-card",
        session.durationMinutes < 30 ? "agenda-session-card--compact" : "",
        split ? "agenda-session-card--split" : "",
        dragging ? "agenda-session-card--dragging" : "",
        conflicting ? "agenda-session-card--conflict" : "",
        selected ? "agenda-session-card--selected" : "",
      ].filter((token) => token !== "").join(" ")}
      data-session-id={session.id}
      data-testid={`session-card-${session.id}`}
      draggable
      onClick={() => onSelect(session.id)}
      onDragEnd={onDragEnd}
      onDragStart={(event) => onDragStart(event, session.id)}
      style={{
        "--agenda-session-duration": session.durationMinutes / 30,
        left: width === undefined ? undefined : `calc(${width * (column?.index ?? 0)}% + 4px)`,
        width: width === undefined ? undefined : `calc(${width}% - ${8 / (column?.count ?? 1)}px)`,
      } as CSSProperties}
      title={`${session.title} — ${session.durationMinutes} minutes`}
    >
      <button
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        aria-label={`Actions for ${session.title}`}
        className="agenda-session-card__menu"
        onClick={(event) => {
          event.stopPropagation();
          onOpenMenu(session.id, event.currentTarget);
        }}
        type="button"
      >
        ⋯
      </button>
      <span className="agenda-session-card__track" style={{ borderColor: session.track?.color ?? undefined }}>
        {session.track?.name ?? "Track TBD"}
      </span>
      <h3>{session.title}</h3>
      <p>{session.scheduleStatus === "unplaced" ? "Not on a day yet" : sessionTime(session, timezone)}</p>
      <small>{session.room?.name ?? (session.scheduleStatus === "tbd" ? "Day set · room TBD" : "Room TBD")} · {session.durationMinutes}m</small>
      <div className="agenda-session-card__speakers">{session.speakers.map((speaker) => <span key={speaker.id}>{speaker.name}</span>)}</div>
      <div className="agenda-session-card__marks">
        {conflicting ? <span className="agenda-mark agenda-mark--clash">⚠ Clash</span> : null}
        <span className={`agenda-mark agenda-mark--${session.contentStatus}`}>{contentLabel(session)}</span>
        {session.publishedAt === null ? null : <span className="agenda-mark agenda-mark--published">● Public</span>}
      </div>
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
  const [dropTarget, setDropTarget] = useState<{ roomId: string; time: string } | null>(null);
  const [overTray, setOverTray] = useState(false);
  const [cardMenu, setCardMenu] = useState<CardMenu | null>(null);
  const [clashesOpen, setClashesOpen] = useState(true);
  const draggingSessionIdRef = useRef<string | null>(null);
  const dropTargetRef = useRef<string>("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<BoardToast | null>(null);
  const [error, setError] = useState<string | null>(null);
  const clashesRef = useRef<HTMLElement | null>(null);

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

  useEffect(() => {
    if (toast === null) return;
    const timer = setTimeout(() => setToast(null), 10_000);
    return () => clearTimeout(timer);
  }, [toast]);

  /* The menu floats above the grid's own scroll container, so it follows its card rather than
     closing the moment focus nudges that container. */
  useEffect(() => {
    if (cardMenu === null) return;
    const follow = () => {
      const card = document.querySelector(`[data-session-id="${cardMenu.sessionId}"] .agenda-session-card__menu`);
      if (card === null) { setCardMenu(null); return; }
      const box = card.getBoundingClientRect();
      const next = menuPosition(cardMenu.sessionId, box);
      setCardMenu((current) =>
        current === null || (current.top === next.top && current.left === next.left) ? current : next
      );
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setCardMenu(null); };
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
      window.removeEventListener("keydown", onKey);
    };
  }, [cardMenu]);

  const sessionsById = useMemo<Map<string, AgendaSession>>(
    () => new Map(agenda?.sessions.map((session) => [session.id, session]) ?? []),
    [agenda],
  );
  const columns = useMemo(() => overlapColumns(agenda?.sessions ?? []), [agenda]);
  const unscheduled = agenda?.sessions.filter((session) => session.scheduleStatus !== "placed") ?? [];
  const placed = agenda?.sessions.filter((session) => session.scheduleStatus === "placed") ?? [];
  const selectedSession = agenda?.sessions.find((session) => session.id === selectedSessionId) ?? null;
  const draggingSession = draggingSessionId === null ? null : sessionsById.get(draggingSessionId) ?? null;

  function startDrag(event: DragEvent<HTMLElement>, sessionId: string): void {
    draggingSessionIdRef.current = sessionId;
    event.dataTransfer.setData("application/x-greenroom-session", sessionId);
    event.dataTransfer.setData("text/plain", sessionId);
    event.dataTransfer.effectAllowed = "move";
    setCardMenu(null);
    setDraggingSessionId(sessionId);
  }

  function endDrag(): void {
    draggingSessionIdRef.current = null;
    dropTargetRef.current = "";
    setDraggingSessionId(null);
    setDropTarget(null);
    setOverTray(false);
  }

  function draggedSessionId(event: DragEvent<HTMLElement>): string | null {
    const candidate = draggingSessionIdRef.current ||
      event.dataTransfer.getData("application/x-greenroom-session") ||
      draggingSessionId || event.dataTransfer.getData("text/plain");
    return candidate === "" || candidate === null ? null : candidate;
  }

  async function savePlacement(
    sessionId: string,
    placement: AgendaPlacement,
    confirmation: string,
    options: { detail?: string | null; clashes?: number; undoable?: boolean } = {},
  ): Promise<void> {
    setBusy(true);
    setError(null);
    const currentSession = sessionsById.get(sessionId);
    const previous = currentSession === undefined ? null : placementOf(currentSession);
    const publicationWasCleared = currentSession !== undefined && currentSession.publishedAt !== null;
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
      setToast({
        message: confirmation,
        detail: options.detail ?? null,
        clashes: options.clashes ?? 0,
        undo: options.undoable === false ? null : previous,
        undoSessionId: sessionId,
        publicationCleared: publicationWasCleared,
      });
      if ((options.clashes ?? 0) > 0) setClashesOpen(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Placement could not be saved.");
    } finally {
      setBusy(false);
      endDrag();
    }
  }

  function placeSession(sessionId: string, day: string, roomId: string, time: string): void {
    if (agenda === null) return;
    const session = sessionsById.get(sessionId);
    if (session === undefined) return;
    const room = agenda.rooms.find((candidate) => candidate.id === roomId);
    const startsAt = zonedEpoch(day, time, agenda.event.timezone);
    const prediction = predictDrop(
      agenda.sessions,
      session,
      { day, roomId, roomName: room?.name ?? "Room", startsAt },
      (epoch) => epochLabel(epoch, agenda.event.timezone),
    );
    const where = `${timeLabel(time)} · ${room?.name ?? "room"}`;
    const confirmation = prediction.count === 0
      ? `${shortTitle(session.title)} placed at ${where}.`
      : `⚠ ${shortTitle(session.title)} placed at ${where} — ${prediction.count} clash${prediction.count === 1 ? "" : "es"}.`;
    void savePlacement(
      sessionId,
      { scheduleStatus: "placed", scheduledDate: day, roomId, startsAt },
      confirmation,
      { clashes: prediction.count, detail: prediction.reasons.length === 0 ? null : `${prediction.reasons.join(" · ")}.` },
    );
  }

  function undoPlacement(): void {
    if (toast === null || toast.undo === null || toast.undoSessionId === null) return;
    const session = sessionsById.get(toast.undoSessionId);
    const restored = toast.undo;
    const name = session === undefined ? "Session" : shortTitle(session.title);
    const detail = toast.publicationCleared
      ? "Publication stays cleared — publish agenda again to make it public."
      : null;
    void savePlacement(toast.undoSessionId, restored, `${name} put back.`, { detail, undoable: false });
  }

  async function approveContent(sessionId: string): Promise<void> {
    const session = sessionsById.get(sessionId);
    if (session === undefined) return;
    setBusy(true);
    setError(null);
    setCardMenu(null);
    try {
      const nextAgenda = await agendaRequest<AgendaState>(
        `/api/events/${eventId}/agenda/sessions/${sessionId}/content`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ contentStatus: "approved" }),
        },
      );
      setAgenda(nextAgenda);
      setToast({
        message: `${shortTitle(session.title)} content approved.`,
        detail: "Speaker edits are locked. Publish the agenda when its placement is ready.",
        clashes: 0,
        undo: null,
        undoSessionId: null,
        publicationCleared: false,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Session content could not be approved.");
    } finally {
      setBusy(false);
    }
  }

  async function sendCalendarInvite(sessionId: string): Promise<void> {
    const session = sessionsById.get(sessionId);
    if (session === undefined) return;
    setBusy(true);
    setError(null);
    setCardMenu(null);
    try {
      const result = await agendaRequest<{ sentCount: number; failedCount: number; sequence: number }>(
        `/api/events/${eventId}/sessions/${sessionId}/calendar-invite`,
        { method: "POST" },
      );
      setToast({
        message: `Calendar invite sent to ${result.sentCount} speaker${result.sentCount === 1 ? "" : "s"}.`,
        detail: `Calendar update ${result.sequence}.`,
        clashes: 0,
        undo: null,
        undoSessionId: null,
        publicationCleared: false,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Calendar invite could not be sent.");
    } finally {
      setBusy(false);
    }
  }

  function moveToTbd(sessionId: string): void {
    const session = sessionsById.get(sessionId);
    if (session === undefined) return;
    setCardMenu(null);
    void savePlacement(
      sessionId,
      { scheduleStatus: "tbd", scheduledDate: session.scheduledDate ?? activeDay },
      `${shortTitle(session.title)} moved to ${dayLabel(session.scheduledDate ?? activeDay)} · time and room TBD.`,
      { detail: "Session-scoped tasks pause until it is placed again." },
    );
  }

  function unplace(sessionId: string): void {
    const session = sessionsById.get(sessionId);
    if (session === undefined) return;
    setCardMenu(null);
    void savePlacement(
      sessionId,
      { scheduleStatus: "unplaced" },
      `${shortTitle(session.title)} returned to the inbox.`,
    );
  }

  function dropIntoSlot(event: DragEvent<HTMLElement>, day: string, roomId: string, time: string): void {
    event.preventDefault();
    if (agenda === null) return;
    const sessionId = draggedSessionId(event);
    if (sessionId === null || !sessionsById.has(sessionId)) { endDrag(); return; }
    placeSession(sessionId, day, roomId, time);
  }

  function dropIntoTray(event: DragEvent<HTMLElement>): void {
    event.preventDefault();
    const sessionId = draggedSessionId(event);
    if (sessionId === null || !sessionsById.has(sessionId)) { endDrag(); return; }
    if (sessionsById.get(sessionId)?.scheduleStatus === "unplaced") { endDrag(); return; }
    unplace(sessionId);
  }

  function dropIntoDay(event: DragEvent<HTMLElement>, day: string): void {
    event.preventDefault();
    const sessionId = draggedSessionId(event);
    if (sessionId === null || !sessionsById.has(sessionId)) { endDrag(); return; }
    void savePlacement(
      sessionId,
      { scheduleStatus: "tbd", scheduledDate: day },
      `${shortTitle(sessionsById.get(sessionId)?.title ?? "Session")} moved to ${dayLabel(day)} · TBD.`,
      { detail: "Its time and room were cleared — Undo puts them back." },
    );
  }

  function enterSlot(roomId: string, time: string): void {
    if (draggingSessionIdRef.current === null && draggingSessionId === null) return;
    const key = `${roomId}:${time}`;
    if (dropTargetRef.current === key) return;
    dropTargetRef.current = key;
    setDropTarget({ roomId, time });
  }

  function leaveSlot(event: DragEvent<HTMLElement>, roomId: string, time: string): void {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    if (dropTargetRef.current !== `${roomId}:${time}`) return;
    dropTargetRef.current = "";
    setDropTarget(null);
  }

  async function publish(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await agendaRequest<{ message: string }>(`/api/events/${eventId}/agenda/publish`, { method: "POST" });
      const refreshed = await agendaRequest<AgendaState>(`/api/events/${eventId}/agenda`);
      setAgenda(refreshed);
      setToast({ message: result.message, detail: null, clashes: 0, undo: null, undoSessionId: null, publicationCleared: false });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Agenda could not be published.");
    } finally {
      setBusy(false);
    }
  }

  function useSelection(): void {
    if (agenda === null || selectedSessionId === "" || selectedRoomId === "") return;
    placeSession(selectedSessionId, activeDay, selectedRoomId, selectedTime);
  }

  function selectSession(sessionId: string): void {
    setSelectedSessionId(sessionId);
    const selected = sessionsById.get(sessionId);
    if (selected?.scheduledDate !== null && selected?.scheduledDate !== undefined) setActiveDay(selected.scheduledDate);
    if (selected?.room !== null && selected?.room !== undefined) setSelectedRoomId(selected.room.id);
    const time = selected === undefined || agenda === null ? null : sessionTimeValue(selected, agenda.event.timezone);
    if (time !== null && timeSlots.includes(time)) setSelectedTime(time);
  }

  if (agenda === null) {
    return (
      <section className="agenda-page">
        {error === null ? <LoadingState label="Loading agenda builder" /> : <p role="alert">{error}</p>}
      </section>
    );
  }

  const conflicts = agenda.conflicts;
  const conflictingSessionIds = new Set(conflicts.flatMap((conflict) => conflict.sessionIds));
  const timezone = agenda.event.timezone;
  const dayStarts = timeSlots.map((time) => zonedEpoch(activeDay, time, timezone));

  const prediction: DropPrediction | null = draggingSession === null || dropTarget === null ? null : predictDrop(
    agenda.sessions,
    draggingSession,
    {
      day: activeDay,
      roomId: dropTarget.roomId,
      roomName: agenda.rooms.find((room) => room.id === dropTarget.roomId)?.name ?? "Room",
      startsAt: zonedEpoch(activeDay, dropTarget.time, timezone),
    },
    (epoch) => epochLabel(epoch, timezone),
  );

  const freeSlotFix = (conflict: AgendaConflict): { time: string; label: string } | null => {
    const session = sessionsById.get(conflict.fixSessionId);
    if (session === undefined || session.room === null || session.scheduledDate === null) return null;
    const room = session.room;
    const candidates = timeSlots.map((time) => zonedEpoch(session.scheduledDate ?? activeDay, time, timezone));
    const free = nearestFreeStart(
      agenda.sessions,
      session,
      { day: session.scheduledDate, roomId: room.id, roomName: room.name },
      candidates,
      (epoch) => epochLabel(epoch, timezone),
    );
    if (free === null) return null;
    const index = candidates.indexOf(free);
    const time = timeSlots[index];
    if (time === undefined) return null;
    return { time, label: `Move ${shortTitle(session.title)} to ${timeLabel(time)} ${room.name}` };
  };

  const renderCard = (session: AgendaSession, column?: OverlapColumn) => (
    <SessionCard
      column={column}
      conflicting={conflictingSessionIds.has(session.id)}
      dragging={draggingSessionId === session.id}
      key={session.id}
      menuOpen={cardMenu?.sessionId === session.id}
      onDragEnd={endDrag}
      onDragStart={startDrag}
      onOpenMenu={(sessionId, anchor) => {
        setCardMenu(
          cardMenu?.sessionId === sessionId ? null : menuPosition(sessionId, anchor.getBoundingClientRect()),
        );
        selectSession(sessionId);
      }}
      onSelect={selectSession}
      selected={selectedSessionId === session.id}
      session={session}
      timezone={timezone}
    />
  );

  const menuSession = cardMenu === null ? null : sessionsById.get(cardMenu.sessionId) ?? null;

  return (
    <section className="agenda-page">
      <div className="agenda-strip">
        <div className="agenda-strip__id">
          <h1>{agenda.event.name}</h1>
          <p>Run of show · live edit</p>
        </div>
          <div aria-label="Live slot math" className="agenda-slot-math">
            <span><strong>{agenda.metrics.unplaced}</strong> unplaced</span>
            <i>·</i>
            <button
              aria-expanded={conflicts.length === 0 ? undefined : clashesOpen}
              className={`agenda-slot-math__clashes${conflicts.length === 0 ? "" : " agenda-slot-math__clashes--live"}`}
              disabled={conflicts.length === 0}
              onClick={() => setClashesOpen((open) => !open)}
              type="button"
            >
              <strong>{conflicts.length}</strong>{" "}
              <span>{conflicts.length === 0 ? "clashes" : `⚠ clash${conflicts.length === 1 ? "" : "es"}`}</span>
              {conflicts.length === 0 ? null : <b aria-hidden="true">{clashesOpen ? "▾" : "▸"}</b>}
            </button>
          <i>·</i>
          <span><strong>{agenda.metrics.tbd}</strong> TBD</span>
        </div>
        <div aria-label="Agenda views" className="agenda-view-tabs" role="tablist">
          {views.map((view) => (
            <button aria-selected={activeView === view} className={activeView === view ? "active" : ""} key={view} onClick={() => setActiveView(view)} role="tab" type="button">
              {view}
            </button>
          ))}
        </div>
        <div className="agenda-publish">
          <span>Public</span>
          <strong>{agenda.sessions.filter((session) => session.publishedAt !== null).length}/{agenda.sessions.length} current</strong>
          <Button disabled={busy} onClick={() => void publish()} tone="signal">{busy ? "Saving…" : "Publish agenda ↗"}</Button>
        </div>
      </div>

      {error === null ? null : <p className="agenda-error" role="alert">{error}</p>}

      {agenda.sessions.length === 0 ? (
        <section className="agenda-empty">
          <span>00</span><h2>No accepted sessions yet.</h2><p>Accept a proposal in disposition and it will arrive here ready to place.</p><a href="/organizer/disposition">Open disposition →</a>
        </section>
      ) : (
        <>
          {activeView === "day" ? (
            <nav aria-label="Agenda days" className="agenda-days">
              {agenda.days.map((day, index) => (
                <button className={activeDay === day ? "active" : ""} key={day} onClick={() => setActiveDay(day)} type="button">
                  <span>0{index + 1}</span>
                  <strong>{dayLabel(day, true)}</strong>
                  <small>{placed.filter((session) => session.scheduledDate === day).length} placed</small>
                </button>
              ))}
            </nav>
          ) : null}

          <div className={`agenda-workbench${conflicts.length > 0 && clashesOpen ? " agenda-workbench--clashes" : ""}`}>
            <aside
              aria-label="Inbox"
              className={`agenda-tray${overTray ? " agenda-tray--drop" : ""}`}
              onDragLeave={(event) => {
                const next = event.relatedTarget;
                if (next instanceof Node && event.currentTarget.contains(next)) return;
                setOverTray(false);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                if (!overTray) setOverTray(true);
              }}
              onDrop={dropIntoTray}
            >
              <div className="agenda-tray__heading">
                <span>INBOX</span>
                <strong>
                  <span className="agenda-when-drag">Drag to place</span>
                  <span className="agenda-when-touch">Waiting to place</span>
                </strong>
                <small>{unscheduled.length} waiting / TBD</small>
                <small className="agenda-when-touch">Dragging needs a pointer — use <b>Place without dragging</b> below the board.</small>
              </div>
              <div className="agenda-tray__cards">{unscheduled.length === 0 ? <p>Everything has a room and time.</p> : unscheduled.map((session) => renderCard(session))}</div>
              <p className="agenda-tray__return agenda-when-drag">{draggingSessionId === null ? "Drag a card back here to unplace" : "Drop here to unplace"}</p>
            </aside>

            <main className="agenda-board">
              {activeView === "day" ? (
                <div className="agenda-grid-scroll">
                  <div
                    className={`agenda-day-grid${draggingSessionId === null ? "" : " agenda-day-grid--dragging"}`}
                    style={{ gridTemplateColumns: `76px repeat(${agenda.rooms.length}, minmax(124px, 1fr))` }}
                  >
                    <div className="agenda-grid-corner">PT</div>
                    {agenda.rooms.map((room) => <div className="agenda-room-heading" key={room.id}><strong>{room.name}</strong><small>{placed.filter((session) => session.scheduledDate === activeDay && session.room?.id === room.id).length} placed</small></div>)}
                    {timeSlots.map((time, timeIndex) => [
                      <div className={`agenda-time${time.endsWith(":00") ? " agenda-time--hour" : ""}`} key={`time-${time}`}>{timeLabel(time)}</div>,
                      ...agenda.rooms.map((room, roomIndex) => {
                        const slotSessions = placed.filter((session) => session.scheduledDate === activeDay && session.room?.id === room.id && sessionTimeValue(session, timezone) === time);
                        const isTarget = dropTarget !== null && dropTarget.roomId === room.id && dropTarget.time === time;
                        const clashing = isTarget && prediction !== null && prediction.count > 0;
                        return (
                          <div
                            aria-label={`${room.name}, ${timeLabel(time)}, ${slotSessions.length === 0 ? "empty" : slotSessions.map((session) => session.title).join(" and ")}`}
                            className={`agenda-drop-slot${time.endsWith(":00") ? " agenda-drop-slot--hour" : ""}${isTarget ? (clashing ? " agenda-drop-slot--target-clash" : " agenda-drop-slot--target") : ""}`}
                            data-testid={`agenda-slot-${activeDay}-${room.id}-${time}`}
                            key={`${room.id}-${time}`}
                            onDragEnter={() => enterSlot(room.id, time)}
                            onDragLeave={(event) => leaveSlot(event, room.id, time)}
                            onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; enterSlot(room.id, time); }}
                            onDrop={(event) => dropIntoSlot(event, activeDay, room.id, time)}
                            role="gridcell"
                          >
                            {slotSessions.map((session) => renderCard(session, columns.get(session.id)))}
                            {isTarget && draggingSession !== null && prediction !== null ? (
                              <div
                                className={`agenda-ghost${prediction.count > 0 ? " agenda-ghost--clash" : ""}`}
                                style={{ "--agenda-session-duration": draggingSession.durationMinutes / 30 } as CSSProperties}
                              >
                                <span className="agenda-ghost__chip">
                                  {prediction.count > 0 ? "⚠ " : ""}
                                  {timeLabel(time)}–{epochLabel(
                                    (dayStarts[timeIndex] ?? 0) + draggingSession.durationMinutes * 60_000,
                                    timezone,
                                  )} · {room.name}
                                </span>
                                <div className={`agenda-ghost__flag${roomIndex >= agenda.rooms.length - 2 ? " agenda-ghost__flag--left" : ""}`}>
                                  <strong>{draggingSession.title}</strong>
                                  <small>{draggingSession.durationMinutes} min · {draggingSession.speakers.map((speaker) => speaker.name).join(", ")}</small>
                                  {prediction.count === 0
                                    ? <p className="agenda-ghost__free">✓ Room and speakers free</p>
                                    : <ul className="agenda-ghost__why">{prediction.reasons.map((reason) => <li key={reason}>⚠ {reason}</li>)}</ul>}
                                </div>
                              </div>
                            ) : null}
                          </div>
                        );
                      }),
                    ])}
                  </div>
                </div>
              ) : null}

              {activeView === "week" ? (
                <div className="agenda-column-view agenda-column-view--days">
                  {agenda.days.map((day) => (
                    <section key={day} onDragOver={(event) => event.preventDefault()} onDrop={(event) => dropIntoDay(event, day)}>
                      <header><span>{day.slice(-2)}</span><div><strong>{dayLabel(day, true)}</strong><small>Drop here for TBD</small></div></header>
                      {agenda.sessions.filter((session) => session.scheduledDate === day).map((session) => renderCard(session))}
                    </section>
                  ))}
                </div>
              ) : null}

              {activeView === "track" ? (
                <div className="agenda-column-view">
                  {[...agenda.tracks, { id: "none", name: "Track TBD", color: null }].map((track) => (
                    <section key={track.id}><header><span style={{ background: track.color ?? undefined }} /><div><strong>{track.name}</strong><small>{agenda.sessions.filter((session) => session.track?.id === track.id || (track.id === "none" && session.track === null)).length} sessions</small></div></header>{agenda.sessions.filter((session) => session.track?.id === track.id || (track.id === "none" && session.track === null)).map((session) => renderCard(session))}</section>
                  ))}
                </div>
              ) : null}

              {activeView === "room" ? (
                <div className="agenda-column-view">
                  {[...agenda.rooms, { id: "none", name: "Room TBD" }].map((room) => (
                    <section key={room.id}><header><span>⌂</span><div><strong>{room.name}</strong><small>{agenda.sessions.filter((session) => session.room?.id === room.id || (room.id === "none" && session.room === null)).length} sessions</small></div></header>{agenda.sessions.filter((session) => session.room?.id === room.id || (room.id === "none" && session.room === null)).map((session) => renderCard(session))}</section>
                  ))}
                </div>
              ) : null}

              {activeView === "list" ? (
                <div className="agenda-list-view">
                  <table>
                    <caption>All accepted sessions</caption>
                    <thead><tr><th>Session</th><th>Day / time</th><th>Room</th><th>Track</th><th>State</th></tr></thead>
                    <tbody>{agenda.sessions.map((session) => <tr key={session.id}><td><button onClick={() => selectSession(session.id)} type="button">{session.title}</button><small>{session.speakers.map((speaker) => speaker.name).join(", ")}</small></td><td>{session.scheduledDate === null ? "—" : dayLabel(session.scheduledDate)}<small>{sessionTime(session, timezone)}</small></td><td>{session.room?.name ?? "TBD"}</td><td>{session.track?.name ?? "TBD"}</td><td><StatusChip tone={session.scheduleStatus === "placed" ? "good" : session.scheduleStatus === "tbd" ? "signal" : "neutral"}>{session.scheduleStatus}</StatusChip></td></tr>)}</tbody>
                  </table>
                </div>
              ) : null}
            </main>

            {conflicts.length === 0 || !clashesOpen ? null : (
              <section aria-label="Schedule conflicts" className="agenda-clashes" ref={clashesRef}>
                <div className="agenda-clashes__head">
                  <span aria-hidden="true">!</span>
                  <strong>{conflicts.length} clash{conflicts.length === 1 ? "" : "es"}</strong>
                  <button aria-label="Hide clashes" onClick={() => setClashesOpen(false)} type="button">×</button>
                </div>
                <div className="agenda-clashes__list">
                  <p className="agenda-clashes__note">Warnings only · your move was saved.</p>
                  {conflicts.map((conflict) => {
                    const fixSession = sessionsById.get(conflict.fixSessionId);
                    const free = freeSlotFix(conflict);
                    return (
                      <article className="agenda-clash" key={conflict.id}>
                        <span>{conflict.kind} overlap</span>
                        <strong title={conflict.label}>{conflict.label}</strong>
                        <div className="agenda-clash__actions">
                          {free === null || fixSession === undefined ? null : (
                            <button
                              disabled={busy}
                              onClick={() => placeSession(
                                fixSession.id,
                                fixSession.scheduledDate ?? activeDay,
                                fixSession.room?.id ?? selectedRoomId,
                                free.time,
                              )}
                              type="button"
                            >{free.label} →</button>
                          )}
                          <button
                            className={free === null ? "" : "agenda-clash__secondary"}
                            disabled={busy || fixSession === undefined}
                            onClick={() => fixSession === undefined ? undefined : moveToTbd(fixSession.id)}
                            type="button"
                          >Move {fixSession === undefined ? "session" : shortTitle(fixSession.title)} to TBD →</button>
                          {fixSession === undefined ? null : (
                            <button className="agenda-clash__secondary" onClick={() => selectSession(fixSession.id)} type="button">Show me</button>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            )}
          </div>

          <section aria-label="Selected session" className="agenda-inspector">
            <div className="agenda-inspector__head">
              <div>
                <p className="section-label">
                  SELECTED · {selectedSession === null
                    ? "NOTHING"
                    : selectedSession.scheduleStatus === "placed"
                      ? `${sessionTime(selectedSession, timezone)} · ${selectedSession.room?.name ?? "room TBD"} · ${dayLabel(selectedSession.scheduledDate ?? activeDay)}`
                      : selectedSession.scheduleStatus === "tbd" ? "TIME AND ROOM TBD" : "NOT ON A DAY YET"}
                </p>
                <strong>{selectedSession?.title ?? "Choose a session"}</strong>
                <small>Approval locks speaker edits and makes this session eligible for publication.</small>
              </div>
              {selectedSession === null ? null : (
                <div className="agenda-inspector__actions">
                  <StatusChip tone={selectedSession.contentStatus === "approved" ? "good" : selectedSession.contentStatus === "in_review" ? "signal" : "neutral"}>
                    {contentLabel(selectedSession)}
                  </StatusChip>
                  <Button disabled={busy || selectedSession.contentStatus === "approved"} onClick={() => void approveContent(selectedSession.id)}>
                    {selectedSession.contentStatus === "approved" ? "Content approved" : "Approve content"}
                  </Button>
                  <Button
                    disabled={busy || selectedSession.scheduleStatus !== "placed"}
                    onClick={() => void sendCalendarInvite(selectedSession.id)}
                    title={selectedSession.scheduleStatus === "placed" ? undefined : "Place the session before sending its calendar invite."}
                    tone="quiet"
                  >
                    Send calendar invite
                  </Button>
                </div>
              )}
            </div>
            <details className="agenda-console">
              <summary>Place without dragging (keyboard-safe)</summary>
              <div className="agenda-console__fields">
                <SelectField label="Session" onChange={(event) => selectSession(event.target.value)} value={selectedSessionId}>
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
                <div className="agenda-console__actions">
                  <Button disabled={busy} onClick={useSelection}>Place</Button>
                  <Button disabled={busy || selectedSessionId === ""} onClick={() => moveToTbd(selectedSessionId)} tone="quiet">TBD</Button>
                  <Button disabled={busy || selectedSessionId === ""} onClick={() => unplace(selectedSessionId)} tone="quiet">Unplace</Button>
                </div>
              </div>
            </details>
          </section>
        </>
      )}

      {menuSession === null || cardMenu === null ? null : (
        <div className="agenda-card-menu" role="menu" style={{ top: `${cardMenu.top}px`, left: `${cardMenu.left}px` }}>
          <p>{shortTitle(menuSession.title)}</p>
          <button disabled={busy || menuSession.scheduleStatus === "tbd"} onClick={() => moveToTbd(menuSession.id)} role="menuitem" type="button">Move to TBD</button>
          <button disabled={busy || menuSession.contentStatus === "approved"} onClick={() => void approveContent(menuSession.id)} role="menuitem" type="button">Approve content</button>
          <button disabled={busy || menuSession.scheduleStatus !== "placed"} onClick={() => void sendCalendarInvite(menuSession.id)} role="menuitem" type="button">Send calendar invite</button>
          <button className="agenda-card-menu__danger" disabled={busy || menuSession.scheduleStatus === "unplaced"} onClick={() => unplace(menuSession.id)} role="menuitem" type="button">Unplace</button>
        </div>
      )}

      <div aria-live="polite" className={`agenda-toast${toast === null ? "" : " agenda-toast--visible"}${toast !== null && toast.clashes > 0 ? " agenda-toast--clash" : ""}`} role="status">
        {toast === null ? null : (
          <>
            <strong>{toast.message}</strong>
            {toast.detail === null ? null : <small>{toast.detail}</small>}
            {toast.publicationCleared && toast.undo !== null
              ? <small>Publication cleared — publish agenda again to make this change public.</small>
              : null}
            <div className="agenda-toast__actions">
              {toast.undo === null ? null : <button onClick={undoPlacement} type="button">Undo</button>}
              {toast.clashes === 0 ? null : (
                <button
                  className="agenda-toast__review"
                  onClick={() => {
                    setClashesOpen(true);
                    clashesRef.current?.scrollIntoView({ block: "nearest" });
                  }}
                  type="button"
                >Review clashes</button>
              )}
              <button aria-label="Dismiss" className="agenda-toast__close" onClick={() => setToast(null)} type="button">×</button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
