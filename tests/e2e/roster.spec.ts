// ABOUTME: Exercises the organizer roster, bulk assignment, and missing-information worklist in a real browser.
// ABOUTME: Confirms the seeded event exposes a complete morning chase workflow without mocked requests.
import { expect, test } from "@playwright/test";

async function signInAsOrganizer(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill("sbek-organizer@example.com");
  await page.getByLabel("Password").fill("SbekTest!2027-org");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/organizer$/);
}

test("organizer sees sessionless onboarding assignments in the chase list", async ({ page }) => {
  await signInAsOrganizer(page);

  await page.goto("/organizer/roster");
  const rosterResponse = await page.request.get("/api/events/evt_devflow_conf_2027/roster");
  const roster = await rosterResponse.json() as {
    items: Array<{ id: string; taskSummary: { total: number; incomplete: number } }>;
  };
  const priyaRoster = roster.items.find((speaker) => speaker.id === "spk_priya_devflow_2027");
  expect(priyaRoster).toBeDefined();
  const priyaRosterRow = page.getByRole("row", { name: /Priya Raman/ });
  await expect(priyaRosterRow).toContainText(
    `${priyaRoster?.taskSummary.incomplete} / ${priyaRoster?.taskSummary.total} tasks`,
  );

  await page.getByRole("navigation", { name: "Speaker operations" })
    .getByRole("link", { name: "Missing info", exact: true })
    .click();
  const tasksResponse = await page.request.get("/api/events/evt_devflow_conf_2027/tasks");
  const tasks = await tasksResponse.json() as {
    items: Array<{
      status: string;
      title: string;
      assignees: Array<{ speakerId: string; status: string }>;
    }>;
  };
  const priyaTaskTitles = tasks.items.filter((task) =>
    task.status === "active" && task.assignees.some((assignee) =>
      assignee.speakerId === "spk_priya_devflow_2027" && assignee.status !== "completed"
    )
  ).map((task) => task.title);
  expect(priyaTaskTitles).toHaveLength(priyaRoster?.taskSummary.incomplete ?? 0);
  const priyaChaseCard = page.locator(".chase-card").filter({ hasText: "Priya Raman" });
  for (const taskTitle of priyaTaskTitles) {
    await expect(priyaChaseCard).toContainText(taskTitle);
  }
});

test("organizer assigns a file request in bulk and sees who needs chasing", async ({ page }) => {
  await signInAsOrganizer(page);
  await expect(page.getByRole("heading", { name: "DevFlow Conf 2027" })).toBeVisible();

  await page.goto("/organizer/disposition");
  const proposalRow = page.getByRole("row", { name: /Taming 40-Minute CI/ });
  const decision = proposalRow.getByRole("combobox");
  if (await decision.inputValue() !== "accepted") {
    await decision.selectOption("accepted");
    await expect(page.getByText("1 decision saved silently.")).toBeVisible();
  }
  await expect(proposalRow.getByText("active", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Speakers", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Speaker roster." })).toBeVisible();
  await expect(page.getByText("Priya Raman", { exact: true })).toBeVisible();
  await expect(page.getByText("Marcus Okafor", { exact: true })).toBeVisible();
  await page.getByLabel("Search speakers").fill("Marcus");
  await expect(page.getByText("Priya Raman", { exact: true })).toHaveCount(0);
  await page.getByLabel("Search speakers").fill("");

  await page.getByRole("link", { name: "Tasks", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Onboarding." })).toBeVisible();
  await page.getByLabel("Task kind").selectOption("file_request");
  await page.getByLabel("Task title").fill("Upload accessibility-ready slides");
  await page.getByLabel("Due date").fill("2026-01-15");
  await page.getByLabel(/Priya Raman/).check();
  await page.getByLabel(/Marcus Okafor/).check();
  await page.getByRole("button", { name: "Assign to 2 speakers" }).click();
  await expect(page.getByRole("status")).toContainText("assigned to 2 speakers");

  await page.getByRole("link", { name: "Missing info", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "Morning check." })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Who still owes us something?" })).toBeVisible();
  await expect(page.getByText("Priya Raman", { exact: true })).toBeVisible();
  await expect(page.getByText("Headshot", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Upload accessibility-ready slides", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/days overdue/).first()).toBeVisible();
});
