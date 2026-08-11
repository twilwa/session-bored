// ABOUTME: Exercises organizer roster, task management, and missing-information workflows in a real browser.
// ABOUTME: Confirms the seeded event supports a complete onboarding workflow without mocked requests.
import { expect, test } from "@playwright/test";

async function signInAsOrganizer(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill("sbek-organizer@example.com");
  await page.getByLabel("Password").fill("SbekTest!2027-org");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/organizer$/);
}

async function signInAsSpeaker(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill("sbek-speaker2@example.com");
  await page.getByLabel("Password").fill("SbekTest!2027-spk2");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Marcus Okafor" })).toBeVisible();
}

async function signOut(page: import("@playwright/test").Page): Promise<void> {
  const status = await page.evaluate(async () => {
    const response = await fetch("/api/auth/sign-out", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return response.status;
  });
  expect(status).toBe(200);
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
    `${priyaRoster?.taskSummary.incomplete} open item${priyaRoster?.taskSummary.incomplete === 1 ? "" : "s"}`,
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
  const missingResponse = await page.request.get("/api/events/evt_devflow_conf_2027/missing-information");
  const missing = await missingResponse.json() as {
    items: Array<{ speakerId: string; missingCount: number }>;
  };
  expect(missing.items.find((speaker) => speaker.speakerId === "spk_priya_devflow_2027")?.missingCount)
    .toBe(priyaRoster?.taskSummary.incomplete);
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
  await page.getByRole("checkbox", { name: /Priya Raman/ }).check();
  await page.getByRole("checkbox", { name: /Marcus Okafor/ }).check();
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

test("organizer completes and reopens one speaker assignment", async ({ page }) => {
  await signInAsOrganizer(page);
  await page.goto("/organizer/roster/tasks");

  const title = `Confirm completion workflow ${Date.now()}`;
  await page.getByLabel("Task title").fill(title);
  await page.getByRole("checkbox", { name: /Priya Raman/ }).check();
  await page.getByRole("button", { name: "Assign to 1 speaker" }).click();

  const taskRow = page.getByRole("row", { name: new RegExp(title) });
  await taskRow.getByRole("button", { name: `Mark complete ${title} for Priya Raman` }).click();
  await expect(page.getByRole("status")).toContainText(`marked complete for Priya Raman`);
  await expect(taskRow).toContainText("Complete");

  await taskRow.getByRole("button", { name: `Reopen ${title} for Priya Raman` }).click();
  await expect(page.getByRole("status")).toContainText(`marked open for Priya Raman`);
  await expect(taskRow).toContainText("Open");
});

test("organizer edits, reassigns, and removes a task from the ledger", async ({ page }) => {
  await signInAsOrganizer(page);
  await page.goto("/organizer/roster/tasks");

  const suffix = Date.now().toString();
  const originalTitle = `Confirm ledger workflow ${suffix}`;
  const updatedTitle = `Upload ledger workflow ${suffix}`;
  await page.getByLabel("Task title").fill(originalTitle);
  await page.getByRole("checkbox", { name: /Priya Raman/ }).check();
  await page.getByRole("button", { name: "Assign to 1 speaker" }).click();
  await expect(page.getByRole("row", { name: new RegExp(originalTitle) })).toBeVisible();

  await page.getByRole("button", { name: `Edit ${originalTitle}` }).click();
  const editDialog = page.getByRole("dialog", { name: `Edit ${originalTitle}` });
  await editDialog.getByLabel("Task kind").selectOption("file_request");
  await editDialog.getByLabel("Task title").fill(updatedTitle);
  await editDialog.getByLabel("Instructions").fill("Upload the final event checklist.");
  await editDialog.getByLabel("Due date").fill("2027-04-30");
  await editDialog.getByRole("checkbox", { name: /Priya Raman/ }).uncheck();
  await editDialog.getByRole("checkbox", { name: /Marcus Okafor/ }).check();
  await editDialog.getByRole("button", { name: "Save task" }).click();

  const updatedRow = page.getByRole("row", { name: new RegExp(updatedTitle) });
  await expect(updatedRow).toContainText("file request");
  await expect(updatedRow).toContainText("1");
  await page.getByRole("button", { name: `Edit ${updatedTitle}` }).click();
  const updatedDialog = page.getByRole("dialog", { name: `Edit ${updatedTitle}` });
  await expect(updatedDialog.getByRole("checkbox", { name: /Priya Raman/ })).not.toBeChecked();
  await expect(updatedDialog.getByRole("checkbox", { name: /Marcus Okafor/ })).toBeChecked();
  await updatedDialog.getByRole("button", { name: "Cancel" }).click();

  await signOut(page);
  await signInAsSpeaker(page);
  const speakerTask = page.locator("li.task-row", { hasText: updatedTitle });
  await speakerTask.locator("input[type='file']").setInputFiles("fixtures/slides.pdf");
  await expect(page.getByText("File uploaded. Task marked complete.")).toBeVisible();
  const activeFile = page.locator("li", { hasText: updatedTitle }).filter({ hasText: "Version 1" });
  const activeDownload = activeFile.getByRole("link", { name: "slides.pdf" });
  await expect(activeDownload).toBeVisible();
  const downloadUrl = await activeDownload.getAttribute("href");

  await signOut(page);
  await signInAsOrganizer(page);
  await page.goto("/organizer/roster/tasks");
  await page.getByRole("button", { name: `Remove ${updatedTitle}` }).click();
  const removeDialog = page.getByRole("dialog", { name: `Remove ${updatedTitle}?` });
  await expect(removeDialog).toContainText("retaining completed work and uploaded files");
  await removeDialog.getByRole("button", { name: "Remove task" }).click();
  await expect(page.getByRole("row", { name: new RegExp(updatedTitle) })).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("Completed work and uploads were retained");

  await signOut(page);
  await signInAsSpeaker(page);
  await expect(page.locator("li.task-row", { hasText: updatedTitle })).toHaveCount(0);
  const archivedFile = page.locator("li", { hasText: updatedTitle }).filter({ hasText: "Archived task" });
  const archivedDownload = archivedFile.getByRole("link", { name: "slides.pdf" });
  await expect(archivedDownload).toHaveAttribute("href", downloadUrl ?? "");
  expect(downloadUrl).not.toBeNull();
  const download = await page.request.get(downloadUrl ?? "");
  expect(download.status()).toBe(200);
});
