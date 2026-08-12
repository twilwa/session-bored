// ABOUTME: Defines the safe behavior of Greenroom's email boundary before a provider is configured.
// ABOUTME: Ensures later communication lanes can depend on a typed, explicitly unavailable sender.
import { afterEach, describe, expect, it, vi } from "vitest";
import { emailDelivery, isEmailConfigured, missingEmailSenderSecrets, resolveEmailDelivery } from "../../worker/email.ts";
import { createResendEmailDelivery } from "../../worker/email/resend.ts";

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

describe("resolveEmailDelivery", () => {
  const baseEnv = { APP_ORIGIN: "https://example.test" };

  it("is unconfigured when either Resend var is missing", () => {
    expect(isEmailConfigured(baseEnv)).toBe(false);
    expect(isEmailConfigured({ ...baseEnv, RESEND_API_KEY: "key_only" })).toBe(false);
    expect(isEmailConfigured({ ...baseEnv, RESEND_FROM_ADDRESS: "a@b.com" })).toBe(false);
    expect(resolveEmailDelivery(baseEnv)).toBe(emailDelivery);
  });

  it("resolves a real sender once both Resend vars are present", () => {
    const configured = { ...baseEnv, RESEND_API_KEY: "key", RESEND_FROM_ADDRESS: "Greenroom <a@b.com>" };
    expect(isEmailConfigured(configured)).toBe(true);
    expect(resolveEmailDelivery(configured)).not.toBe(emailDelivery);
  });

  it("names exactly the secrets an operator still has to set", () => {
    expect(missingEmailSenderSecrets(baseEnv)).toEqual(["RESEND_API_KEY", "RESEND_FROM_ADDRESS"]);
    expect(missingEmailSenderSecrets({ ...baseEnv, RESEND_API_KEY: "key" })).toEqual(["RESEND_FROM_ADDRESS"]);
    expect(missingEmailSenderSecrets({ ...baseEnv, RESEND_FROM_ADDRESS: "a@b.com" })).toEqual(["RESEND_API_KEY"]);
    expect(missingEmailSenderSecrets({ ...baseEnv, RESEND_API_KEY: "key", RESEND_FROM_ADDRESS: "a@b.com" }))
      .toEqual([]);
    // An empty binding is not a configured secret, so it is still reported as missing.
    expect(missingEmailSenderSecrets({ ...baseEnv, RESEND_API_KEY: "", RESEND_FROM_ADDRESS: "" }))
      .toEqual(["RESEND_API_KEY", "RESEND_FROM_ADDRESS"]);
  });
});

describe("createResendEmailDelivery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never touches the network without an explicitly stubbed fetch", async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ id: "msg" }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchSpy);
    const delivery = createResendEmailDelivery({ apiKey: "key", fromAddress: "Greenroom <a@b.com>" });
    await delivery.send({
      eventId: "evt_devflow_conf_2027",
      recipient: "speaker@greenroom-mail.dev",
      subject: "Hi",
      html: "<p>Hi</p>",
      text: "Hi",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0];
    expect(call?.[0]).toBe("https://api.resend.com/emails");
    expect(call?.[1]?.headers).toMatchObject({ authorization: "Bearer key" });
  });

  it("maps a successful Resend response to sent with the provider message id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ id: "resend_msg_123" }), { status: 200 })),
    );
    const delivery = createResendEmailDelivery({ apiKey: "key", fromAddress: "Greenroom <a@b.com>" });
    await expect(delivery.send({
      eventId: "evt_devflow_conf_2027",
      recipient: "speaker@greenroom-mail.dev",
      subject: "Hi",
      html: "<p>Hi</p>",
      text: "Hi",
    })).resolves.toEqual({ status: "sent", providerMessageId: "resend_msg_123" });
  });

  it("maps a rejected Resend response to failed without throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ message: "invalid domain" }), { status: 422 })),
    );
    const delivery = createResendEmailDelivery({ apiKey: "key", fromAddress: "Greenroom <a@b.com>" });
    const result = await delivery.send({
      eventId: "evt_devflow_conf_2027",
      recipient: "speaker@greenroom-mail.dev",
      subject: "Hi",
      html: "<p>Hi</p>",
      text: "Hi",
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("resend_422");
  });

  it("maps a network failure to failed rather than throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network unreachable"); }));
    const delivery = createResendEmailDelivery({ apiKey: "key", fromAddress: "Greenroom <a@b.com>" });
    const result = await delivery.send({
      eventId: "evt_devflow_conf_2027",
      recipient: "speaker@greenroom-mail.dev",
      subject: "Hi",
      html: "<p>Hi</p>",
      text: "Hi",
    });
    expect(result).toEqual({ status: "failed", error: "network unreachable" });
  });
});
