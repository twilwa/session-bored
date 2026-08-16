// ABOUTME: Walks the private cross-event speaker directory in a real organizer browser.
// ABOUTME: Proves metadata, filters, notes, history, merges, and phone-width layout.
import { expect, test } from "@playwright/test";

async function signInAsOrganizer(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill("sbek-organizer@example.com");
  await page.getByLabel("Password").fill("SbekTest!2027-org");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/organizer$/);
}

test("organizer browses the all-event directory and opens a speaker history", async ({ page }) => {
  await signInAsOrganizer(page);
  await page.goto("/organizer/directory");

  await expect(page.getByRole("heading", { name: "Speaker directory." })).toBeVisible();
  await expect(page.getByText("SPEAKER MEMORY / ALL EVENTS")).toBeVisible();

  await page.getByLabel("Search directory").fill("Marcus");
  await page.getByRole("button", { name: "Apply filters" }).click();
  const marcus = page.locator(".directory-row").filter({ hasText: "Marcus Okafor" });
  await marcus.getByRole("link", { name: "View Marcus Okafor" }).click();
  await expect(page.getByRole("heading", { name: "Marcus Okafor" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Event history" })).toBeVisible();
  await expect(page.locator(".directory-event")).toContainText("DevFlow Conf 2027");

  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));
});

test("organizer enriches a private contact and reruns combined filters without a page load", async ({ page }, testInfo) => {
  await signInAsOrganizer(page);
  await page.goto("/organizer/directory");
  await page.getByLabel("Search directory").fill("sbek-speaker@example.com");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await page.locator(".directory-row").filter({ hasText: "Priya Raman" })
    .getByRole("link", { name: "View Priya Raman" }).click();

  await page.getByRole("button", { name: "Edit directory details" }).click();
  await page.getByLabel("Tags").fill("Keynote, Accessibility");
  await page.getByLabel("Custom fields").fill("Region: EMEA\nAudience: Engineering leaders");
  await page.getByRole("button", { name: "Save directory details" }).click();
  await expect(page.getByText("Accessibility", { exact: true })).toBeVisible();
  await expect(page.getByText("Engineering leaders", { exact: true })).toBeVisible();

  const note = `Private CRM note ${testInfo.project.name}-${Date.now()}`;
  await page.getByLabel("Add internal note").fill(note);
  await page.getByRole("button", { name: "Add private note" }).click();
  await expect(page.locator(".directory-note-list").getByText(note, { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "All speaker records" }).click();
  await page.getByRole("checkbox", { name: "Keynote", exact: true }).check();
  await page.getByRole("checkbox", { name: "Region: EMEA", exact: true }).check();
  const beforePath = new URL(page.url()).pathname;
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.locator(".directory-row").filter({ hasText: "Priya Raman" })).toBeVisible();
  await expect(page.getByText("Marcus Okafor", { exact: true })).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe(beforePath);

  const segmentName = `EMEA keynotes ${testInfo.project.name}-${Date.now()}`;
  await page.getByLabel("Segment name").fill(segmentName);
  await page.getByRole("button", { name: "Save segment" }).click();
  await expect(page.locator(".toast")).toContainText("Segment saved");
  await page.getByRole("button", { name: "Clear filters" }).click();
  await page.getByLabel("Saved segment").selectOption({ label: segmentName });
  await page.getByRole("button", { name: "Run segment" }).click();
  await expect(page.locator(".directory-row").filter({ hasText: "Priya Raman" })).toBeVisible();
  await expect(page.getByText("Marcus Okafor", { exact: true })).toHaveCount(0);

  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));
});

async function submitProposalAs(
  request: import("@playwright/test").APIRequestContext,
  speaker: { name: string; email: string; organization: string },
  title: string,
): Promise<void> {
  const submitted = await request.post("/api/public/cfp/devflow-conf-2027/submissions", {
    data: {
      intent: "submit",
      speaker: { ...speaker, jobTitle: "Staff Engineer" },
      collaborators: [],
      proposal: {
        title,
        abstract: "A real proposal that gives this directory identity a proposal record to keep.",
        track: "Developer Experience",
        format: "Talk (30 min)",
        audienceLevel: "Intermediate",
        answers: { key_takeaway: "Durable speaker identity matters across events." },
      },
    },
  });
  expect(submitted.status(), await submitted.text()).toBe(201);
}

test("organizer cannot merge two speaker records from the same event", async ({ page }, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const name = `Directory Twin ${suffix}`;
  const organization = `Northwind ${suffix}`;
  const keptEmail = `twin-kept-${suffix}@example.com`;
  const archivedEmail = `twin-archived-${suffix}@example.com`;
  await submitProposalAs(page.request, { name, email: keptEmail, organization }, `Twin kept ${suffix}`);
  await submitProposalAs(page.request, { name, email: archivedEmail, organization }, `Twin archived ${suffix}`);

  await signInAsOrganizer(page);
  await page.goto("/organizer/directory");
  await page.getByLabel("Search directory").fill(keptEmail);
  await page.getByRole("button", { name: "Apply filters" }).click();
  await page.locator(".directory-row").filter({ hasText: keptEmail })
    .getByRole("link", { name: `View ${name}` }).click();
  await expect(page.getByRole("heading", { name: "Possible duplicates" })).toBeVisible();

  const candidate = page.locator(".directory-duplicate").filter({ hasText: archivedEmail });
  await candidate.getByRole("button", { name: `Keep ${keptEmail}` }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm speaker merge" });
  await expect(dialog).toContainText(`Archive ${archivedEmail}`);
  await dialog.getByRole("button", { name: `Merge and keep ${keptEmail}` }).click();

  await expect(page.locator(".toast")).toContainText("Resolve the same-event speaker records");
  await expect(page.getByRole("heading", { name: "Possible duplicates" })).toBeVisible();
  await expect(candidate).toBeVisible();

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("link", { name: "All speaker records" }).click();
  await page.getByLabel("Search directory").fill(name);
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.locator(".directory-row").filter({ hasText: keptEmail })).toBeVisible();
  await expect(page.locator(".directory-row").filter({ hasText: archivedEmail })).toBeVisible();
});

test("organizer reviews and merges a likely duplicate while choosing the kept record", async ({ page }, testInfo) => {
  await signInAsOrganizer(page);
  const directoryResponse = await page.request.get("/api/speaker-directory?q=sbek-speaker%40example.com");
  expect(directoryResponse.status()).toBe(200);
  const directory = await directoryResponse.json() as {
    items: Array<{ id: string; name: string; email: string; organization: string | null }>;
  };
  const priya = directory.items.find((person) => person.id === "psn_priya_raman");
  expect(priya).toBeDefined();
  await page.context().clearCookies();

  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const duplicateEmail = `priya-directory-${suffix}@example.com`;
  const submitted = await page.request.post("/api/public/cfp/devflow-conf-2027/submissions", {
    data: {
      intent: "submit",
      speaker: {
        name: `Directory Author ${suffix}`,
        email: `directory-author-${suffix}@example.com`,
        jobTitle: "Staff Engineer",
        organization: "Contoso",
      },
      collaborators: [{
        name: priya!.name,
        email: duplicateEmail,
        jobTitle: "Principal Engineer",
        organization: priya!.organization,
        roleLabel: "co-speaker",
      }],
      proposal: {
        title: `Directory duplicate proof ${suffix}`,
        abstract: "A real proposal that introduces a duplicate directory identity for merge review.",
        track: "Developer Experience",
        format: "Talk (30 min)",
        audienceLevel: "Intermediate",
        answers: { key_takeaway: "Durable speaker identity matters across events." },
      },
    },
  });
  expect(submitted.status(), await submitted.text()).toBe(201);

  await signInAsOrganizer(page);
  await page.goto("/organizer/directory");
  await page.getByLabel("Search directory").fill(duplicateEmail);
  await page.getByRole("button", { name: "Apply filters" }).click();
  const duplicate = page.locator(".directory-row").filter({ hasText: duplicateEmail });
  await expect(duplicate).toContainText("Possible duplicate");
  await duplicate.getByRole("link", { name: `View ${priya!.name}` }).click();

  const candidate = page.locator(".directory-duplicate").filter({ hasText: priya!.email });
  await candidate.getByRole("button", { name: `Keep ${priya!.email}` }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm speaker merge" });
  await expect(dialog).toContainText(`Keep ${priya!.email}`);
  await expect(dialog).toContainText(`Archive ${duplicateEmail}`);
  await expect(dialog).toContainText("moves only ownership references");
  await expect(dialog).toContainText("Roster status, removals, publication, task state, profile fields, and account ownership stay untouched");
  await dialog.getByRole("button", { name: `Merge and keep ${priya!.email}` }).click();

  await expect(page).toHaveURL(/\/organizer\/directory\/psn_priya_raman$/);
  await expect(page.locator(".toast")).toContainText("merged into");
  await expect(page.locator(".toast")).toContainText("ownership reference");
  await expect(page.getByRole("heading", { level: 1, name: priya!.name })).toBeVisible();
});
