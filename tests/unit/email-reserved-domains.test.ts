// ABOUTME: Pins which recipient domains Greenroom refuses as permanently undeliverable.
// ABOUTME: Guards both directions - every reserved form is refused, every registrable lookalike is not.
import { describe, expect, it, vi } from "vitest";
import { resolveEmailDelivery } from "../../worker/email.ts";
import {
  isUndeliverableRecipient,
  refuseUndeliverableRecipients,
  undeliverableRecipientReason,
} from "../../worker/email/reserved-domains.ts";
import { createResendEmailDelivery } from "../../worker/email/resend.ts";

const message = {
  eventId: "evt_devflow_conf_2027",
  subject: "Your proposal",
  html: "<p>Hi</p>",
  text: "Hi",
} as const;

describe("isUndeliverableRecipient", () => {
  it("refuses every domain RFC 2606 reserves for examples, and their subdomains", () => {
    for (const recipient of [
      "speaker@example.com",
      "speaker@example.net",
      "speaker@example.org",
      "speaker@mail.example.com",
      "qa-journey-2026@example.com",
    ]) {
      expect(isUndeliverableRecipient(recipient), recipient).toBe(true);
    }
  });

  it("refuses every reserved top-level domain", () => {
    for (const recipient of [
      "speaker@greenroom.invalid",
      "speaker@greenroom.test",
      "speaker@greenroom.example",
      "speaker@greenroom.localhost",
      "speaker@localhost",
      "speaker@deep.staging.greenroom.test",
    ]) {
      expect(isUndeliverableRecipient(recipient), recipient).toBe(true);
    }
  });

  it("is case- and trailing-dot-insensitive, so neither disguises a reserved domain", () => {
    expect(isUndeliverableRecipient("Speaker@EXAMPLE.COM")).toBe(true);
    expect(isUndeliverableRecipient("speaker@example.com.")).toBe(true);
  });

  it("leaves registrable lookalikes alone rather than matching on a substring", () => {
    for (const recipient of [
      "speaker@myexample.com",
      "speaker@example.company",
      "speaker@examplecom.org",
      "speaker@notexample.net",
      "speaker@testing.com",
      "speaker@invalid-inputs.com",
      "speaker@localhost.dev",
      "speaker@greenroom-mail.dev",
      "example.com@greenroom-mail.dev",
    ]) {
      expect(isUndeliverableRecipient(recipient), recipient).toBe(false);
    }
  });
});

describe("refuseUndeliverableRecipients", () => {
  it("fails a reserved recipient with a plain reason and never calls the wrapped delivery", async () => {
    const send = vi.fn(async () => ({ status: "sent" }) as const);
    const guarded = refuseUndeliverableRecipients({ send });

    const result = await guarded.send({ ...message, recipient: "qa-journey-2026@example.com" });

    expect(result).toEqual({
      status: "failed",
      error: undeliverableRecipientReason("qa-journey-2026@example.com"),
    });
    expect(result.error).toContain("nothing was sent");
    expect(send).not.toHaveBeenCalled();
  });

  it("passes a deliverable recipient straight through", async () => {
    const send = vi.fn(async () => ({ status: "sent", providerMessageId: "msg_1" }) as const);
    const guarded = refuseUndeliverableRecipients({ send });

    await expect(guarded.send({ ...message, recipient: "speaker@myexample.com" }))
      .resolves.toEqual({ status: "sent", providerMessageId: "msg_1" });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("the sender an organizer's send actually resolves", () => {
  it("refuses a reserved recipient without reaching the network", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const delivery = resolveEmailDelivery({
        APP_ORIGIN: "https://greenroom-mail.dev",
        RESEND_API_KEY: "re_key",
        RESEND_FROM_ADDRESS: "Greenroom <program@greenroom-mail.dev>",
      });

      const result = await delivery.send({ ...message, recipient: "speaker@example.com" });

      expect(result.status).toBe("failed");
      expect(fetchSpy).not.toHaveBeenCalled();

      // The provider adapter refuses on its own too, so constructing one
      // directly - the one way past the wrapper - still cannot reach Resend.
      const unwrapped = createResendEmailDelivery({ apiKey: "re_key", fromAddress: "a@greenroom-mail.dev" });
      await expect(unwrapped.send({ ...message, recipient: "speaker@example.com" }))
        .resolves.toMatchObject({ status: "failed" });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
