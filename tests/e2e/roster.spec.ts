// ABOUTME: Exercises the organizer roster, bulk assignment, and missing-information worklist in a real browser.
// ABOUTME: Confirms the seeded event exposes a complete morning chase workflow without mocked requests.
import { expect, test } from "@playwright/test";

test("organizer assigns a file request in bulk and sees who needs chasing", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("sbek-organizer@example.com");
  await page.getByLabel("Password").fill("SbekTest!2027-org");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/organizer$/);
  await expect(page.getByRole("heading", { name: "DevFlow Conf 2027" })).toBeVisible();

  await page.goto("/organizer/disposition");
  const proposalRow = page.getByRole("row", { name: /Taming 40-Minute CI/ });
  const decision = proposalRow.getByRole("combobox");
  if (await decision.inputValue() !== "accepted") {
    await decision.selectOption("accepted");
    await expect(page.getByText("1 decision saved silently.")).toBeVisible();
  }
  await expect(proposalRow.getByText("active", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Speakers", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Speaker roster." })).toBeVisible();
  await expect(page.getByText("Priya Raman", { exact: true })).toBeVisible();
  await expect(page.getByText("Marcus Okafor", { exact: true })).toBeVisible();
  await page.getByLabel("Search speakers").fill("Marcus");
  await expect(page.getByText("Priya Raman", { exact: true })).toHaveCount(0);
  await page.getByLabel("Search speakers").fill("");

  await page.getByRole("link", { name: "Tasks", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Onboarding." })).toBeVisible();
  await page.getByLabel("Task kind").selectOption("file_request");
  await page.getByLabel("Task title").fill("Upload accessibility-ready slides");
  await page.getByLabel("Due date").fill("2026-01-15");
  await page.getByLabel(/Priya Raman/).check();
  await page.getByLabel(/Marcus Okafor/).check();
  await page.getByRole("button", { name: "Assign to 2 speakers" }).click();
  await expect(page.getByRole("status")).toContainText("assigned to 2 speakers");

  await page.getByRole("link", { name: "Missing info", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "Morning check." })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Who still owes us something?" })).toBeVisible();
  await expect(page.getByText("Priya Raman", { exact: true })).toBeVisible();
  await expect(page.getByText("Headshot", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Upload accessibility-ready slides", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/days overdue/).first()).toBeVisible();
});
