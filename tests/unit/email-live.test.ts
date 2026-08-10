// ABOUTME: The one real, opt-in send this repo makes over the network - skipped by default.
// ABOUTME: Proves the Resend wiring actually works; every other test injects a fake delivery instead.
import { describe, expect, it } from "vitest";
import { createResendEmailDelivery } from "../../worker/email/resend.ts";

declare const process: {
  env: {
    RUN_REAL_EMAIL_TEST?: string;
    RESEND_API_KEY?: string;
    RESEND_FROM_ADDRESS?: string;
  };
};

const enabled = process.env.RUN_REAL_EMAIL_TEST === "1" &&
  process.env.RESEND_API_KEY !== undefined &&
  process.env.RESEND_FROM_ADDRESS !== undefined;

// Run with:
//   RUN_REAL_EMAIL_TEST=1 RESEND_API_KEY=... RESEND_FROM_ADDRESS=... npx vitest run tests/unit/email-live.test.ts
// Sends to Resend's documented safe test address (delivered@resend.dev), never a real inbox.
describe.skipIf(!enabled)("live Resend delivery (opt-in)", () => {
  it("actually sends through the real Resend API", async () => {
    const delivery = createResendEmailDelivery({
      apiKey: process.env.RESEND_API_KEY!,
      fromAddress: process.env.RESEND_FROM_ADDRESS!,
    });
    const result = await delivery.send({
      eventId: "evt_devflow_conf_2027",
      recipient: "delivered@resend.dev",
      subject: "Greenroom live send test",
      html: "<p>Greenroom live send test.</p>",
      text: "Greenroom live send test.",
    });
    expect(result.status).toBe("sent");
    expect(result.providerMessageId).toBeDefined();
  });
});
