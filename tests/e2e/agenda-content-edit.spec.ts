// ABOUTME: Verifies organizer editing and approval comparisons for published agenda content.
// ABOUTME: Covers the edited-since-approval warning, missing snapshots, and phone containment.
import { expect, test } from "@playwright/test";

const eventId = "evt_devflow_conf_2027";
const approvedTitle = "Approved CI session title";
const approvedAbstract = "Approved CI session abstract for the organizer comparison.";
const originalTitle = "Taming 40-Minute CI: Incremental Builds at Monorepo Scale";
const originalAbstract = "Our monorepo CI took 40 minutes on a good day. This talk walks through how we cut it to 6 minutes with content-addressed caching, remote execution, and a test-selection model — including the two migrations that failed first. You'll leave with a decision framework for which incremental-build investments pay off at which repo sizes, and the graphs to convince your platform team.";

test("organizer edits approved content and reviews the approved copy beside the current copy", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/login");
  await page.getByLabel("Email").fill("sbek-organizer@example.com");
  await page.getByLabel("Password").fill("SbekTest!2027-org");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/organizer$/);

  const setup = await page.evaluate(async ({ currentEventId, baselineTitle, baselineAbstract }) => {
    await fetch(`/api/events/${currentEventId}/disposition`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ submissionIds: ["sub_ci_monorepo"], status: "declined" }),
    });
    await fetch(`/api/events/${currentEventId}/disposition`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ submissionIds: ["sub_ci_monorepo"], status: "accepted" }),
    });
    const agenda = await (await fetch(`/api/events/${currentEventId}/agenda`)).json() as {
      sessions: Array<{
        id: string;
        title: string;
        abstract: string | null;
        track: { name: string } | null;
      }>;
    };
    const session = agenda.sessions.find((item) => item.track?.name === "Platform & Infra");
    if (session === undefined) throw new Error("Accepted CI session was not created");
    const baseline = await fetch(`/api/events/${currentEventId}/agenda/sessions/${session.id}/content`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: baselineTitle, abstract: baselineAbstract }),
    });
    if (!baseline.ok) throw new Error(`Approved baseline could not be saved (${baseline.status})`);
    await fetch(`/api/events/${currentEventId}/agenda/sessions/${session.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scheduleStatus: "placed",
        scheduledDate: "2027-05-12",
        roomId: "rm_room_2a",
        startsAt: Date.parse("2027-05-12T17:00:00Z"),
      }),
    });
    await fetch(`/api/events/${currentEventId}/agenda/sessions/${session.id}/content`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contentStatus: "approved" }),
    });
    await fetch(`/api/events/${currentEventId}/agenda/publish`, { method: "POST" });
    return { ...session, title: baselineTitle, abstract: baselineAbstract };
  }, {
    currentEventId: eventId,
    baselineTitle: approvedTitle,
    baselineAbstract: approvedAbstract,
  });

  await page.goto("/organizer/agenda");
  await page.getByTestId(`session-card-${setup.id}`).click();
  const inspector = page.getByRole("region", { name: "Selected session" });
  const editStatus = inspector.locator(".status-chip").filter({ hasText: /^Edited since approval$/ });
  await expect(editStatus).toHaveCount(0);
  await inspector.getByText("Edit session content", { exact: true }).click();

  const editedTitle = "Taming CI without the wait";
  const editedAbstract = "A corrected organizer summary with the approved state left intact.";
  await inspector.getByRole("textbox", { name: "Session title", exact: true }).fill(editedTitle);
  await inspector.getByRole("textbox", { name: "Abstract", exact: true }).fill(editedAbstract);
  await inspector.getByRole("button", { name: "Save content" }).click();

  await expect(editStatus).toBeVisible();
  const comparison = page.getByRole("region", { name: "Approval comparison" });
  await expect(comparison).toBeVisible();
  await expect(comparison).toContainText("Approved");
  await expect(comparison).toContainText("Current");
  await expect(comparison).toContainText(setup.title);
  await expect(comparison).toContainText(editedTitle);
  await expect(comparison).toContainText(setup.abstract ?? "");
  await expect(comparison).toContainText(editedAbstract);

  const state = await page.evaluate(async ({ currentEventId, sessionId }) => {
    const agenda = await (await fetch(`/api/events/${currentEventId}/agenda`)).json() as {
      sessions: Array<{
        id: string;
        contentStatus: string;
        editedSinceApproval: boolean;
        publishedAt: number | null;
      }>;
    };
    return agenda.sessions.find((session) => session.id === sessionId);
  }, { currentEventId: eventId, sessionId: setup.id });
  expect(state).toMatchObject({
    contentStatus: "approved",
    editedSinceApproval: true,
    publishedAt: expect.any(Number),
  });

  await page.getByRole("button", { name: "Publish agenda" }).click();
  await expect(editStatus).toBeVisible();
  const containment = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(containment.documentWidth).toBeLessThanOrEqual(containment.viewportWidth);

  await page.goto("/program");
  await expect(page.getByRole("link", { name: editedTitle, exact: false })).toBeVisible();

  const cleanup = await page.evaluate(async ({ currentEventId, sessionId, title, abstract }) => {
    const content = await fetch(`/api/events/${currentEventId}/agenda/sessions/${sessionId}/content`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, abstract }),
    });
    const decision = await fetch("/api/review/submissions/sub_ci_monorepo/status", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "under_review" }),
    });
    return { content: content.status, decision: decision.status };
  }, {
    currentEventId: eventId,
    sessionId: setup.id,
    title: originalTitle,
    abstract: originalAbstract,
  });
  expect(cleanup).toEqual({ content: 200, decision: 200 });
});
