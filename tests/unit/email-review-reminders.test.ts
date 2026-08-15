// ABOUTME: Verifies review-reminder copy against the built-in typed template.
// ABOUTME: Keeps singular and plural outstanding-read messages clear before dispatch drafting.
import { describe, expect, it } from "vitest";
import { reviewReminderTemplate } from "../../worker/email/templates.ts";

describe("review reminder template", () => {
  it("names the event, outstanding count, and same-origin review destination", () => {
    const one = reviewReminderTemplate.render({
      eventName: "DevFlow Conf 2027",
      recipientName: "Sam Whitfield",
      outstandingReviewCount: 1,
      reviewUrl: "https://greenroom.example/reviewer",
    });
    expect(one.subject).toBe("1 proposal still needs your review for DevFlow Conf 2027");
    expect(one.text).toContain("Hi Sam Whitfield,");
    expect(one.text).toContain("1 proposal still needs your review for DevFlow Conf 2027.");
    expect(one.text).toContain("https://greenroom.example/reviewer");

    const several = reviewReminderTemplate.render({
      eventName: "DevFlow Conf 2027",
      recipientName: "Sam Whitfield",
      outstandingReviewCount: 3,
      reviewUrl: "https://greenroom.example/reviewer",
    });
    expect(several.subject).toBe("3 proposals still need your review for DevFlow Conf 2027");
  });
});
