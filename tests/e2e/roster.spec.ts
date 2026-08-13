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

async function clickTaskAction(
  taskCard: import("@playwright/test").Locator,
  title: string,
  action: "Edit" | "Remove",
): Promise<void> {
  const button = taskCard.getByRole("button", { name: `${action} ${title}` });
  if (!await button.isVisible()) {
    await taskCard.getByLabel(`More actions for ${title}`).click();
  }
  await button.click();
}

async function clickSpeakerAction(
  speakerCard: import("@playwright/test").Locator,
  name: string,
  action: "Edit" | "Send invitation" | "Remove",
): Promise<void> {
  const buttonName = action === "Remove" ? `Remove ${name}` : action;
  const button = speakerCard.getByRole("button", { name: buttonName, exact: true });
  if (!await button.isVisible()) {
    await speakerCard.getByLabel(`More actions for ${name}`).click();
  }
  await button.click();
}

test("organizer sees sessionless onboarding assignments in the chase list", async ({ page }) => {
  await signInAsOrganizer(page);

  await page.goto("/organizer/roster");
  const rosterResponse = await page.request.get("/api/events/evt_devflow_conf_2027/roster");
  const roster = await rosterResponse.json() as {
    items: Array<{ id: string; workSummary: { total: number; incomplete: number } }>;
  };
  const priyaRoster = roster.items.find((speaker) => speaker.id === "spk_priya_devflow_2027");
  expect(priyaRoster).toBeDefined();
  const priyaRosterRow = page.locator(".speaker-record").filter({ hasText: "Priya Raman" });
  await expect(priyaRosterRow).toContainText(
    `${priyaRoster?.workSummary.incomplete} open item${priyaRoster?.workSummary.incomplete === 1 ? "" : "s"}`,
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
    .toBe(priyaRoster?.workSummary.incomplete);
  const priyaChaseCard = page.locator(".chase-card").filter({ hasText: "Priya Raman" });
  await priyaChaseCard.getByRole("button", { name: "Show all items for Priya Raman" }).click();
  for (const taskTitle of priyaTaskTitles) {
    await expect(priyaChaseCard).toContainText(taskTitle);
  }
});

test("roster rows count assigned tasks and profile requirements in one work total", async ({ page }) => {
  await signInAsOrganizer(page);
  const beforeResponse = await page.request.get("/api/events/evt_devflow_conf_2027/roster");
  const beforeRoster = await beforeResponse.json() as {
    items: Array<{
      id: string;
      profile: { bioComplete: boolean; headshotComplete: boolean };
      workSummary: { total: number; incomplete: number };
    }>;
  };
  const marcusBefore = beforeRoster.items.find((speaker) => speaker.id === "spk_marcus_devflow_2027");
  expect(marcusBefore).toMatchObject({
    profile: { bioComplete: true, headshotComplete: false },
  });

  const taskResponse = await page.request.post("/api/events/evt_devflow_conf_2027/tasks", {
    data: {
      speakerIds: ["spk_marcus_devflow_2027"],
      taskType: "general",
      title: `Roster count truth ${Date.now()}`,
    },
  });
  expect(taskResponse.status()).toBe(201);

  await page.goto("/organizer/roster");
  const rosterResponse = await page.request.get("/api/events/evt_devflow_conf_2027/roster");
  const roster = await rosterResponse.json() as {
    items: Array<{
      id: string;
      profile: { bioComplete: boolean; headshotComplete: boolean };
      workSummary: { total: number; incomplete: number };
    }>;
  };
  const marcus = roster.items.find((speaker) => speaker.id === "spk_marcus_devflow_2027");
  expect(marcus).toBeDefined();
  expect(marcus?.workSummary).toEqual({
    incomplete: (marcusBefore?.workSummary.incomplete ?? -1) + 1,
    total: (marcusBefore?.workSummary.total ?? -1) + 1,
  });
  expect(marcus?.workSummary.incomplete).toBeLessThanOrEqual(marcus?.workSummary.total ?? -1);

  const rosterRow = page.locator(".speaker-record").filter({ hasText: "Marcus Okafor" });
  const openLabel = `${marcus?.workSummary.incomplete} open item${marcus?.workSummary.incomplete === 1 ? "" : "s"}`;
  const totalLabel = `${marcus?.workSummary.total} work item${marcus?.workSummary.total === 1 ? "" : "s"} tracked`;
  await expect(rosterRow).toContainText(openLabel);
  await expect(rosterRow).toContainText(totalLabel);
  await rosterRow.getByRole("button", { name: "Show details for Marcus Okafor" }).click();
  await expect(rosterRow).toContainText(openLabel);
  await expect(rosterRow).toContainText(totalLabel);
});

test("organizer can edit a speaker without replacing or silently removing their stored headshot", async ({ page }) => {
  await signInAsOrganizer(page);
  await page.goto("/organizer/roster");

  const rosterBeforeResponse = await page.request.get("/api/events/evt_devflow_conf_2027/roster");
  const rosterBefore = await rosterBeforeResponse.json() as {
    items: Array<{ id: string; headshotUrl: string | null }>;
  };
  const storedHeadshotUrl = rosterBefore.items.find(
    (speaker) => speaker.id === "spk_priya_devflow_2027",
  )?.headshotUrl;
  expect(storedHeadshotUrl).toMatch(/^\//);

  const speakerCard = page.locator(".speaker-record").filter({ hasText: "Priya Raman" });
  await clickSpeakerAction(speakerCard, "Priya Raman", "Edit");
  const dialog = page.getByRole("dialog", { name: "Edit Priya Raman" });
  await expect(dialog.getByLabel("Replacement headshot URL")).toHaveValue("");
  await expect(dialog).toContainText("Leave this blank to keep the stored headshot");
  await expect(dialog.getByRole("checkbox", { name: "Remove stored headshot" })).not.toBeChecked();

  await dialog.getByLabel("Organization").fill("Latticework Systems, Inc.");
  await dialog.getByRole("button", { name: "Save speaker" }).click();
  await expect(speakerCard).toContainText("Latticework Systems, Inc.");

  const rosterResponse = await page.request.get("/api/events/evt_devflow_conf_2027/roster");
  const roster = await rosterResponse.json() as { items: Array<{ id: string; headshotUrl: string | null }> };
  expect(roster.items.find((speaker) => speaker.id === "spk_priya_devflow_2027")?.headshotUrl)
    .toBe(storedHeadshotUrl);
});

test("task ledger keeps assignees collapsed behind truthful progress summaries", async ({ page }) => {
  await signInAsOrganizer(page);
  await page.goto("/organizer/roster/tasks");

  const tasksResponse = await page.request.get("/api/events/evt_devflow_conf_2027/tasks");
  const tasks = await tasksResponse.json() as {
    items: Array<{
      title: string;
      assignees: Array<{ speakerName: string; status: string }>;
    }>;
  };

  const taskCards = page.locator(".task-card");
  await expect(taskCards).toHaveCount(tasks.items.length);
  for (const [index, task] of tasks.items.entries()) {
    const complete = task.assignees.filter((assignee) => assignee.status === "completed").length;
    const open = task.assignees.length - complete;
    const taskCard = taskCards.nth(index);
    await expect(taskCard).toContainText(task.title);
    await expect(taskCard).toContainText(`${open} open · ${complete} complete · ${task.assignees.length} assigned`);
    await expect(taskCard.getByText(task.assignees[0]?.speakerName ?? "", { exact: true })).toHaveCount(0);
  }

  const firstTask = tasks.items[0];
  const firstAssignee = firstTask?.assignees[0];
  if (firstTask === undefined || firstAssignee === undefined) {
    throw new Error("The seeded task ledger must include at least one assigned task.");
  }
  const firstTaskCard = taskCards.first();
  await firstTaskCard.getByRole("button", { name: `Show assignees for ${firstTask.title}` }).click();
  await expect(firstTaskCard.getByText(firstAssignee.speakerName, { exact: true })).toBeVisible();

  await firstTaskCard.getByRole("button", { name: `Hide assignees for ${firstTask.title}` }).click();
  const collapsedHeights = await taskCards.evaluateAll((cards) => cards.map((card) => card.getBoundingClientRect().height));
  expect(Math.max(...collapsedHeights)).toBeLessThan(260);
});

test("task creation opens in a bounded modal with a searchable explicit audience", async ({ page }) => {
  await signInAsOrganizer(page);
  await page.goto("/organizer/roster/tasks");

  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByLabel("Task title")).toHaveCount(0);
  await page.getByRole("button", { name: "Create task" }).click();

  const dialog = page.getByRole("dialog", { name: "Create onboarding task" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Search assigned speakers").fill("Marcus");
  await expect(dialog.getByRole("checkbox", { name: /Marcus Okafor/ })).toBeVisible();
  await expect(dialog.getByRole("checkbox", { name: /Priya Raman/ })).toHaveCount(0);
  await expect(dialog.getByText("0 speakers selected", { exact: true })).toBeVisible();

  await dialog.getByRole("button", { name: "Select all matching" }).click();
  await expect(dialog.getByText("1 speaker selected", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("checkbox", { name: /Marcus Okafor/ })).toBeChecked();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
});

test("phone roster cards keep disclosure beside aligned speaker text without horizontal scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAsOrganizer(page);
  await page.goto("/organizer/roster");

  const rosterResponse = await page.request.get("/api/events/evt_devflow_conf_2027/roster");
  const roster = await rosterResponse.json() as { items: Array<{ name: string }> };
  const firstSpeaker = roster.items[0];
  if (firstSpeaker === undefined) {
    throw new Error("The seeded roster must include a speaker.");
  }

  const speakerCards = page.locator(".speaker-record");
  await expect(speakerCards).toHaveCount(roster.items.length);
  await expect(page.locator(".roster-table-card table")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  const firstCard = speakerCards.filter({ hasText: firstSpeaker.name });
  const disclosure = firstCard.getByRole("button", { name: `Show details for ${firstSpeaker.name}` });
  const name = firstCard.locator(".speaker-record__name");
  const subheading = firstCard.locator(".speaker-record__subheading");
  const [disclosureBox, nameBox, subheadingBox] = await Promise.all([
    disclosure.boundingBox(),
    name.boundingBox(),
    subheading.boundingBox(),
  ]);
  expect(disclosureBox).not.toBeNull();
  expect(nameBox).not.toBeNull();
  expect(subheadingBox).not.toBeNull();
  expect((disclosureBox?.x ?? 0) + (disclosureBox?.width ?? 0)).toBeLessThanOrEqual(nameBox?.x ?? 0);
  expect(Math.abs((nameBox?.x ?? 0) - (subheadingBox?.x ?? 0))).toBeLessThanOrEqual(1);
  const nameFontSize = await name.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  expect(nameBox?.height ?? 0).toBeLessThanOrEqual(nameFontSize * 1.5);

  await disclosure.click();
  await expect(firstCard.getByText("Speaker details", { exact: true })).toBeVisible();
});

test("organizer can add, edit, invite, update, and remove a speaker from the roster card", async ({ page }) => {
  await signInAsOrganizer(page);
  await page.goto("/organizer/roster");

  const suffix = Date.now().toString();
  const name = `Roster Action ${suffix}`;
  await page.getByRole("button", { name: "Add speaker" }).click();
  const addDialog = page.getByRole("dialog", { name: "Add a speaker" });
  await addDialog.getByLabel("Name").fill(name);
  await addDialog.getByLabel("Email").fill(`roster-action-${suffix}@example.com`);
  await addDialog.getByLabel("Job title").fill("Staff Engineer");
  await addDialog.getByRole("button", { name: "Save speaker" }).click();

  const speakerCard = page.locator(".speaker-record").filter({ hasText: name });
  await expect(speakerCard).toBeVisible();
  await clickSpeakerAction(speakerCard, name, "Edit");
  const editDialog = page.getByRole("dialog", { name: `Edit ${name}` });
  await editDialog.getByLabel("Organization").fill("Greenroom Verification Lab");
  await editDialog.getByRole("button", { name: "Save speaker" }).click();
  await expect(speakerCard).toContainText("Greenroom Verification Lab");

  await speakerCard.getByLabel(`Workflow status for ${name}`).selectOption("onboarding");
  await expect(page.getByRole("status")).toContainText("No message was sent");
  await clickSpeakerAction(speakerCard, name, "Send invitation");
  await expect(page.getByRole("status")).toContainText("no invitation was sent");

  await clickSpeakerAction(speakerCard, name, "Remove");
  const removeDialog = page.getByRole("dialog", { name: `Remove ${name}?` });
  await expect(removeDialog).toContainText("event history remain intact");
  await removeDialog.getByRole("button", { name: "Remove speaker" }).click();
  await expect(speakerCard).toHaveCount(0);
});

test("chase list states its sort and filters collapsed speaker queues", async ({ page }) => {
  await signInAsOrganizer(page);
  await page.goto("/organizer/roster/missing");

  const response = await page.request.get("/api/events/evt_devflow_conf_2027/missing-information");
  const worklist = await response.json() as {
    items: Array<{ name: string; missing: Array<{ label: string }> }>;
  };
  const firstSpeaker = worklist.items[0];
  if (firstSpeaker === undefined) {
    throw new Error("The seeded chase list must include a speaker.");
  }

  await expect(page.getByText("Sorted by most overdue, then nearest due, then undated.", { exact: true })).toBeVisible();
  const chaseCards = page.locator(".chase-card");
  await expect(chaseCards).toHaveCount(worklist.items.length);
  const firstCard = chaseCards.filter({ hasText: firstSpeaker.name });
  await expect(firstCard.locator(".missing-items")).toHaveCount(0);

  await firstCard.getByRole("button", { name: `Show all items for ${firstSpeaker.name}` }).click();
  await expect(firstCard.locator(".missing-item")).toHaveCount(firstSpeaker.missing.length);

  await page.getByLabel("Search chase list").fill(firstSpeaker.name);
  await expect(chaseCards).toHaveCount(1);
  await page.getByLabel("Search chase list").fill("");
  await page.getByLabel("Work type").selectOption("profile");
  const speakersWithProfileGaps = worklist.items.filter((speaker) =>
    speaker.missing.some((item) => item.label === "Bio" || item.label === "Headshot")
  ).length;
  await expect(chaseCards).toHaveCount(speakersWithProfileGaps);
});

test("phone task summaries and creation modal stay within the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAsOrganizer(page);
  await page.goto("/organizer/roster/tasks");

  const firstTaskCard = page.locator(".task-card").first();
  await expect(firstTaskCard).toBeVisible();
  await expect(page.locator(".task-ledger table")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(page.getByRole("button", { name: "Create task" })).toBeVisible();
  const firstTaskTitle = await firstTaskCard.locator(".task-card__identity > strong").innerText();
  await expect(firstTaskCard.getByLabel(`More actions for ${firstTaskTitle}`)).toBeVisible();
  await expect(firstTaskCard.getByRole("button", { name: `Edit ${firstTaskTitle}` })).not.toBeVisible();

  await page.getByRole("button", { name: "Create task" }).click();
  const modal = page.getByRole("dialog", { name: "Create onboarding task" });
  const modalBox = await modal.boundingBox();
  expect(modalBox).not.toBeNull();
  expect((modalBox?.x ?? 0) + (modalBox?.width ?? 0)).toBeLessThanOrEqual(390);
  expect(await modal.evaluate((element) => element.scrollHeight)).toBeGreaterThan(
    await modal.evaluate((element) => element.clientHeight),
  );
});

test("organizer assigns a file request in bulk and sees who needs chasing", async ({ page }) => {
  await signInAsOrganizer(page);
  await expect(page.getByRole("heading", { name: "DevFlow Conf 2027" })).toBeVisible();
  const title = `Upload accessibility-ready slides ${Date.now()}`;

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
  await page.getByRole("button", { name: "Create task" }).click();
  const createDialog = page.getByRole("dialog", { name: "Create onboarding task" });
  await createDialog.getByLabel("Task kind").selectOption("file_request");
  await createDialog.getByLabel("Task title").fill(title);
  await createDialog.getByLabel("Due date").fill("2026-01-15");
  await createDialog.getByRole("checkbox", { name: /Priya Raman/ }).check();
  await createDialog.getByRole("checkbox", { name: /Marcus Okafor/ }).check();
  await createDialog.getByRole("button", { name: "Assign to 2 speakers" }).click();
  await expect(page.getByRole("status")).toContainText("assigned to 2 speakers");

  await page.getByRole("link", { name: "Missing info", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "Morning check." })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Who still owes us something?" })).toBeVisible();
  await expect(page.getByText("Priya Raman", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Show all items for Priya Raman" }).click();
  await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/days overdue/).first()).toBeVisible();
});

test("picture requests disclose their public headshot effect before and after upload", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Run the irreversible public-headshot journey once against the shared D1.");
  await signInAsOrganizer(page);
  await page.goto("/organizer/roster/tasks");

  const suffix = Date.now().toString();
  const pictureTitle = `Send us a conference photo ${suffix}`;
  const documentTitle = `Upload your release form ${suffix}`;

  await page.getByRole("button", { name: "Create task" }).click();
  const pictureDialog = page.getByRole("dialog", { name: "Create onboarding task" });
  await pictureDialog.getByLabel("Task kind").selectOption("file_request");
  await pictureDialog.getByLabel("What this request wants").selectOption("picture");
  await expect(pictureDialog).toContainText("The picture a speaker uploads here becomes their profile headshot.");
  await pictureDialog.getByLabel("Task title").fill(pictureTitle);
  await pictureDialog.getByRole("checkbox", { name: /Marcus Okafor/ }).check();
  await pictureDialog.getByRole("button", { name: "Assign to 1 speaker" }).click();

  await page.getByRole("button", { name: "Create task" }).click();
  const documentDialog = page.getByRole("dialog", { name: "Create onboarding task" });
  await documentDialog.getByLabel("Task kind").selectOption("file_request");
  await documentDialog.getByLabel("Task title").fill(documentTitle);
  await documentDialog.getByRole("checkbox", { name: /Marcus Okafor/ }).check();
  await documentDialog.getByRole("button", { name: "Assign to 1 speaker" }).click();

  await signOut(page);
  await signInAsSpeaker(page);

  const pictureRequest = page.locator("li.task-row", { hasText: pictureTitle });
  await expect(pictureRequest.getByText("This picture will become your public profile photo.")).toBeVisible();
  await expect(pictureRequest.getByText("Uploading will replace your public profile photo.")).toBeVisible();

  const documentRequest = page.locator("li.task-row", { hasText: documentTitle });
  await expect(documentRequest.getByText("This picture will become your public profile photo.")).toHaveCount(0);
  await expect(documentRequest.getByText("Uploading will replace your public profile photo.")).toHaveCount(0);

  await pictureRequest.locator("input[type='file']").setInputFiles("fixtures/headshot.png");
  await expect(page.getByText("File uploaded. This is now your profile photo on the public programme.")).toBeVisible();
});

test("organizer-completed file work stays complete on the Deliverables board", async ({ page }) => {
  await signInAsOrganizer(page);
  await page.goto("/organizer/roster/tasks");

  const title = `Confirm completion workflow ${Date.now()}`;
  await page.getByRole("button", { name: "Create task" }).click();
  const createDialog = page.getByRole("dialog", { name: "Create onboarding task" });
  await createDialog.getByLabel("Task kind").selectOption("file_request");
  await createDialog.getByLabel("Task title").fill(title);
  await createDialog.getByLabel("Due date").fill("2026-01-15");
  await createDialog.getByRole("checkbox", { name: /Priya Raman/ }).check();
  await createDialog.getByRole("button", { name: "Assign to 1 speaker" }).click();

  const taskRow = page.locator(".task-card").filter({ hasText: title });
  await taskRow.getByRole("button", { name: `Show assignees for ${title}` }).click();
  await taskRow.getByRole("button", { name: `Mark complete ${title} for Priya Raman` }).click();
  await expect(page.getByRole("status")).toContainText(`marked complete for Priya Raman`);
  await expect(taskRow).toContainText("Complete");

  await page.goto("/organizer/content");
  const deliverable = page.locator("li.deliverable-card").filter({ hasText: title });
  await expect(deliverable).toContainText("completed");
  await expect(deliverable).toContainText("Marked complete; no task file is attached.");
  await page.getByRole("button", { name: /Overdue \d+/ }).click();
  await expect(deliverable).toHaveCount(0);

  await page.goto("/organizer/roster/tasks");
  const reopenedTaskRow = page.locator(".task-card").filter({ hasText: title });
  await reopenedTaskRow.getByRole("button", { name: `Show assignees for ${title}` }).click();
  await reopenedTaskRow.getByRole("button", { name: `Reopen ${title} for Priya Raman` }).click();
  await expect(page.getByRole("status")).toContainText(`marked open for Priya Raman`);
  await expect(reopenedTaskRow).toContainText("Open");
});

test("organizer edits, reassigns, and removes a task from the ledger", async ({ page }) => {
  await signInAsOrganizer(page);
  await page.goto("/organizer/roster/tasks");

  const suffix = Date.now().toString();
  const originalTitle = `Confirm ledger workflow ${suffix}`;
  const updatedTitle = `Upload ledger workflow ${suffix}`;
  await page.getByRole("button", { name: "Create task" }).click();
  const createDialog = page.getByRole("dialog", { name: "Create onboarding task" });
  await createDialog.getByLabel("Task title").fill(originalTitle);
  await createDialog.getByRole("checkbox", { name: /Priya Raman/ }).check();
  await createDialog.getByRole("button", { name: "Assign to 1 speaker" }).click();
  const originalCard = page.locator(".task-card").filter({ hasText: originalTitle });
  await expect(originalCard).toBeVisible();

  await clickTaskAction(originalCard, originalTitle, "Edit");
  const editDialog = page.getByRole("dialog", { name: `Edit ${originalTitle}` });
  await editDialog.getByLabel("Task kind").selectOption("file_request");
  await editDialog.getByLabel("Task title").fill(updatedTitle);
  await editDialog.getByLabel("Instructions").fill("Upload the final event checklist.");
  await editDialog.getByLabel("Due date").fill("2027-04-30");
  await editDialog.getByRole("checkbox", { name: /Priya Raman/ }).uncheck();
  await editDialog.getByRole("checkbox", { name: /Marcus Okafor/ }).check();
  await editDialog.getByRole("button", { name: "Save task" }).click();

  const updatedRow = page.locator(".task-card").filter({ hasText: updatedTitle });
  await expect(updatedRow).toContainText("file request");
  await expect(updatedRow).toContainText("1");
  await clickTaskAction(updatedRow, updatedTitle, "Edit");
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
  const removableCard = page.locator(".task-card").filter({ hasText: updatedTitle });
  await clickTaskAction(removableCard, updatedTitle, "Remove");
  const removeDialog = page.getByRole("dialog", { name: `Remove ${updatedTitle}?` });
  await expect(removeDialog).toContainText("retaining completed work and uploaded files");
  await removeDialog.getByRole("button", { name: "Remove task" }).click();
  await expect(page.locator(".task-card").filter({ hasText: updatedTitle })).toHaveCount(0);
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
