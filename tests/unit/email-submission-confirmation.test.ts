// ABOUTME: Specifies that the submission confirmation never invents an address to send to.
// ABOUTME: The anonymous-submission path must skip cleanly without touching the database.
import { describe, expect, it, vi } from "vitest";
import type { EmailMessage } from "../../worker/email.ts";
import { sendSubmissionConfirmationEmail } from "../../worker/email/submission-confirmation.ts";

const baseInput = {
  env: { APP_ORIGIN: "https://example.test" },
  eventId: "evt_devflow_conf_2027" as const,
  eventName: "DevFlow Conf 2027",
  recipientName: "Priya Raman",
  submissionTitle: "Taming CI",
  returnUrl: "https://example.test/cfp/devflow/submissions/sub_1",
};

describe("sendSubmissionConfirmationEmail", () => {
  it("skips without touching the database when there is no address", async () => {
    const database = { insert: vi.fn() };
    const result = await sendSubmissionConfirmationEmail({
      ...baseInput,
      database: database as never,
      recipientEmail: undefined,
    });
    expect(result).toEqual({ status: "skipped_no_address" });
    expect(database.insert).not.toHaveBeenCalled();
  });

  it("skips for a blank address rather than inventing one", async () => {
    const database = { insert: vi.fn() };
    const result = await sendSubmissionConfirmationEmail({
      ...baseInput,
      database: database as never,
      recipientEmail: "   ",
    });
    expect(result).toEqual({ status: "skipped_no_address" });
    expect(database.insert).not.toHaveBeenCalled();
  });

  it("sends through the injected delivery when an address is present", async () => {
    const send = vi.fn(async (_message: EmailMessage) => ({ status: "sent" as const, providerMessageId: "msg_1" }));
    const values = vi.fn(async () => []);
    const database = { insert: vi.fn(() => ({ values })) };
    const result = await sendSubmissionConfirmationEmail({
      ...baseInput,
      database: database as never,
      recipientEmail: "priya@example.test",
      delivery: { send },
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({ recipient: "priya@example.test" });
    expect(result).toMatchObject({ status: "sent", providerMessageId: "msg_1" });
    expect(database.insert).toHaveBeenCalledTimes(1);
  });
});
