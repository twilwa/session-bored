// ABOUTME: Exercises Greenroom's committee review workflow through a real browser and D1.
// ABOUTME: Verifies the two primary sorts, durable discussion permalink, and reviewer scope.
import { expect, test } from "@playwright/test";

async function signIn(page: import("@playwright/test").Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("organizer review makes the coverage and decision sorts primary", async ({ page }) => {
  await signIn(page, "sbek-organizer@example.com", "SbekTest!2027-org");
  await page.getByRole("link", { name: "Review", exact: true }).click();

  await expect(page.getByRole("heading", { name: /Read together/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Coverage worklist/ })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: /Decision meeting/ }).click();
  await expect(page.getByRole("button", { name: /Decision meeting/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("ratings", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("No email is sent", { exact: true }).first()).toBeVisible();

  await page.getByText("Committee setup", { exact: true }).click();
  await expect(page.getByLabel("Enable optional AI reading aids")).not.toBeChecked();
  await expect(page.getByText("AI never records a score or decision.", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: /Taming 40-Minute CI/ }).click();
  await expect(page).toHaveURL(/\/organizer\/review\/submissions\/sub_ci_monorepo/);
  await expect(page.getByRole("heading", { name: /Talk it through here/ })).toBeVisible();
  await expect(page.getByText("Priya Raman", { exact: true })).toBeVisible();
});

test("reviewer opens only their remit and posts to its durable thread", async ({ page }) => {
  await signIn(page, "sbek-reviewer@example.com", "SbekTest!2027-rev");

  await expect(page.getByText("1 assigned proposal", { exact: true })).toBeVisible();
  await expect(page.getByText("Your AI Pair Programmer", { exact: false })).toHaveCount(0);
  await page.getByRole("link", { name: /Taming 40-Minute CI/ }).click();
  await expect(page).toHaveURL(/\/reviewer\/submissions\/sub_ci_monorepo/);

  const comment = `Browser committee note ${Date.now()}`;
  await page.getByLabel("Add to the committee thread").fill(comment);
  await page.getByRole("button", { name: "Post comment" }).click();
  await expect(page.getByText(comment, { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Initial review" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "AI-generated reading aid" })).toHaveCount(0);
});
