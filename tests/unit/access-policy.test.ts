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
    expect(authorizeAccess({ roles: ["reviewer"] }, "organizer")).toEqual({
      allowed: false,
      status: 403,
    });
    expect(authorizeAccess({ roles: ["speaker"] }, "reviewer")).toEqual({
      allowed: false,
      status: 403,
    });
  });

  it("requires ownership checks after role access succeeds", () => {
    expect(authorizeAccess({ roles: ["reviewer"] }, "reviewer", false)).toEqual({
      allowed: false,
      status: 403,
    });
    expect(authorizeAccess({ roles: ["reviewer"] }, "reviewer", true)).toEqual({ allowed: true });
  });

  it("refuses an attendee every role-scoped area", () => {
    for (const area of ["organizer", "reviewer", "speaker"] as const) {
      expect(authorizeAccess({ roles: ["attendee"] }, area)).toEqual({ allowed: false, status: 403 });
    }
  });

  it("opens every granted area to an account holding more than one grant", () => {
    const twoHats = { roles: ["reviewer", "speaker"] } as const;
    expect(authorizeAccess(twoHats, "reviewer")).toEqual({ allowed: true });
    expect(authorizeAccess(twoHats, "speaker")).toEqual({ allowed: true });
    // And no further: holding two grants confers nothing it was not given.
    expect(authorizeAccess(twoHats, "organizer")).toEqual({ allowed: false, status: 403 });
  });

  it("never lets a wider grant imply a narrower one", () => {
    expect(authorizeAccess({ roles: ["organizer"] }, "speaker")).toEqual({
      allowed: false,
      status: 403,
    });
  });

  it("counts an attendee as signed in, so their own records stay reachable", () => {
    expect(authorizeAccess({ roles: ["attendee"] }, "authenticated")).toEqual({ allowed: true });
    expect(authorizeAccess({ roles: ["attendee"] }, "public")).toEqual({ allowed: true });
  });
});
