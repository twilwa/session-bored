// ABOUTME: Specifies deny-by-default role and ownership decisions through the policy interface.
// ABOUTME: Keeps HTTP middleware and resource loaders aligned on 401 and 403 behavior.
import { describe, expect, it } from "vitest";
import { authorizeAccess } from "../../worker/access.ts";

describe("access policy", () => {
  it("allows anonymous access only to public routes", () => {
    expect(authorizeAccess(null, "public")).toEqual({ allowed: true });
    expect(authorizeAccess(null, "organizer")).toEqual({ allowed: false, status: 401 });
  });

  it("returns 403 when an authenticated role crosses a role boundary", () => {
    expect(authorizeAccess({ role: "reviewer" }, "organizer")).toEqual({
      allowed: false,
      status: 403,
    });
    expect(authorizeAccess({ role: "speaker" }, "reviewer")).toEqual({
      allowed: false,
      status: 403,
    });
  });

  it("requires ownership checks after role access succeeds", () => {
    expect(authorizeAccess({ role: "reviewer" }, "reviewer", false)).toEqual({
      allowed: false,
      status: 403,
    });
    expect(authorizeAccess({ role: "reviewer" }, "reviewer", true)).toEqual({ allowed: true });
  });
});
