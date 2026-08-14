// ABOUTME: Pins how a personal schedule moves from an anonymous device onto a signed-in account.
// ABOUTME: A dropped pick or an unbatched merge silently loses saved sessions, so both are proven here.
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_UPDATE_LIMIT,
  createPersonalScheduleStore,
  PersonalScheduleRejected,
  type PersonalScheduleChange,
  type PersonalScheduleEnvironment,
} from "../../client/pages/public/personal-schedule.ts";

const EVENT_ID = "evt_devflow_conf_2027";
const DEVICE_KEY = `greenroom.personal-schedule.v1:${EVENT_ID}`;

function migrationKey(userId: string): string {
  return `greenroom.personal-schedule-account.v1:${userId}:${EVENT_ID}`;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

class FakeSchedule implements PersonalScheduleEnvironment {
  readonly storage = new Map<string, string>();
  readonly updates: PersonalScheduleChange[] = [];
  account: string[] = [];
  publicIds = new Set<string>();
  userId: string | null = "usr_attendee";
  pendingUserId: Deferred<string | null> | null = null;
  failNextUpdate: Error | null = null;

  constructor(devicePicks: string[] = []) {
    if (devicePicks.length > 0) {
      this.storage.set(DEVICE_KEY, JSON.stringify(devicePicks));
    }
  }

  readStored(key: string): string | null {
    return this.storage.get(key) ?? null;
  }

  writeStored(key: string, value: string): void {
    this.storage.set(key, value);
  }

  async accountUserId(): Promise<string | null> {
    return this.pendingUserId === null ? this.userId : this.pendingUserId.promise;
  }

  async readAccountSchedule(): Promise<string[]> {
    return [...this.account];
  }

  // Mirrors the server contract in worker/routes/personal-schedule.ts: at most 100 ids per
  // list, and every added session must still be public.
  async updateAccountSchedule(_eventId: string, change: PersonalScheduleChange): Promise<string[]> {
    this.updates.push({ add: [...change.add], remove: [...change.remove] });
    const failure = this.failNextUpdate;
    if (failure !== null) {
      this.failNextUpdate = null;
      throw failure;
    }
    if (change.add.length > ACCOUNT_UPDATE_LIMIT || change.remove.length > ACCOUNT_UPDATE_LIMIT) {
      throw new PersonalScheduleRejected("invalid_personal_schedule");
    }
    if (change.add.some((sessionId) => !this.publicIds.has(sessionId))) {
      throw new PersonalScheduleRejected("invalid_personal_schedule");
    }
    const removed = new Set(change.remove);
    this.account = [...this.account.filter((sessionId) => !removed.has(sessionId)), ...change.add]
      .filter((sessionId, index, all) => all.indexOf(sessionId) === index);
    return [...this.account];
  }

  async publicSessionIds(): Promise<Set<string>> {
    return new Set(this.publicIds);
  }
}

function manyPicks(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `ses_${index}`);
}

describe("anonymous device schedule", () => {
  it("keeps picks on the device and never calls the account", async () => {
    const environment = new FakeSchedule(["ses_docs"]);
    environment.userId = null;
    const store = createPersonalScheduleStore(EVENT_ID, environment);

    await store.settle();
    store.toggle("ses_payments");

    expect(store.snapshot().storageStatus).toBe("device");
    expect(store.snapshot().sessionIds).toEqual(["ses_docs", "ses_payments"]);
    expect(JSON.parse(environment.storage.get(DEVICE_KEY)!)).toEqual(["ses_docs", "ses_payments"]);
    expect(environment.updates).toEqual([]);
  });
});

describe("first signed-in use on a device", () => {
  it("migrates more than 100 still-public picks in bounded batches", async () => {
    const environment = new FakeSchedule(manyPicks(150));
    environment.publicIds = new Set(manyPicks(150));
    const store = createPersonalScheduleStore(EVENT_ID, environment);

    await store.settle();

    expect(environment.updates.map((update) => update.add.length)).toEqual([100, 50]);
    expect(environment.updates.every((update) => update.add.length <= ACCOUNT_UPDATE_LIMIT)).toBe(true);
    expect(environment.account).toEqual(manyPicks(150));
    expect(store.snapshot().sessionIds).toEqual(manyPicks(150));
    expect(store.snapshot().storageStatus).toBe("account");
    expect(environment.readStored(migrationKey("usr_attendee"))).toBe("done");
  });

  it("adds to the account picks and drops device picks that are no longer public", async () => {
    const environment = new FakeSchedule(["ses_public", "ses_withdrawn"]);
    environment.publicIds = new Set(["ses_public", "ses_kept"]);
    environment.account = ["ses_kept"];
    const store = createPersonalScheduleStore(EVENT_ID, environment);

    await store.settle();

    expect(environment.updates).toEqual([{ add: ["ses_public"], remove: [] }]);
    expect(store.snapshot().sessionIds).toEqual(["ses_kept", "ses_public"]);
  });

  it("records the migration only after every batch succeeds, and finishes it on a later attempt", async () => {
    const environment = new FakeSchedule(manyPicks(150));
    environment.publicIds = new Set(manyPicks(150));
    const store = createPersonalScheduleStore(EVENT_ID, environment);
    environment.failNextUpdate = new Error("personal_schedule_sync_failed");

    await store.settle();

    expect(environment.account).toEqual([]);
    expect(environment.readStored(migrationKey("usr_attendee"))).toBeNull();
    expect(store.snapshot().storageStatus).toBe("error");

    await store.settle();

    expect(environment.account).toEqual(manyPicks(150));
    expect(environment.readStored(migrationKey("usr_attendee"))).toBe("done");
    expect(store.snapshot().storageStatus).toBe("account");
  });

  it("never writes account picks into device storage", async () => {
    const environment = new FakeSchedule(["ses_public"]);
    environment.publicIds = new Set(["ses_public", "ses_other_device", "ses_later"]);
    environment.account = ["ses_other_device"];
    const store = createPersonalScheduleStore(EVENT_ID, environment);

    await store.settle();
    store.toggle("ses_later");
    await store.settle();

    expect(store.snapshot().sessionIds).toEqual(["ses_other_device", "ses_public", "ses_later"]);
    expect(JSON.parse(environment.storage.get(DEVICE_KEY)!)).toEqual(["ses_public"]);
  });
});

describe("a pick made before persistence is settled", () => {
  it("reaches the account instead of being replaced by the loaded schedule", async () => {
    const environment = new FakeSchedule([]);
    environment.publicIds = new Set(["ses_kept", "ses_early"]);
    environment.account = ["ses_kept"];
    environment.pendingUserId = deferred<string | null>();
    const store = createPersonalScheduleStore(EVENT_ID, environment);

    const settling = store.settle();
    store.toggle("ses_early");
    expect(store.snapshot().sessionIds).toEqual(["ses_early"]);
    environment.pendingUserId.resolve("usr_attendee");
    await settling;
    await store.settle();

    expect(environment.updates).toEqual([{ add: ["ses_early"], remove: [] }]);
    expect(environment.account).toEqual(["ses_kept", "ses_early"]);
    expect(store.snapshot().sessionIds).toEqual(["ses_kept", "ses_early"]);
    expect(store.snapshot().storageStatus).toBe("account");
  });

  it("holds a pick a failed save dropped and sends it with the next one", async () => {
    const environment = new FakeSchedule([]);
    environment.publicIds = new Set(["ses_first", "ses_second"]);
    const store = createPersonalScheduleStore(EVENT_ID, environment);
    await store.settle();

    environment.failNextUpdate = new Error("personal_schedule_sync_failed");
    await store.toggle("ses_first");
    expect(store.snapshot().storageStatus).toBe("error");
    expect(environment.account).toEqual([]);

    await store.toggle("ses_second");

    expect(environment.account).toEqual(["ses_first", "ses_second"]);
    expect(store.snapshot().sessionIds).toEqual(["ses_first", "ses_second"]);
    expect(store.snapshot().storageStatus).toBe("account");
  });
});
