// ABOUTME: Derives the agenda board's slot lattice, drop predictions, and overlap columns.
// ABOUTME: Mirrors the server's room and speaker overlap rules so the board can warn before a drop.
import type { AgendaPlacement, AgendaSession } from "../../../shared/api.ts";

/** Every placeable start on the board: 08:00 to 18:00 in half hours. */
export const timeSlots: string[] = Array.from({ length: 21 }, (_, index) => {
  const minutes = 8 * 60 + index * 30;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
});

export interface DropTarget {
  day: string;
  roomId: string;
  roomName: string;
  startsAt: number;
}

export interface DropPrediction {
  /** Conflict rows the server would produce for this drop — the number the strip will show. */
  count: number;
  /** The same information as sentences, one room line plus one line per double-booked speaker. */
  reasons: string[];
}

export interface OverlapColumn {
  index: number;
  count: number;
}

function overlaps(firstStart: number, firstEnd: number, secondStart: number, secondEnd: number): boolean {
  return firstStart < secondEnd && secondStart < firstEnd;
}

function placedRivals(sessions: AgendaSession[], movedId: string): AgendaSession[] {
  return sessions.filter((session) =>
    session.id !== movedId &&
    session.scheduleStatus === "placed" &&
    session.startsAt !== null &&
    session.endsAt !== null
  );
}

/**
 * What the server's overlaps()/agendaConflicts() would say about dropping `moved` on `target`,
 * available while the pointer is still holding the card.
 */
export function predictDrop(
  sessions: AgendaSession[],
  moved: AgendaSession,
  target: DropTarget,
  formatTime: (epoch: number) => string,
): DropPrediction {
  const endsAt = target.startsAt + moved.durationMinutes * 60_000;
  const rivals = placedRivals(sessions, moved.id).filter((rival) =>
    overlaps(target.startsAt, endsAt, rival.startsAt ?? 0, rival.endsAt ?? 0)
  );
  const roomTaken = rivals.filter((rival) => rival.room !== null && rival.room.id === target.roomId);
  const movedSpeakerIds = new Set(moved.speakers.map((speaker) => speaker.id));
  const speakerLines: string[] = [];
  let speakerCount = 0;
  for (const rival of rivals) {
    for (const speaker of rival.speakers) {
      if (!movedSpeakerIds.has(speaker.id)) continue;
      speakerCount += 1;
      speakerLines.push(
        `${speaker.name} is already in ${rival.room?.name ?? "another room"} at ${formatTime(rival.startsAt ?? 0)}`,
      );
    }
  }
  const reasons = roomTaken.length === 0 ? [] : [
    `${target.roomName} is taken by ${roomTaken.map((rival) => shortTitle(rival.title)).join(" and ")}`,
  ];
  return { count: roomTaken.length + speakerCount, reasons: [...reasons, ...speakerLines] };
}

/**
 * The nearest start in `candidates` that this session can take in `target`'s room without a
 * clash, searched outward from where it sits now, or forward from the room's last session when
 * it has no time yet. Returns null when the room has no free start on that day.
 */
export function nearestFreeStart(
  sessions: AgendaSession[],
  moved: AgendaSession,
  target: Omit<DropTarget, "startsAt">,
  candidates: number[],
  formatTime: (epoch: number) => string,
): number | null {
  const fits = (startsAt: number) =>
    predictDrop(sessions, moved, { ...target, startsAt }, formatTime).count === 0;
  const anchor = moved.scheduleStatus === "placed" ? moved.startsAt : null;
  const order: number[] = [];
  if (anchor === null) {
    const lastEnd = placedRivals(sessions, moved.id)
      .filter((rival) => rival.room !== null && rival.room.id === target.roomId)
      .reduce((latest, rival) => Math.max(latest, rival.endsAt ?? 0), 0);
    const from = Math.max(0, candidates.findIndex((candidate) => candidate >= lastEnd));
    for (let index = from; index < candidates.length; index += 1) order.push(index);
    for (let index = from - 1; index >= 0; index -= 1) order.push(index);
  } else {
    const from = candidates.indexOf(anchor);
    const start = from === -1 ? 0 : from;
    for (let step = 1; step < candidates.length; step += 1) {
      if (start + step < candidates.length) order.push(start + step);
      if (start - step >= 0) order.push(start - step);
    }
    if (from === -1) order.unshift(0);
  }
  for (const index of order) {
    const candidate = candidates[index];
    if (candidate !== undefined && fits(candidate)) return candidate;
  }
  return null;
}

/**
 * Splits each room's overlapping sessions into side-by-side columns, so a clash stays readable
 * in place instead of one card hiding the other.
 */
export function overlapColumns(sessions: AgendaSession[]): Map<string, OverlapColumn> {
  const columns = new Map<string, OverlapColumn>();
  const byRoom = new Map<string, AgendaSession[]>();
  for (const session of sessions) {
    if (session.scheduleStatus !== "placed" || session.room === null || session.startsAt === null) continue;
    const key = `${session.scheduledDate ?? ""}:${session.room.id}`;
    byRoom.set(key, [...(byRoom.get(key) ?? []), session]);
  }
  for (const group of byRoom.values()) {
    const ordered = [...group].sort((first, second) => (first.startsAt ?? 0) - (second.startsAt ?? 0));
    let cluster: AgendaSession[] = [];
    let clusterEnd = -1;
    const flush = () => {
      cluster.forEach((session, index) => columns.set(session.id, { index, count: cluster.length }));
      cluster = [];
    };
    for (const session of ordered) {
      if (cluster.length > 0 && (session.startsAt ?? 0) < clusterEnd) {
        cluster.push(session);
        clusterEnd = Math.max(clusterEnd, session.endsAt ?? 0);
        continue;
      }
      flush();
      cluster = [session];
      clusterEnd = session.endsAt ?? 0;
    }
    flush();
  }
  return columns;
}

/** The placement a session currently holds, so a change can be handed back to Undo. */
export function placementOf(session: AgendaSession): AgendaPlacement {
  if (session.scheduleStatus === "placed" && session.room !== null && session.startsAt !== null &&
    session.scheduledDate !== null) {
    return {
      scheduleStatus: "placed",
      scheduledDate: session.scheduledDate,
      roomId: session.room.id,
      startsAt: session.startsAt,
    };
  }
  if (session.scheduleStatus === "tbd" && session.scheduledDate !== null) {
    return { scheduleStatus: "tbd", scheduledDate: session.scheduledDate };
  }
  return { scheduleStatus: "unplaced" };
}

/** A card title short enough to read inside a clash sentence. */
export function shortTitle(title: string): string {
  const head = title.split(":")[0] ?? title;
  return head.length > 40 ? `${head.slice(0, 38).replace(/[ ,]+$/, "")}…` : head;
}

/** The epoch a wall-clock day and time resolve to in the event's timezone. */
export function zonedEpoch(day: string, time: string, timezone: string): number {
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

/** The lattice time a placed session sits on, or null when it sits between slots. */
export function sessionTimeValue(session: AgendaSession, timezone: string): string | null {
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
