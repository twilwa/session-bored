// ABOUTME: Walks the real front door in a browser: sign up, land as an attendee, get granted.
// ABOUTME: Confirms an attendee sees a readable refusal at every workspace rather than a JSON body.
import { expect, test } from "@playwright/test";

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

/** Opens the header's collapsed navigation on phone-width projects, as app-shell.spec.ts does. */
async function openMobileNavigation(page: import("@playwright/test").Page): Promise<void> {
  const menuButton = page.locator(".public-header__menu");
  if (await menuButton.isVisible()) {
    await menuButton.click();
  }
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
  // The nav names the account only once it has resolved one, so an absent switcher means
  // something. One area is a destination, not a choice: this chrome is unchanged.
  await expect(page.locator(".submitter-dashboard__identity")).toHaveText("Submitter Account");
  await expect(page.getByLabel("Switch area")).toHaveCount(0);
});

test("a new account signs up, lands on its own schedule, and reaches no workspace", async ({ page }) => {
  const email = uniqueEmail("attendee");
  await signUp(page, "Rowan Ellis", email);

  await expect(page).toHaveURL(/\/schedule\/mine$/);
  // Until the header names this account's one area it reads "Sign in" and carries no
  // switcher either way, so the resolved state has to come first.
  await expect(page.locator(".nav-signin")).toHaveText("My schedule");
  await expect(page.getByLabel("Switch area")).toHaveCount(0);

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
  const invitedEmail = uniqueEmail("prefilled-reviewer");
  await page.goto(`/signup?email=${encodeURIComponent(invitedEmail)}`);
  await expect(page.getByRole("heading", { name: "Create account" })).toBeVisible();
  await expect(page.getByLabel("Email")).toHaveValue(invitedEmail);
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
  await page.getByRole("button", { name: "Send invitation", exact: true }).click();

  await expect(page.locator(".toast")).toContainText("no email sender is connected");
  const invite = page.locator(".people-invite-list li").filter({ hasText: invited });
  await expect(invite).toBeVisible();
  await expect(invite.getByText("waiting on sign-up")).toBeVisible();
  await expect(invite.getByText("email not sent")).toBeVisible();

  const resendResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    response.url().includes("/reviewer-invites/") &&
    response.url().endsWith("/resend")
  );
  await invite.getByRole("button", { name: "Resend invitation" }).click();
  expect((await resendResponse).status()).toBe(200);
  await expect(page.locator(".toast")).toContainText("Invitation is still open, but no email sender is connected");

  // Re-entering an address that is already invited says so, and names the action just above.
  await page.getByLabel("Invite a reviewer by email").fill(invited);
  await page.getByRole("button", { name: "Send invitation", exact: true }).click();
  await expect(page.locator(".toast")).toContainText("already has an open invitation");
  await expect(page.locator(".toast")).toContainText("Resend invitation");
  await expect(page.locator(".people-invite-list li").filter({ hasText: invited })).toHaveCount(1);

  await invite.getByRole("button", { name: "Withdraw" }).click();
  await expect(page.locator(".toast")).toContainText("was withdrawn");
});

test("a slow invitation send cannot be fired twice by an impatient organizer", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("sbek-organizer@example.com");
  await page.getByLabel("Password").fill("SbekTest!2027-org");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/organizer$/);

  // The invitation POST now waits on a live provider call, so hold it open the way a slow
  // sender would and confirm the button cannot be clicked into a second invitation.
  let attempts = 0;
  let release = (): void => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/reviewer-invites", async (route) => {
    attempts += 1;
    await held;
    await route.continue();
  });

  const slowInvited = uniqueEmail("slow-invite");
  await page.goto("/organizer/people");
  await page.getByLabel("Invite a reviewer by email").fill(slowInvited);
  const send = page.getByRole("button", { name: "Send invitation", exact: true });
  await send.click();

  const sending = page.getByRole("button", { name: "Sending…", exact: true });
  await expect(sending).toBeVisible();
  await expect(sending).toBeDisabled();
  await sending.click({ force: true });

  release();
  await expect(page.locator(".toast")).toContainText("no email sender is connected");
  expect(attempts).toBe(1);
  await expect(page.locator(".people-invite-list li").filter({ hasText: slowInvited })).toHaveCount(1);
});

test("an invitation to an address that already has an account says so honestly", async ({ page }) => {
  const email = uniqueEmail("existing-account");
  await signUp(page, "Existing Account", email);
  await expect(page).toHaveURL(/\/schedule\/mine$/);
  await page.request.post("/api/auth/sign-out", { data: {} });

  await page.goto("/login");
  await page.getByLabel("Email").fill("sbek-organizer@example.com");
  await page.getByLabel("Password").fill("SbekTest!2027-org");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/organizer$/);

  await page.goto("/organizer/people");
  await page.getByLabel("Invite a reviewer by email").fill(email);
  await page.getByRole("button", { name: "Send invitation", exact: true }).click();

  await expect(page.locator(".toast")).toContainText(
    "An account already exists for",
  );
  await expect(page.locator(".toast")).toContainText("its address is not confirmed yet");
  const invite = page.locator(".people-invite-list li").filter({ hasText: email });
  await expect(invite).toBeVisible();
  // The address is unconfirmed, so there is no reviewer access to open yet.
  await expect(invite.getByText("account exists, address unconfirmed")).toBeVisible();
  await expect(invite.getByRole("button", { name: "Open reviewer access" })).toHaveCount(0);
});

test("the invitation link page greets a signed-out visitor with both paths", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("sbek-organizer@example.com");
  await page.getByLabel("Password").fill("SbekTest!2027-org");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/organizer$/);

  const invited = uniqueEmail("link-visitor");
  const created = await page.request.post("/api/events/evt_devflow_conf_2027/reviewer-invites", {
    data: { email: invited },
  });
  expect(created.status()).toBe(201);
  const inviteId = (await created.json()).invite.id as string;

  // A signed-in account that is not the invited address is told so, and offered nothing.
  await page.goto(`/invitations/${inviteId}?email=${encodeURIComponent(invited)}`);
  await expect(page.getByText(`This invitation was sent to ${invited}`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Open reviewer access" })).toHaveCount(0);

  await openMobileNavigation(page);
  await page.getByRole("button", { name: "Sign out" }).click();
  // The invitation page stays put on sign-out, so wait for the header to become signed-out.
  await expect(page.getByRole("banner").getByRole("link", { name: "Sign in" })).toBeVisible();

  await page.goto(`/invitations/${inviteId}?email=${encodeURIComponent(invited)}`);
  await expect(page.getByRole("heading", { name: /review committee/i })).toBeVisible();
  await expect(page.getByText("You've been invited to review proposals for DevFlow Conf 2027")).toBeVisible();
  const create = page.getByRole("link", { name: "Create your account" });
  await expect(create).toBeVisible();
  await expect(create).toHaveAttribute("href", `/signup?email=${encodeURIComponent(invited)}`);
  await expect(page.getByRole("main").getByRole("link", { name: "Sign in", exact: true })).toBeVisible();

  // A withdrawn invitation tells the truth instead of offering an accept.
  await page.goto("/login");
  await page.getByLabel("Email").fill("sbek-organizer@example.com");
  await page.getByLabel("Password").fill("SbekTest!2027-org");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/organizer$/);
  const withdrawn = await page.request.delete(`/api/reviewer-invites/${inviteId}`);
  expect(withdrawn.ok()).toBe(true);
  await openMobileNavigation(page);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("banner").getByRole("link", { name: "Sign in" })).toBeVisible();
  await page.goto(`/invitations/${inviteId}?email=${encodeURIComponent(invited)}`);
  await expect(page.getByText("This invitation was withdrawn by the organizer.")).toBeVisible();
});

test("the invitation link page tells a signed-in unconfirmed account to confirm first", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("sbek-organizer@example.com");
  await page.getByLabel("Password").fill("SbekTest!2027-org");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/organizer$/);

  const invited = uniqueEmail("link-unconfirmed");
  const created = await page.request.post("/api/events/evt_devflow_conf_2027/reviewer-invites", {
    data: { email: invited },
  });
  expect(created.status()).toBe(201);
  const inviteId = (await created.json()).invite.id as string;
  await openMobileNavigation(page);
  await page.getByRole("button", { name: "Sign out" }).click();

  // The invited person already signed up but never confirmed the address - the exact
  // account an emailed link used to strand, because nothing re-fires verification.
  await signUp(page, "Link Unconfirmed", invited);
  await expect(page).toHaveURL(/\/schedule\/mine$/);
  await page.goto(`/invitations/${inviteId}?email=${encodeURIComponent(invited)}`);

  await expect(page.getByText("Confirm your address to open reviewer access")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open reviewer access" })).toHaveCount(0);
  await page.getByRole("button", { name: "Resend confirmation email" }).click();
  await expect(page.locator(".toast")).toContainText("Confirmation email sent");
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
  const reviewerGrant = row.getByRole("form", { name: "Reviewer remit" });
  await expect(reviewerGrant).toBeVisible();
  await expect(reviewerGrant.getByRole("button", { name: "Grant reviewer with remit" })).toBeDisabled();
  await reviewerGrant.getByRole("group", { name: "Track remit" }).getByRole("checkbox").first().check();
  await reviewerGrant.getByRole("group", { name: "Review round" }).getByRole("checkbox").first().check();
  await reviewerGrant.getByRole("button", { name: "Grant reviewer with remit" }).click();
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
  await expect(page.getByRole("region", { name: "Your review queue" }).locator(".reviewer-row").first()).toBeVisible();

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
  await expect(page.getByText("YOUR COMMITTEE DESK")).toBeVisible();
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
