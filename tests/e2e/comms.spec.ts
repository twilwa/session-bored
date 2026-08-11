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
  await expect(page.getByText("Messages are drafted for review, never sent automatically.")).toBeVisible();

  await page.getByRole("button", { name: "Draft reminders for overdue tasks" }).click();
  await expect(page.getByText(/reminder draft.* queued for review\./)).toBeVisible();

  const templatePreview = page.getByRole("region", { name: "Template preview" });
  await templatePreview.getByRole("combobox").selectOption("portal_invitation");
  await templatePreview.getByLabel("Priya Raman <sbek-speaker@example.com>").check();
  await templatePreview.getByLabel("portalUrl").fill("https://example.test/speaker");
  await templatePreview.getByRole("button", { name: "Render preview" }).click();

  const previewResult = page.locator(".comms-preview__result");
  await expect(previewResult).toContainText("Set up your speaker portal for DevFlow Conf 2027");
  await expect(previewResult).toContainText("Hi Priya Raman");
  await expect(previewResult).toContainText("speaker for DevFlow Conf 2027");
});

test("organizer authors, previews, and queues a template without leaving Communications", async ({ page }) => {
  const templateName = `Arrival logistics ${Date.now()}`;
  const expectedSubject = `Arrival details ${templateName} for DevFlow Conf 2027`;
  await page.goto("/login");
  await page.getByLabel("Email").fill("sbek-organizer@example.com");
  await page.getByLabel("Password").fill("SbekTest!2027-org");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("link", { name: "Communications" }).click();

  await page.getByRole("button", { name: "New template" }).click();
  await page.getByLabel("Template name").fill(templateName);
  await page.getByLabel("Subject template").fill(`Arrival details ${templateName} for {{eventName}}`);
  await page.getByLabel("Body template").fill("Hi {{recipientName}}, meet us at {{meetingPoint}}.");
  await page.getByRole("button", { name: "Create template" }).click();

  const templatePreview = page.getByRole("region", { name: "Template preview" });
  await expect(templatePreview.getByRole("combobox", { name: "Template" })).toHaveValue(/tmpl_/);
  await expect(templatePreview.getByText("Event template · editable")).toBeVisible();
  await templatePreview.getByLabel("Priya Raman <sbek-speaker@example.com>").check();
  await templatePreview.getByRole("button", { name: "Render preview" }).click();
  await expect(page.getByRole("status")).toContainText("Missing merge fields: meetingPoint");

  await templatePreview.getByLabel("meetingPoint").fill("the north lobby");
  await templatePreview.getByRole("button", { name: "Render preview" }).click();
  await expect(page.getByRole("status")).not.toContainText("Missing merge fields");
  await expect(templatePreview).toContainText(expectedSubject);
  await expect(templatePreview).toContainText("Hi Priya Raman, meet us at the north lobby.");

  await templatePreview.getByRole("button", { name: "Queue 1 draft" }).click();
  await expect(page.getByRole("status")).toContainText("1 draft queued for review");
  const reviewQueue = page.getByRole("region", { name: "Message review queue" });
  const draftedMessage = reviewQueue.locator(".comms-draft").filter({
    has: page.locator(`input[value="${expectedSubject}"]`),
  });
  await expect(draftedMessage).toContainText("sbek-speaker@example.com");
  await expect(draftedMessage.getByLabel("Subject")).toHaveValue(expectedSubject);
  await expect(draftedMessage.getByLabel("Body")).toHaveValue("Hi Priya Raman, meet us at the north lobby.");
});
