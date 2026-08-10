// ABOUTME: Verifies the anonymous CFP journey from landing page through draft, submit, and edit.
// ABOUTME: Covers local-time deadline rendering, durable references, inline errors, and reload persistence.
import { expect, test } from "@playwright/test";

test("speaker saves a draft, submits, and edits through a durable private link", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/cfp/devflow-conf-2027");

  await expect(page.getByRole("heading", { name: "DevFlow Conf 2027" })).toBeVisible();
  // The seeded deadline is 2027-04-30T23:59:59Z. The event's own timezone (America/Los_Angeles,
  // PDT in April) must render it as April 30, 4:59 PM PDT — not the viewer's zone, and not the
  // raw UTC instant (11:59 PM), regardless of what timezone this browser happens to run in.
  await expect(page.getByTestId("deadline-local")).toContainText("America/Los_Angeles");
  await expect(page.getByLabel("Submission deadline")).toContainText("April 30, 2027");
  await expect(page.getByLabel("Submission deadline")).toContainText("4:59 PM");
  await expect(page.getByLabel("Submission deadline")).toContainText("PDT");
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();

  await page.getByLabel("Your name").fill("Casey Rivera");
  await page.getByLabel("Email").fill("casey.cfp.e2e@example.com");
  await page.getByLabel("Session title").fill("Keeping unfinished work safe");
  await page.getByRole("button", { name: "Save draft" }).click();

  await expect(page.getByRole("heading", { name: "Draft saved" })).toBeVisible();
  await expect(page.getByText(/^sub_/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Private return link" })).toHaveAttribute("href", /key=/);
  await expect(page.getByText("Keeping unfinished work safe", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Continue editing" }).click();
  await page.getByRole("button", { name: "Submit proposal" }).click();
  await expect(page.getByText("Abstract is required.", { exact: true })).toBeVisible();
  await expect(page.getByText("Key takeaway is required.", { exact: true })).toBeVisible();

  await page.getByLabel("Abstract").fill("A practical account of preserving incomplete work without lowering the final quality bar.");
  await page.getByLabel("Track").selectOption({ label: "Developer Experience" });
  await page.getByLabel("Format").selectOption({ label: "Talk (30 min)" });
  await page.getByLabel("Key takeaway").fill("Saving and validating are separate jobs.");
  await page.getByRole("button", { name: "Submit proposal" }).click();

  await expect(page.getByRole("heading", { name: "Proposal submitted" })).toBeVisible();
  await page.getByRole("button", { name: "Edit proposal" }).click();
  await page.getByLabel("Abstract").fill("A practical account of preserving incomplete work. Updated before the deadline.");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Your changes are saved.", { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("Abstract")).toHaveValue(/Updated before the deadline\./);
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(375);
});
