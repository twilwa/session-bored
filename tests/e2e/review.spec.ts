// ABOUTME: Exercises Greenroom's committee review workflow through a real browser and D1.
// ABOUTME: Verifies the two primary sorts, durable discussion permalink, and reviewer scope.
import { expect, test } from "@playwright/test";

async function signIn(page: import("@playwright/test").Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("an out-of-remit proposal explains the assignment boundary without leaking content", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, "sbek-reviewer@example.com", "SbekTest!2027-rev");
  await expect(page).toHaveURL(/\/reviewer$/);

  await page.goto("/reviewer/submissions/sub_ai_verification?roundId=rnd_initial_review");

  await expect(page.getByRole("heading", { name: "This proposal isn’t available to you." })).toBeVisible();
  await expect(page.getByText("This proposal is not in your current assignment or review round.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to Assigned proposals" })).toHaveAttribute("href", "/reviewer");
  await expect(page.getByLabel("Loading proposal")).toHaveCount(0);
  await expect(page.getByText("forbidden", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Your AI Pair Programmer Is Lying to You", { exact: false })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});

test("organizer review makes the coverage and decision sorts primary", async ({ page }, testInfo) => {
  await signIn(page, "sbek-organizer@example.com", "SbekTest!2027-org");
  await page.getByRole("link", { name: "Review", exact: true }).click();

  await expect(page.getByRole("heading", { name: /Read together/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Coverage worklist/ })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: /Decision meeting/ }).click();
  await expect(page.getByRole("button", { name: /Decision meeting/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("ratings", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("No email is sent", { exact: true }).first()).toBeVisible();

  await page.getByText("Committee setup", { exact: true }).click();
  if (testInfo.project.name === "desktop") {
    await expect(page.getByLabel("Enable optional AI reading aids")).not.toBeChecked();
  }
  await expect(page.getByText("AI never records a score or decision.", { exact: true })).toBeVisible();
  await expect(page.getByText(
    "No track remit is the default. Select each track this reviewer should be able to see.",
    { exact: true },
  )).toBeVisible();
  await expect(page.getByRole("group", {
    name: "Track remit · none selected means assigned proposals only",
  })).toBeVisible();

  // A reviewer card also links to a proposal it was recused from, so reach this one from the list.
  await page.getByLabel("Decision meeting agenda").getByRole("link", { name: /Taming 40-Minute CI/ }).click();
  await expect(page).toHaveURL(/\/organizer\/review\/submissions\/sub_ci_monorepo/);
  await expect(page.getByRole("heading", { name: /Talk it through here/ })).toBeVisible();
  await expect(page.getByText("Priya Raman", { exact: true })).toBeVisible();
});

test("committee setup reports a newly created round without a client error", async ({ page }) => {
  const name = `Browser setup round ${Date.now()}`;
  await signIn(page, "sbek-organizer@example.com", "SbekTest!2027-org");
  await page.getByRole("link", { name: "Review", exact: true }).click();
  await page.getByText("Committee setup", { exact: true }).click();

  const roundForm = page.getByRole("heading", { name: "Turn on another pass." }).locator("..");
  await roundForm.getByLabel("Round name").fill(name);
  await roundForm.getByRole("button", { name: "Create round" }).click();

  await expect(page.getByText("Round created.", { exact: false })).toBeVisible();
  await expect(page.getByTestId(/review-round-/).filter({ hasText: name })).toHaveCount(1);
  await expect(page.getByText("Cannot read properties of null", { exact: false })).toHaveCount(0);
});

test("narrowing a remit in committee setup takes that reading access away", async ({ page, browser }) => {
  const unique = Date.now();
  const email = `narrowed-reviewer-${unique}@example.com`;
  const password = "ReviewTalks!2027";
  await signIn(page, "sbek-organizer@example.com", "SbekTest!2027-org");
  await expect(page).toHaveURL(/\/organizer/);
  const provision = await page.request.post("/api/review/events/evt_devflow_conf_2027/reviewers", {
    data: { name: `Narrowed Reviewer ${unique}`, email, password },
  });
  expect(provision.status()).toBe(201);

  const reviewerContext = await browser.newContext();
  const reviewerPage = await reviewerContext.newPage();
  await signIn(reviewerPage, email, password);
  await expect(reviewerPage.getByRole("link", { name: /Taming 40-Minute CI/ })).toBeVisible();
  await expect(reviewerPage.getByRole("link", { name: /Your AI Pair Programmer/ })).toBeVisible();

  await page.getByRole("link", { name: "Review", exact: true }).click();
  await page.getByText("Committee setup", { exact: true }).click();
  const reviewerCard = page
    .locator(".reviewer-progress-list article")
    .filter({ hasText: `Narrowed Reviewer ${unique}` });
  await expect(reviewerCard.getByText("All submissions", { exact: true })).toBeVisible();
  await reviewerCard.getByText("Edit remit", { exact: true }).click();
  await reviewerCard.getByLabel("Platform & Infra").uncheck();
  await reviewerCard.getByLabel("Developer Experience").uncheck();
  await reviewerCard.getByRole("button", { name: "Save remit" }).click();
  await expect(page.getByText("2 removed. They lose that access immediately.", { exact: false }))
    .toBeVisible();
  await expect(reviewerCard.getByText("1 track remit", { exact: true })).toBeVisible();

  await reviewerPage.reload();
  await expect(reviewerPage.getByRole("link", { name: /Your AI Pair Programmer/ })).toBeVisible();
  await expect(reviewerPage.getByRole("link", { name: /Taming 40-Minute CI/ })).toHaveCount(0);
  await reviewerPage.goto("/reviewer/submissions/sub_ci_monorepo?roundId=rnd_initial_review");
  await expect(
    reviewerPage.getByRole("heading", { name: "This proposal isn’t available to you." }),
  ).toBeVisible();
  await expect(reviewerPage.getByText("Taming 40-Minute CI", { exact: false })).toHaveCount(0);
  await reviewerContext.close();
});

test("reviewer opens only their remit and posts to its durable thread", async ({ page }) => {
  await signIn(page, "sbek-reviewer@example.com", "SbekTest!2027-rev");

  await expect(page.getByRole("link", { name: "Assignments", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Completed", exact: true })).toHaveCount(0);
  await expect(page.getByText(/assigned proposal|proposals in remit/)).toBeVisible();
  await expect(page.getByText("Your AI Pair Programmer", { exact: false })).toHaveCount(0);
  await page.getByRole("link", { name: /Taming 40-Minute CI/ }).click();
  await expect(page).toHaveURL(/\/reviewer\/submissions\/sub_ci_monorepo/);

  await page.getByLabel(/Overall rating/).fill("5");
  await page.getByLabel(/Recommendation/).selectOption("Maybe");
  await page.getByLabel(/Reviewer notes/).fill("Unsaved scorecard draft.");
  await page.getByLabel("Scorecard note").fill("Keep this draft while discussing.");
  const comment = `Browser committee note ${Date.now()}`;
  await page.getByLabel("Add to the committee thread").fill(comment);
  const refreshedDetail = page.waitForResponse((response) =>
    response.request().method() === "GET" &&
    response.url().includes("/api/review/submissions/sub_ci_monorepo")
  );
  await page.getByRole("button", { name: "Post comment" }).click();
  await refreshedDetail;
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await expect(page.getByText(comment, { exact: true })).toBeVisible();
  await expect(page.getByLabel(/Overall rating/)).toHaveValue("5");
  await expect(page.getByLabel(/Recommendation/)).toHaveValue("Maybe");
  await expect(page.getByLabel(/Reviewer notes/)).toHaveValue("Unsaved scorecard draft.");
  await expect(page.getByLabel("Scorecard note")).toHaveValue("Keep this draft while discussing.");
  await expect(page.getByRole("heading", { name: "Initial review" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "AI-generated reading aid" })).toHaveCount(0);
});

test("returning reviewer sees their saved scorecard", async ({ page }) => {
  await signIn(page, "sbek-reviewer@example.com", "SbekTest!2027-rev");
  await page.getByRole("link", { name: /Taming 40-Minute CI/ }).click();

  await page.getByLabel(/Overall rating/).fill("4");
  await page.getByLabel(/Recommendation/).selectOption("Accept");
  await page.getByLabel(/Reviewer notes/).fill("The evidence is concrete and useful.");
  await page.getByLabel("Scorecard note").fill("Bring this to the accept discussion.");
  await page.getByRole("button", { name: /(?:Save|Update) scorecard/ }).click();
  await expect(page.getByText("Scorecard saved.", { exact: false })).toBeVisible();

  await page.getByRole("link", { name: "Back to review" }).click();
  await page.getByRole("link", { name: /Taming 40-Minute CI/ }).click();

  await expect(page.getByText("Editing saved scorecard", { exact: true })).toBeVisible();
  await expect(page.getByLabel(/Overall rating/)).toHaveValue("4");
  await expect(page.getByLabel(/Recommendation/)).toHaveValue("Accept");
  await expect(page.getByLabel(/Reviewer notes/)).toHaveValue("The evidence is concrete and useful.");
  await expect(page.getByLabel("Scorecard note")).toHaveValue("Bring this to the accept discussion.");
});

test("reviewer sees the complete submitted proposal", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "The mobile project runs after seed-count coverage.");
  const unique = Date.now();
  const createResponse = await page.request.post("/api/public/cfp/devflow-conf-2027/submissions", {
    data: {
      intent: "submit",
      speaker: { name: "Complete Proposal Speaker", email: `complete-proposal-${unique}@example.com` },
      proposal: {
        title: `Complete proposal ${unique}`,
        abstract: "Every scoring input belongs on the proposal permalink.",
        track: "Platform & Infra",
        format: "Talk (30 min)",
        audienceLevel: "Advanced",
        answers: { key_takeaway: "Pinned custom answers keep the committee informed." },
      },
    },
  });
  expect(createResponse.ok()).toBe(true);

  await signIn(page, "sbek-reviewer@example.com", "SbekTest!2027-rev");
  await page.getByRole("link", { name: `Complete proposal ${unique}` }).click();

  await expect(page.getByText("Talk (30 min)", { exact: true })).toBeVisible();
  await expect(page.getByText("Advanced", { exact: true })).toBeVisible();
  await expect(page.getByText("Platform & Infra", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Submitted answers" })).toBeVisible();
  await expect(page.getByText("Key takeaway", { exact: true })).toBeVisible();
  await expect(page.getByText("Pinned custom answers keep the committee informed.", { exact: true })).toBeVisible();
});

test("reviewer explicitly requests enabled AI assistance", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "One browser owns the event-level toggle.");
  await signIn(page, "sbek-organizer@example.com", "SbekTest!2027-org");
  await page.getByRole("link", { name: "Review", exact: true }).click();
  await page.getByText("Committee setup", { exact: true }).click();
  const toggle = page.getByLabel("Enable optional AI reading aids");
  if (!(await toggle.isChecked())) {
    const saved = page.waitForResponse((response) =>
      response.request().method() === "PATCH" &&
      response.url().endsWith("/api/review/events/evt_devflow_conf_2027/ai-assistance")
    );
    await toggle.click();
    expect((await saved).ok()).toBe(true);
  }
  await expect(toggle).toBeChecked();

  try {
    await page.context().clearCookies();
    let generationRequests = 0;
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        request.url().endsWith("/api/review/submissions/sub_ci_monorepo/ai-assistance")
      ) {
        generationRequests += 1;
      }
    });
    await signIn(page, "sbek-reviewer@example.com", "SbekTest!2027-rev");
    await page.getByRole("link", { name: /Taming 40-Minute CI/ }).click();
    await expect(page.getByText("The proposal", { exact: false })).toBeVisible();
    expect(generationRequests).toBe(0);

    await page.getByRole("button", { name: "Generate AI reading aid" }).click();
    await expect(page.getByRole("heading", { name: "Unavailable right now." })).toBeVisible();
    expect(generationRequests).toBe(1);
  } finally {
    await page.context().clearCookies();
    await signIn(page, "sbek-organizer@example.com", "SbekTest!2027-org");
    await page.getByRole("link", { name: "Review", exact: true }).click();
    await page.getByText("Committee setup", { exact: true }).click();
    const restoreToggle = page.getByLabel("Enable optional AI reading aids");
    if (await restoreToggle.isChecked()) {
      const saved = page.waitForResponse((response) =>
        response.request().method() === "PATCH" &&
        response.url().endsWith("/api/review/events/evt_devflow_conf_2027/ai-assistance")
      );
      await restoreToggle.click();
      expect((await saved).ok()).toBe(true);
    }
    await expect(restoreToggle).not.toBeChecked();
    await expect(page.getByText("AI reading aids turned off", { exact: false })).toBeVisible();
  }
});

test("organizer edits and removes a scorecard criterion", async ({ page }) => {
  const unique = Date.now();
  const originalLabel = `Temporary criterion ${unique}`;
  const updatedLabel = `Renamed criterion ${unique}`;
  await signIn(page, "sbek-organizer@example.com", "SbekTest!2027-org");
  await page.getByRole("link", { name: "Review", exact: true }).click();
  await page.getByText("Committee setup", { exact: true }).click();

  const createForm = page.getByRole("heading", { name: "Add one useful signal." }).locator("..");
  await createForm.getByLabel("Criterion").fill(originalLabel);
  await createForm.getByLabel("Type").selectOption("numeric");
  await createForm.getByLabel("Weight").fill("1");
  await createForm.getByRole("button", { name: "Add criterion" }).click();
  await expect(page.getByText(originalLabel, { exact: true })).toBeVisible();

  const criterionRow = page.getByRole("listitem").filter({ hasText: originalLabel });
  await criterionRow.getByText("Edit", { exact: true }).click();
  await criterionRow.getByLabel("Criterion label").fill(updatedLabel);
  await criterionRow.getByLabel("Weight").fill("2");
  await criterionRow.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText(updatedLabel, { exact: true })).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  const updatedRow = page.getByRole("listitem").filter({ hasText: updatedLabel });
  await updatedRow.getByRole("button", { name: "Remove criterion" }).click();
  await expect(page.getByText(updatedLabel, { exact: true })).toHaveCount(0);
});

test("a reviewer recuses themselves and the committee sees the recusal", async ({ page, browser }) => {
  const unique = Date.now();
  const email = `recusing-reviewer-${unique}@example.com`;
  const password = "ReviewTalks!2027";
  const name = `Recusing Reviewer ${unique}`;
  await signIn(page, "sbek-organizer@example.com", "SbekTest!2027-org");
  await expect(page).toHaveURL(/\/organizer/);
  const provision = await page.request.post("/api/review/events/evt_devflow_conf_2027/reviewers", {
    data: { name, email, password, trackIds: [] },
  });
  expect(provision.status()).toBe(201);
  const reviewerUserId = (await provision.json()).reviewer.id;
  const assign = await page.request.post("/api/review/rounds/rnd_initial_review/assignments", {
    data: { reviewerUserId, submissionIds: ["sub_ci_monorepo", "sub_ai_verification"] },
  });
  expect(assign.status()).toBe(201);

  const reviewerContext = await browser.newContext();
  const reviewerPage = await reviewerContext.newPage();
  await signIn(reviewerPage, email, password);
  await expect(reviewerPage.getByText("2 proposals in remit", { exact: true })).toBeVisible();
  await reviewerPage.getByRole("link", { name: /Taming 40-Minute CI/ }).click();
  await expect(reviewerPage).toHaveURL(/\/reviewer\/submissions\/sub_ci_monorepo/);

  await reviewerPage.getByRole("button", { name: "Recuse myself" }).click();
  await expect(reviewerPage.getByText("It records no score, no decision, and sends nothing to the speaker.", { exact: false })).toBeVisible();
  await reviewerPage.getByRole("button", { name: "Confirm recusal" }).click();

  await expect(reviewerPage.getByRole("heading", { name: "You stepped back from this proposal." })).toBeVisible();
  await expect(reviewerPage.getByRole("button", { name: /Save scorecard|Update scorecard/ })).toHaveCount(0);
  await expect(reviewerPage.getByRole("button", { name: "Recuse myself" })).toHaveCount(0);
  await expect(reviewerPage.getByText("RECORDED SCORECARDS", { exact: true })).toHaveCount(0);

  await reviewerPage.getByRole("link", { name: "← Back to review" }).click();
  await expect(reviewerPage.getByText("1 assigned proposal", { exact: true })).toBeVisible();
  await expect(
    reviewerPage.getByRole("region", { name: "Your review queue" })
      .getByRole("link", { name: /Taming 40-Minute CI/ }),
  ).toHaveCount(0);
  const recusedList = reviewerPage.getByRole("region", {
    name: "Proposals you recused yourself from",
  });
  await expect(recusedList.getByRole("link", { name: /Taming 40-Minute CI/ })).toBeVisible();
  const coverage = reviewerPage.locator(".coverage-dial");
  await expect(coverage.getByText("0%", { exact: true })).toBeVisible();
  await expect(coverage.getByText("0 of 1 scorecards", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Review", exact: true }).click();
  // The worklist row says why a proposal can sit at no ratings.
  const worklistRow = page.locator(".review-row").filter({ hasText: "sub_ci_monorepo" });
  await expect(worklistRow.locator(".review-row__recusal")).toContainText(name);

  await page.getByText("Committee setup", { exact: true }).click();
  const reviewerCard = page.locator(".reviewer-progress-list article").filter({ hasText: name });
  await expect(reviewerCard.getByText("0 / 1", { exact: true })).toBeVisible();
  await expect(reviewerCard.getByText("1 recused", { exact: false })).toBeVisible();
  // The count leads to the proposal it stands for.
  await reviewerCard.getByRole("link", { name: /Taming 40-Minute CI/ }).click();
  await expect(page).toHaveURL(/\/organizer\/review\/submissions\/sub_ci_monorepo/);
  await reviewerContext.close();
});
