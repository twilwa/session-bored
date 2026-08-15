// ABOUTME: Verifies a real multi-participant proposal from the CFP form through organizer amendment.
// ABOUTME: Covers the promise the call makes: co-presenters can be named, amended, and survive acceptance.
import { expect, test } from "@playwright/test";

async function signIn(page: import("@playwright/test").Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("a panel names its participants, the program team amends them, and acceptance keeps them", async ({ page }) => {
  const stamp = Date.now();
  const authorEmail = `panel.author.${stamp}@example.test`;
  const sessionTitle = `What a panel owes its audience ${stamp}`;
  await page.goto("/cfp/devflow-conf-2027");

  await expect(page.getByText("Name your co-presenters here")).toBeVisible();
  await page.getByLabel("Your name").fill("Rosa Okonkwo");
  await page.locator("#cfp-speaker-email").fill(authorEmail);
  await page.getByLabel("Session title").fill(sessionTitle);
  await page.getByLabel("Abstract").fill("Three practitioners on the difference between a discussion and a performance.");
  await page.getByLabel("Track").selectOption({ label: "Developer Experience" });
  await page.getByLabel("Format").selectOption({ label: "Panel (45 min)" });
  await page.getByLabel("Key takeaway").fill("A panel needs a shared question, not three separate talks.");

  await page.getByRole("button", { name: "Add a participant" }).click();
  await page.locator("#cfp-collaborator-name-0").fill("Dev Malhotra");
  await page.locator("#cfp-collaborator-email-0").fill(`dev.${stamp}@example.test`);
  await page.locator("#cfp-collaborator-role-0").fill("co-speaker");
  await page.getByRole("button", { name: "Add a participant" }).click();
  await page.locator("#cfp-collaborator-name-1").fill("Ines Brenner");
  await page.locator("#cfp-collaborator-email-1").fill(`ines.${stamp}@example.test`);
  await page.locator("#cfp-collaborator-role-1").fill("moderator");

  await page.getByRole("button", { name: "Submit proposal" }).click();
  await expect(page.getByRole("heading", { name: "Proposal submitted" })).toBeVisible();
  const reference = await page.getByText(/^sub_/).innerText();

  // The saved proposal returns with all three participants, not only the author.
  await page.getByRole("button", { name: "Edit proposal" }).click();
  await expect(page.locator("#cfp-collaborator-name-0")).toHaveValue("Dev Malhotra");
  await expect(page.locator("#cfp-collaborator-name-1")).toHaveValue("Ines Brenner");
  await expect(page.locator("#cfp-collaborator-role-1")).toHaveValue("moderator");

  await signIn(page, "sbek-organizer@example.com", "SbekTest!2027-org");
  await expect(page).toHaveURL(/\/organizer$/);
  await page.goto(`/organizer/review/submissions/${reference}`);
  await expect(page.getByText("Dev Malhotra")).toBeVisible();
  await expect(page.getByText("Ines Brenner")).toBeVisible();

  await page.getByRole("button", { name: "Add a participant" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill("Late Addition");
  await page.getByRole("textbox", { name: "Email" }).fill(`late.${stamp}@example.test`);
  await page.getByRole("textbox", { name: "Role" }).last().fill("workshop assistant");
  await page.getByRole("button", { name: "Add participant" }).click();
  await expect(page.getByText("Late Addition")).toBeVisible();

  const accepted = await page.evaluate(async (submissionId) => {
    const response = await fetch("/api/events/evt_devflow_conf_2027/disposition", {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ submissionIds: [submissionId], status: "accepted" }),
    });
    return response.json() as Promise<{ handoffs: Array<{ speakers: Array<{ name: string }> }> }>;
  }, reference);
  expect(accepted.handoffs[0]?.speakers.map((speaker) => speaker.name)).toEqual([
    "Rosa Okonkwo",
    "Dev Malhotra",
    "Ines Brenner",
    "Late Addition",
  ]);

  await page.reload();
  await expect(page.getByText("On the session").first()).toBeVisible();
  await expect(page.getByText("Not on the session")).toHaveCount(0);

  // Removing somebody says what it did and, as plainly, what it left standing at the event.
  await page.locator(".participant").filter({ hasText: "Late Addition" })
    .getByRole("button", { name: "Remove" }).click();
  const removalNotice = page.getByRole("status", { name: "What removing this participant did" });
  await expect(removalNotice.getByText("Late Addition is no longer on this proposal")).toBeVisible();
  await expect(removalNotice.getByText("They are still a speaker at this event", { exact: false })).toBeVisible();
  await expect(removalNotice.getByText("They no longer owe this onboarding work:")).toBeVisible();
  await expect(removalNotice.getByRole("listitem")).toHaveText([
    "Complete bio and profile",
    "Confirm participation",
    "Sign speaker release form",
    "Upload final slides by 2027-05-01",
    "Upload headshot",
  ]);
  await expect(removalNotice.getByText(
    "Naming them on this proposal again restores this work and its history.",
  )).toBeVisible();
  await expect(removalNotice.getByRole("link", { name: "roster" })).toHaveAttribute("href", "/organizer/roster");
  await expect(page.locator(".participant").filter({ hasText: "Late Addition" })).toHaveCount(0);

  // Everybody on the panel, the author included, clears onto the roster ready for publication.
  const addresses = [
    authorEmail,
    `dev.${stamp}@example.test`,
    `ines.${stamp}@example.test`,
    `late.${stamp}@example.test`,
  ];
  const roster = await page.evaluate(async () => {
    const response = await fetch("/api/events/evt_devflow_conf_2027/roster", { credentials: "same-origin" });
    return (await response.json() as { items: Array<{ id: string; email: string; status: string }> }).items;
  });
  const panel = addresses.map((address) => roster.find((item) => item.email === address));
  expect(panel.map((item) => item?.status)).toEqual(["onboarding", "onboarding", "onboarding", "onboarding"]);

  const publishedSessionId = await page.evaluate(async (title) => {
    const agenda = await fetch("/api/events/evt_devflow_conf_2027/agenda", { credentials: "same-origin" })
      .then((response) => response.json() as Promise<{ sessions: Array<{ id: string; title: string }> }>);
    const session = agenda.sessions.find((item) => item.title === title);
    if (session === undefined) throw new Error(`Session missing for ${title}`);
    await fetch(`/api/events/evt_devflow_conf_2027/agenda/sessions/${session.id}`, {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scheduleStatus: "tbd", scheduledDate: "2027-05-13" }),
    });
    await fetch(`/api/events/evt_devflow_conf_2027/agenda/sessions/${session.id}/content`, {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contentStatus: "approved" }),
    });
    await fetch("/api/events/evt_devflow_conf_2027/agenda/publish", {
      method: "POST",
      credentials: "same-origin",
    });
    return session.id;
  }, sessionTitle);
  expect(publishedSessionId).toMatch(/^ses_/);

  await page.goto("/speakers");
  // The approved panel is the directory's evidence, so the three people still on it are listed.
  for (const name of ["Rosa Okonkwo", "Dev Malhotra", "Ines Brenner"]) {
    await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
  }
  // Removal leaves the event-speaker row standing - the roster owns withdrawal, and the removal
  // notice said so - but the directory speaks for the programme, and this person is no longer on it.
  await expect(page.getByText("Late Addition", { exact: true })).toHaveCount(0);

  // This spec adds real people and one session to the shared fixture event, so it withdraws the
  // people through the organizer's own roster action, takes the session back off the schedule -
  // which clears its publication - and leaves the seeded programme exactly as it found it.
  await page.evaluate(async ({ speakerIds, sessionId }) => {
    for (const speakerId of speakerIds) {
      await fetch(`/api/events/evt_devflow_conf_2027/speakers/${speakerId}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "withdrawn" }),
      });
    }
    await fetch(`/api/events/evt_devflow_conf_2027/agenda/sessions/${sessionId}`, {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scheduleStatus: "unplaced" }),
    });
  }, { speakerIds: panel.map((item) => item?.id ?? ""), sessionId: publishedSessionId });
});

test("a participant added to a published session stays pending until the organizer republishes", async ({ page }) => {
  const stamp = Date.now();
  const title = `Pending participant publication ${stamp}`;
  const authorName = `Published Author ${stamp}`;
  const pendingName = `Pending Presenter ${stamp}`;
  const createdResponse = await page.request.post("/api/public/cfp/devflow-conf-2027/submissions", {
    data: {
      intent: "submit",
      speaker: {
        name: authorName,
        email: `published.author.${stamp}@example.test`,
        jobTitle: "Principal Engineer",
        organization: "Northwind Labs",
      },
      collaborators: [],
      proposal: {
        title,
        abstract: "A real-browser proof that participant publication remains deliberate.",
        track: "Developer Experience",
        format: "Talk (30 min)",
        audienceLevel: "Intermediate",
        answers: { key_takeaway: "Publication is a confirmation, not a side effect." },
      },
    },
  });
  expect(createdResponse.status()).toBe(201);
  const created = await createdResponse.json() as { submission: { id: string } };

  await signIn(page, "sbek-organizer@example.com", "SbekTest!2027-org");
  await expect(page).toHaveURL(/\/organizer$/);
  const sessionId = await page.evaluate(async ({ submissionId, sessionTitle }) => {
    const accepted = await fetch("/api/events/evt_devflow_conf_2027/disposition", {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ submissionIds: [submissionId], status: "accepted" }),
    });
    if (!accepted.ok) {
      throw new Error(`Proposal could not be accepted (${accepted.status}): ${await accepted.text()}`);
    }
    const agenda = await fetch("/api/events/evt_devflow_conf_2027/agenda", { credentials: "same-origin" })
      .then((response) => response.json() as Promise<{ sessions: Array<{ id: string; title: string }> }>);
    const session = agenda.sessions.find((item) => item.title === sessionTitle);
    if (session === undefined) throw new Error("Accepted session missing from agenda");
    await fetch(`/api/events/evt_devflow_conf_2027/agenda/sessions/${session.id}`, {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scheduleStatus: "tbd", scheduledDate: "2027-05-13" }),
    });
    await fetch(`/api/events/evt_devflow_conf_2027/agenda/sessions/${session.id}/content`, {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contentStatus: "approved" }),
    });
    await fetch("/api/events/evt_devflow_conf_2027/agenda/publish", {
      method: "POST",
      credentials: "same-origin",
    });
    return session.id;
  }, { submissionId: created.submission.id, sessionTitle: title });

  await page.goto(`/organizer/review/submissions/${created.submission.id}`);
  await page.getByRole("button", { name: "Add a participant" }).click();
  await expect(page.getByText("Their place on this session will stay private until you review and republish the agenda."))
    .toBeVisible();
  await page.getByRole("textbox", { name: "Name" }).fill(pendingName);
  await page.getByRole("textbox", { name: "Email" }).fill(`pending.presenter.${stamp}@example.test`);
  await page.getByRole("textbox", { name: "Role" }).last().fill("co-speaker");
  await page.getByRole("button", { name: "Add participant" }).click();
  const pendingParticipant = page.locator(".participant").filter({ hasText: pendingName });
  await expect(pendingParticipant.getByText("Pending publication")).toBeVisible();
  expect(await page.request.get(`/api/public/events/evt_devflow_conf_2027/sessions`).then((response) => response.text()))
    .not.toContain(pendingName);

  await page.goto("/organizer/roster");
  await page.getByLabel("Search speakers").fill(pendingName);
  const pendingRosterRecord = page.locator(".speaker-record").filter({ hasText: pendingName });
  await expect(pendingRosterRecord.getByText("Pending publication")).toBeVisible();
  await expect(pendingRosterRecord.getByText(title)).toBeVisible();
  await pendingRosterRecord.getByRole("link", { name: "Review and republish agenda" }).click();
  await expect(page).toHaveURL(/\/organizer\/agenda$/);
  await expect(page.getByText("1 participant pending")).toBeVisible();
  await page.getByRole("button", { name: "Republish agenda" }).click();
  await expect(page.getByText("1 participant pending")).toHaveCount(0);

  expect(await page.request.get(`/api/public/events/evt_devflow_conf_2027/sessions`).then((response) => response.text()))
    .toContain(pendingName);
  await page.goto("/program");
  const publicSession = page.getByRole("article").filter({ has: page.getByRole("heading", { name: title }) });
  await expect(publicSession).toContainText(pendingName);
  await page.goto("/speakers");
  await expect(page.getByText(pendingName, { exact: true }).first()).toBeVisible();

  expect(sessionId).toMatch(/^ses_/);
  // Publication is this spec's subject, so it also has to hand the shared fixture event back
  // unpublished: the people are withdrawn and the session comes off the schedule.
  await page.evaluate(async ({ publishedAuthor, pendingPresenter, publishedSessionId }) => {
    const roster = await fetch("/api/events/evt_devflow_conf_2027/roster", { credentials: "same-origin" })
      .then((response) => response.json() as Promise<{ items: Array<{ id: string; name: string }> }>);
    for (const name of [publishedAuthor, pendingPresenter]) {
      const speaker = roster.items.find((item) => item.name === name);
      if (speaker === undefined) continue;
      await fetch(`/api/events/evt_devflow_conf_2027/speakers/${speaker.id}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "withdrawn" }),
      });
    }
    await fetch(`/api/events/evt_devflow_conf_2027/agenda/sessions/${publishedSessionId}`, {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scheduleStatus: "unplaced" }),
    });
  }, { publishedAuthor: authorName, pendingPresenter: pendingName, publishedSessionId: sessionId });
});
