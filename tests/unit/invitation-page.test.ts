// ABOUTME: Guards the invitation landing page against confusing historical redemption with live access.
// ABOUTME: Keeps the redeemed-state copy truthful after an organizer later revokes the reviewer grant.
import { describe, expect, it } from "vitest";
import { redeemedInvitationMessage } from "../../client/pages/account/InvitationPage.tsx";

describe("reviewer invitation landing copy", () => {
  it("describes a redeemed invitation as history without promising current access", () => {
    expect(redeemedInvitationMessage("DevFlow Conf 2027"))
      .toBe("This invitation has already been used for DevFlow Conf 2027.");
  });
});
