// ABOUTME: Checks the agenda board's drop prediction, free-slot search, and overlap columns.
// ABOUTME: Holds the client warning to the same room and speaker rules the server counts.
import { describe, expect, it } from "vitest";
import {
  nearestFreeStart,
  overlapColumns,
  placementOf,
  predictDrop,
  shortTitle,
  timeSlots,
  zonedEpoch,
} from "../../client/pages/agenda/board.ts";
import type { AgendaSession } from "../../shared/api.ts";

const timezone = "America/Los_Angeles";
const day = "2027-05-12";
const at = (time: string) => zonedEpoch(day, time, timezone);
const formatTime = (epoch: number) =>
  new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: timezone }).format(epoch);

function session(overrides: Partial<AgendaSession> & { id: string; title: string }): AgendaSession {
  const durationMinutes = overrides.durationMinutes ?? 30;
  const startsAt = overrides.startsAt ?? null;
  return {
    startsAt,
    abstract: null,
    approvedContent: null,
    contentStatus: "draft",
    editedSinceApproval: false,
    endsAt: startsAt === null ? null : startsAt + durationMinutes * 60_000,
    publishedAt: null,
    room: null,
    scheduleStatus: startsAt === null ? "unplaced" : "placed",
    scheduledDate: startsAt === null ? null : day,
    speakers: [],
    track: null,
    ...overrides,
    durationMinutes,
    id: overrides.id as AgendaSession["id"],
  };
}

const mainStage = { id: "rm_main", name: "Main Stage" };
const room2a = { id: "rm_2a", name: "Room 2A" };
const priya = { id: "spk_priya", name: "Priya Raman" };
const marcus = { id: "spk_marcus", name: "Marcus Okafor" };

const taming = session({
  id: "ses_taming",
  title: "Taming 40-Minute CI: Incremental Builds at Monorepo Scale",
  room: mainStage,
  speakers: [priya],
  startsAt: at("10:00"),
});
const verification = session({
  id: "ses_verification",
  title: "Your AI Pair Programmer Is Lying to You",
  speakers: [priya, marcus],
  durationMinutes: 30,
});
const lightning = session({
  id: "ses_docs",
  title: "Docs That Answer Back",
  durationMinutes: 10,
  speakers: [marcus],
});

describe("predictDrop", () => {
  it("says nothing clashes when the room and the speakers are free", () => {
    const prediction = predictDrop([taming, verification], verification, {
      day,
      roomId: room2a.id,
      roomName: room2a.name,
      startsAt: at("11:00"),
    }, formatTime);
    expect(prediction).toEqual({ count: 0, reasons: [] });
  });

  it("counts one room clash and one speaker clash for the same double booking", () => {
    const prediction = predictDrop([taming, verification], verification, {
      day,
      roomId: mainStage.id,
      roomName: mainStage.name,
      startsAt: at("10:00"),
    }, formatTime);
    expect(prediction.count).toBe(2);
    expect(prediction.reasons).toEqual([
      "Main Stage is taken by Taming 40-Minute CI",
      "Priya Raman is already in Main Stage at 10:00 AM",
    ]);
  });

  it("reports a speaker double booking made in a different room", () => {
    const prediction = predictDrop([taming, verification], verification, {
      day,
      roomId: room2a.id,
      roomName: room2a.name,
      startsAt: at("10:00"),
    }, formatTime);
    expect(prediction.count).toBe(1);
    expect(prediction.reasons).toEqual(["Priya Raman is already in Main Stage at 10:00 AM"]);
  });

  it("names every session already holding the room", () => {
    const alsoMain = session({
      id: "ses_keynote",
      title: "Everything Is a Build Graph",
      room: mainStage,
      speakers: [marcus],
      startsAt: at("10:00"),
    });
    const prediction = predictDrop([taming, alsoMain, lightning], lightning, {
      day,
      roomId: mainStage.id,
      roomName: mainStage.name,
      startsAt: at("10:00"),
    }, formatTime);
    expect(prediction.count).toBe(3);
    expect(prediction.reasons[0]).toBe("Main Stage is taken by Taming 40-Minute CI and Everything Is a Build Graph");
    expect(prediction.reasons).toContain("Marcus Okafor is already in Main Stage at 10:00 AM");
  });

  it("ignores a session that only touches the edge of the slot", () => {
    const prediction = predictDrop([taming, verification], verification, {
      day,
      roomId: mainStage.id,
      roomName: mainStage.name,
      startsAt: at("10:30"),
    }, formatTime);
    expect(prediction).toEqual({ count: 0, reasons: [] });
  });

  it("ignores the session being moved and anything not on the board", () => {
    const unplacedRival = session({ id: "ses_idle", title: "Local-First Dev Environments", speakers: [priya] });
    const prediction = predictDrop([taming, unplacedRival], taming, {
      day,
      roomId: mainStage.id,
      roomName: mainStage.name,
      startsAt: at("10:00"),
    }, formatTime);
    expect(prediction).toEqual({ count: 0, reasons: [] });
  });

  it("sees a clash a longer session reaches into", () => {
    const workshop = session({ id: "ses_workshop", title: "Shipping Agents", durationMinutes: 120 });
    const prediction = predictDrop([taming, workshop], workshop, {
      day,
      roomId: mainStage.id,
      roomName: mainStage.name,
      startsAt: at("09:00"),
    }, formatTime);
    expect(prediction.count).toBe(1);
    expect(prediction.reasons).toEqual(["Main Stage is taken by Taming 40-Minute CI"]);
  });
});

describe("nearestFreeStart", () => {
  const candidates = timeSlots.map((time) => at(time));

  it("offers the closest free start after the one that clashes", () => {
    const clashing = session({
      id: "ses_verification",
      title: "Your AI Pair Programmer Is Lying to You",
      room: mainStage,
      speakers: [priya, marcus],
      startsAt: at("10:00"),
    });
    const free = nearestFreeStart(
      [taming, clashing],
      clashing,
      { day, roomId: mainStage.id, roomName: mainStage.name },
      candidates,
      formatTime,
    );
    expect(free).toBe(at("10:30"));
  });

  it("starts an unplaced session after the room's last session, not at the top of the day", () => {
    const free = nearestFreeStart(
      [taming, lightning],
      lightning,
      { day, roomId: mainStage.id, roomName: mainStage.name },
      candidates,
      formatTime,
    );
    expect(free).toBe(at("10:30"));
  });

  it("returns null when the room has no free start left", () => {
    const wall = timeSlots.map((time, index) =>
      session({
        id: `ses_wall_${index}`,
        title: `Filler ${index}`,
        room: mainStage,
        startsAt: at(time),
        durationMinutes: 30,
      })
    );
    const free = nearestFreeStart(
      [...wall, lightning],
      lightning,
      { day, roomId: mainStage.id, roomName: mainStage.name },
      candidates,
      formatTime,
    );
    expect(free).toBeNull();
  });
});

describe("overlapColumns", () => {
  it("puts two clashing sessions in the same room side by side", () => {
    const rival = session({
      id: "ses_verification",
      title: "Your AI Pair Programmer Is Lying to You",
      room: mainStage,
      startsAt: at("10:00"),
    });
    const columns = overlapColumns([taming, rival]);
    expect(columns.get("ses_taming")).toEqual({ index: 0, count: 2 });
    expect(columns.get("ses_verification")).toEqual({ index: 1, count: 2 });
  });

  it("leaves a session that clashes with nothing at full width", () => {
    const later = session({ id: "ses_later", title: "Provisioning Without Tickets", room: mainStage, startsAt: at("11:00") });
    const columns = overlapColumns([taming, later]);
    expect(columns.get("ses_taming")).toEqual({ index: 0, count: 1 });
    expect(columns.get("ses_later")).toEqual({ index: 0, count: 1 });
  });

  it("keeps different rooms independent", () => {
    const elsewhere = session({ id: "ses_elsewhere", title: "Evals as a Build Step", room: room2a, startsAt: at("10:00") });
    const columns = overlapColumns([taming, elsewhere]);
    expect(columns.get("ses_taming")).toEqual({ index: 0, count: 1 });
    expect(columns.get("ses_elsewhere")).toEqual({ index: 0, count: 1 });
  });

  it("splits a cluster a long session drags two others into", () => {
    const workshop = session({ id: "ses_workshop", title: "Shipping Agents", room: mainStage, startsAt: at("09:30"), durationMinutes: 120 });
    const late = session({ id: "ses_late", title: "Provisioning Without Tickets", room: mainStage, startsAt: at("11:00") });
    const columns = overlapColumns([workshop, taming, late]);
    expect(columns.get("ses_workshop")?.count).toBe(3);
    expect(columns.get("ses_taming")?.count).toBe(3);
    expect(columns.get("ses_late")?.count).toBe(3);
    const indexes = ["ses_workshop", "ses_taming", "ses_late"].map((id) => columns.get(id)?.index);
    expect(new Set(indexes).size).toBe(3);
  });
});

describe("placementOf", () => {
  it("hands back a placed session's exact slot so Undo can restore it", () => {
    expect(placementOf(taming)).toEqual({
      scheduleStatus: "placed",
      scheduledDate: day,
      roomId: mainStage.id,
      startsAt: at("10:00"),
    });
  });

  it("keeps the day of a session whose time and room are TBD", () => {
    const tbd = session({ id: "ses_tbd", title: "Docs That Answer Back", scheduleStatus: "tbd", scheduledDate: day });
    expect(placementOf(tbd)).toEqual({ scheduleStatus: "tbd", scheduledDate: day });
  });

  it("reports an inbox session as unplaced", () => {
    expect(placementOf(lightning)).toEqual({ scheduleStatus: "unplaced" });
  });
});

describe("shortTitle", () => {
  it("keeps the part before the colon", () => {
    expect(shortTitle("Taming 40-Minute CI: Incremental Builds at Monorepo Scale")).toBe("Taming 40-Minute CI");
  });

  it("truncates a long title that has no colon", () => {
    expect(shortTitle("Everything You Ever Wanted To Know About Incremental Build Graphs")).toBe(
      "Everything You Ever Wanted To Know Abo…",
    );
  });
});
