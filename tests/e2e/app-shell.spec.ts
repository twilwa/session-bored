// ABOUTME: Verifies Greenroom's public, organizer, reviewer, and speaker shells in a real browser.
// ABOUTME: Checks seeded visibility, scoped navigation, password login, and 375-pixel readability.
import { expect, test } from "@playwright/test";

test("public CFP is populated and mobile readable", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/cfp/devflow-conf-2027");

  await expect(page.getByRole("heading", { name: "DevFlow Conf 2027" })).toBeVisible();
  await expect(page.getByText("AI Engineering", { exact: true })).toBeVisible();
  await expect(page.getByText("Workshop (120 min)", { exact: true })).toBeVisible();
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(375);
});

test("public program shows an approved fixture session", async ({ page }) => {
  await page.goto("/program");

  await expect(page.getByRole("heading", { name: "DevFlow Conf 2027 program" })).toBeVisible();
  await expect(page.getByText("Docs That Answer Back", { exact: false })).toBeVisible();
});

test("organizer password opens the populated operations shell", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("sbek-organizer@example.com");
  await page.getByLabel("Password").fill("SbekTest!2027-org");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(/\/organizer/);
  await expect(page.getByRole("heading", { name: "DevFlow Conf 2027" })).toBeVisible();
  await expect(page.getByText("Taming 40-Minute CI", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: "Call for speakers", exact: true })).toBeVisible();
});

test("reviewer sees exactly one assignment and no organizer navigation", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("sbek-reviewer@example.com");
  await page.getByLabel("Password").fill("SbekTest!2027-rev");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(/\/reviewer/);
  await expect(page.getByText("1 assigned proposal", { exact: true })).toBeVisible();
  await expect(page.getByText("Taming 40-Minute CI", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: "Organizer" })).toHaveCount(0);

  const response = await page.goto("/organizer");
  expect(response?.status()).toBe(403);
});

test("speaker shell shows only the signed-in speaker's work", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("sbek-speaker@example.com");
  await page.getByLabel("Password").fill("SbekTest!2027-spk");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(/\/speaker/);
  await expect(page.getByText("Priya Raman", { exact: true })).toBeVisible();
  await expect(page.getByText("Taming 40-Minute CI", { exact: false })).toBeVisible();
  await expect(page.getByText("Docs That Answer Back", { exact: false })).toHaveCount(0);
});
