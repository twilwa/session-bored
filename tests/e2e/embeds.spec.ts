// ABOUTME: Walks the organizer embed builder and third-party iframe delivery in a real browser.
// ABOUTME: Covers the five-widget selector, published snippet output, and phone-width layout.
import { expect, test } from "@playwright/test";

async function signInAsOrganizer(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill("sbek-organizer@example.com");
  await page.getByLabel("Password").fill("SbekTest!2027-org");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/organizer/);
}

function publicDeliveryPaths(publicToken: string): string[] {
  return [
    // The extensionless public read is the iframe document's data request.
    `/api/public/embeds/${publicToken}`,
    `/api/public/embeds/${publicToken}.json`,
    `/api/public/embeds/${publicToken}.ics`,
    `/embed/${publicToken}.js`,
  ];
}

async function expectPublicDeliveryStatus(
  page: import("@playwright/test").Page,
  publicToken: string,
  status: number,
): Promise<void> {
  for (const path of publicDeliveryPaths(publicToken)) {
    expect((await page.request.get(path)).status(), path).toBe(status);
  }
}

test("organizer manages the full embed lifecycle without leaving a live token", async ({ page, context, browser }) => {
  const runId = Date.now();
  const initialName = `Homepage programme ${runId}`;
  const editedName = `Homepage agenda ${runId}`;
  await signInAsOrganizer(page);
  await page.goto("/organizer/embeds");

  await expect(page.getByRole("heading", { name: "Put the programme on your own site." })).toBeVisible();
  for (const label of ["Sessions list", "Speakers list", "Agenda", "Itinerary", "Speaker gallery"]) {
    await expect(page.locator(".embed-type").filter({ hasText: label })).toBeVisible();
  }
  await page.getByLabel("Name").fill(initialName);
  await page.getByLabel("Track").selectOption({ label: "Developer Experience" });
  await page.getByRole("button", { name: "Save embed" }).click();

  await expect(page.getByRole("heading", { name: "Copy your snippet" })).toBeVisible();
  await expect(page.getByText("Draft · public URLs return 404")).toBeVisible();
  const iframeHref = await page.getByRole("link", { name: "Open iframe preview" }).getAttribute("href");
  const scriptHref = await page.getByRole("link", { name: "Open script" }).getAttribute("href");
  const iframeUrl = new URL(iframeHref!);
  const scriptUrl = new URL(scriptHref!);
  const publicToken = iframeUrl.pathname.split("/").at(-1)!;
  expect(iframeUrl.pathname).toMatch(/^\/embed\/emb_/);
  expect(scriptUrl.pathname).toMatch(/^\/embed\/emb_.*\.js$/);
  await expectPublicDeliveryStatus(page, publicToken, 404);

  const embedRow = page.getByRole("row").filter({ has: page.getByRole("button", { name: initialName, exact: true }) });
  await embedRow.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(embedRow.getByText("published", { exact: true })).toBeVisible();
  await expectPublicDeliveryStatus(page, publicToken, 200);

  const host = await context.newPage();
  await host.setContent(`<main><h1>Our programme</h1><script src="${scriptUrl.href}" async></script><div id="greenroom-${iframeUrl.pathname.split("/").at(-1)}"></div></main>`);
  const frame = host.frameLocator(`iframe[title='Greenroom ${initialName}']`);
  await expect(frame.getByText("Docs That Answer Back", { exact: false })).toBeVisible();
  await host.close();

  await embedRow.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByRole("heading", { name: "Edit embed" })).toBeVisible();
  await page.getByLabel("Name").fill(editedName);
  await page.locator(".embed-type").filter({ hasText: "Agenda" }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  const editedRow = page.getByRole("row").filter({ has: page.getByRole("button", { name: editedName, exact: true }) });
  await expect(editedRow).toBeVisible();
  const editedPayload = await (await page.request.get(`/api/public/embeds/${publicToken}.json`)).json();
  expect(editedPayload.embed).toMatchObject({ name: editedName, widgetType: "agenda" });
  expect(editedPayload.embed.config).toEqual({ track: "Developer Experience" });
  const builderPreview = page.frameLocator(`iframe[title='Preview ${editedName}']`);
  await expect(builderPreview.getByRole("heading", { name: editedName })).toBeVisible();
  const freshContext = await browser.newContext();
  const agendaFrame = await freshContext.newPage();
  await agendaFrame.goto(`/embed/${publicToken}`);
  const agendaSession = agendaFrame.locator(".embed-agenda__cell article", { hasText: "Docs That Answer Back" });
  await expect(agendaSession).toContainText("Marcus Okafor · Staff Developer Advocate, Cloudreach Labs");
  await freshContext.close();

  await editedRow.getByRole("button", { name: "Unpublish" }).click();
  const unpublishDialog = page.getByRole("dialog", { name: `Unpublish ${editedName}?` });
  await expect(unpublishDialog).toContainText("stops working on every site that uses it");
  await unpublishDialog.getByRole("button", { name: "Unpublish embed" }).click();
  await expect(editedRow.getByText("draft", { exact: true })).toBeVisible();
  await expectPublicDeliveryStatus(page, publicToken, 404);

  await editedRow.getByRole("button", { name: "Publish", exact: true }).click();
  await expectPublicDeliveryStatus(page, publicToken, 200);
  await editedRow.getByRole("button", { name: "Delete" }).click();
  const deleteDialog = page.getByRole("dialog", { name: `Delete ${editedName}?` });
  await expect(deleteDialog).toContainText("stops working on every site that uses it");
  await expect(deleteDialog).toContainText("token cannot be restored");
  await deleteDialog.getByRole("button", { name: "Delete embed" }).click();
  await expect(editedRow).toBeHidden();
  await expectPublicDeliveryStatus(page, publicToken, 404);
});

test("embed builder remains usable at phone width", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signInAsOrganizer(page);
  await page.goto("/organizer/embeds");

  await expect(page.getByRole("heading", { name: "New embed" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save embed" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});
