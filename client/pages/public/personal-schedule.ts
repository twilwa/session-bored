// ABOUTME: Persists an anonymous attendee's selected public session IDs on this device.
// ABOUTME: Builds a public calendar path containing the attendee's current selection snapshot.
import { useState } from "react";

const STORAGE_PREFIX = "greenroom.personal-schedule.v1";

function storageKey(eventId: string): string {
  return `${STORAGE_PREFIX}:${eventId}`;
}

function readSessionIds(eventId: string): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(storageKey(eventId)) ?? "[]");
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((value): value is string => typeof value === "string" && value !== ""))]
      : [];
  } catch {
    return [];
  }
}

function persistSessionIds(eventId: string, sessionIds: string[]): void {
  try {
    window.localStorage.setItem(storageKey(eventId), JSON.stringify(sessionIds));
  } catch {
    // The in-memory selection still works when a browser blocks device storage.
  }
}

export function usePersonalSchedule(eventId: string) {
  const [sessionIds, setSessionIds] = useState<string[]>(() => readSessionIds(eventId));

  function toggleSession(sessionId: string): void {
    setSessionIds((current) => {
      const next = current.includes(sessionId)
        ? current.filter((id) => id !== sessionId)
        : [...current, sessionId];
      persistSessionIds(eventId, next);
      return next;
    });
  }

  return { sessionIds, toggleSession };
}

export function personalScheduleSnapshotPath(eventId: string, sessionIds: string[]): string {
  const params = new URLSearchParams({ sessions: sessionIds.join(",") });
  return `/api/public/events/${eventId}/schedule.ics?${params.toString()}`;
}
