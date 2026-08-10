// ABOUTME: Exercises the organizer communications page in the real browser-rendered UI.
// ABOUTME: Confirms drafting reminders never sends anything and template preview renders real copy.
import { expect, test } from "@playwright/test";

test("organizer reviews communications without anything sending itself", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("sbek-organizer@example.com");
  await page.getByLabel("Password").fill("SbekTest!2027-org");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("link", { name: "Communications" }).click();

  await expect(page.getByRole("heading", { name: /Draft it/ })).toBeVisible();
  await expect(page.getByText("Reminders are drafted for review, never sent automatically.")).toBeVisible();

  await page.getByRole("button", { name: "Draft reminders for overdue tasks" }).click();
  await expect(page.getByText(/reminder draft.* queued for review\./)).toBeVisible();

  const templatePreview = page.getByRole("region", { name: "Template preview" });
  await templatePreview.getByRole("combobox").selectOption("portal_invitation");
  await templatePreview.getByLabel("eventName").fill("DevFlow Conf 2027");
  await templatePreview.getByLabel("recipientName").fill("Priya Raman");
  await templatePreview.getByLabel("portalUrl").fill("https://example.test/speaker");
  await templatePreview.getByRole("button", { name: "Render preview" }).click();

  const previewResult = page.locator(".comms-preview__result");
  await expect(previewResult).toContainText("Set up your speaker portal for DevFlow Conf 2027");
  await expect(previewResult).toContainText("Hi Priya Raman");
  await expect(previewResult).toContainText("speaker for DevFlow Conf 2027");
});
