// ABOUTME: Keeps anonymous personal schedules on-device and signed-in schedules on the account.
// ABOUTME: Migrates each device's existing picks additively so signing in never discards them.
import { useEffect, useMemo, useSyncExternalStore } from "react";

const STORAGE_PREFIX = "greenroom.personal-schedule.v1";
const MIGRATION_PREFIX = "greenroom.personal-schedule-account.v1";

export const ACCOUNT_UPDATE_LIMIT = 100;

export type StorageStatus = "checking" | "device" | "account" | "error";

export interface PersonalScheduleChange {
  add: string[];
  remove: string[];
}

export interface PersonalScheduleSnapshot {
  sessionIds: string[];
  storageStatus: StorageStatus;
}

export interface PersonalScheduleEnvironment {
  readStored(key: string): string | null;
  writeStored(key: string, value: string): void;
  accountUserId(): Promise<string | null>;
  readAccountSchedule(eventId: string): Promise<string[]>;
  updateAccountSchedule(eventId: string, change: PersonalScheduleChange): Promise<string[]>;
  publicSessionIds(eventId: string): Promise<Set<string>>;
}

export interface PersonalScheduleStore {
  subscribe(listener: () => void): () => void;
  snapshot(): PersonalScheduleSnapshot;
  settle(): Promise<void>;
  toggle(sessionId: string): Promise<void>;
}

// A change the server will refuse however often it is retried, so the store drops it
// instead of holding it against every later save.
export class PersonalScheduleRejected extends Error {}

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

function migrationKey(userId: string, eventId: string): string {
  return `${MIGRATION_PREFIX}:${userId}:${eventId}`;
}

function accountSchedulePath(eventId: string): string {
  return `/api/attendee/events/${eventId}/schedule`;
}

export function accountScheduleBatches(change: PersonalScheduleChange): PersonalScheduleChange[] {
  const batches: PersonalScheduleChange[] = [];
  for (let index = 0; index < change.remove.length; index += ACCOUNT_UPDATE_LIMIT) {
    batches.push({ add: [], remove: change.remove.slice(index, index + ACCOUNT_UPDATE_LIMIT) });
  }
  for (let index = 0; index < change.add.length; index += ACCOUNT_UPDATE_LIMIT) {
    batches.push({ add: change.add.slice(index, index + ACCOUNT_UPDATE_LIMIT), remove: [] });
  }
  return batches;
}

export function browserPersonalScheduleEnvironment(): PersonalScheduleEnvironment {
  return {
    readStored(key) {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    writeStored(key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // The in-memory selection still works when a browser blocks device storage.
      }
    },
    async accountUserId() {
      const response = await fetch("/api/session", { credentials: "same-origin" });
      if (response.status === 401) {
        return null;
      }
      if (!response.ok) {
        throw new Error("session_load_failed");
      }
      return (await response.json<SessionPayload>()).user.id;
    },
    async readAccountSchedule(eventId) {
      const response = await fetch(accountSchedulePath(eventId), { credentials: "same-origin" });
      if (!response.ok) {
        throw new Error("personal_schedule_load_failed");
      }
      return (await response.json<PersonalSchedulePayload>()).sessionIds;
    },
    async updateAccountSchedule(eventId, change) {
      const response = await fetch(accountSchedulePath(eventId), {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(change),
      });
      if (response.status === 400) {
        throw new PersonalScheduleRejected("personal_schedule_rejected");
      }
      if (!response.ok) {
        throw new Error("personal_schedule_sync_failed");
      }
      return (await response.json<PersonalSchedulePayload>()).sessionIds;
    },
    async publicSessionIds(eventId) {
      const response = await fetch(`/api/public/events/${eventId}/sessions`, { credentials: "same-origin" });
      if (!response.ok) {
        throw new Error("public_sessions_load_failed");
      }
      const payload = await response.json<PublicSessionListPayload>();
      return new Set(payload.items.map((session) => session.id));
    },
  };
}

export function createPersonalScheduleStore(
  eventId: string,
  environment: PersonalScheduleEnvironment = browserPersonalScheduleEnvironment(),
): PersonalScheduleStore {
  const devicePicks = readDevicePicks();
  const pending = new Map<string, boolean>();
  const listeners = new Set<() => void>();
  let sessionIds = devicePicks;
  let mode: "checking" | "device" | "account" = "checking";
  let failed = false;
  let accountUserId: string | null = null;
  let accountLoaded = false;
  let snapshot: PersonalScheduleSnapshot = { sessionIds, storageStatus: "checking" };
  let queue: Promise<void> = Promise.resolve();

  function readDevicePicks(): string[] {
    try {
      const parsed: unknown = JSON.parse(environment.readStored(storageKey(eventId)) ?? "[]");
      return Array.isArray(parsed)
        ? [...new Set(parsed.filter((value): value is string => typeof value === "string" && value !== ""))]
        : [];
    } catch {
      return [];
    }
  }

  function persistDevicePicks(): void {
    environment.writeStored(storageKey(eventId), JSON.stringify(sessionIds));
  }

  function publish(): void {
    snapshot = { sessionIds, storageStatus: failed ? "error" : mode };
    for (const listener of listeners) {
      listener();
    }
  }

  function withPending(saved: string[]): string[] {
    const next = saved.filter((sessionId) => pending.get(sessionId) !== false);
    for (const [sessionId, keep] of pending) {
      if (keep && !next.includes(sessionId)) {
        next.push(sessionId);
      }
    }
    return next;
  }

  async function applyChange(change: PersonalScheduleChange, current: string[]): Promise<string[]> {
    let saved = current;
    for (const batch of accountScheduleBatches(change)) {
      saved = await environment.updateAccountSchedule(eventId, batch);
    }
    return saved;
  }

  async function loadAccountSchedule(userId: string): Promise<string[]> {
    let saved = await environment.readAccountSchedule(eventId);
    if (environment.readStored(migrationKey(userId, eventId)) !== "done") {
      const publicIds = await environment.publicSessionIds(eventId);
      const known = new Set(saved);
      const additions = devicePicks.filter((sessionId) => publicIds.has(sessionId) && !known.has(sessionId));
      saved = await applyChange({ add: additions, remove: [] }, saved);
      environment.writeStored(migrationKey(userId, eventId), "done");
    }
    return saved;
  }

  async function runSettle(): Promise<void> {
    try {
      if (mode === "checking") {
        accountUserId = await environment.accountUserId();
        mode = accountUserId === null ? "device" : "account";
      }
      if (mode === "device") {
        persistDevicePicks();
        pending.clear();
        failed = false;
        publish();
        return;
      }
      if (!accountLoaded) {
        sessionIds = withPending(await loadAccountSchedule(accountUserId!));
        accountLoaded = true;
        publish();
      }
      const add = [...pending].filter(([, keep]) => keep).map(([sessionId]) => sessionId);
      const remove = [...pending].filter(([, keep]) => !keep).map(([sessionId]) => sessionId);
      if (add.length > 0 || remove.length > 0) {
        sessionIds = await applyChange({ add, remove }, sessionIds);
        pending.clear();
      }
      failed = false;
      publish();
    } catch (error) {
      if (error instanceof PersonalScheduleRejected) {
        pending.clear();
        accountLoaded = false;
      }
      failed = true;
      publish();
    }
  }

  function settle(): Promise<void> {
    queue = queue.then(runSettle);
    return queue;
  }

  function toggle(sessionId: string): Promise<void> {
    const saved = sessionIds.includes(sessionId);
    sessionIds = saved ? sessionIds.filter((id) => id !== sessionId) : [...sessionIds, sessionId];
    if (mode === "device") {
      persistDevicePicks();
      publish();
      return Promise.resolve();
    }
    pending.set(sessionId, !saved);
    publish();
    return settle();
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot() {
      return snapshot;
    },
    settle,
    toggle,
  };
}

export function usePersonalSchedule(eventId: string) {
  const store = useMemo(() => createPersonalScheduleStore(eventId), [eventId]);
  const snapshot = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);

  useEffect(() => {
    void store.settle();
  }, [store]);

  return {
    sessionIds: snapshot.sessionIds,
    storageStatus: snapshot.storageStatus,
    toggleSession: (sessionId: string): void => {
      void store.toggle(sessionId);
    },
  };
}

export function personalScheduleSnapshotPath(eventId: string, sessionIds: string[]): string {
  const params = new URLSearchParams({ sessions: sessionIds.join(",") });
  return `/api/public/events/${eventId}/schedule.ics?${params.toString()}`;
}
