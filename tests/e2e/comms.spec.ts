// ABOUTME: Exercises the organizer communications page in the real browser-rendered UI.
// ABOUTME: Confirms drafting reminders never sends anything and template preview renders real copy.
import { expect, test } from "@playwright/test";

test("organizer reviews communications without anything sending itself", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("sbek-organizer@example.com");
  await page.getByLabel("Password").fill("SbekTest!2027-org");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("link", { name: "Communications" }).click();

  await expect(page.getByRole("heading", { name: /Draft it/ })).toBeVisible();
  await expect(page.getByText("Messages are drafted for review, never sent automatically.")).toBeVisible();
  const deliveryStatus = page.getByRole("region", { name: "Email delivery status" });
  await expect(deliveryStatus).toContainText("Email sender not connected");
  await expect(deliveryStatus).toContainText("Nothing will send until then.");
  // The alert has to say what is missing, who can set it, and exactly what to ask for.
  await expect(deliveryStatus).toContainText("RESEND_API_KEY and RESEND_FROM_ADDRESS");
  await expect(deliveryStatus).toContainText("Whoever deploys this Greenroom");
  await expect(deliveryStatus).toContainText("npx wrangler secret put RESEND_FROM_ADDRESS");
  await expect(deliveryStatus.getByRole("link", { name: "Connecting an email sender" })).toBeVisible();
  // And it may only promise a later send because a waiting letter is genuinely kept and sendable.
  await expect(deliveryStatus).toContainText("go out once a sender is connected");

  await page.getByRole("button", { name: "Draft reminders for overdue tasks" }).click();
  await expect(page.getByText(/reminder draft.* queued for review\./)).toBeVisible();

  const templatePreview = page.getByRole("region", { name: "Template preview" });
  await templatePreview.getByRole("combobox").selectOption("portal_invitation");
  await templatePreview.getByLabel("Priya Raman <sbek-speaker@example.com>").check();
  await templatePreview.getByLabel("portalUrl").fill("https://example.test/speaker");
  await templatePreview.getByRole("button", { name: "Render preview" }).click();

  const previewResult = page.locator(".comms-preview__result");
  await expect(previewResult).toContainText("Set up your speaker portal for DevFlow Conf 2027");
  await expect(previewResult).toContainText("Hi Priya Raman");
  await expect(previewResult).toContainText("speaker for DevFlow Conf 2027");
});

test("organizer authors, previews, and queues a template without leaving Communications", async ({ page }) => {
  const templateName = `Arrival logistics ${Date.now()}`;
  const expectedSubject = `Arrival details ${templateName} for DevFlow Conf 2027`;
  await page.goto("/login");
  await page.getByLabel("Email").fill("sbek-organizer@example.com");
  await page.getByLabel("Password").fill("SbekTest!2027-org");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("link", { name: "Communications" }).click();

  await page.getByRole("button", { name: "New template" }).click();
  await page.getByLabel("Template name").fill(templateName);
  await page.getByLabel("Subject template").fill(`Arrival details ${templateName} for {{eventName}}`);
  await page.getByLabel("Body template").fill("Hi {{recipientName}}, meet us at {{meetingPoint}}.");
  await page.getByRole("button", { name: "Create template" }).click();

  const templatePreview = page.getByRole("region", { name: "Template preview" });
  await expect(templatePreview.getByRole("combobox", { name: "Template" })).toHaveValue(/tmpl_/);
  await expect(templatePreview.getByText("Event template · editable")).toBeVisible();
  await templatePreview.getByLabel("Priya Raman <sbek-speaker@example.com>").check();
  await templatePreview.getByRole("button", { name: "Render preview" }).click();
  await expect(page.getByRole("status")).toContainText("Missing merge fields: meetingPoint");

  await templatePreview.getByLabel("meetingPoint").fill("the north lobby");
  await templatePreview.getByRole("button", { name: "Render preview" }).click();
  await expect(page.getByRole("status")).not.toContainText("Missing merge fields");
  await expect(templatePreview).toContainText(expectedSubject);
  await expect(templatePreview).toContainText("Hi Priya Raman, meet us at the north lobby.");

  await templatePreview.getByRole("button", { name: "Queue 1 draft" }).click();
  await expect(page.getByRole("status")).toContainText("1 draft queued for review");
  const reviewQueue = page.getByRole("region", { name: "Message review queue" });
  const draftedMessage = reviewQueue.locator(".comms-draft").filter({
    has: page.locator(`input[value="${expectedSubject}"]`),
  });
  await expect(draftedMessage).toContainText("sbek-speaker@example.com");
  await expect(draftedMessage.getByLabel("Subject")).toHaveValue(expectedSubject);
  await expect(draftedMessage.getByLabel("Body")).toHaveValue("Hi Priya Raman, meet us at the north lobby.");

  await draftedMessage.getByRole("button", { name: "Approve and send" }).click();
  await expect(page.getByRole("status")).toContainText("No email sender is configured, so nothing was sent.");
  await expect(draftedMessage).toBeVisible();
});

test("a queued decision notice stays visible when no sender is connected", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/login");
  await page.getByLabel("Email").fill("sbek-organizer@example.com");
  await page.getByLabel("Password").fill("SbekTest!2027-org");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/organizer$/);

  const decisionResponse = await page.request.patch("/api/events/evt_devflow_conf_2027/disposition", {
    data: { submissionIds: ["sub_ai_verification"], status: "accepted" },
  });
  expect(decisionResponse.status()).toBe(200);
  const batchResponse = await page.request.post("/api/events/evt_devflow_conf_2027/decision-batches", {
    data: { submissionIds: ["sub_ai_verification"] },
  });
  expect(batchResponse.status()).toBe(201);
  const batch = await batchResponse.json() as { id: string };
  const dispatchResponse = await page.request.post(
    `/api/events/evt_devflow_conf_2027/decision-batches/${batch.id}/dispatch`,
  );
  expect(dispatchResponse.status()).toBe(200);
  await expect(dispatchResponse.json()).resolves.toMatchObject({ emailDelivery: "not_configured" });

  await page.goto("/organizer/comms");
  const log = page.getByRole("region", { name: "Dispatch log" });
  // A proposal can have more than one letter in this history once an earlier one is cancelled,
  // so identify the waiting letter by the pending state rather than by its subject alone.
  const notice = log.getByRole("row")
    .filter({ hasText: "Your talk has been accepted to DevFlow Conf 2027" })
    .filter({ hasText: "No email sender is connected, so delivery was not attempted." });
  await expect(notice).toContainText("queued");
  await expect(notice).toContainText("No email sender is connected, so delivery was not attempted.");
  await expect(notice.getByText("sent", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Email delivery status" })).toContainText("Email sender not connected");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});

test("a decision letter that could not be sent stays visible and honest in Communications", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("sbek-organizer@example.com");
  await page.getByLabel("Password").fill("SbekTest!2027-org");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/organizer$/);

  // Record and dispatch a decision letter with no email sender connected. The proposal is
  // already accepted in the fixture, so this changes no state other lanes' tests read.
  await page.request.patch("/api/events/evt_devflow_conf_2027/disposition", {
    data: { submissionIds: ["sub_ai_verification"], status: "accepted" },
  });
  const batchResponse = await page.request.post("/api/events/evt_devflow_conf_2027/decision-batches", {
    data: { submissionIds: ["sub_ai_verification"] },
  });
  const batch = await batchResponse.json() as { id: string };
  const dispatchResponse = await page.request.post(
    `/api/events/evt_devflow_conf_2027/decision-batches/${batch.id}/dispatch`,
  );
  await expect(dispatchResponse.json()).resolves.toMatchObject({ emailDelivery: "not_configured" });

  // The organizer can see what they decided, that it has not gone out, and why.
  await page.goto("/organizer/comms");
  const undelivered = page.getByRole("region", { name: "Decision letters not yet delivered" });
  await expect(undelivered).toContainText("Your AI Pair Programmer Is Lying to You");
  await expect(undelivered).toContainText("Waiting to send — no delivery has been attempted");
  await expect(undelivered).toContainText("It will go out once an email sender is connected.");
  // With no sender there is nothing to click, so the page offers no dead-end send action.
  await expect(undelivered.getByRole("button", { name: "Send now" })).toHaveCount(0);
});

test("organizer corrects a wrong recipient by cancelling the letter and re-queueing it", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("sbek-organizer@example.com");
  await page.getByLabel("Password").fill("SbekTest!2027-org");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/organizer$/);

  // A cancelled letter stays in the history for good, so every run needs its own reason to
  // identify by. The local database is persistent and other specs queue this same proposal.
  const reason = `Queued to a stale address ${Date.now()}.`;
  const corrected = "priya.raman@greenroom-e2e.dev";

  // Whatever the earlier specs left, there is exactly one live letter for this proposal after
  // this: a dispatch that finds one already queued adds nothing.
  await page.request.patch("/api/events/evt_devflow_conf_2027/disposition", {
    data: { submissionIds: ["sub_ai_verification"], status: "accepted" },
  });
  const batch = await (await page.request.post("/api/events/evt_devflow_conf_2027/decision-batches", {
    data: { submissionIds: ["sub_ai_verification"] },
  })).json() as { id: string };
  await page.request.post(`/api/events/evt_devflow_conf_2027/decision-batches/${batch.id}/dispatch`);

  try {
    await page.goto("/organizer/comms");
    const undelivered = page.getByRole("region", { name: "Decision letters not yet delivered" });
    await expect(undelivered).toContainText("sbek-speaker@example.com");

    // The control exists, is reachable, and opens the correction it promises.
    await undelivered.getByRole("button", { name: "Wrong recipient?" }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("has not been sent, so cancelling it tells nobody anything");
    const addressField = dialog.getByLabel("Correct the recipient's address");
    await expect(addressField).toHaveValue("sbek-speaker@example.com");
    await addressField.fill(corrected);
    await dialog.getByLabel("Why is it being cancelled?").fill(reason);
    await dialog.getByRole("button", { name: "Cancel and re-queue" }).click();

    // One click lands on the replacement letter, rendered from the corrected record.
    await expect(page).toHaveURL(/\/organizer\/disposition\?requeue=sub_ai_verification$/);
    const replacement = page.getByRole("region", { name: "Replacement letter" });
    await expect(replacement).toContainText("The previous letter was cancelled and has not been sent.");
    await expect(replacement).toContainText("Nothing is queued until you dispatch it.");
    await expect(page.getByRole("region", { name: "Decision batch preview" })).toContainText(corrected);

    // Approval is still required: the replacement is not queued until dispatch is clicked.
    const notices = await (await page.request.get("/api/events/evt_devflow_conf_2027/disposition")).json() as {
      items: Array<{ id: string; notice: unknown }>;
    };
    expect(notices.items.find((item) => item.id === "sub_ai_verification")?.notice).toBeNull();

    // The cancelled letter did not vanish - it is in the shared history, marked cancelled, and
    // still showing the address it would have gone to.
    await page.goto("/organizer/comms");
    const cancelled = page.getByRole("region", { name: "Dispatch log" })
      .getByRole("row").filter({ hasText: reason });
    await expect(cancelled).toContainText("cancelled");
    await expect(cancelled).toContainText("sbek-speaker@example.com");
  } finally {
    // Always put the fixture address back, including after a failure, or every later spec reads
    // a speaker this one renamed.
    const roster = await (await page.request.get("/api/events/evt_devflow_conf_2027/roster")).json() as {
      items: Array<{ id: string; email: string }>;
    };
    const moved = roster.items.find((item) => item.email === corrected);
    if (moved !== undefined) {
      await page.request.patch(`/api/events/evt_devflow_conf_2027/speakers/${moved.id}`, {
        data: { email: "sbek-speaker@example.com" },
      });
    }
  }
});

test("cancelling without editing the address leaves an already-corrected recipient alone", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("sbek-organizer@example.com");
  await page.getByLabel("Password").fill("SbekTest!2027-org");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/organizer$/);

  const corrected = `already-corrected-${Date.now()}@greenroom-e2e.dev`;
  await page.request.patch("/api/events/evt_devflow_conf_2027/disposition", {
    data: { submissionIds: ["sub_ci_monorepo"], status: "declined" },
  });
  const batch = await (await page.request.post("/api/events/evt_devflow_conf_2027/decision-batches", {
    data: { submissionIds: ["sub_ci_monorepo"] },
  })).json() as { id: string };
  await page.request.post(`/api/events/evt_devflow_conf_2027/decision-batches/${batch.id}/dispatch`);

  // The address is corrected on the roster, independently, after the letter froze the old one.
  const roster = await (await page.request.get("/api/events/evt_devflow_conf_2027/roster")).json() as {
    items: Array<{ id: string; email: string }>;
  };
  const speaker = roster.items.find((item) => item.email === "sbek-speaker@example.com");
  expect(speaker, "seeded speaker is on the roster").toBeDefined();
  await page.request.patch(`/api/events/evt_devflow_conf_2027/speakers/${speaker!.id}`, {
    data: { email: corrected },
  });

  try {
    // The dialog prefills the letter's frozen address, which is deliberately not the person's
    // current one. Cancelling without touching it must not write the stale address back.
    await page.goto("/organizer/comms");
    const undelivered = page.getByRole("region", { name: "Decision letters not yet delivered" });
    await undelivered.getByRole("button", { name: "Wrong recipient?" }).first().click();
    await expect(page.getByRole("dialog").getByLabel("Correct the recipient's address"))
      .toHaveValue("sbek-speaker@example.com");
    await page.getByRole("dialog").getByRole("button", { name: "Cancel this letter only" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const after = await (await page.request.get("/api/events/evt_devflow_conf_2027/roster")).json() as {
      items: Array<{ id: string; email: string }>;
    };
    expect(after.items.find((item) => item.id === speaker!.id)?.email).toBe(corrected);
  } finally {
    await page.request.patch(`/api/events/evt_devflow_conf_2027/speakers/${speaker!.id}`, {
      data: { email: "sbek-speaker@example.com" },
    });
  }
});
