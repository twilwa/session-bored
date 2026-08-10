// ABOUTME: Browser coverage for the agenda, itinerary, and speaker gallery surfaces (F-10.6-10.10, F-10.14).
// ABOUTME: Runs against the real seeded fixture, which has one approved session with no time or room yet.

import { expect, test } from "@playwright/test";

test("agenda grid renders a day honestly, with TBD placements shown not hidden, and opens session detail", async ({ page }) => {
  await page.goto("/agenda");

  await expect(page.getByRole("heading", { name: "Agenda", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Thu, May 13" })).toBeVisible();
  await expect(page.getByText("Time TBD")).toBeVisible();
  await expect(page.getByText("Room TBD")).toBeVisible();

  const sessionBlock = page.locator(".agenda-grid__session", { hasText: "Docs That Answer Back" });
  await expect(sessionBlock).toBeVisible();
  await sessionBlock.click();

  const modal = page.getByRole("dialog");
  await expect(modal).toBeVisible();
  await expect(modal.getByText("Docs That Answer Back", { exact: false })).toBeVisible();
  await expect(modal.getByText("Marcus Okafor", { exact: false })).toBeVisible();

  await modal.getByRole("button", { name: "← Back" }).click();
  await expect(modal).toBeHidden();
  // ABOUTME: The back control closes the overlay in place — the same day tab and grid stay rendered underneath.
  await expect(page.getByRole("button", { name: "Thu, May 13" })).toBeVisible();
  await expect(sessionBlock).toBeVisible();
});

test("itinerary lists the day chronologically with track, title, description, time, and room", async ({ page }) => {
  await page.goto("/schedule");

  await expect(page.getByRole("heading", { name: "Schedule", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Thu, May 13" })).toBeVisible();

  const item = page.locator(".itinerary-item");
  await expect(item).toHaveCount(1);
  await expect(item).toContainText("Developer Experience");
  await expect(item).toContainText("Docs That Answer Back");
  await expect(item).toContainText("Time TBD");
  await expect(item).toContainText("Room TBD");
});

test("speaker gallery is alphabetized by surname, searches, and opens a speaker detail", async ({ page }) => {
  await page.goto("/gallery");

  await expect(page.getByRole("heading", { name: "Gallery", exact: true })).toBeVisible();
  const names = await page.locator(".gallery-card__caption h2").allTextContents();
  expect(names).toEqual(["Marcus Okafor", "Priya Raman"]);

  // ABOUTME: Priya Raman has no headshot in the fixture, so her card must fall back to initials, not break.
  const priyaCard = page.locator(".gallery-card", { hasText: "Priya Raman" });
  await expect(priyaCard.locator(".gallery-card__photo--placeholder")).toHaveText("PR");

  await page.fill('input[aria-label="Search speakers by name"]', "priya");
  await expect(page.locator(".gallery-card")).toHaveCount(1);
  await expect(page.getByText("1 of 2 speakers")).toBeVisible();

  await page.locator(".gallery-card", { hasText: "Priya Raman" }).click();
  await expect(page).toHaveURL(/\/speakers\/spk_priya_devflow_2027$/);
  await expect(page.getByRole("heading", { name: "Priya Raman", exact: true })).toBeVisible();
});

test("a session reads identically on the program, agenda, itinerary, and speaker detail surfaces", async ({ page }) => {
  await page.goto("/program");
  const programCard = page.locator(".program-session");
  await expect(programCard).toContainText("Developer Experience");
  await expect(programCard).toContainText("Docs That Answer Back: Retrieval-Grounded Documentation Sites");
  await expect(programCard).toContainText("time TBD");

  await page.goto("/agenda");
  await page.locator(".agenda-grid__session", { hasText: "Docs That Answer Back" }).click();
  const modal = page.getByRole("dialog");
  await expect(modal).toContainText("Developer Experience");
  await expect(modal).toContainText("Time TBD");
  await expect(modal).toContainText("Room TBD");
  await expect(modal).toContainText("Marcus Okafor");

  await page.goto("/schedule");
  const itineraryItem = page.locator(".itinerary-item");
  await expect(itineraryItem).toContainText("Developer Experience");
  await expect(itineraryItem).toContainText("Time TBD");
  await expect(itineraryItem).toContainText("Room TBD");

  await page.goto("/speakers/spk_marcus_devflow_2027");
  const speakerSession = page.locator(".speaker-sessions__item");
  await expect(speakerSession).toContainText("Docs That Answer Back: Retrieval-Grounded Documentation Sites");
  await expect(speakerSession).toContainText("Developer Experience");
  await expect(speakerSession).toContainText("time TBD");
});

test("agenda, itinerary, and gallery stay readable at a 375-pixel phone width", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });

  for (const path of ["/agenda", "/schedule", "/gallery"]) {
    await page.goto(path);
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width, `${path} overflows the 375px viewport`).toBeLessThanOrEqual(375);
  }
});
