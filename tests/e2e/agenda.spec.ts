// ABOUTME: Exercises the agenda board: live drop feedback, clashes, undo, views, and publish.
// ABOUTME: Confirms the organizer can create and resolve a named clash without a blocking interaction.
import { expect, test, type Locator, type Page } from "@playwright/test";

const eventId = "evt_devflow_conf_2027";

test.skip(({ isMobile }) => isMobile === true, "Dragging needs a pointer; the console covers touch until tap-to-place lands.");

async function dispatchDrag(page: Page, source: Locator, target: Locator): Promise<void> {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await source.dispatchEvent("dragstart", { dataTransfer });
  await target.dispatchEvent("dragenter", { dataTransfer });
  await target.dispatchEvent("dragover", { dataTransfer });
  await target.dispatchEvent("drop", { dataTransfer });
  await source.dispatchEvent("dragend", { dataTransfer });
  await dataTransfer.dispose();
}

/** Holds a card over a slot without releasing it, so the drop feedback can be read. */
async function hoverDrag(page: Page, source: Locator, target: Locator): Promise<() => Promise<void>> {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await source.dispatchEvent("dragstart", { dataTransfer });
  await target.dispatchEvent("dragenter", { dataTransfer });
  await target.dispatchEvent("dragover", { dataTransfer });
  return async () => {
    await target.dispatchEvent("drop", { dataTransfer });
    await source.dispatchEvent("dragend", { dataTransfer });
    await dataTransfer.dispose();
  };
}

test("organizer drags a session, sees a clash before dropping, undoes, resolves, and publishes", async ({ page }) => {
  test.setTimeout(120_000);
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
  await expect(page.getByRole("heading", { level: 1, name: "DevFlow Conf 2027" })).toBeVisible();
  const slotMath = page.getByLabel("Live slot math");
  await expect(slotMath).toContainText("3 unplaced");
  await expect(slotMath).toContainText("0 clashes");
  await expect(slotMath).toContainText("0 TBD");
  await expect(page.getByRole("region", { name: "Schedule conflicts" })).toHaveCount(0);

  // The board leads the page: the first drop row is on screen without scrolling.
  const firstSlot = page.getByTestId("agenda-slot-2027-05-12-rm_main_stage-09:00");
  const viewport = page.viewportSize();
  const firstSlotBox = await firstSlot.boundingBox();
  expect(firstSlotBox).not.toBeNull();
  if (firstSlotBox !== null && viewport !== null) {
    expect(firstSlotBox.y + firstSlotBox.height).toBeLessThan(viewport.height);
  }

  const inspector = page.getByRole("region", { name: "Selected session" });
  await page.getByTestId(`session-card-${ciSession.id}`).click();
  await expect(inspector).toContainText("Taming 40-Minute CI");
  await expect(inspector).toContainText("Draft");
  await inspector.getByRole("button", { name: "Approve content" }).click();
  await expect(inspector).toContainText("Approved");

  const docsCard = page.getByTestId("session-card-ses_docs_retrieval");
  await dispatchDrag(page, docsCard, firstSlot);
  await expect(firstSlot.getByTestId("session-card-ses_docs_retrieval")).toBeVisible();
  await expect(page.getByRole("status")).toContainText("placed at 9:00 AM");

  const replacementSlot = page.getByTestId("agenda-slot-2027-05-12-rm_room_2a-09:30");
  await dispatchDrag(page, firstSlot.getByTestId("session-card-ses_docs_retrieval"), replacementSlot);
  await expect(replacementSlot.getByTestId("session-card-ses_docs_retrieval")).toBeVisible();
  await dispatchDrag(page, replacementSlot.getByTestId("session-card-ses_docs_retrieval"), firstSlot);
  await expect(firstSlot.getByTestId("session-card-ses_docs_retrieval")).toBeVisible();

  await page.getByTestId("session-card-ses_docs_retrieval")
    .getByRole("button", { name: /Actions for/ })
    .click();
  await page.getByRole("menu").getByRole("menuitem", { name: "Send calendar invite" }).click();
  await expect(page.getByRole("alert")).toContainText("email not configured");
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

  // Holding the clashing session over the taken slot marks that slot only, and says why.
  const release = await hoverDrag(page, aiCard, conflictSlot);
  await expect(page.locator(".agenda-drop-slot--target, .agenda-drop-slot--target-clash")).toHaveCount(1);
  await expect(conflictSlot).toHaveClass(/agenda-drop-slot--target-clash/);
  const ghost = conflictSlot.locator(".agenda-ghost");
  await expect(ghost).toContainText("Main Stage is taken by Taming 40-Minute CI");
  await expect(ghost).toContainText("Priya Raman is already in Main Stage at 10:00 AM");
  const ghostBox = await ghost.boundingBox();
  expect(ghostBox).not.toBeNull();
  if (ghostBox !== null) expect(Math.abs(ghostBox.height - ciBox.height)).toBeLessThan(4);
  await release();

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

  // The toast next to the cursor names the clash instead of reporting an unqualified success.
  const toast = page.getByRole("status");
  await expect(toast).toContainText("2 clashes");
  await expect(toast).toContainText("Main Stage is taken by Taming 40-Minute CI");

  const conflicts = page.getByRole("region", { name: "Schedule conflicts" });
  await expect(conflicts).toBeVisible();
  await expect(conflicts.locator("article")).toHaveCount(2);
  await expect(conflicts).toContainText("Main Stage overlaps");
  await expect(conflicts).toContainText("Priya Raman overlaps");
  await expect(slotMath).toContainText("2 ⚠ clashes");
  await expect(slotMath).toContainText("0 unplaced");

  // Undo takes the clash back off the board, and re-doing it by hand puts it back.
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect(slotMath).toContainText("0 clashes");
  await expect(conflicts).toHaveCount(0);
  await expect(page.getByTestId(`session-card-${aiSession.id}`)).toBeVisible();
  await dispatchDrag(page, page.getByTestId(`session-card-${aiSession.id}`), conflictSlot);
  await expect(conflicts.locator("article")).toHaveCount(2);
  await expect(slotMath).toContainText("2 ⚠ clashes");

  await page.reload();
  await expect(conflictSlot.getByTestId(`session-card-${ciSession.id}`)).toHaveAttribute("aria-label", /Schedule conflict:/);
  await expect(conflictSlot.getByTestId(`session-card-${aiSession.id}`)).toHaveAttribute("aria-label", /Schedule conflict:/);
  await expect(conflicts.locator("article")).toHaveCount(2);
  await expect(slotMath).toContainText("2 ⚠ clashes");

  // The clash offers the nearest free slot first, and moving to TBD still works.
  await expect(conflicts.getByRole("button", { name: /Move .* to 10:30 AM Main Stage/ }).first()).toBeVisible();
  await conflicts.getByRole("button", { name: /Move .* to TBD/ }).first().click();
  await expect(conflicts).toHaveCount(0);
  await expect(slotMath).toContainText("0 clashes");
  await expect(slotMath).toContainText("1 TBD");

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

  // A placement change clears publication and says so, from the console under the board.
  await page.goto("/organizer/agenda");
  await page.getByTestId(`session-card-${ciSession.id}`).click();
  await page.locator(".agenda-console summary").click();
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

  // Dragging a placed card back to the inbox is the inverse of the gesture that placed it.
  await page.goto("/organizer/agenda");
  const trayBefore = await page.locator(".agenda-tray .agenda-session-card").count();
  await dispatchDrag(
    page,
    page.getByTestId(`session-card-${ciSession.id}`),
    page.getByRole("complementary", { name: "Inbox" }),
  );
  await expect(page.getByRole("status")).toContainText("returned to the inbox");
  await expect(page.locator(".agenda-tray .agenda-session-card")).toHaveCount(trayBefore + 1);

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

/**
 * Issue #72 was a CSS pointer-events rule, invisible to synthetic drag events: only a real mouse
 * drag catches it. Kept as its own short test on a clean board, because Playwright's mouse drag is
 * sensitive to whatever else the long workflow above has left on screen.
 */
test("a placed card can be picked up and moved with a real mouse drag", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/login");
  await page.getByLabel("Email").fill("sbek-organizer@example.com");
  await page.getByLabel("Password").fill("SbekTest!2027-org");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/organizer$/);

  await page.evaluate(async ({ currentEventId }) => {
    await fetch(`/api/events/${currentEventId}/disposition`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ submissionIds: ["sub_docs_retrieval"], status: "accepted" }),
    });
    const agenda = await (await fetch(`/api/events/${currentEventId}/agenda`)).json() as {
      sessions: Array<{ id: string }>;
    };
    for (const session of agenda.sessions) {
      await fetch(`/api/events/${currentEventId}/agenda/sessions/${session.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scheduleStatus: "unplaced" }),
      });
    }
  }, { currentEventId: eventId });

  await page.goto("/organizer/agenda");
  const source = page.getByTestId("agenda-slot-2027-05-12-rm_main_stage-09:00");
  const target = page.getByTestId("agenda-slot-2027-05-12-rm_room_2a-09:30");
  await dispatchDrag(page, page.getByTestId("session-card-ses_docs_retrieval"), source);
  const placed = source.getByTestId("session-card-ses_docs_retrieval");
  await expect(placed).toBeVisible();

  await placed.dragTo(target, { timeout: 20_000 });
  await expect(target.getByTestId("session-card-ses_docs_retrieval")).toBeVisible();
  await expect(source.getByTestId("session-card-ses_docs_retrieval")).toHaveCount(0);
});
