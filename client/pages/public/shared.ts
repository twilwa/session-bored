// ABOUTME: Shared formatting and URL-state helpers for the public audience surfaces.
// ABOUTME: Pure functions; safe to unit-test without a DOM.
import type { PublicSessionCard, PublicSpeakerRef } from "../../../shared/api.ts";

export const DEVFLOW_EVENT_ID = "evt_devflow_conf_2027";

export function formatSchedule(params: {
  scheduledDate: string | null;
  startsAt: number | null;
  endsAt: number | null;
  scheduleStatus: string;
  timezone: string;
}): string {
  if (params.scheduledDate === null) {
    return "Schedule TBD";
  }
  const dateText = formatDayLabel(params.scheduledDate);
  if (params.startsAt === null || params.endsAt === null) {
    return params.scheduleStatus === "placed" ? `${dateText} · time TBD` : `${dateText} · time TBD`;
  }
  return `${dateText} · ${formatTime(params.startsAt, params.timezone)}–${formatTime(params.endsAt, params.timezone)}`;
}

export function formatDayLabel(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

// ABOUTME: Renders an instant in the event's own timezone, not the viewer's or UTC — a session
// scheduled 17:00Z for a Los Angeles event must read 10:00 AM, the time an attendee walks in for.
export function formatTime(epochMs: number, timeZone: string): string {
  return new Date(epochMs).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  });
}

// ABOUTME: The single source for a session's full start–end range, used by the agenda grid,
// the itinerary, and session detail so the same session reads identically everywhere (F-10.14).
export function formatTimeRange(startsAt: number | null, endsAt: number | null, timeZone: string): string {
  if (startsAt === null || endsAt === null) {
    return "Time TBD";
  }
  return `${formatTime(startsAt, timeZone)}–${formatTime(endsAt, timeZone)}`;
}

// ABOUTME: Renders a full weekday/date/time in the event's own timezone, not the viewer's or UTC —
// a submission deadline must read identically for every submitter regardless of where they browse from.
export function formatFullDateTime(epochMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone,
  }).format(new Date(epochMs));
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const slice = text.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  return `${lastSpace > 0 ? slice.slice(0, lastSpace) : slice}…`;
}

export function formatSpeakerLine(speakers: PublicSpeakerRef[]): string {
  if (speakers.length === 0) {
    return "Speaker TBD";
  }
  return speakers
    .map((speaker) => {
      const detail = [speaker.jobTitle, speaker.organization].filter((value) => value !== null && value !== "").join(", ");
      return detail === "" ? speaker.name : `${speaker.name} · ${detail}`;
    })
    .join("; ");
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) {
    return "?";
  }
  if (parts.length === 1) {
    return parts[0]!.slice(0, 2).toUpperCase();
  }
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

export interface ProgramFilters {
  q: string;
  track: string;
  format: string;
  room: string;
  day: string;
}

export const EMPTY_FILTERS: ProgramFilters = { q: "", track: "", format: "", room: "", day: "" };

export function readFiltersFromUrl(search: string): ProgramFilters {
  const params = new URLSearchParams(search);
  return {
    q: params.get("q") ?? "",
    track: params.get("track") ?? "",
    format: params.get("format") ?? "",
    room: params.get("room") ?? "",
    day: params.get("day") ?? "",
  };
}

export function writeFiltersToUrl(filters: ProgramFilters): void {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== "") {
      params.set(key, value);
    }
  }
  const query = params.toString();
  const nextUrl = query === "" ? window.location.pathname : `${window.location.pathname}?${query}`;
  window.history.replaceState({}, "", nextUrl);
}

export function activeFilterCount(filters: ProgramFilters): number {
  return (Object.keys(filters) as Array<keyof ProgramFilters>).filter((key) => filters[key] !== "").length;
}

export function surnameOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts[parts.length - 1] ?? name;
}

// ABOUTME: Splits approved sessions into per-day buckets for day-tab surfaces; sessions with no
// scheduledDate at all cannot belong to a day tab and are returned separately, never dropped.
export function groupSessionsByDay(
  sessions: PublicSessionCard[],
): { byDay: Map<string, PublicSessionCard[]>; unscheduled: PublicSessionCard[] } {
  const byDay = new Map<string, PublicSessionCard[]>();
  const unscheduled: PublicSessionCard[] = [];
  for (const session of sessions) {
    if (session.scheduledDate === null) {
      unscheduled.push(session);
      continue;
    }
    const list = byDay.get(session.scheduledDate) ?? [];
    list.push(session);
    byDay.set(session.scheduledDate, list);
  }
  return { byDay, unscheduled };
}

// ABOUTME: Chronological order for the itinerary; sessions with no start time have no place in a
// timeline, so they sort last rather than being hidden, then break ties by title.
export function sortSessionsChronologically(sessions: PublicSessionCard[]): PublicSessionCard[] {
  return [...sessions].sort((a, b) => {
    if (a.startsAt === null && b.startsAt === null) {
      return (a.title ?? "").localeCompare(b.title ?? "");
    }
    if (a.startsAt === null) {
      return 1;
    }
    if (b.startsAt === null) {
      return -1;
    }
    return a.startsAt - b.startsAt;
  });
}

export const TBD_KEY = "tbd";

export interface AgendaAxisLabel {
  key: string;
  label: string;
}

export interface AgendaGrid {
  rows: AgendaAxisLabel[];
  columns: AgendaAxisLabel[];
  cells: Map<string, PublicSessionCard[]>;
}

export function agendaCellKey(rowKey: string, columnKey: string): string {
  return `${rowKey}__${columnKey}`;
}

// ABOUTME: Lays out one day's sessions on a time (row) x room (column) grid without inventing a
// time or room a session does not have — unplaced sessions land in an honest "TBD" row/column.
export function buildAgendaGrid(sessions: PublicSessionCard[], eventRooms: string[], timeZone: string): AgendaGrid {
  const timesByKey = new Map<string, number>();
  let hasTbdTime = false;
  for (const session of sessions) {
    if (session.startsAt === null) {
      hasTbdTime = true;
    } else {
      timesByKey.set(String(session.startsAt), session.startsAt);
    }
  }
  const sortedTimeKeys = [...timesByKey.entries()].sort((a, b) => a[1] - b[1]).map(([key]) => key);
  const rows: AgendaAxisLabel[] = [
    ...(hasTbdTime ? [{ key: TBD_KEY, label: "Time TBD" }] : []),
    ...sortedTimeKeys.map((key) => ({ key, label: formatTime(timesByKey.get(key)!, timeZone) })),
  ];

  const roomsPresent = new Set(sessions.flatMap((session) => (session.room === null ? [] : [session.room])));
  const hasTbdRoom = sessions.some((session) => session.room === null);
  const orderedRooms = eventRooms.filter((room) => roomsPresent.has(room));
  for (const room of roomsPresent) {
    if (!orderedRooms.includes(room)) {
      orderedRooms.push(room);
    }
  }
  const columns: AgendaAxisLabel[] = [
    ...orderedRooms.map((room) => ({ key: room, label: room })),
    ...(hasTbdRoom ? [{ key: TBD_KEY, label: "Room TBD" }] : []),
  ];

  const cells = new Map<string, PublicSessionCard[]>();
  for (const session of sessions) {
    const rowKey = session.startsAt === null ? TBD_KEY : String(session.startsAt);
    const columnKey = session.room === null ? TBD_KEY : session.room;
    const cellKey = agendaCellKey(rowKey, columnKey);
    const list = cells.get(cellKey) ?? [];
    list.push(session);
    cells.set(cellKey, list);
  }

  return { rows, columns, cells };
}
