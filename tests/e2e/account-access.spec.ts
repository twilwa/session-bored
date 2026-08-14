// ABOUTME: Walks the real front door in a browser: sign up, land as an attendee, get granted.
// ABOUTME: Confirms an attendee sees a readable refusal at every workspace rather than a JSON body.
import { expect, test } from "@playwright/test";

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

async function signUp(page: import("@playwright/test").Page, name: string, email: string): Promise<void> {
  await page.goto("/signup");
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("Greenroom!2027");
  await page.getByRole("button", { name: "Create account" }).click();
}

test("the submitter gate explains sign-in and then admits an authenticated account", async ({ page }) => {
  const denied = await page.goto("/submitter");

  expect(denied?.status()).toBe(401);
  await expect(page.getByRole("heading", { name: "Sign in to reach the signed-in workspace." })).toBeVisible();
  await expect(page.locator("main").getByRole("link", { name: "Sign in" })).toHaveAttribute(
    "href",
    "/login?returnTo=%2Fsubmitter",
  );

  await signUp(page, "Submitter Account", uniqueEmail("submitter"));
  await expect(page).toHaveURL(/\/schedule\/mine$/);
  await page.goto("/submitter");

  await expect(page.getByRole("heading", { name: /Your proposals/ })).toBeVisible();
  await expect(page.getByText("403 · WRONG WORKSPACE")).toHaveCount(0);
  // One area is a destination, not a choice: this account's dashboard chrome is unchanged.
  await expect(page.getByLabel("Switch area")).toHaveCount(0);
});

test("a new account signs up, lands on its own schedule, and reaches no workspace", async ({ page }) => {
  const email = uniqueEmail("attendee");
  await signUp(page, "Rowan Ellis", email);

  await expect(page).toHaveURL(/\/schedule\/mine$/);
  await expect(page.getByLabel("Switch area")).toHaveCount(0);
  await expect(page.locator(".nav-signin")).toHaveText("My schedule");

  // The page said what the account would become, and the session agrees.
  const session = await page.request.get("/api/session");
  expect(session.status()).toBe(200);
  expect((await session.json()).user.role).toBe("attendee");

  for (const path of ["/organizer", "/reviewer", "/speaker"]) {
    await page.goto(path);
    await expect(page.getByText("403 · WRONG WORKSPACE")).toBeVisible();
    await expect(page.getByRole("link", { name: "My schedule" })).toBeVisible();
  }

  // Their own records stay open, which is what an account is for.
  await page.goto("/submitter");
  await expect(page.getByRole("heading", { name: /Your proposals/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No account-owned proposals yet." })).toBeVisible();
});

test("the sign-up page states the role it produces", async ({ page }) => {
  await page.goto("/signup");
  await expect(page.getByRole("heading", { name: "Create account" })).toBeVisible();
  await expect(page.locator(".signup-outcome")).toContainText("attendee");
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));
});

test("an organizer grants access from People and takes it back", async ({ page }) => {
  const email = uniqueEmail("granted");
  await signUp(page, "Rising Star", email);
  await page.request.post("/api/auth/sign-out", { data: {} });

  await page.goto("/login");
  await page.getByLabel("Email").fill("sbek-organizer@example.com");
  await page.getByLabel("Password").fill("SbekTest!2027-org");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/organizer$/);

  await page.goto("/organizer/people");
  await expect(page.getByRole("heading", { name: "People." })).toBeVisible();
  // The surface is honest about what a grant currently means.
  await expect(page.getByText("PLATFORM ACCESS / ALL EVENTS")).toBeVisible();

  await page.getByLabel("Search people").fill(email);
  const row = page.locator(".people-row").filter({ hasText: email });
  await expect(row).toBeVisible();
  await expect(row.getByText("No records")).toBeVisible();
  await expect(row.getByText("attendee", { exact: true })).toBeVisible();

  await row.getByRole("button", { name: "Grant speaker" }).click();
  await expect(page.locator(".toast")).toContainText("is now a speaker");
  await expect(row.getByText("speaker granted by Jordan Alvarez")).toBeVisible();

  await row.getByRole("button", { name: "Remove speaker" }).click();
  await expect(page.locator(".toast")).toContainText("no longer has speaker access");
  await expect(row.getByText("attendee", { exact: true })).toBeVisible();
});

test("an invitation is recorded as pending, not as access", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("sbek-organizer@example.com");
  await page.getByLabel("Password").fill("SbekTest!2027-org");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/organizer$/);

  const invited = uniqueEmail("invited-reviewer");
  await page.goto("/organizer/people");
  await page.getByLabel("Invite a reviewer by email").fill(invited);
  await page.getByRole("button", { name: "Send invitation" }).click();

  await expect(page.locator(".toast")).toContainText("once they confirm that address");
  const invite = page.locator(".people-invite-list li").filter({ hasText: invited });
  await expect(invite).toBeVisible();
  await expect(invite.getByText("waiting on confirmation")).toBeVisible();

  await invite.getByRole("button", { name: "Withdraw" }).click();
  await expect(page.locator(".toast")).toContainText("was withdrawn");
});

test("an account granted two areas can reach both of them from the header", async ({ page }) => {
  const email = uniqueEmail("two-hats");
  await signUp(page, "Wren Adeyemi", email);
  await page.waitForURL(/\/schedule\/mine$/);
  await page.request.post("/api/auth/sign-out", { data: {} });

  await page.goto("/login");
  await page.getByLabel("Email").fill("sbek-organizer@example.com");
  await page.getByLabel("Password").fill("SbekTest!2027-org");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/organizer$/);

  await page.goto("/organizer/people");
  await page.getByLabel("Search people").fill(email);
  const row = page.locator(".people-row").filter({ hasText: email });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Grant reviewer" }).click();
  await expect(page.locator(".toast")).toContainText("is now a reviewer");
  await row.getByRole("button", { name: "Grant speaker" }).click();
  await expect(page.locator(".toast")).toContainText("is now a speaker");
  await page.request.post("/api/auth/sign-out", { data: {} });

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("Greenroom!2027");
  await page.getByRole("button", { name: "Sign in" }).click();
  // The widest grant chooses the landing area; the header must expose the full union.
  await page.waitForURL(/\/reviewer$/);
  await expect(page.getByText("YOUR COMMITTEE DESK")).toBeVisible();
  const areaSwitcher = page.getByLabel("Switch area");
  await expect(areaSwitcher).toBeVisible();
  expect(await areaSwitcher.locator("option").allTextContents()).toEqual([
    "Reviewer area",
    "Speaker area",
  ]);

  await areaSwitcher.selectOption("/speaker");
  await expect(page).toHaveURL(/\/speaker$/);
  await expect(page.getByText("No speaker profile is linked to this account yet.")).toBeVisible();

  // The client route proves nothing about the gate: ask the server for the narrower
  // grant's area directly, which is where the refusal in #149 appeared.
  const speakerVisit = await page.goto("/speaker");
  expect(speakerVisit?.status()).toBe(200);
  await expect(page.getByText("403 · WRONG WORKSPACE")).toHaveCount(0);
  await expect(page.getByText("No speaker profile is linked to this account yet.")).toBeVisible();

  await page.getByLabel("Switch area").selectOption("/reviewer");
  await expect(page).toHaveURL(/\/reviewer$/);
  await expect(page.getByText("YOUR COMMITTEE DESK")).toBeVisible();

  // A public page sits outside every granted area: the switcher claims no location
  // there, and the first granted area still navigates when chosen.
  await page.goto("/program");
  const publicAreaSwitcher = page.getByLabel("Switch area");
  await expect(publicAreaSwitcher).toHaveValue("");
  expect(await publicAreaSwitcher.locator("option").allTextContents()).toEqual([
    "Go to...",
    "Reviewer area",
    "Speaker area",
  ]);
  await publicAreaSwitcher.selectOption("/reviewer");
  await expect(page).toHaveURL(/\/reviewer$/);
  await expect(page.getByText("YOUR COMMITTEE DESK")).toBeVisible();

  // The submitter dashboard is signed-in chrome of its own, and it leads back too.
  await page.goto("/submitter");
  await expect(page.getByRole("heading", { name: /Your proposals/ })).toBeVisible();
  const dashboardSwitcher = page.getByLabel("Switch area");
  await expect(dashboardSwitcher).toHaveValue("");
  expect(await dashboardSwitcher.locator("option").allTextContents()).toEqual([
    "Go to...",
    "Reviewer area",
    "Speaker area",
  ]);
  await dashboardSwitcher.selectOption("/speaker");
  await expect(page).toHaveURL(/\/speaker$/);
  await expect(page.getByText("No speaker profile is linked to this account yet.")).toBeVisible();

  // And only the two areas that were granted: the third stays shut.
  await page.goto("/organizer");
  await expect(page.getByText("403 · WRONG WORKSPACE")).toBeVisible();

  await page.goto("/reviewer");
  if (await page.getByRole("button", { name: "Open navigation" }).isVisible()) {
    await page.getByRole("button", { name: "Open navigation" }).click();
  }
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/$/);
  const denied = await page.goto("/speaker");
  expect(denied?.status()).toBe(401);
  await page.locator("main").getByRole("link", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/login\?returnTo=%2Fspeaker$/);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("Greenroom!2027");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(/\/speaker$/);
  await expect(page.getByText("No speaker profile is linked to this account yet.")).toBeVisible();
});
