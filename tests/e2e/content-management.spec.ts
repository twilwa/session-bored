// ABOUTME: Walks a real speaker upload and comment into the organizer's filterable deliverables board.
// ABOUTME: Verifies cross-role visibility, download discovery, and phone-width containment without mocked data.
import { expect, test, type Page } from "@playwright/test";

async function signIn(page: Page, email: string, password: string, landingPath: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(new RegExp(`${landingPath}$`));
}

test("speaker and organizer discuss a delivered file from the content board", async ({ page }, testInfo) => {
  const runMarker = `${testInfo.project.name}-${Date.now()}`;
  const speakerNote = `Speaker note from ${runMarker}.`;
  const organizerNote = `Organizer response from ${runMarker}.`;
  await signIn(page, "sbek-speaker@example.com", "SbekTest!2027-spk", "/speaker");
  await expect(page.getByRole("heading", { name: "Priya Raman" })).toBeVisible();

  const slidesTask = page.locator("li.task-row", { hasText: "Upload final slides" });
  await slidesTask.locator("input[type='file']").setInputFiles("fixtures/slides.pdf");
  await expect(page.getByText("File uploaded. Task marked complete.")).toBeVisible();

  const speakerFile = page.locator(".file-history > li").filter({
    has: page.getByRole("link", { name: "slides.pdf", exact: true }),
  });
  await expect(speakerFile).toHaveCount(1);
  await speakerFile.locator(".file-comments summary").click();
  await speakerFile.getByLabel("Add a comment").fill(speakerNote);
  await speakerFile.getByRole("button", { name: "Post comment" }).click();
  await expect(speakerFile.locator(".file-comments__thread").getByText(speakerNote, { exact: true })).toBeVisible();

  await page.context().clearCookies();
  await signIn(page, "sbek-organizer@example.com", "SbekTest!2027-org", "/organizer");
  await page.goto("/organizer/content");
  await expect(page.getByRole("heading", { name: "Know what landed. Chase what didn’t." })).toBeVisible();

  await page.getByRole("button", { name: /Delivered/ }).click();
  await page.getByLabel("Search speaker, task, or file").fill("Priya");
  const delivered = page.locator("li.deliverable-card").filter({
    has: page.getByRole("link", { name: "slides.pdf", exact: true }),
  });
  await expect(delivered).toHaveCount(1);
  await expect(delivered.locator(".deliverable-card__identity strong").getByText("Priya Raman", { exact: true })).toBeVisible();
  await expect(delivered.getByRole("link", { name: "slides.pdf" })).toBeVisible();
  await delivered.locator(".file-comments summary").click();
  await expect(delivered.locator(".file-comments__thread").getByText(speakerNote, { exact: true })).toBeVisible();
  await delivered.getByLabel("Add a comment").fill(organizerNote);
  await delivered.getByRole("button", { name: "Post comment" }).click();
  await expect(delivered.locator(".file-comments__thread").getByText(organizerNote, { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: "Deliverables" })).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBe(dimensions.clientWidth);
});
