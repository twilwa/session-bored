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

test("organizer publishes an embed that renders through its iframe script", async ({ page, context }) => {
  await signInAsOrganizer(page);
  await page.goto("/organizer/embeds");

  await expect(page.getByRole("heading", { name: "Put the programme on your own site." })).toBeVisible();
  for (const label of ["Sessions list", "Speakers list", "Agenda", "Itinerary", "Speaker gallery"]) {
    await expect(page.getByRole("button", { name: label, exact: false })).toBeVisible();
  }
  await page.getByLabel("Name").fill("Homepage programme");
  await page.getByLabel("Status").selectOption("published");
  await page.getByLabel("Track").selectOption({ label: "Developer Experience" });
  await page.getByRole("button", { name: "Save embed" }).click();

  await expect(page.getByRole("heading", { name: "Copy your snippet" })).toBeVisible();
  const iframeHref = await page.getByRole("link", { name: "Open iframe preview" }).getAttribute("href");
  const scriptHref = await page.getByRole("link", { name: "Open script" }).getAttribute("href");
  const iframeUrl = new URL(iframeHref!);
  const scriptUrl = new URL(scriptHref!);
  expect(iframeUrl.pathname).toMatch(/^\/embed\/emb_/);
  expect(scriptUrl.pathname).toMatch(/^\/embed\/emb_.*\.js$/);

  const host = await context.newPage();
  await host.setContent(`<main><h1>Our programme</h1><script src="${scriptUrl.href}" async></script><div id="greenroom-${iframeUrl.pathname.split("/").at(-1)}"></div></main>`);
  const frame = host.frameLocator("iframe[title='Greenroom Homepage programme']");
  await expect(frame.getByText("Docs That Answer Back", { exact: false })).toBeVisible();
  await host.close();
});

test("embed builder remains usable at phone width", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signInAsOrganizer(page);
  await page.goto("/organizer/embeds");

  await expect(page.getByRole("heading", { name: "New embed" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save embed" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});
