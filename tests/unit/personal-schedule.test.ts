// ABOUTME: Pins how a personal schedule moves from an anonymous device onto a signed-in account.
// ABOUTME: A dropped pick or an unbatched merge silently loses saved sessions, so both are proven here.
import { describe, expect, it } from "vitest";
import { personalScheduleUpdateLimit, type PersonalScheduleChange } from "../../shared/api.ts";
import {
  createPersonalScheduleStore,
  personalScheduleStore,
  PersonalScheduleRejected,
  PersonalScheduleUnauthenticated,
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
  reads = 0;
  publicIds = new Set<string>();
  userId: string | null = "usr_attendee";
  pendingUserId: Deferred<string | null> | null = null;
  userIdFailure: Error | null = null;
  readFailure: Error | null = null;
  failNextUpdate: Error | null = null;
  updateFailure: Error | null = null;
  publicSessionIdsFailure: Error | null = null;
  blockNextUpdate: { started: Deferred<void>; release: Deferred<void> } | null = null;

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
    if (this.userIdFailure !== null) {
      throw this.userIdFailure;
    }
    return this.pendingUserId === null ? this.userId : this.pendingUserId.promise;
  }

  async readAccountSchedule(): Promise<string[]> {
    this.reads += 1;
    if (this.readFailure !== null) {
      throw this.readFailure;
    }
    return [...this.account];
  }

  // Mirrors the server contract in worker/routes/personal-schedule.ts: at most 100 ids per
  // list, and every added session must still be public.
  async updateAccountSchedule(_eventId: string, change: PersonalScheduleChange): Promise<string[]> {
    this.updates.push({ add: [...change.add], remove: [...change.remove] });
    const block = this.blockNextUpdate;
    if (block !== null) {
      this.blockNextUpdate = null;
      block.started.resolve();
      await block.release.promise;
    }
    if (this.updateFailure !== null) {
      throw this.updateFailure;
    }
    const failure = this.failNextUpdate;
    if (failure !== null) {
      this.failNextUpdate = null;
      throw failure;
    }
    if (change.add.length > personalScheduleUpdateLimit || change.remove.length > personalScheduleUpdateLimit) {
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
    if (this.publicSessionIdsFailure !== null) {
      throw this.publicSessionIdsFailure;
    }
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
    expect(environment.updates.every((update) => update.add.length <= personalScheduleUpdateLimit)).toBe(true);
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

describe("a pick made while a save is in flight", () => {
  it("still reaches the account", async () => {
    const environment = new FakeSchedule([]);
    environment.publicIds = new Set(["ses_first", "ses_second"]);
    const store = createPersonalScheduleStore(EVENT_ID, environment);
    await store.settle();

    const started = deferred<void>();
    const release = deferred<void>();
    environment.blockNextUpdate = { started, release };
    const first = store.toggle("ses_first");
    await started.promise;
    const second = store.toggle("ses_second");
    release.resolve();
    await Promise.all([first, second]);

    expect(environment.updates).toEqual([
      { add: ["ses_first"], remove: [] },
      { add: ["ses_second"], remove: [] },
    ]);
    expect(environment.account).toEqual(["ses_first", "ses_second"]);
    expect(store.snapshot().sessionIds).toEqual(["ses_first", "ses_second"]);
    expect(store.snapshot().storageStatus).toBe("account");
  });

  it("removes a pick taken back while its own save was in flight", async () => {
    const environment = new FakeSchedule([]);
    environment.publicIds = new Set(["ses_kept", "ses_undone"]);
    environment.account = ["ses_kept"];
    const store = createPersonalScheduleStore(EVENT_ID, environment);
    await store.settle();

    const started = deferred<void>();
    const release = deferred<void>();
    environment.blockNextUpdate = { started, release };
    const saving = store.toggle("ses_undone");
    await started.promise;
    const undoing = store.toggle("ses_undone");
    release.resolve();
    await Promise.all([saving, undoing]);

    expect(environment.account).toEqual(["ses_kept"]);
    expect(store.snapshot().sessionIds).toEqual(["ses_kept"]);
    expect(store.snapshot().storageStatus).toBe("account");
  });
});

describe("when the account check cannot be answered", () => {
  it("keeps saving the visitor's picks on the device", async () => {
    const environment = new FakeSchedule(["ses_earlier"]);
    environment.userIdFailure = new Error("session_load_failed");
    const store = createPersonalScheduleStore(EVENT_ID, environment);

    await store.settle();
    expect(store.snapshot().storageStatus).toBe("device");

    await store.toggle("ses_pick");

    expect(store.snapshot().sessionIds).toEqual(["ses_earlier", "ses_pick"]);
    expect(store.snapshot().storageStatus).toBe("device");
    expect(JSON.parse(environment.storage.get(DEVICE_KEY)!)).toEqual(["ses_earlier", "ses_pick"]);
    expect(environment.updates).toEqual([]);
  });
});

describe("a flush the server refuses part of", () => {
  it("drops only the pick that left the programme and keeps its batch peers", async () => {
    const environment = new FakeSchedule([]);
    environment.publicIds = new Set(manyPicks(150));
    const store = createPersonalScheduleStore(EVENT_ID, environment);
    await store.settle();

    environment.updateFailure = new Error("personal_schedule_sync_failed");
    for (const sessionId of manyPicks(150)) {
      await store.toggle(sessionId);
    }
    expect(environment.account).toEqual([]);

    // One session stops being public while 150 picks are still waiting to be saved. The
    // first batch of 100 carries it, and the server refuses that whole batch.
    environment.updateFailure = null;
    environment.publicIds.delete("ses_0");
    await store.settle();

    // The refused pick leaves the rendered list at once - the page must not go on showing a
    // session the programme has withdrawn, under copy that says the picks are being kept.
    expect(store.snapshot().storageStatus).toBe("error");
    expect(store.snapshot().sessionIds).not.toContain("ses_0");
    expect(store.snapshot().sessionIds).toEqual(manyPicks(150).slice(1));

    await store.settle();

    expect(environment.account).toEqual(manyPicks(150).slice(1));
    expect(store.snapshot().sessionIds).toEqual(manyPicks(150).slice(1));
    expect(store.snapshot().sessionIds).not.toContain("ses_0");
    expect(store.snapshot().storageStatus).toBe("account");
  });

  it("holds every pick when the programme cannot be read to tell which one was refused", async () => {
    const environment = new FakeSchedule([]);
    environment.publicIds = new Set(manyPicks(3));
    const store = createPersonalScheduleStore(EVENT_ID, environment);
    await store.settle();

    environment.updateFailure = new PersonalScheduleRejected("invalid_personal_schedule");
    environment.publicSessionIdsFailure = new Error("public_sessions_load_failed");
    await store.toggle("ses_0");
    await store.toggle("ses_1");

    expect(store.snapshot().storageStatus).toBe("error");

    environment.updateFailure = null;
    environment.publicSessionIdsFailure = null;
    await store.settle();

    expect(environment.account).toEqual(["ses_0", "ses_1"]);
    expect(store.snapshot().sessionIds).toEqual(["ses_0", "ses_1"]);
    expect(store.snapshot().storageStatus).toBe("account");
  });
});

describe("moving between the pages that show the schedule", () => {
  // `/schedule` and `/schedule/mine` are one SPA navigation apart, so the itinerary's page
  // component unmounts while its save is still in flight.
  it("carries a pick that is still saving onto the next page, and reads the account once", async () => {
    const navigationEventId = `${EVENT_ID}_navigation`;
    const environment = new FakeSchedule([]);
    environment.publicIds = new Set(["ses_first"]);
    const itinerary = personalScheduleStore(navigationEventId, environment);

    await itinerary.settle();
    expect(environment.reads).toBe(1);

    const started = deferred<void>();
    const release = deferred<void>();
    environment.blockNextUpdate = { started, release };
    const saving = itinerary.toggle("ses_first");
    await started.promise;

    const mySchedule = personalScheduleStore(navigationEventId);
    expect(mySchedule.snapshot().sessionIds).toEqual(["ses_first"]);
    expect(mySchedule.snapshot().storageStatus).toBe("account");

    release.resolve();
    await Promise.all([saving, mySchedule.settle()]);

    expect(environment.account).toEqual(["ses_first"]);
    expect(mySchedule.snapshot().sessionIds).toEqual(["ses_first"]);
    expect(mySchedule.snapshot().storageStatus).toBe("account");
    expect(environment.updates).toEqual([{ add: ["ses_first"], remove: [] }]);
    expect(environment.reads).toBe(1);
  });
});

describe("an account that is no longer signed in", () => {
  // Signing out in another tab, or a session simply expiring, never reaches this page:
  // `observePublicSession` is a same-window event. The refusal itself is the only signal.
  it("hands the shared device back to its anonymous owner when a save is refused", async () => {
    const environment = new FakeSchedule(["ses_device"]);
    environment.publicIds = new Set(["ses_device", "ses_account", "ses_later"]);
    environment.account = ["ses_account"];
    environment.storage.set(migrationKey("usr_attendee"), "done");
    const store = createPersonalScheduleStore(EVENT_ID, environment);

    await store.settle();
    expect(store.snapshot().sessionIds).toEqual(["ses_account"]);
    expect(store.snapshot().storageStatus).toBe("account");

    environment.updateFailure = new PersonalScheduleUnauthenticated("authentication_required");
    environment.userId = null;
    await store.toggle("ses_later");

    expect(store.snapshot().storageStatus).toBe("device");
    expect(store.snapshot().sessionIds).toEqual(["ses_device"]);
    expect(environment.account).toEqual(["ses_account"]);
    // Neither the account's saved pick nor the one it never managed to send may be written
    // to a device the account does not own.
    expect(JSON.parse(environment.storage.get(DEVICE_KEY)!)).toEqual(["ses_device"]);

    environment.updateFailure = null;
    await store.toggle("ses_later");

    expect(store.snapshot().storageStatus).toBe("device");
    expect(store.snapshot().sessionIds).toEqual(["ses_device", "ses_later"]);
    expect(JSON.parse(environment.storage.get(DEVICE_KEY)!)).toEqual(["ses_device", "ses_later"]);
    expect(environment.account).toEqual(["ses_account"]);
  });

  it("keeps persisting on the device when the schedule read itself is refused", async () => {
    const environment = new FakeSchedule(["ses_device"]);
    environment.publicIds = new Set(["ses_device", "ses_later"]);
    environment.account = ["ses_account"];
    environment.readFailure = new PersonalScheduleUnauthenticated("authentication_required");
    const store = createPersonalScheduleStore(EVENT_ID, environment);

    await store.settle();

    expect(store.snapshot().storageStatus).toBe("device");
    expect(store.snapshot().sessionIds).toEqual(["ses_device"]);

    await store.toggle("ses_later");

    expect(store.snapshot().storageStatus).toBe("device");
    expect(JSON.parse(environment.storage.get(DEVICE_KEY)!)).toEqual(["ses_device", "ses_later"]);
    expect(environment.updates).toEqual([]);
  });
});

describe("signing out on the page", () => {
  it("drops the account's picks and returns the device's own", async () => {
    const environment = new FakeSchedule(["ses_device"]);
    environment.publicIds = new Set(["ses_device", "ses_account"]);
    environment.account = ["ses_account"];
    const store = createPersonalScheduleStore(EVENT_ID, environment);

    await store.settle();
    expect(store.snapshot().sessionIds).toEqual(["ses_account", "ses_device"]);

    environment.userId = null;
    await store.reset();

    expect(store.snapshot().storageStatus).toBe("device");
    expect(store.snapshot().sessionIds).toEqual(["ses_device"]);
    expect(JSON.parse(environment.storage.get(DEVICE_KEY)!)).toEqual(["ses_device"]);
  });

  it("ignores a load that was already in flight when the account changed", async () => {
    const environment = new FakeSchedule(["ses_device"]);
    environment.publicIds = new Set(["ses_device", "ses_account"]);
    environment.account = ["ses_account"];
    environment.pendingUserId = deferred<string | null>();
    const store = createPersonalScheduleStore(EVENT_ID, environment);

    const stale = store.settle();
    environment.pendingUserId.resolve("usr_attendee");
    environment.pendingUserId = null;
    environment.userId = null;
    const resetting = store.reset();
    await Promise.all([stale, resetting]);

    expect(store.snapshot().storageStatus).toBe("device");
    expect(store.snapshot().sessionIds).toEqual(["ses_device"]);
  });
});
