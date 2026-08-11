// ABOUTME: Verifies organizers can discover and download every portable event export.
// ABOUTME: Exercises real browser downloads without exposing controls to other roles.
import { expect, test } from "@playwright/test";

async function signInAsOrganizer(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill("sbek-organizer@example.com");
  await page.getByLabel("Password").fill("SbekTest!2027-org");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/organizer/);
}

test("organizer exports are discoverable and download the named files", async ({ page }) => {
  await signInAsOrganizer(page);
  await page.getByRole("navigation", { name: "organizer navigation" })
    .getByRole("link", { name: "Exports", exact: true }).click();

  await expect(page).toHaveURL(/\/organizer\/exports$/);
  await expect(page.getByRole("heading", { name: "Take the whole program with you." })).toBeVisible();

  for (const [label, filename] of [
    ["Download sessions.json", "sessions.json"],
    ["Download speakers.json", "speakers.json"],
    ["Download reviews.csv", "reviews.csv"],
    ["Download schedule.ics", "schedule.ics"],
  ] as const) {
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("link", { name: label }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(filename);
  }
});
