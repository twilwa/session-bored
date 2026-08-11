// ABOUTME: Browser coverage for the agenda, itinerary, and speaker gallery surfaces (F-10.6-10.10, F-10.14).
// ABOUTME: Seeds its own known placement for the fixture session via the real organizer agenda API so
// assertions don't depend on what the organizer scheduling suite (agenda.spec.ts) leaves behind in the
// shared local D1 — with playwright.config's workers: 1, e2e files run sequentially against one database.

import { expect, test, type Page } from "@playwright/test";

const EVENT_ID = "evt_devflow_conf_2027";
const DOCS_SESSION_ID = "ses_docs_retrieval";
const DOCS_SUBMISSION_ID = "sub_docs_retrieval";
const MAIN_STAGE_ROOM_ID = "rm_main_stage";
const PLACED_DAY = "2027-05-13";
// ABOUTME: 17:00Z is 10:00 AM in Los Angeles during daylight time (UTC-7) — chosen deliberately so a
// browser run proves the public surfaces render the event's own timezone, not the raw UTC instant.
const PLACED_STARTS_AT_ISO = "2027-05-13T17:00:00Z";

type Placement =
  | { scheduleStatus: "tbd"; scheduledDate: string }
  | { scheduleStatus: "placed"; scheduledDate: string; roomId: string; startsAt: number };

// ABOUTME: Signs in as organizer and drives the real disposition/agenda APIs to give the fixture's one
// approved session a known placement, then publishes it — the same effect the organizer's own
// drag-and-drop UI has, without depending on that other test file's exact day/room/time choices.
async function placeDocsSession(page: Page, placement: Placement): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill("sbek-organizer@example.com");
  await page.getByLabel("Password").fill("SbekTest!2027-org");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/organizer$/);

  const result = await page.evaluate(
    async ({ eventId, submissionId, sessionId, placement }) => {
      const disposition = await fetch(`/api/events/${eventId}/disposition`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ submissionIds: [submissionId], status: "accepted" }),
      });
      const approved = await fetch(`/api/events/${eventId}/agenda/sessions/${sessionId}/content`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contentStatus: "approved" }),
      });
      const placed = await fetch(`/api/events/${eventId}/agenda/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(placement),
      });
      const published = await fetch(`/api/events/${eventId}/agenda/publish`, { method: "POST" });
      return {
        dispositionStatus: disposition.status,
        approvalStatus: approved.status,
        placedStatus: placed.status,
        publishedStatus: published.status,
      };
    },
    { eventId: EVENT_ID, submissionId: DOCS_SUBMISSION_ID, sessionId: DOCS_SESSION_ID, placement },
  );
  expect(result.dispositionStatus, "disposition accept failed").toBe(200);
  expect(result.approvalStatus, "content approval failed").toBe(200);
  expect(result.placedStatus, "agenda placement failed").toBe(200);
  expect(result.publishedStatus, "agenda publish failed").toBe(200);
}

test("agenda grid renders a real placement with the event's own timezone, and opens session detail", async ({ page }) => {
  await placeDocsSession(page, {
    scheduleStatus: "placed",
    scheduledDate: PLACED_DAY,
    roomId: MAIN_STAGE_ROOM_ID,
    startsAt: new Date(PLACED_STARTS_AT_ISO).getTime(),
  });

  await page.goto("/agenda");
  await expect(page.getByRole("heading", { name: "Agenda", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Thu, May 13" })).toBeVisible();
  await expect(page.getByText("Main Stage", { exact: true })).toBeVisible();
  await expect(page.getByText("10:00 AM", { exact: true })).toBeVisible();

  const sessionBlock = page.locator(".agenda-grid__session", { hasText: "Docs That Answer Back" });
  await expect(sessionBlock).toBeVisible();
  await sessionBlock.click();

  const modal = page.getByRole("dialog");
  await expect(modal).toBeVisible();
  await expect(modal.getByText("Docs That Answer Back", { exact: false })).toBeVisible();
  await expect(modal).toContainText("10:00 AM–10:10 AM");
  await expect(modal).toContainText("Main Stage");
  await expect(modal.getByText("Marcus Okafor", { exact: false })).toBeVisible();

  await modal.getByRole("button", { name: "← Back" }).click();
  await expect(modal).toBeHidden();
  // ABOUTME: The back control closes the overlay in place — the same day tab and grid stay rendered underneath.
  await expect(page.getByRole("button", { name: "Thu, May 13" })).toBeVisible();
  await expect(sessionBlock).toBeVisible();
});

test("agenda grid renders an honest TBD placement without inventing a room or time", async ({ page }) => {
  await placeDocsSession(page, { scheduleStatus: "tbd", scheduledDate: PLACED_DAY });

  await page.goto("/agenda");
  await expect(page.getByRole("button", { name: "Thu, May 13" })).toBeVisible();
  await expect(page.getByText("Time TBD")).toBeVisible();
  await expect(page.getByText("Room TBD")).toBeVisible();
  await expect(page.locator(".agenda-grid__session", { hasText: "Docs That Answer Back" })).toBeVisible();
});

test("itinerary lists a real placement chronologically with track, title, description, time, and room", async ({ page }) => {
  await placeDocsSession(page, {
    scheduleStatus: "placed",
    scheduledDate: PLACED_DAY,
    roomId: MAIN_STAGE_ROOM_ID,
    startsAt: new Date(PLACED_STARTS_AT_ISO).getTime(),
  });

  await page.goto("/schedule");
  await expect(page.getByRole("heading", { name: "Schedule", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Thu, May 13" })).toBeVisible();

  const item = page.locator(".itinerary-item", { hasText: "Docs That Answer Back" });
  await expect(item).toBeVisible();
  await expect(item).toContainText("Developer Experience");
  await expect(item).toContainText("10:00 AM–10:10 AM");
  await expect(item).toContainText("Main Stage");
});

test("speaker gallery is alphabetized by surname, searches, and opens a speaker detail", async ({ page }) => {
  await page.goto("/gallery");

  await expect(page.getByRole("heading", { name: "Gallery", exact: true })).toBeVisible();
  // ABOUTME: The heading renders synchronously; the cards depend on an async fetch, so wait for
  // them to actually land before reading text — a one-shot read here raced the fetch under load.
  await expect(page.locator(".gallery-card")).toHaveCount(2);
  const names = await page.locator(".gallery-card__caption h2").allTextContents();
  expect(names).toEqual(["Marcus Okafor", "Priya Raman"]);

  // Marcus Okafor has no headshot in the fixture and no other spec ever gives him one (unlike
  // Priya, whose portal e2e coverage legitimately uploads hers), so his card is the stable one
  // to assert the no-headshot fallback against: it must render initials, not break.
  const marcusCard = page.locator(".gallery-card", { hasText: "Marcus Okafor" });
  await expect(marcusCard.locator(".gallery-card__photo--placeholder")).toHaveText("MO");
  const priyaHeadshot = page.locator(".gallery-card", { hasText: "Priya Raman" }).locator("img");
  await expect(priyaHeadshot).toHaveAttribute("src", /.+/);
  await expect.poll(() => priyaHeadshot.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

  await page.fill('input[aria-label="Search speakers by name"]', "priya");
  await expect(page.locator(".gallery-card")).toHaveCount(1);
  await expect(page.getByText("1 of 2 speakers")).toBeVisible();

  await page.locator(".gallery-card", { hasText: "Priya Raman" }).click();
  await expect(page).toHaveURL(/\/speakers\/spk_priya_devflow_2027$/);
  await expect(page.getByRole("heading", { name: "Priya Raman", exact: true })).toBeVisible();
});

test("a placed session reads identically on the program, agenda, itinerary, and speaker detail surfaces", async ({ page }) => {
  await placeDocsSession(page, {
    scheduleStatus: "placed",
    scheduledDate: PLACED_DAY,
    roomId: MAIN_STAGE_ROOM_ID,
    startsAt: new Date(PLACED_STARTS_AT_ISO).getTime(),
  });

  await page.goto("/program");
  const programCard = page.locator(".program-session", { hasText: "Docs That Answer Back" });
  await expect(programCard).toContainText("Developer Experience");
  await expect(programCard).toContainText("Docs That Answer Back: Retrieval-Grounded Documentation Sites");
  await expect(programCard).toContainText("Thu, May 13");
  await expect(programCard).toContainText("10:00 AM");
  await expect(programCard).toContainText("Main Stage");

  await page.goto("/agenda");
  await page.locator(".agenda-grid__session", { hasText: "Docs That Answer Back" }).click();
  const modal = page.getByRole("dialog");
  await expect(modal).toContainText("Developer Experience");
  await expect(modal).toContainText("10:00 AM–10:10 AM");
  await expect(modal).toContainText("Main Stage");
  await expect(modal).toContainText("Marcus Okafor");

  await page.goto("/schedule");
  const itineraryItem = page.locator(".itinerary-item", { hasText: "Docs That Answer Back" });
  await expect(itineraryItem).toContainText("Developer Experience");
  await expect(itineraryItem).toContainText("10:00 AM–10:10 AM");
  await expect(itineraryItem).toContainText("Main Stage");

  await page.goto("/speakers/spk_marcus_devflow_2027");
  const speakerSession = page.locator(".speaker-sessions__item", { hasText: "Docs That Answer Back" });
  await expect(speakerSession).toContainText("Docs That Answer Back: Retrieval-Grounded Documentation Sites");
  await expect(speakerSession).toContainText("Developer Experience");
  await expect(speakerSession).toContainText("Thu, May 13");
  await expect(speakerSession).toContainText("10:00 AM");
  await expect(speakerSession).toContainText("Main Stage");
});

test("the error-state retry control on agenda, itinerary, and gallery actually refetches", async ({ page }) => {
  // ABOUTME: Each surface's retry used to be a Link back to its own current URL, which never
  // remounts the page or reruns its fetch effect — the button must trigger a real new request.
  for (const [path, apiPattern, heading] of [
    ["/agenda", "**/api/public/events/*/sessions", "Agenda"],
    ["/schedule", "**/api/public/events/*/sessions", "Schedule"],
    ["/gallery", "**/api/public/events/*/speakers", "Gallery"],
  ] as const) {
    let requestCount = 0;
    await page.route(apiPattern, async (route) => {
      requestCount += 1;
      if (requestCount === 1) {
        await route.fulfill({ status: 500, body: "forced failure" });
      } else {
        await route.continue();
      }
    });

    await page.goto(path);
    await expect(page.getByText("could not be loaded", { exact: false })).toBeVisible();

    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await expect(page.getByText("could not be loaded", { exact: false })).toHaveCount(0);
    expect(requestCount, `${path} retry did not send a second request`).toBeGreaterThanOrEqual(2);

    await page.unroute(apiPattern);
  }
});

test("agenda, itinerary, and gallery stay readable at a 375-pixel phone width", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });

  for (const path of ["/agenda", "/schedule", "/gallery"]) {
    await page.goto(path);
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width, `${path} overflows the 375px viewport`).toBeLessThanOrEqual(375);
  }
});
