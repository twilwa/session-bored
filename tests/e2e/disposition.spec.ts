// ABOUTME: Exercises silent decisions and deliberate batch preview in the real organizer UI.
// ABOUTME: Confirms Greenroom never represents its queue-only dispatch as delivered email.
import { expect, test } from "@playwright/test";

test("organizer decides silently and reviews a queue-only batch", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("sbek-organizer@example.com");
  await page.getByLabel("Password").fill("SbekTest!2027-org");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("link", { name: "Disposition" }).click();

  await expect(page.getByRole("heading", { name: /Decide quietly/ })).toBeVisible();
  await expect(page.getByText("Status changes never notify speakers.")).toBeVisible();
  await expect(page.getByText("Email sender not connected")).toBeVisible();

  const proposalRow = page.getByRole("row", { name: /Taming 40-Minute CI/ });
  await proposalRow.getByRole("combobox").selectOption("accepted");
  await expect(page.getByText("1 decision saved silently.")).toBeVisible();
  await expect(proposalRow.getByText("active", { exact: true })).toBeVisible();

  await proposalRow.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Preview decision batch" }).click();
  await expect(page.getByRole("region", { name: "Decision batch preview" })).toBeVisible();
  await expect(page.getByText("No email has been sent.")).toBeVisible();
  await expect(page.getByText("Priya Raman <sbek-speaker@example.com>")).toBeVisible();
  await expect(page.getByRole("button", { name: "Dispatch to queue once" })).toBeVisible();
});
