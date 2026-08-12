// ABOUTME: Asserts the public programme and itinerary render the same speaker line for one session.
// ABOUTME: Cross-surface speaker consistency drifts silently, so both cards are rendered and compared.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PublicSessionCard } from "../../shared/api.ts";
import { ItinerarySessionCard } from "../../client/pages/public/ItinerarySessionCard.tsx";
import { SessionCard } from "../../client/pages/public/ProgramPage.tsx";
import { formatSpeakerLine } from "../../client/pages/public/shared.ts";

const TIMEZONE = "America/Los_Angeles";

function session(overrides: Partial<PublicSessionCard> = {}): PublicSessionCard {
  return {
    id: "ses_taming_ci",
    title: "Taming 40-Minute CI: Incremental Builds at Monorepo Scale",
    abstract: "Our monorepo CI took 40 minutes on a good day.",
    track: "Platform & Infra",
    format: "Talk (30 min)",
    room: "Main Stage",
    scheduledDate: "2027-05-12",
    startsAt: new Date("2027-05-12T18:00:00Z").getTime(),
    endsAt: new Date("2027-05-12T18:30:00Z").getTime(),
    scheduleStatus: "placed",
    speakers: [
      { id: "spk_priya", name: "Priya Raman", jobTitle: "Principal Engineer", organization: "Latticework Systems" },
    ],
    ...overrides,
  };
}

function programmeMarkup(card: PublicSessionCard): string {
  return renderToStaticMarkup(createElement(SessionCard, { session: card, index: 0, timezone: TIMEZONE }));
}

function itineraryMarkup(card: PublicSessionCard): string {
  return renderToStaticMarkup(
    createElement(ItinerarySessionCard, {
      session: card,
      onOpen: () => {},
      timezone: TIMEZONE,
      saved: false,
      onToggleSaved: () => {},
    }),
  );
}

describe("public speaker line consistency", () => {
  it("shows the same speaker line on the programme and the itinerary", () => {
    const card = session();
    const expected = formatSpeakerLine(card.speakers);

    expect(expected).toBe("Priya Raman · Principal Engineer, Latticework Systems");
    expect(programmeMarkup(card)).toContain(expected);
    expect(itineraryMarkup(card)).toContain(expected);
  });

  it("agrees on a multi-speaker session, where a partial list would be the easy mistake", () => {
    const card = session({
      speakers: [
        { id: "spk_priya", name: "Priya Raman", jobTitle: "Principal Engineer", organization: "Latticework Systems" },
        { id: "spk_marcus", name: "Marcus Okafor", jobTitle: "Staff Developer Advocate", organization: "Cloudreach Labs" },
      ],
    });
    const expected = formatSpeakerLine(card.speakers);

    expect(expected).toContain("Priya Raman");
    expect(expected).toContain("Marcus Okafor");
    expect(programmeMarkup(card)).toContain(expected);
    expect(itineraryMarkup(card)).toContain(expected);
  });

  it("agrees when a session has no speakers yet", () => {
    const card = session({ speakers: [] });

    expect(programmeMarkup(card)).toContain("Speaker TBD");
    expect(itineraryMarkup(card)).toContain("Speaker TBD");
  });
});
