// ABOUTME: Walks the organizer embed builder and third-party iframe delivery in a real browser.
// ABOUTME: Covers widget configuration, public output, lifecycle controls, and phone-width layout.
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

async function fetchPublicJson(
  page: import("@playwright/test").Page,
  publicToken: string,
): Promise<{ status: number; payload: { embed?: { name: string; widgetType: string }; error?: string } }> {
  return page.evaluate(async (token) => {
    const response = await fetch(`/api/public/embeds/${token}.json`);
    return { status: response.status, payload: await response.json() };
  }, publicToken);
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

  const returningVisitorContext = await browser.newContext();
  const returningVisitor = await returningVisitorContext.newPage();
  await returningVisitor.goto(`/embed/${publicToken}`);
  await expect(returningVisitor.getByRole("heading", { name: initialName })).toBeVisible();
  expect(await fetchPublicJson(returningVisitor, publicToken)).toMatchObject({
    status: 200,
    payload: { embed: { name: initialName, widgetType: "sessions" } },
  });

  await embedRow.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByRole("heading", { name: "Edit embed" })).toBeVisible();
  await page.getByLabel("Name").fill(editedName);
  await page.locator(".embed-type").filter({ hasText: "Agenda" }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  const editedRow = page.getByRole("row").filter({ has: page.getByRole("button", { name: editedName, exact: true }) });
  await expect(editedRow).toBeVisible();
  const editedPayload = await (await page.request.get(`/api/public/embeds/${publicToken}.json`)).json();
  expect(editedPayload.embed).toMatchObject({ name: editedName, widgetType: "agenda" });
  expect(editedPayload.embed.config).toMatchObject({ track: "Developer Experience" });
  expect(await fetchPublicJson(returningVisitor, publicToken)).toMatchObject({
    status: 200,
    payload: { embed: { name: editedName, widgetType: "agenda" } },
  });
  await returningVisitor.goto(`/embed/${publicToken}`);
  await expect(returningVisitor.getByRole("heading", { name: editedName })).toBeVisible();
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
  expect(await fetchPublicJson(returningVisitor, publicToken)).toEqual({
    status: 404,
    payload: { error: "not_found" },
  });
  await returningVisitor.goto(`/embed/${publicToken}`);
  await expect(returningVisitor.getByRole("alert")).toHaveText("This embed is not available.");
  await returningVisitorContext.close();
});

test("embed builder remains usable at phone width", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signInAsOrganizer(page);
  await page.goto("/organizer/embeds");

  await expect(page.getByRole("heading", { name: "New embed" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save embed" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});

test("organizer styling and field choices reach the public widget in both preview sizes", async ({ page, browser }) => {
  const name = `Branded programme ${Date.now()}`;
  await signInAsOrganizer(page);
  await page.goto("/organizer/embeds");

  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Status").selectOption("published");
  await page.getByLabel("Track").selectOption({ label: "Developer Experience" });
  await page.getByRole("combobox", { name: "Format", exact: true }).selectOption({ label: "Lightning Talk (10 min)" });
  await expect(page.getByRole("combobox", { name: "Location", exact: true }).getByRole("option", { name: "Main Stage" })).toHaveCount(1);
  await page.getByLabel("Background color").fill("#123456");
  await page.getByLabel("Text color").fill("#ffffff");
  await page.getByLabel("Accent color").fill("#ffcc00");
  await page.getByLabel("Show description").uncheck();
  await page.getByLabel("Display speakers").uncheck();
  await page.getByLabel("Show location").uncheck();
  await page.getByLabel("Display event label").uncheck();
  await page.getByLabel("Show date and time").uncheck();
  await page.getByLabel("Display taxonomy").uncheck();
  await page.getByLabel("Display session kind").uncheck();
  await page.getByRole("button", { name: "Save embed" }).click();

  const preview = page.locator(".embed-preview");
  await expect(preview).toBeVisible();
  const phonePreview = page.getByRole("button", { name: "Phone preview" });
  await phonePreview.click();
  await expect(phonePreview).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await preview.boundingBox())?.width ?? 0).toBeLessThanOrEqual(390);
  const desktopPreview = page.getByRole("button", { name: "Desktop preview" });
  await desktopPreview.click();
  await expect(desktopPreview).toHaveAttribute("aria-pressed", "true");
  if ((page.viewportSize()?.width ?? 0) > 760) {
    await expect.poll(async () => (await preview.boundingBox())?.width ?? 0).toBeGreaterThan(700);
  } else {
    await expect.poll(async () => (await preview.boundingBox())?.width ?? 0).toBeLessThanOrEqual(390);
  }

  const iframeHref = await page.getByRole("link", { name: "Open iframe preview" }).getAttribute("href");
  const publicContext = await browser.newContext();
  const publicPage = await publicContext.newPage();
  await publicPage.goto(iframeHref!);
  await expect(publicPage.getByRole("heading", { name })).toBeVisible();
  await expect(publicPage.getByText("Docs That Answer Back", { exact: false })).toBeVisible();
  await expect(publicPage.locator(".embed-frame__abstract")).toHaveCount(0);
  await expect(publicPage.locator(".embed-frame__speakers")).toHaveCount(0);
  await expect(publicPage.getByText("Room TBD", { exact: true })).toHaveCount(0);
  await expect(publicPage.getByText("DevFlow Conf 2027", { exact: true })).toHaveCount(0);
  await expect(publicPage.locator(".embed-session-list__time")).toHaveCount(0);
  await expect(publicPage.locator(".embed-frame__meta")).toHaveCount(0);
  await expect(publicPage.locator("main")).toHaveCSS("background-color", "rgb(18, 52, 86)");
  await expect(publicPage.locator("main")).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(publicPage.locator(".embed-frame__header")).toHaveCSS("border-bottom-color", "rgb(255, 204, 0)");
  await publicContext.close();

  const publicToken = new URL(iframeHref!).pathname.split("/").at(-1)!;
  const embedRow = page.getByRole("row").filter({ has: page.getByRole("button", { name, exact: true }) });
  await embedRow.getByRole("button", { name: "Unpublish" }).click();
  await page.getByRole("dialog", { name: `Unpublish ${name}?` }).getByRole("button", { name: "Unpublish embed" }).click();
  expect((await page.request.get(`/api/public/embeds/${publicToken}.json`)).status()).toBe(404);
  await embedRow.getByRole("button", { name: "Publish", exact: true }).click();
  const republished = await (await page.request.get(`/api/public/embeds/${publicToken}.json`)).json();
  expect(republished.embed.config).toMatchObject({
    backgroundColor: "#123456",
    textColor: "#ffffff",
    accentColor: "#ffcc00",
    format: "Lightning Talk (10 min)",
    showDescription: false,
    showSpeakers: false,
    showLocation: false,
    showEventName: false,
    showTime: false,
    showTrack: false,
    showFormat: false,
  });
});

test("speaker widgets honor their field choices and omit session-only delivery", async ({ page, browser }) => {
  const name = `Speaker gallery ${Date.now()}`;
  await signInAsOrganizer(page);
  await page.goto("/organizer/embeds");

  await page.getByLabel("Name").fill(name);
  await page.locator(".embed-type").filter({ hasText: "Speaker gallery" }).click();
  await page.getByLabel("Status").selectOption("published");
  await page.getByLabel("Show description").uncheck();
  await page.getByLabel("Show speaker photo").uncheck();
  await page.getByLabel("Show speaker details").uncheck();
  await page.getByRole("button", { name: "Save embed" }).click();

  await expect(page.getByRole("heading", { name: "Copy your snippet" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "iCal" })).toHaveCount(0);
  const iframeHref = await page.getByRole("link", { name: "Open iframe preview" }).getAttribute("href");
  const publicContext = await browser.newContext();
  const publicPage = await publicContext.newPage();
  await publicPage.goto(iframeHref!);
  await expect(publicPage.getByRole("heading", { name })).toBeVisible();
  expect(await publicPage.locator(".embed-speakers h2").count()).toBeGreaterThan(0);
  await expect(publicPage.locator(".embed-speakers img, .embed-speakers__initials")).toHaveCount(0);
  await expect(publicPage.locator(".embed-speaker-details")).toHaveCount(0);
  await expect(publicPage.locator(".embed-speaker-bio")).toHaveCount(0);
  await publicContext.close();
});
