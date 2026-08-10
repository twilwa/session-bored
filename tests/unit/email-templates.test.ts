// ABOUTME: Specifies Greenroom's merge-field email templates and their generic preview renderer.
// ABOUTME: Locks the documented merge fields so the preview endpoint stays in sync with the templates.
import { describe, expect, it } from "vitest";
import {
  isTemplateKey,
  listTemplates,
  portalInvitationTemplate,
  renderTemplate,
  submissionConfirmationTemplate,
  taskReminderTemplate,
} from "../../worker/email/templates.ts";
import { textToHtml } from "../../worker/email/send.ts";

describe("submissionConfirmationTemplate", () => {
  it("personalizes subject and body per recipient", () => {
    const rendered = submissionConfirmationTemplate.render({
      eventName: "DevFlow Conf 2027",
      recipientName: "Priya Raman",
      submissionTitle: "Taming CI",
      returnUrl: "https://example.test/cfp/devflow/submissions/sub_1?key=abc",
    });
    expect(rendered.subject).toContain("DevFlow Conf 2027");
    expect(rendered.text).toContain("Priya Raman");
    expect(rendered.text).toContain("Taming CI");
    expect(rendered.text).toContain("https://example.test/cfp/devflow/submissions/sub_1?key=abc");
    expect(rendered.html).toContain("Priya Raman");
  });

  it("uses the form's configured confirmation copy when provided, instead of the default message", () => {
    const rendered = submissionConfirmationTemplate.render({
      eventName: "DevFlow Conf 2027",
      recipientName: "Priya Raman",
      submissionTitle: "Taming CI",
      returnUrl: "https://example.test/cfp/devflow/submissions/sub_1",
      customCopy: "We received Taming CI for DevFlow Conf 2027.",
    });
    expect(rendered.text).toContain("We received Taming CI for DevFlow Conf 2027.");
    expect(rendered.text).not.toContain("The committee will review it");
  });
});

describe("portalInvitationTemplate", () => {
  it("links to the portal URL", () => {
    const rendered = portalInvitationTemplate.render({
      eventName: "DevFlow Conf 2027",
      recipientName: "Priya Raman",
      portalUrl: "https://example.test/speaker",
    });
    expect(rendered.text).toContain("https://example.test/speaker");
  });
});

describe("taskReminderTemplate", () => {
  it("includes the overdue task list", () => {
    const rendered = taskReminderTemplate.render({
      eventName: "DevFlow Conf 2027",
      recipientName: "Priya Raman",
      taskList: "- Upload headshot (was due 2026-01-01)",
      portalUrl: "https://example.test/speaker",
    });
    expect(rendered.text).toContain("Upload headshot");
  });
});

describe("template registry", () => {
  it("lists every registered template with its merge fields", () => {
    const templates = listTemplates();
    expect(templates.map((template) => template.key).sort()).toEqual([
      "portal_invitation",
      "submission_confirmation",
      "task_reminder",
    ]);
    const submissionConfirmation = templates.find((template) => template.key === "submission_confirmation");
    expect(submissionConfirmation?.mergeFields).toEqual(["eventName", "recipientName", "submissionTitle", "returnUrl"]);
  });

  it("recognizes only registered template keys", () => {
    expect(isTemplateKey("submission_confirmation")).toBe(true);
    expect(isTemplateKey("decision_accepted")).toBe(false);
    expect(isTemplateKey(42)).toBe(false);
  });

  it("renders any registered template generically by key, matching its typed render", () => {
    const context = {
      eventName: "DevFlow Conf 2027",
      recipientName: "Priya Raman",
      portalUrl: "https://example.test/speaker",
    };
    expect(renderTemplate("portal_invitation", context)).toEqual(portalInvitationTemplate.render(context));
  });
});

describe("textToHtml", () => {
  it("escapes HTML-significant characters", () => {
    expect(textToHtml("Tom & Jerry <script>")).toBe("<p>Tom &amp; Jerry &lt;script&gt;</p>");
  });

  it("splits paragraphs on blank lines and preserves single newlines as breaks", () => {
    expect(textToHtml("Line one\nLine two\n\nSecond paragraph")).toBe(
      "<p>Line one<br>Line two</p>\n<p>Second paragraph</p>",
    );
  });
});
