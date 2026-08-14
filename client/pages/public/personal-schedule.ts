// ABOUTME: Keeps anonymous personal schedules on-device and signed-in schedules on the account.
// ABOUTME: Migrates each device's existing picks additively so signing in never discards them.
import { useEffect, useRef, useState } from "react";

const STORAGE_PREFIX = "greenroom.personal-schedule.v1";
const MIGRATION_PREFIX = "greenroom.personal-schedule-account.v1";

type StorageStatus = "checking" | "device" | "account" | "error";

interface SessionPayload {
  user: { id: string };
}

interface PersonalSchedulePayload {
  sessionIds: string[];
}

interface PublicSessionListPayload {
  items: Array<{ id: string }>;
}

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

function migrationKey(userId: string, eventId: string): string {
  return `${MIGRATION_PREFIX}:${userId}:${eventId}`;
}

function hasMigrated(userId: string, eventId: string): boolean {
  try {
    return window.localStorage.getItem(migrationKey(userId, eventId)) === "done";
  } catch {
    return false;
  }
}

function rememberMigration(userId: string, eventId: string): void {
  try {
    window.localStorage.setItem(migrationKey(userId, eventId), "done");
  } catch {
    // The account copy still works when a browser blocks device storage.
  }
}

function accountSchedulePath(eventId: string): string {
  return `/api/attendee/events/${eventId}/schedule`;
}

async function fetchPublicSessionIds(eventId: string): Promise<Set<string>> {
  const response = await fetch(`/api/public/events/${eventId}/sessions`, { credentials: "same-origin" });
  if (!response.ok) {
    throw new Error("public_sessions_load_failed");
  }
  const payload = await response.json<PublicSessionListPayload>();
  return new Set(payload.items.map((session) => session.id));
}

async function updateAccountSchedule(
  eventId: string,
  change: { add: string[]; remove: string[] },
): Promise<PersonalSchedulePayload> {
  const response = await fetch(accountSchedulePath(eventId), {
    method: "PATCH",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(change),
  });
  if (!response.ok) {
    throw new Error("personal_schedule_sync_failed");
  }
  return response.json<PersonalSchedulePayload>();
}

export function usePersonalSchedule(eventId: string) {
  const [sessionIds, setSessionIds] = useState<string[]>(() => readSessionIds(eventId));
  const [storageStatus, setStorageStatus] = useState<StorageStatus>("checking");
  const currentSessionIds = useRef(sessionIds);
  const accountUserId = useRef<string | null>(null);
  const deviceMode = useRef(false);

  function replaceSessionIds(next: string[]): void {
    currentSessionIds.current = next;
    if (deviceMode.current) {
      persistSessionIds(eventId, next);
    }
    setSessionIds(next);
  }

  useEffect(() => {
    let active = true;
    async function loadSchedule(): Promise<void> {
      try {
        const sessionResponse = await fetch("/api/session", { credentials: "same-origin" });
        if (sessionResponse.status === 401) {
          deviceMode.current = true;
          persistSessionIds(eventId, currentSessionIds.current);
          if (active) setStorageStatus("device");
          return;
        }
        if (!sessionResponse.ok) {
          throw new Error("session_load_failed");
        }
        const session = await sessionResponse.json<SessionPayload>();
        accountUserId.current = session.user.id;
        deviceMode.current = false;
        const scheduleResponse = await fetch(accountSchedulePath(eventId), { credentials: "same-origin" });
        if (!scheduleResponse.ok) {
          throw new Error("personal_schedule_load_failed");
        }
        let accountSchedule = await scheduleResponse.json<PersonalSchedulePayload>();
        if (!hasMigrated(session.user.id, eventId)) {
          const devicePicks = currentSessionIds.current;
          if (devicePicks.length > 0) {
            const publicIds = await fetchPublicSessionIds(eventId);
            const additions = devicePicks.filter((sessionId) => publicIds.has(sessionId));
            if (additions.length > 0) {
              accountSchedule = await updateAccountSchedule(eventId, { add: additions, remove: [] });
            }
          }
          rememberMigration(session.user.id, eventId);
        }
        if (active) {
          replaceSessionIds(accountSchedule.sessionIds);
          setStorageStatus("account");
        }
      } catch {
        accountUserId.current = null;
        if (active) setStorageStatus("error");
      }
    }
    void loadSchedule();
    return () => {
      active = false;
    };
  }, [eventId]);

  function toggleSession(sessionId: string): void {
    const saved = currentSessionIds.current.includes(sessionId);
    const next = saved
      ? currentSessionIds.current.filter((id) => id !== sessionId)
      : [...currentSessionIds.current, sessionId];
    replaceSessionIds(next);
    if (accountUserId.current === null) {
      return;
    }
    void updateAccountSchedule(eventId, {
      add: saved ? [] : [sessionId],
      remove: saved ? [sessionId] : [],
    }).then((accountSchedule) => {
      replaceSessionIds(accountSchedule.sessionIds);
      setStorageStatus("account");
    }).catch(() => {
      setStorageStatus("error");
    });
  }

  return { sessionIds, storageStatus, toggleSession };
}

export function personalScheduleSnapshotPath(eventId: string, sessionIds: string[]): string {
  const params = new URLSearchParams({ sessions: sessionIds.join(",") });
  return `/api/public/events/${eventId}/schedule.ics?${params.toString()}`;
}
