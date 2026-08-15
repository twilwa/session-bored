// ABOUTME: Guards the organizer's reviewer-invitation remit choice against being silently widened.
// ABOUTME: A half-chosen remit must reach the route as chosen, never dropped back to the default.
import { describe, expect, it } from "vitest";
import { invitationRemitSelection } from "../../client/pages/people/invitation-remit.ts";

describe("reviewer invitation remit selection", () => {
  it("carries both halves when the organizer chose both", () => {
    expect(invitationRemitSelection(["trk_platform_infra"], ["rnd_initial_review"])).toEqual({
      trackIds: ["trk_platform_infra"],
      roundIds: ["rnd_initial_review"],
    });
  });

  it("keeps chosen tracks when no round was ticked, rather than sending nothing", () => {
    expect(invitationRemitSelection(["trk_platform_infra"], [])).toEqual({
      trackIds: ["trk_platform_infra"],
    });
  });

  it("keeps a chosen round when no track was ticked", () => {
    expect(invitationRemitSelection([], ["rnd_initial_review"])).toEqual({
      roundIds: ["rnd_initial_review"],
    });
  });

  it("names no remit at all when the organizer ticked nothing", () => {
    expect(invitationRemitSelection([], [])).toEqual({});
  });
});
