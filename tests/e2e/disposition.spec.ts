// ABOUTME: Exercises silent decisions and deliberate batch preview in the real organizer UI.
// ABOUTME: Confirms Greenroom never represents its queue-only dispatch as delivered email.
import { expect, test, type Route } from "@playwright/test";

test("organizer decides silently and reviews a queue-only batch", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("sbek-organizer@example.com");
  await page.getByLabel("Password").fill("SbekTest!2027-org");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("link", { name: "Disposition", exact: true }).click();

  await expect(page.getByRole("heading", { name: /Decide quietly/ })).toBeVisible();
  await expect(page.getByText("Status changes never notify speakers.")).toBeVisible();
  await expect(page.getByText("Email sender not connected")).toBeVisible();

  const previewButton = page.getByRole("button", { name: "Preview decision batch" });
  const applyButton = page.getByRole("button", { name: "Apply silently" });
  await expect(previewButton).toBeDisabled();
  await expect(applyButton).toBeDisabled();
  await expect(previewButton).toHaveAttribute("aria-describedby", "disposition-selection-help");
  await expect(applyButton).toHaveAttribute("aria-describedby", "disposition-selection-help");
  await expect(page.getByText("Select at least one proposal to apply a decision or preview a batch.")).toBeVisible();

  const proposalRow = page.getByRole("row", { name: /Taming 40-Minute CI/ });
  await proposalRow.getByRole("combobox").selectOption("accepted");
  await expect(page.getByText("1 decision saved silently.")).toBeVisible();
  await expect(proposalRow.getByText("active", { exact: true })).toBeVisible();

  await proposalRow.getByRole("checkbox").check();
  await previewButton.click();
  await expect(page.getByRole("region", { name: "Decision batch preview" })).toBeVisible();
  await expect(page.getByText("No email has been sent.")).toBeVisible();
  await expect(page.getByText("Priya Raman <sbek-speaker@example.com>")).toBeVisible();
  const dispatchButton = page.getByRole("button", { name: "Dispatch to queue once" });
  await expect(dispatchButton).toBeVisible();

  await page.clock.install();
  let heldDispatch: Route | undefined;
  await page.route("**/decision-batches/*/dispatch", (route) => {
    heldDispatch = route;
  });

  await dispatchButton.click();
  await expect.poll(() => heldDispatch !== undefined).toBe(true);
  await page.clock.fastForward(15_001);

  await expect(dispatchButton).toBeDisabled();
  await expect(page.getByText("Request timed out. Try again.")).toHaveCount(0);

  await heldDispatch?.fulfill({
    contentType: "application/json",
    json: { queuedCount: 1, skippedCount: 0 },
    status: 200,
  });
  await expect(page.getByText("1 notice queued; 0 already queued. No email provider is connected.")).toBeVisible();
});
