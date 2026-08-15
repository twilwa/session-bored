// ABOUTME: Exercises direct organizer session entry through the real agenda UI and Worker.
// ABOUTME: Proves the created session stays in the SPA loop and can be scheduled and published.
import { expect, test } from "@playwright/test";

test("an organizer adds, schedules, approves, and publishes a session without a CFP submission", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const title = `Opening remarks ${testInfo.project.name} ${Date.now()}`;

  await page.goto("/login");
  await page.getByLabel("Email").fill("sbek-organizer@example.com");
  await page.getByLabel("Password").fill("SbekTest!2027-org");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/organizer$/);

  await page.goto("/organizer/agenda");
  await expect(page.getByRole("heading", { level: 1, name: "DevFlow Conf 2027" })).toBeVisible();
  let documentNavigations = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) documentNavigations += 1;
  });

  await page.getByRole("button", { name: "Add session" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a session" });
  await dialog.getByLabel("Session title").fill(title);
  await dialog.getByLabel("Abstract").fill("Welcome everyone and set the programme in motion.");
  await dialog.getByLabel("Track").selectOption({ label: "AI Engineering" });
  await dialog.getByLabel("Format").selectOption({ label: "Keynote (45 min)" });
  await dialog.getByRole("button", { name: "Create session" }).click();

  await expect(dialog).toHaveCount(0);
  const directCard = page.getByRole("complementary", { name: "Inbox" }).locator("article").filter({ hasText: title });
  await expect(directCard.getByText(title, { exact: true })).toBeVisible();
  const sessionId = await directCard.getAttribute("data-session-id");
  expect(sessionId).not.toBeNull();

  const inspector = page.getByRole("region", { name: "Selected session" });
  await expect(inspector).toContainText(title);
  await page.locator(".agenda-console summary").click();
  await page.getByRole("combobox", { name: "Session", exact: true }).selectOption({ label: title });
  await page.getByRole("combobox", { name: "Day", exact: true }).selectOption("2027-05-12");
  await page.getByRole("combobox", { name: "Time", exact: true }).selectOption("09:00");
  await page.getByRole("combobox", { name: "Room", exact: true }).selectOption("rm_main_stage");
  await page.getByRole("button", { name: "Place", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("placed at 9:00 AM");

  await inspector.getByRole("button", { name: "Approve content" }).click();
  await expect(inspector).toContainText("Approved");
  await page.getByRole("button", { name: "Publish agenda" }).click();
  await expect(page.getByRole("status")).toContainText("published");
  expect(documentNavigations).toBe(0);

  await page.goto("/program");
  await expect(page.getByRole("link", { name: title, exact: false })).toBeVisible();

  const cleanupStatus = await page.evaluate(async (createdSessionId) => {
    const response = await fetch(`/api/events/evt_devflow_conf_2027/agenda/sessions/${createdSessionId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scheduleStatus: "unplaced" }),
    });
    return response.status;
  }, sessionId);
  expect(cleanupStatus).toBe(200);
});
