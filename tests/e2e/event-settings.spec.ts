// ABOUTME: Exercises organizer event, room, and track settings through the real Worker and browser UI.
// ABOUTME: Covers brand delivery, safe removal messaging, and desktop and phone-width layouts.
import { expect, test, type Locator, type Page } from "@playwright/test";

async function signInAsOrganizer(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill("sbek-organizer@example.com");
  await page.getByLabel("Password").fill("SbekTest!2027-org");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/organizer$/);
}

async function expandSettingsItem(dialog: Locator, itemName: string): Promise<void> {
  const showDetails = dialog.getByRole("button", { name: `Show details for ${itemName}` });
  const hideDetails = dialog.getByRole("button", { name: `Hide details for ${itemName}` });
  await expect(showDetails.or(hideDetails)).toBeVisible();
  if (await showDetails.isVisible()) await showDetails.click();
  await expect(hideDetails).toBeVisible();
}

test("organizer edits event identity, dates, venue, timezone, and branding", async ({ page }) => {
  await signInAsOrganizer(page);
  const original = await page.evaluate(async () => {
    const response = await fetch("/api/events/evt_devflow_conf_2027");
    return response.json() as Promise<Record<string, unknown>>;
  });

  try {
    await page.goto("/organizer/event");
    await expect(page.getByRole("heading", { name: "Event setup" })).toBeVisible();
    await page.getByLabel("Event name").fill("Signal Summit 2027");
    await page.getByLabel("Public slug").fill("signal-summit-2027");
    await page.getByLabel("Tagline").fill("Where production systems meet their operators.");
    await page.getByLabel("Description").fill("A practical gathering for people who run software in the real world.");
    await page.getByLabel("Start date").fill("2027-09-08");
    await page.getByLabel("End date").fill("2027-09-10");
    await page.getByLabel("Venue").fill("Pier 27, San Francisco");
    await page.getByLabel("Timezone").selectOption("America/New_York");
    await page.getByLabel("Primary color").fill("#173b57");
    await page.getByLabel("Accent color").fill("#f4b942");
    await page.getByLabel("Logo image URL").fill("https://images.example.com/signal-mark.png");
    await page.getByLabel("Background image URL").fill("https://images.example.com/signal-stage.png");
    await page.getByLabel("Upload logo image").setInputFiles("fixtures/headshot.png");
    await expect(page.getByRole("status")).toContainText("Logo image uploaded.");
    await page.getByLabel("Upload background image").setInputFiles("fixtures/headshot.png");
    await expect(page.getByRole("status")).toContainText("Background image uploaded.");
    await page.getByRole("button", { name: "Save event" }).click();

    await expect(page.getByRole("status")).toContainText("Event setup saved.");
    await expect(page.locator(".event-switcher strong")).toHaveText("Signal Summit 2027");
    await expect(page.locator(".event-switcher")).toContainText("Sep 8–10, 2027 · Pier 27, San Francisco");
    await expect(page.getByRole("img", { name: "Signal Summit 2027 logo preview" })).toBeVisible();

    await page.goto("/cfp/devflow-conf-2027");
    await expect(page.getByRole("heading", { name: "Signal Summit 2027" })).toBeVisible();
    await expect(page.getByText("Where production systems meet their operators.", { exact: true })).toBeVisible();
    await expect(page.getByRole("img", { name: "Signal Summit 2027 logo" })).toBeVisible();
    const masthead = page.locator(".cfp-masthead");
    expect(await masthead.evaluate((element) => getComputedStyle(element).getPropertyValue("--event-primary").trim()))
      .toBe("#173b57");
    await expect(masthead).toHaveCSS("background-image", /\/branding\/background/);
  } finally {
    await page.goto("/organizer");
    const restoreStatus = await page.evaluate(async (event) => {
      const response = await fetch("/api/events/evt_devflow_conf_2027", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
      });
      return response.status;
    }, original);
    expect(restoreStatus).toBe(200);
  }
});

test("organizer creates, renames, and removes a room from the agenda", async ({ page }, testInfo) => {
  const runId = `${testInfo.project.name}-${Date.now().toString(36)}`;
  const roomName = `Studio ${runId}`;
  const renamedRoomName = `Studio Three ${runId}`;
  await signInAsOrganizer(page);
  await page.goto("/organizer/agenda");

  await page.getByRole("button", { name: "Manage rooms and tracks" }).click();
  const dialog = page.getByRole("dialog", { name: "Rooms and tracks" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Add room" }).click();
  await dialog.getByLabel("Room name").fill(roomName);
  await dialog.getByRole("button", { name: "Create room" }).click();
  await expect(dialog.getByText(roomName, { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await expect(page.locator(".agenda-room-heading").getByText(roomName, { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Manage rooms and tracks" }).click();
  await expandSettingsItem(dialog, roomName);
  await dialog.getByRole("button", { name: `Edit ${roomName}` }).click();
  await dialog.getByLabel("Room name").fill(renamedRoomName);
  await dialog.getByRole("button", { name: "Save room" }).click();
  await expect(dialog.getByText(renamedRoomName, { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await expect(page.locator(".agenda-room-heading").getByText(renamedRoomName, { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Manage rooms and tracks" }).click();
  await expandSettingsItem(dialog, renamedRoomName);
  await dialog.getByRole("button", { name: `Remove ${renamedRoomName}` }).click();
  await dialog.getByRole("button", { name: "Remove room" }).click();
  await expect(dialog.getByText(renamedRoomName, { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await expect(page.locator(".agenda-room-heading").getByText(renamedRoomName, { exact: true })).toHaveCount(0);
});

test("organizer manages CFP tracks and gets reference-safe removal guidance", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const runId = `${testInfo.project.name}-${Date.now().toString(36)}`;
  const trackName = `Web Performance ${runId}`;
  const renamedTrackName = `Fast Web ${runId}`;
  await signInAsOrganizer(page);
  await page.goto("/organizer/agenda");

  await page.getByRole("button", { name: "Manage rooms and tracks" }).click();
  const dialog = page.getByRole("dialog", { name: "Rooms and tracks" });
  await dialog.getByRole("button", { name: "Add track" }).click();
  await dialog.getByLabel("Track name").fill(trackName);
  await dialog.getByRole("button", { name: "Create track" }).click();
  await expect(dialog.getByText(trackName, { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("tab", { name: "track", exact: true }).click();
  await expect(page.locator(".agenda-column-view header").getByText(trackName, { exact: true })).toBeVisible();
  await page.goto("/cfp/devflow-conf-2027");
  await expect(page.getByLabel("Track").locator("option", { hasText: trackName })).toHaveCount(1);

  await page.goto("/organizer/agenda");
  await page.getByRole("button", { name: "Manage rooms and tracks" }).click();
  await expandSettingsItem(dialog, trackName);
  await dialog.getByRole("button", { name: `Edit ${trackName}` }).click();
  await dialog.getByLabel("Track name").fill(renamedTrackName);
  await dialog.getByRole("button", { name: "Save track" }).click();
  await expect(dialog.getByText(renamedTrackName, { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await page.goto("/cfp/devflow-conf-2027");
  await expect(page.getByLabel("Track").locator("option", { hasText: renamedTrackName })).toHaveCount(1);
  await expect(page.getByLabel("Track").locator("option", { hasText: trackName })).toHaveCount(0);

  await page.goto("/organizer/agenda");
  await page.getByRole("button", { name: "Manage rooms and tracks" }).click();
  await expandSettingsItem(dialog, renamedTrackName);
  await dialog.getByRole("button", { name: `Remove ${renamedTrackName}` }).click();
  await expect(dialog).toContainText("stops offering it on the CFP");
  await dialog.getByRole("button", { name: "Remove track" }).click();
  await expect(dialog.getByRole("button", { name: "Add track" })).toBeVisible();
  await expect(dialog.getByText(renamedTrackName, { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await page.goto("/cfp/devflow-conf-2027");
  await expect(page.getByLabel("Track").locator("option", { hasText: renamedTrackName })).toHaveCount(0);

  await page.goto("/organizer/agenda");
  const setupStatus = await page.evaluate(async () => {
    const eventId = "evt_devflow_conf_2027";
    const disposition = await fetch(`/api/events/${eventId}/disposition`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ submissionIds: ["sub_ci_monorepo", "sub_ai_verification", "sub_docs_retrieval"], status: "accepted" }),
    });
    if (!disposition.ok) return disposition.status;
    const agendaResponse = await fetch(`/api/events/${eventId}/agenda`);
    if (!agendaResponse.ok) return agendaResponse.status;
    const agenda = await agendaResponse.json() as { sessions: Array<{ id: string; title: string }> };
    const docs = agenda.sessions.find((session) => session.id === "ses_docs_retrieval");
    const ci = agenda.sessions.find((session) => session.title.startsWith("Taming 40-Minute CI"));
    const ai = agenda.sessions.find((session) => session.title.startsWith("Your AI Pair Programmer"));
    if (docs === undefined || ci === undefined || ai === undefined) return 404;
    const placements = [
      [docs.id, Date.parse("2027-05-12T16:00:00Z")],
      [ci.id, Date.parse("2027-05-12T17:00:00Z")],
      [ai.id, Date.parse("2027-05-12T17:00:00Z")],
    ] as const;
    for (const [sessionId, startsAt] of placements) {
      const response = await fetch(`/api/events/${eventId}/agenda/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scheduleStatus: "placed",
          scheduledDate: "2027-05-12",
          roomId: "rm_main_stage",
          startsAt,
        }),
      });
      if (!response.ok) return response.status;
    }
    return 200;
  });
  expect(setupStatus).toBe(200);
  await page.reload();
  const slotMath = page.getByLabel("Live slot math");
  await expect(slotMath).toContainText("2 ⚠ clashes");
  await expect(page.getByRole("region", { name: "Schedule conflicts" }).locator("article")).toHaveCount(2);

  await page.getByRole("button", { name: "Manage rooms and tracks" }).click();
  const viewport = page.viewportSize();
  const dialogBox = await dialog.boundingBox();
  expect(dialogBox).not.toBeNull();
  if (viewport !== null && dialogBox !== null) {
    expect(dialogBox.x).toBeGreaterThanOrEqual(0);
    expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(viewport.width);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await expandSettingsItem(dialog, "Main Stage");
  await dialog.getByRole("button", { name: "Remove Main Stage" }).click();
  await dialog.getByRole("button", { name: "Remove room" }).click();
  await expect(dialog.getByRole("alert")).toContainText("still has 3 sessions assigned");
  await expect(dialog.getByRole("alert")).toContainText("another room or TBD");
  await dialog.getByRole("button", { name: "Back" }).click();

  await expandSettingsItem(dialog, "Platform & Infra");
  await dialog.getByRole("button", { name: "Remove Platform & Infra" }).click();
  await dialog.getByRole("button", { name: "Remove track" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Platform & Infra is used by");
  await expect(dialog.getByRole("alert")).toContainText("proposal");
  await expect(dialog.getByRole("alert")).toContainText("reviewer remit");
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await expect(slotMath).toContainText("2 ⚠ clashes");
});
