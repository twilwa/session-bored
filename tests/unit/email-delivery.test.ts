// ABOUTME: Defines the safe behavior of Greenroom's email boundary before a provider is configured.
// ABOUTME: Ensures later communication lanes can depend on a typed, explicitly unavailable sender.
import { describe, expect, it } from "vitest";
import { emailDelivery } from "../../worker/email.ts";

describe("email delivery boundary", () => {
  it("reports that delivery is not configured without pretending to send", async () => {
    await expect(emailDelivery.send({
      eventId: "evt_devflow_conf_2027",
      recipient: "speaker@example.com",
      subject: "Welcome",
      html: "<p>Welcome</p>",
      text: "Welcome",
    })).resolves.toEqual({ status: "provider_not_configured" });
  });
});
