// ABOUTME: Walks real speaker uploads into the organizer's filterable deliverables board and latest-file library.
// ABOUTME: Verifies cross-role comments, bulk ZIP download, and phone-width containment without mocked data.
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
  await page.locator(".headshot-picker input[type='file']").setInputFiles("fixtures/headshot.png");
  await expect(page.getByText("Headshot uploaded.")).toBeVisible();

  const slidesTask = page.locator("li.task-row", { hasText: "Upload final slides" });
  await slidesTask.locator("input[type='file']").setInputFiles("fixtures/slides.pdf");
  await expect(page.getByText("File uploaded. Task marked complete.")).toBeVisible();
  const refreshedContentPromise = page.waitForResponse((response) => (
    response.url().endsWith("/api/speaker/content") && response.status() === 200
  ));
  await slidesTask.locator("input[type='file']").setInputFiles("fixtures/slides.pdf");
  const refreshedContent = await refreshedContentPromise;
  const refreshedPayload = await refreshedContent.json() as {
    files: Array<{ displayName: string; versions: Array<{ current: boolean }> }>;
  };
  const earlierVersionCount = refreshedPayload.files
    .find((file) => file.displayName === "slides.pdf")
    ?.versions.filter((version) => !version.current).length ?? 0;
  const versionSummary = earlierVersionCount === 1
    ? "1 earlier version"
    : `${earlierVersionCount} earlier versions`;

  const speakerFile = page.locator(".file-history > li").filter({
    has: page.getByRole("link", { name: "slides.pdf", exact: true }),
  });
  await expect(speakerFile).toHaveCount(1);
  await expect(speakerFile.locator(".file-versions summary")).toHaveText(versionSummary);
  await speakerFile.locator(".file-comments summary").click();
  await speakerFile.getByLabel("Add a comment").fill(speakerNote);
  await speakerFile.getByRole("button", { name: "Post comment" }).click();
  await expect(speakerFile.locator(".file-comments__thread").getByText(speakerNote, { exact: true })).toBeVisible();

  await page.context().clearCookies();
  await signIn(page, "sbek-organizer@example.com", "SbekTest!2027-org", "/organizer");
  await page.goto("/organizer/content");
  await expect(page.getByRole("heading", { name: "Know what landed. Chase what didn’t." })).toBeVisible();
  const deliveredFilter = page.getByRole("button", { name: /^Delivered \d+$/ });
  await expect(deliveredFilter).toBeVisible();
  const headshotRequest = page.locator("li.deliverable-card", { hasText: "Upload headshot" }).filter({
    has: page.getByText("Priya Raman", { exact: true }),
  });
  await expect(headshotRequest).toContainText(/delivered/i);
  await expect(headshotRequest.getByRole("link", { name: "headshot.png", exact: true })).toBeVisible();
  await expect(headshotRequest).not.toContainText("Marked complete; no task file is attached.");

  await deliveredFilter.click();
  await expect(headshotRequest).toHaveCount(1);
  await page.getByLabel("Search speaker, task, or file").fill("Priya");
  const delivered = page.locator("li.deliverable-card").filter({
    has: page.getByRole("link", { name: "slides.pdf", exact: true }),
  });
  await expect(delivered).toHaveCount(1);
  await expect(delivered.locator(".deliverable-card__identity strong").getByText("Priya Raman", { exact: true })).toBeVisible();
  await expect(delivered.getByRole("link", { name: "slides.pdf", exact: true })).toBeVisible();
  await expect(delivered.locator(".file-versions summary")).toHaveText(versionSummary);
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

test("organizer selects a latest file and downloads its ZIP without leaving the library", async ({ page }) => {
  await signIn(page, "sbek-speaker@example.com", "SbekTest!2027-spk", "/speaker");
  const slidesTask = page.locator("li.task-row", { hasText: "Upload final slides" });
  await slidesTask.locator("input[type='file']").setInputFiles("fixtures/slides.pdf");
  await expect(page.getByText("File uploaded. Task marked complete.")).toBeVisible();

  await page.context().clearCookies();
  await signIn(page, "sbek-organizer@example.com", "SbekTest!2027-org", "/organizer");
  await page.goto("/organizer/content");
  await expect(page.getByRole("heading", { name: "Latest files" })).toBeVisible();

  const latestSlides = page.getByRole("row", { name: /slides\.pdf/i });
  await latestSlides.getByRole("checkbox", { name: "Select slides.pdf" }).check();
  const libraryUrl = page.url();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download 1 file" }).click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toBe("evt_devflow_conf_2027-files.zip");
  await expect(page).toHaveURL(libraryUrl);
  await expect(page.getByText("1 file selected")).toBeVisible();
});
