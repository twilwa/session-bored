// ABOUTME: Exercises agenda drag-and-drop, reload persistence, conflicts, views, and publish.
// ABOUTME: Confirms the organizer can resolve a named clash without a blocking interaction.
import { expect, test, type Locator, type Page } from "@playwright/test";

const eventId = "evt_devflow_conf_2027";

test.skip(({ isMobile }) => isMobile === true, "HTML5 drag is covered in the desktop organizer workflow.");

async function dispatchDrag(page: Page, source: Locator, target: Locator): Promise<void> {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await source.dispatchEvent("dragstart", { dataTransfer });
  await target.dispatchEvent("dragover", { dataTransfer });
  await target.dispatchEvent("drop", { dataTransfer });
  await source.dispatchEvent("dragend", { dataTransfer });
  await dataTransfer.dispose();
}

test("organizer drags a session, resolves a clash, changes views, and publishes", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/login");
  await page.getByLabel("Email").fill("sbek-organizer@example.com");
  await page.getByLabel("Password").fill("SbekTest!2027-org");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/organizer$/);

  const dispositionStatus = await page.evaluate(async ({ currentEventId }) => {
    const reset = await fetch(`/api/events/${currentEventId}/disposition`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ submissionIds: ["sub_ci_monorepo"], status: "declined" }),
    });
    if (!reset.ok) return reset.status;
    const response = await fetch(`/api/events/${currentEventId}/disposition`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
      submissionIds: ["sub_ci_monorepo", "sub_ai_verification", "sub_docs_retrieval"],
      status: "accepted",
      }),
    });
    return response.status;
  }, { currentEventId: eventId });
  expect(dispositionStatus).toBe(200);
  const agenda = await page.evaluate(async ({ currentEventId }) => {
    const response = await fetch(`/api/events/${currentEventId}/agenda`);
    if (!response.ok) throw new Error(`Agenda setup failed (${response.status})`);
    return response.json() as Promise<{ sessions: Array<{ id: string; title: string }> }>;
  }, { currentEventId: eventId });
  const ciSession = agenda.sessions.find((session) => session.title.startsWith("Taming 40-Minute CI"));
  const aiSession = agenda.sessions.find((session) => session.title.startsWith("Your AI Pair Programmer"));
  expect(ciSession).toBeDefined();
  expect(aiSession).toBeDefined();
  if (ciSession === undefined || aiSession === undefined) return;
  for (const session of agenda.sessions) {
    const resetStatus = await page.evaluate(async ({ currentEventId, sessionId }) => {
      const response = await fetch(`/api/events/${currentEventId}/agenda/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scheduleStatus: "unplaced" }),
      });
      return response.status;
    }, { currentEventId: eventId, sessionId: session.id });
    expect(resetStatus).toBe(200);
  }

  await page.goto("/organizer/agenda");
  await expect(page.getByRole("heading", { name: /Build the room/ })).toBeVisible();
  await expect(page.getByLabel("Live slot math")).toContainText("3 unplaced · 0 conflicts · 0 TBD");
  await expect(page.getByRole("region", { name: "Schedule conflicts" })).toHaveCount(0);

  await page.getByLabel("Session").selectOption(ciSession.id);
  const contentApproval = page.getByRole("region", { name: "Content approval" });
  await expect(contentApproval).toContainText("Draft");
  await contentApproval.getByRole("button", { name: "Approve content" }).click();
  await expect(contentApproval).toContainText("Approved");

  const firstSlot = page.getByTestId("agenda-slot-2027-05-12-rm_main_stage-09:00");
  const docsCard = page.getByTestId("session-card-ses_docs_retrieval");
  await dispatchDrag(page, docsCard, firstSlot);
  await expect(firstSlot.getByTestId("session-card-ses_docs_retrieval")).toBeVisible();
  await page.reload();
  await expect(firstSlot.getByTestId("session-card-ses_docs_retrieval")).toBeVisible();

  const conflictSlot = page.getByTestId("agenda-slot-2027-05-12-rm_main_stage-10:00");
  const ciCard = page.getByTestId(`session-card-${ciSession.id}`);
  const aiCard = page.getByTestId(`session-card-${aiSession.id}`);
  await dispatchDrag(page, ciCard, conflictSlot);

  const docsBox = await firstSlot.getByTestId("session-card-ses_docs_retrieval").boundingBox();
  const docsTitleBox = await firstSlot.getByTestId("session-card-ses_docs_retrieval").locator("h3").boundingBox();
  const ciBox = await conflictSlot.getByTestId(`session-card-${ciSession.id}`).boundingBox();
  expect(docsBox).not.toBeNull();
  expect(docsTitleBox).not.toBeNull();
  expect(ciBox).not.toBeNull();
  if (docsBox === null || docsTitleBox === null || ciBox === null) return;
  expect(docsTitleBox.y).toBeLessThan(docsBox.y + docsBox.height);
  expect(ciBox.height / docsBox.height).toBeGreaterThan(2.5);

  await dispatchDrag(page, aiCard, conflictSlot);

  const placedCiCard = conflictSlot.getByTestId(`session-card-${ciSession.id}`);
  const placedAiCard = conflictSlot.getByTestId(`session-card-${aiSession.id}`);
  await expect(placedCiCard).toHaveAttribute("aria-label", /Schedule conflict:/);
  await expect(placedAiCard).toHaveAttribute("aria-label", /Schedule conflict:/);
  const placedCiBox = await placedCiCard.boundingBox();
  const placedAiBox = await placedAiCard.boundingBox();
  expect(placedCiBox).not.toBeNull();
  expect(placedAiBox).not.toBeNull();
  if (placedCiBox === null || placedAiBox === null) return;
  expect(placedCiBox.x).not.toBe(placedAiBox.x);

  const conflicts = page.getByRole("region", { name: "Schedule conflicts" });
  await expect(conflicts).toBeVisible();
  await expect(conflicts.locator("article")).toHaveCount(2);
  await expect(conflicts).toContainText("Main Stage overlaps");
  await expect(conflicts).toContainText("Priya Raman overlaps");
  await expect(page.getByLabel("Live slot math")).toContainText("0 unplaced · 2 conflicts · 0 TBD");

  await page.reload();
  await expect(conflictSlot.getByTestId(`session-card-${ciSession.id}`)).toHaveAttribute("aria-label", /Schedule conflict:/);
  await expect(conflictSlot.getByTestId(`session-card-${aiSession.id}`)).toHaveAttribute("aria-label", /Schedule conflict:/);
  await expect(conflicts.locator("article")).toHaveCount(2);
  await expect(page.getByLabel("Live slot math")).toContainText("0 unplaced · 2 conflicts · 0 TBD");

  await conflicts.getByRole("button", { name: /Move .* to TBD/ }).first().click();
  await expect(conflicts).not.toBeVisible();
  await expect(page.getByLabel("Live slot math")).toContainText("0 unplaced · 0 conflicts · 1 TBD");

  for (const view of ["list", "week", "track", "room", "day"]) {
    await page.getByRole("tab", { name: view, exact: true }).click();
    await expect(page.getByRole("tab", { name: view, exact: true })).toHaveAttribute("aria-selected", "true");
  }

  await page.getByRole("button", { name: "Publish agenda" }).click();
  await expect(page.getByText("2 approved agenda sessions published.")).toBeVisible();

  await page.goto("/program");
  await expect(page.getByRole("link", { name: "Docs That Answer Back", exact: false }))
    .toHaveAttribute("href", "/program/ses_docs_retrieval");
  await expect(page.getByRole("link", { name: "Taming 40-Minute CI", exact: false })).toBeVisible();

  await page.goto("/organizer/agenda");
  await page.getByTestId(`session-card-${ciSession.id}`)
    .getByRole("button", { name: /Edit placement/ })
    .click();
  await page.getByLabel("Time").selectOption("11:00");
  await page.getByRole("button", { name: "Place", exact: true }).click();
  await expect(page.getByText(/Publication cleared.*publish agenda again/i)).toBeVisible();
  await expect(page.getByText("1/3 current")).toBeVisible();

  await page.goto("/program");
  await expect(page.getByRole("link", { name: "Taming 40-Minute CI", exact: false })).toHaveCount(0);
  await page.goto("/organizer/agenda");
  await page.getByRole("button", { name: "Publish agenda" }).click();
  await expect(page.getByText("2 approved agenda sessions published.")).toBeVisible();
  await page.goto("/program");
  await expect(page.getByRole("link", { name: "Taming 40-Minute CI", exact: false })).toBeVisible();

  const cleanupStatus = await page.evaluate(async () => {
    const response = await fetch("/api/review/submissions/sub_ci_monorepo/status", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "under_review" }),
    });
    return response.status;
  });
  expect(cleanupStatus).toBe(200);
});
