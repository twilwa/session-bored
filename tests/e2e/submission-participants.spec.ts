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
  await page.goto("/cfp/devflow-conf-2027");

  await expect(page.getByText("Name your co-presenters here")).toBeVisible();
  await page.getByLabel("Your name").fill("Rosa Okonkwo");
  await page.locator("#cfp-speaker-email").fill(authorEmail);
  await page.getByLabel("Session title").fill(`What a panel owes its audience ${stamp}`);
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

  await page.goto("/speakers");
  for (const name of ["Rosa Okonkwo", "Dev Malhotra", "Ines Brenner", "Late Addition"]) {
    await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
  }

  // This spec adds real people to the shared fixture event, so it withdraws them through the
  // organizer's own roster action and leaves the seeded programme exactly as it found it.
  await page.evaluate(async (speakerIds) => {
    for (const speakerId of speakerIds) {
      await fetch(`/api/events/evt_devflow_conf_2027/speakers/${speakerId}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "withdrawn" }),
      });
    }
  }, panel.map((item) => item?.id ?? ""));
});
