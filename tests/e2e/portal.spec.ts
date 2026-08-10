// ABOUTME: Exercises the speaker portal in a real browser against the seeded speaker Priya Raman.
// ABOUTME: Confirms bio, headshot, and file uploads mark the matching onboarding task complete.
import { expect, test } from "@playwright/test";

test("speaker manages their own bio, headshot, and files end to end", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("sbek-speaker@example.com");
  await page.getByLabel("Password").fill("SbekTest!2027-spk");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Priya Raman" })).toBeVisible();

  await page.getByLabel("Bio").fill("Updated bio from the browser test.");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByText("Profile saved.")).toBeVisible();

  const bioTask = page.locator("li.task-row", { hasText: "Complete bio and profile" });
  await expect(bioTask.getByText("completed", { exact: true })).toBeVisible();

  await page.locator(".headshot-picker input[type='file']").setInputFiles("fixtures/headshot.png");
  await expect(page.getByText("Headshot uploaded.")).toBeVisible();
  await expect(page.getByRole("img", { name: "Priya Raman headshot" })).toBeVisible();

  const headshotTask = page.locator("li.task-row", { hasText: "Upload headshot" });
  await expect(headshotTask.getByText("completed", { exact: true })).toBeVisible();

  const slidesTask = page.locator("li.task-row", { hasText: "Upload final slides" });
  await slidesTask.locator("input[type='file']").setInputFiles("fixtures/slides.pdf");
  await expect(page.getByText("File uploaded. Task marked complete.")).toBeVisible();
  await expect(slidesTask.getByText("completed", { exact: true })).toBeVisible();
  await expect(slidesTask.getByText("slides.pdf")).toBeVisible();
});

test("a speaker never sees another speaker's tasks", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("sbek-speaker2@example.com");
  await page.getByLabel("Password").fill("SbekTest!2027-spk2");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("heading", { name: "Marcus Okafor" })).toBeVisible();
  // Onboarding task titles like "Upload headshot" are shared defaults assigned to every
  // accepted speaker (see disposition.ts's defaultOnboardingTasks), so their presence on
  // Marcus's own portal is expected and not a signal of leakage. What must never appear on
  // his portal is anything identifying Priya specifically.
  await expect(page.getByText("Priya Raman", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("img", { name: "Priya Raman headshot" })).toHaveCount(0);
});
