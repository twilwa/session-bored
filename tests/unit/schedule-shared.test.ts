// ABOUTME: Unit tests for the agenda-grid and itinerary helpers in client/pages/public/shared.ts.
// ABOUTME: Pure functions; covers missing time, missing room, and double-booked slots without a DOM.
import { describe, expect, it } from "vitest";
import type { PublicSessionCard } from "../../shared/api.ts";
import {
  agendaCellKey,
  buildAgendaGrid,
  formatFullDateTime,
  formatTimeRange,
  groupSessionsByDay,
  sortSessionsChronologically,
} from "../../client/pages/public/shared.ts";

function session(overrides: Partial<PublicSessionCard> & { id: string }): PublicSessionCard {
  return {
    id: overrides.id,
    title: overrides.title ?? `Session ${overrides.id}`,
    abstract: overrides.abstract ?? null,
    track: overrides.track ?? null,
    format: overrides.format ?? null,
    room: overrides.room ?? null,
    scheduledDate: overrides.scheduledDate ?? null,
    startsAt: overrides.startsAt ?? null,
    endsAt: overrides.endsAt ?? null,
    scheduleStatus: overrides.scheduleStatus ?? "unplaced",
    speakers: overrides.speakers ?? [],
  };
}

const T1 = new Date("2027-05-13T14:00:00Z").getTime();
const T1_END = new Date("2027-05-13T14:30:00Z").getTime();
const T2 = new Date("2027-05-13T15:00:00Z").getTime();

describe("formatTimeRange", () => {
  it("renders TBD when either bound is missing", () => {
    expect(formatTimeRange(null, null, "UTC")).toBe("Time TBD");
    expect(formatTimeRange(T1, null, "UTC")).toBe("Time TBD");
    expect(formatTimeRange(null, T1_END, "UTC")).toBe("Time TBD");
  });

  it("renders a full start-end range in UTC", () => {
    expect(formatTimeRange(T1, T1_END, "UTC")).toMatch(/2:00 PM–2:30 PM/i);
  });

  it("renders the range in the event's own timezone on the itinerary, not UTC", () => {
    // ABOUTME: T1 (14:00Z) is 7:00 AM in Los Angeles during daylight time (UTC-7) — the itinerary
    // card must show the local start time an attendee would actually see, not the UTC instant.
    expect(formatTimeRange(T1, T1_END, "America/Los_Angeles")).toMatch(/7:00 AM–7:30 AM/i);
  });
});

describe("formatFullDateTime", () => {
  const CLOSE_AT = new Date("2027-04-30T23:59:59Z").getTime();

  it("renders the full instant in UTC", () => {
    expect(formatFullDateTime(CLOSE_AT, "UTC")).toMatch(/April 30, 2027.*11:59 PM.*UTC/);
  });

  it("renders a non-UTC event's deadline in its own timezone, not UTC — a 7-hour shift for PDT", () => {
    // ABOUTME: 23:59:59Z on April 30 is 4:59 PM the same day in Los Angeles during daylight time
    // (UTC-7). Rendering this in UTC instead of the event's zone is exactly the deadline defect:
    // it reads 11:59 PM, seven hours later than the instant a Pacific-time submitter actually sees.
    expect(formatFullDateTime(CLOSE_AT, "America/Los_Angeles")).toMatch(/April 30, 2027.*4:59 PM.*PDT/);
  });
});

describe("groupSessionsByDay", () => {
  it("buckets sessions by scheduledDate and separates fully unscheduled ones", () => {
    const sessions = [
      session({ id: "a", scheduledDate: "2027-05-13" }),
      session({ id: "b", scheduledDate: "2027-05-13" }),
      session({ id: "c", scheduledDate: "2027-05-14" }),
      session({ id: "d", scheduledDate: null }),
    ];
    const { byDay, unscheduled } = groupSessionsByDay(sessions);
    expect(byDay.get("2027-05-13")?.map((s) => s.id)).toEqual(["a", "b"]);
    expect(byDay.get("2027-05-14")?.map((s) => s.id)).toEqual(["c"]);
    expect(unscheduled.map((s) => s.id)).toEqual(["d"]);
  });
});

describe("sortSessionsChronologically", () => {
  it("orders by start time ascending", () => {
    const sessions = [
      session({ id: "late", startsAt: T2 }),
      session({ id: "early", startsAt: T1 }),
    ];
    expect(sortSessionsChronologically(sessions).map((s) => s.id)).toEqual(["early", "late"]);
  });

  it("sorts TBD-time sessions last, ordered by title", () => {
    const sessions = [
      session({ id: "tbd-b", title: "B talk", startsAt: null }),
      session({ id: "timed", startsAt: T1 }),
      session({ id: "tbd-a", title: "A talk", startsAt: null }),
    ];
    expect(sortSessionsChronologically(sessions).map((s) => s.id)).toEqual(["timed", "tbd-a", "tbd-b"]);
  });
});

describe("buildAgendaGrid", () => {
  const eventRooms = ["Main Stage", "Room 2A", "Room 2B", "Workshop Lab"];

  it("places a fully-scheduled session at its exact time and room cell", () => {
    const sessions = [session({ id: "a", startsAt: T1, endsAt: T1_END, room: "Main Stage" })];
    const grid = buildAgendaGrid(sessions, eventRooms, "UTC");
    expect(grid.rows.map((r) => r.label)).toEqual(["2:00 PM"]);
    expect(grid.columns.map((c) => c.label)).toEqual(["Main Stage"]);
    expect(grid.cells.get(agendaCellKey(String(T1), "Main Stage"))?.map((s) => s.id)).toEqual(["a"]);
  });

  it("gives sessions with no start time an honest Time TBD row instead of inventing one", () => {
    const sessions = [session({ id: "a", startsAt: null, room: "Main Stage" })];
    const grid = buildAgendaGrid(sessions, eventRooms, "UTC");
    expect(grid.rows.map((r) => r.label)).toEqual(["Time TBD"]);
    expect(grid.cells.get(agendaCellKey("tbd", "Main Stage"))?.map((s) => s.id)).toEqual(["a"]);
  });

  it("gives sessions with no room an honest Room TBD column instead of inventing one", () => {
    const sessions = [session({ id: "a", startsAt: T1, endsAt: T1_END, room: null })];
    const grid = buildAgendaGrid(sessions, eventRooms, "UTC");
    expect(grid.columns.map((c) => c.label)).toEqual(["Room TBD"]);
    expect(grid.cells.get(agendaCellKey(String(T1), "tbd"))?.map((s) => s.id)).toEqual(["a"]);
  });

  it("degrades gracefully when a session has neither a time nor a room", () => {
    const sessions = [session({ id: "a", startsAt: null, room: null })];
    const grid = buildAgendaGrid(sessions, eventRooms, "UTC");
    expect(grid.rows.map((r) => r.label)).toEqual(["Time TBD"]);
    expect(grid.columns.map((c) => c.label)).toEqual(["Room TBD"]);
    expect(grid.cells.get(agendaCellKey("tbd", "tbd"))?.map((s) => s.id)).toEqual(["a"]);
  });

  it("keeps multiple rooms ordered per the event's room list and stacks double-booked sessions in one cell", () => {
    const sessions = [
      session({ id: "a", startsAt: T1, endsAt: T1_END, room: "Room 2A" }),
      session({ id: "b", startsAt: T1, endsAt: T1_END, room: "Main Stage" }),
      session({ id: "c", startsAt: T1, endsAt: T1_END, room: "Main Stage" }),
    ];
    const grid = buildAgendaGrid(sessions, eventRooms, "UTC");
    expect(grid.columns.map((c) => c.label)).toEqual(["Main Stage", "Room 2A"]);
    expect(grid.cells.get(agendaCellKey(String(T1), "Main Stage"))?.map((s) => s.id)).toEqual(["b", "c"]);
  });

  it("sorts multiple time rows ascending", () => {
    const sessions = [
      session({ id: "late", startsAt: T2, room: "Main Stage" }),
      session({ id: "early", startsAt: T1, room: "Main Stage" }),
    ];
    const grid = buildAgendaGrid(sessions, eventRooms, "UTC");
    expect(grid.rows.map((r) => r.label)).toEqual(["2:00 PM", "3:00 PM"]);
  });

  it("labels time rows in the event's own timezone on the agenda grid, not UTC", () => {
    // ABOUTME: T1/T2 (14:00Z/15:00Z) are 7:00/8:00 AM in Los Angeles during daylight time
    // (UTC-7) — the grid's time gutter must show the local hour an attendee would walk in for.
    const sessions = [
      session({ id: "early", startsAt: T1, endsAt: T1_END, room: "Main Stage" }),
      session({ id: "late", startsAt: T2, room: "Main Stage" }),
    ];
    const grid = buildAgendaGrid(sessions, eventRooms, "America/Los_Angeles");
    expect(grid.rows.map((r) => r.label)).toEqual(["7:00 AM", "8:00 AM"]);
  });
});
