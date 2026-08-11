// ABOUTME: Verifies Greenroom's public, organizer, reviewer, and speaker shells in a real browser.
// ABOUTME: Checks seeded visibility, scoped navigation, password login, and 375-pixel readability.
import { expect, test, type Route } from "@playwright/test";
import { formatFullDateTime } from "../../client/pages/public/shared.ts";

test("public CFP is populated and mobile readable", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/cfp/devflow-conf-2027");

  await expect(page.getByRole("heading", { name: "DevFlow Conf 2027" })).toBeVisible();
  await expect(page.locator(".cfp-taxonomy").getByText("AI Engineering", { exact: true })).toBeVisible();
  await expect(page.locator(".cfp-taxonomy").getByText("Workshop (120 min)", { exact: true })).toBeVisible();
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(375);
});

test("every public surface is reachable from the nav at a 375-pixel phone width", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");

  const nav = page.getByRole("navigation", { name: "Public navigation" });
  for (const label of ["Call for speakers", "Program", "Agenda", "Itinerary", "Speakers", "Gallery", "Sign in"]) {
    await expect(nav.getByRole("link", { name: label, exact: true })).toBeVisible();
  }
  expect((await page.request.get("/api/session")).status()).toBe(401);
  await expect(page.getByRole("alert")).toHaveCount(0);
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(375);
});

test("public program shows a published fixture session", async ({ page }) => {
  await page.goto("/program");

  await expect(page.getByRole("heading", { name: "DevFlow Conf 2027", exact: true })).toBeVisible();
  const sessionLink = page.getByRole("link", { name: "Docs That Answer Back", exact: false });
  await expect(sessionLink).toHaveAttribute("href", "/program/ses_docs_retrieval");
  await sessionLink.click();
  await expect(page).toHaveURL(/\/program\/ses_docs_retrieval$/);
  await expect(page.getByText("Docs That Answer Back", { exact: false })).toBeVisible();
});

test("returning to a page after leaving mid-request starts a clean load", async ({ page }) => {
  let requestCount = 0;
  const heldRequests: Route[] = [];
  const sessionsPattern = "**/api/public/events/*/sessions";
  await page.route(sessionsPattern, async (route) => {
    requestCount += 1;
    if (requestCount === 1) {
      heldRequests.push(route);
      return;
    }
    await route.continue();
  });

  try {
    await page.goto("/program");
    await expect(page.getByLabel("Loading program")).toBeVisible();

    await page.evaluate(() => {
      window.history.pushState({}, "", "/program/ses_docs_retrieval");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect.poll(() => requestCount).toBeGreaterThanOrEqual(2);
    await expect(page.getByText("Docs That Answer Back", { exact: false })).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(/\/program$/);
    await expect.poll(() => requestCount).toBeGreaterThanOrEqual(3);
    await expect(page.getByLabel("Loading program")).toHaveCount(0);
    await expect(page.getByText("Docs That Answer Back", { exact: false })).toBeVisible();
  } finally {
    await heldRequests[0]?.abort().catch(() => undefined);
    await page.unroute(sessionsPattern);
  }
});

test("organizer password opens the populated operations shell", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("sbek-organizer@example.com");
  await page.getByLabel("Password").fill("SbekTest!2027-org");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(/\/organizer/);
  await expect(page.getByRole("heading", { name: "DevFlow Conf 2027" })).toBeVisible();
  await expect(page.getByText("Taming 40-Minute CI", { exact: false })).toBeVisible();
  const cfpResponse = await page.request.get("/api/public/cfp/devflow-conf-2027");
  const cfp = await cfpResponse.json() as {
    event: { timezone: string };
    form: { closeAt: string };
  };
  await expect(page.locator(".metric-strip article").filter({ hasText: "DEADLINE" })).toContainText(
    formatFullDateTime(new Date(cfp.form.closeAt).getTime(), cfp.event.timezone),
  );
  await expect(page.getByRole("link", { name: "Call for speakers", exact: true })).toBeVisible();
  const dispositionLink = page.getByRole("link", { name: "Disposition", exact: true });
  await expect(dispositionLink).toHaveAttribute("href", "/organizer/disposition");
  await dispositionLink.click();
  await expect(page.getByRole("heading", { name: "Decide quietly. Tell deliberately." })).toBeVisible();
  for (const unavailableDestination of ["Submissions", "Sessions", "Files"]) {
    await expect(page.getByRole("link", { name: unavailableDestination, exact: true })).toHaveCount(0);
  }

  await page.goto("/program");
  const nav = page.getByRole("navigation", { name: "Public navigation" });
  await expect(nav.getByText("Jordan Alvarez", { exact: true })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Organizer area" })).toHaveAttribute("href", "/organizer");
  await nav.getByRole("link", { name: "Organizer area" }).click();
  await expect(page).toHaveURL(/\/organizer$/);

  await page.goto("/cfp/devflow-conf-2027");
  const cfpNav = page.getByRole("navigation", { name: "Public navigation" });
  await expect(cfpNav.getByRole("link", { name: "Organizer area" })).toHaveAttribute("href", "/organizer");
  const signOutResponse = page.waitForResponse("**/api/auth/sign-out");
  await cfpNav.getByRole("button", { name: "Sign out" }).click();
  expect((await signOutResponse).status()).toBe(200);
  await expect(cfpNav.getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Signed in as Jordan Alvarez" })).toHaveCount(0);
  await expect(page.locator("#cfp-speaker-email")).toBeEnabled();
  expect((await page.request.get("/api/session")).status()).toBe(401);
});

test("a failed organizer load clears loading, explains the failure, and can retry", async ({ page }) => {
  let requestCount = 0;
  await page.route("**/api/events", async (route) => {
    requestCount += 1;
    if (requestCount === 1) {
      await route.fulfill({ status: 500, body: "forced failure" });
      return;
    }
    await route.continue();
  });

  await page.goto("/login");
  await page.getByLabel("Email").fill("sbek-organizer@example.com");
  await page.getByLabel("Password").fill("SbekTest!2027-org");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("alert")).toContainText("Organizer workspace could not be loaded.");
  await expect(page.getByLabel("Loading organizer workspace")).toHaveCount(0);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "DevFlow Conf 2027" })).toBeVisible();
  expect(requestCount).toBeGreaterThanOrEqual(2);
});

test("speaker account with proposals and no portal profile links to the submitter area", async ({ page }) => {
  const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const email = `header-submitter-${unique}@example.com`;
  const signUpResponse = await page.request.post("/api/auth/sign-up/email", {
    data: { name: "Casey Submitter", email, password: "Greenroom!2027" },
  });
  expect(signUpResponse.status()).toBe(200);
  const submissionResponse = await page.request.post("/api/public/cfp/devflow-conf-2027/submissions", {
    data: {
      intent: "draft",
      speaker: { name: "Casey Submitter", email },
      proposal: { title: "A tracked draft", answers: {} },
    },
  });
  expect(submissionResponse.status()).toBe(201);

  await page.goto("/program");
  const nav = page.getByRole("navigation", { name: "Public navigation" });
  await expect(nav.getByText("Casey Submitter", { exact: true })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Submitter area" })).toHaveAttribute("href", "/submitter");
});

test("reviewer sees their review queue and no organizer navigation", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("sbek-reviewer@example.com");
  await page.getByLabel("Password").fill("SbekTest!2027-rev");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(/\/reviewer/);
  await expect(page.getByRole("region", { name: "Your review queue" })).toBeVisible();
  await expect(page.getByText("Taming 40-Minute CI", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: "Organizer" })).toHaveCount(0);

  await page.goto("/program");
  await expect(page.getByRole("navigation", { name: "Public navigation" }).getByRole("link", { name: "Reviewer area" }))
    .toHaveAttribute("href", "/reviewer");

  const response = await page.goto("/organizer");
  expect(response?.status()).toBe(403);
});

test("speaker shell shows only the signed-in speaker's work", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("sbek-speaker@example.com");
  await page.getByLabel("Password").fill("SbekTest!2027-spk");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(/\/speaker/);
  await expect(page.getByText("Priya Raman", { exact: true })).toBeVisible();
  await expect(page.getByText("Taming 40-Minute CI", { exact: false })).toBeVisible();
  await expect(page.getByText("Docs That Answer Back", { exact: false })).toHaveCount(0);

  await page.goto("/program");
  await expect(page.getByRole("navigation", { name: "Public navigation" }).getByRole("link", { name: "Speaker area" }))
    .toHaveAttribute("href", "/speaker");
});
