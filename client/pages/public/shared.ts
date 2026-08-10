// ABOUTME: Shared formatting and URL-state helpers for the public audience surfaces.
// ABOUTME: Pure functions; safe to unit-test without a DOM.
import type { PublicSpeakerRef } from "../../../shared/api.ts";

export const DEVFLOW_EVENT_ID = "evt_devflow_conf_2027";

export function formatSchedule(params: {
  scheduledDate: string | null;
  startsAt: number | null;
  endsAt: number | null;
  scheduleStatus: string;
  timezone?: string;
}): string {
  if (params.scheduledDate === null) {
    return "Schedule TBD";
  }
  const dateText = formatDayLabel(params.scheduledDate);
  if (params.startsAt === null || params.endsAt === null) {
    return params.scheduleStatus === "placed" ? `${dateText} · time TBD` : `${dateText} · time TBD`;
  }
  return `${dateText} · ${formatTime(params.startsAt)}–${formatTime(params.endsAt)}`;
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

export function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
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
