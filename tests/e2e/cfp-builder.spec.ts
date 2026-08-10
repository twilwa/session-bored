// ABOUTME: Verifies an organizer can build, version, publish, and publicly exercise a conditional CFP form.
// ABOUTME: Uses the real browser, Worker, authentication, and D1 path without mocked form responses.
import { expect, test } from "@playwright/test";

test("organizer builds and publishes a conditional CFP form", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "The complete builder journey runs once in desktop Chrome.");
  const suffix = Date.now().toString(36);
  const slug = `browser-cfp-${suffix}`;

  await page.goto("/login");
  await page.getByLabel("Email").fill("sbek-organizer@example.com");
  await page.getByLabel("Password").fill("SbekTest!2027-org");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/organizer/);
  await page.getByRole("link", { name: "Call for speakers", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Shape the call." })).toBeVisible();
  const builder = page.getByTestId("cfp-builder");

  await page.getByRole("button", { name: "+ New form" }).click();
  await page.getByLabel("Form name").fill(`Browser CFP ${suffix}`);
  await page.getByLabel("Public URL slug").fill(slug);
  const createFormResponse = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && response.url().endsWith("/api/cfp-builder/events/evt_devflow_conf_2027/forms")
  ));
  await page.getByRole("button", { name: "Create private draft" }).click();
  const createdForm = await (await createFormResponse).json() as { form: { id: string } };
  await expect(page.getByText("v1 · draft", { exact: true })).toBeVisible();

  async function addField(label: string, type: "Dropdown" | "Long text" | "Short text") {
    await page.getByRole("button", { name: "+ Add field" }).click();
    const card = page.locator(".cfp-field-card").last();
    await card.getByLabel("Label").fill(label);
    await card.getByLabel("Field type").selectOption({ label: type });
    return card;
  }

  const takeaway = await addField("Key takeaway", "Short text");
  await takeaway.getByLabel("Required to submit").check();
  const audience = await addField("Audience level", "Dropdown");
  await audience.getByLabel("Dropdown options, one per line").fill("Beginner\nIntermediate\nAdvanced");
  const workshop = await addField("Workshop prerequisites", "Long text");
  await workshop.getByLabel("Required to submit").check();
  await workshop.getByLabel("Show only when").selectOption("format");
  await workshop.getByLabel("Equals").selectOption({ label: "Workshop (120 min)" });
  await workshop.getByRole("button", { name: "↑ Move up" }).click();

  await page.getByLabel("Welcome copy").fill("Browser-built calls keep every answer attached to its original question.");
  await page.getByLabel("Confirmation page copy").fill("The browser-built proposal is safely saved.");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Draft changes saved.", { exact: true })).toBeVisible();
  await expect(builder.locator('[data-field-key="session_title"]').getByRole("button", { name: "Remove" })).toBeDisabled();
  await page.getByRole("button", { name: "Publish version 1" }).click();
  await expect(page.getByText("v1 · published", { exact: true })).toBeVisible();

  await page.goto(`/cfp/${slug}`);
  await page.getByLabel("Your name").fill("Browser Version Speaker");
  await expect(page.getByLabel("Email")).toBeDisabled();
  await expect(page.getByLabel("Email")).toHaveValue("sbek-organizer@example.com");
  await page.getByLabel("Session title").fill("A browser submission that keeps its questions");
  await page.getByLabel("Abstract").fill("This exact version-one answer must remain readable after the organizer publishes version two.");
  await page.getByLabel("Track").selectOption({ label: "Developer Experience" });
  await page.getByLabel("Format").selectOption({ label: "Talk (30 min)" });
  await page.getByLabel("Key takeaway").fill("Versioned questions preserve intent.");
  const submissionResponse = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && response.url().endsWith(`/api/public/cfp/${slug}/submissions`)
  ));
  await page.getByRole("button", { name: "Submit proposal" }).click();
  const submission = await (await submissionResponse).json() as { submission: { id: string } };
  await expect(page.getByText("The browser-built proposal is safely saved.", { exact: true })).toBeVisible();
  const versionOneRender = await page.request.get(`/api/cfp-builder/submissions/${submission.submission.id}`);
  expect(versionOneRender.status()).toBe(200);
  const historicalVersionOne = await versionOneRender.text();

  await page.goto("/organizer/cfp");
  await expect(page.getByRole("heading", { name: "Shape the call." })).toBeVisible();
  const formLoadResponse = page.waitForResponse((response) => (
    response.request().method() === "GET"
    && response.url().endsWith(`/api/cfp-builder/forms/${createdForm.form.id}`)
  ));
  const formSelect = builder.getByTestId("cfp-builder-form-select");
  await formSelect.selectOption(createdForm.form.id);
  expect((await formLoadResponse).status()).toBe(200);
  await expect(formSelect).toHaveValue(createdForm.form.id);
  await page.getByLabel("Welcome copy").fill("Version two keeps the public call clear without changing version one answers.");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("v2 · draft", { exact: true })).toBeVisible();
  await page.getByLabel("Welcome copy").fill("Unsaved draft edits are included when version two is published.");
  await page.getByRole("button", { name: "Publish version 2" }).click();
  await expect(page.getByText("v2 · published", { exact: true })).toBeVisible();
  const versionTwoRender = await page.request.get(`/api/cfp-builder/submissions/${submission.submission.id}`);
  expect(versionTwoRender.status()).toBe(200);
  expect(await versionTwoRender.text()).toBe(historicalVersionOne);

  await context.clearCookies();
  await page.goto(`/cfp/${slug}`);
  await expect(page.getByText("Unsaved draft edits are included when version two is published.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Key takeaway")).toBeVisible();
  await expect(page.getByLabel("Audience level")).toHaveCount(1);
  await expect(page.getByLabel("Workshop prerequisites")).toHaveCount(0);
  await page.getByLabel("Format").selectOption({ label: "Workshop (120 min)" });
  await expect(page.getByLabel("Workshop prerequisites")).toBeVisible();
  await page.getByLabel("Format").selectOption({ label: "Talk (30 min)" });
  await expect(page.getByLabel("Workshop prerequisites")).toHaveCount(0);
});
