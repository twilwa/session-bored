// ABOUTME: Pins the shared headshot initials derivation and the organizer roster row's avatar.
// ABOUTME: A silent fallback would re-hide the photo, so both states and a load failure are pinned.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { headshotDisplay, initialsOf } from "../../client/components/Headshot.tsx";
import { SpeakerAvatar } from "../../client/pages/roster/RosterPage.tsx";

describe("initialsOf", () => {
  it("returns first + last initial for full names", () => {
    expect(initialsOf("Priya Raman")).toBe("PR");
    expect(initialsOf("Marcus Okafor")).toBe("MO");
  });

  it("returns first two chars of a single token", () => {
    expect(initialsOf("Cher")).toBe("CH");
  });

  it("handles trailing whitespace", () => {
    expect(initialsOf("  Priya Raman  ")).toBe("PR");
  });
});

describe("roster row avatar", () => {
  it("renders the stored headshot when the speaker has one", () => {
    expect(headshotDisplay("Priya Raman", "/api/public/portal/speakers/spk_priya/headshot", false)).toEqual({
      kind: "photo",
      src: "/api/public/portal/speakers/spk_priya/headshot",
    });
    const markup = renderToStaticMarkup(
      createElement(SpeakerAvatar, { name: "Priya Raman", url: "/api/public/portal/speakers/spk_priya/headshot" }),
    );
    expect(markup).toContain('src="/api/public/portal/speakers/spk_priya/headshot"');
    expect(markup).toContain("speaker-avatar");
    expect(markup).not.toContain(">PR<");
  });

  it("renders initials when the speaker has no headshot", () => {
    expect(headshotDisplay("Priya Raman", null, false)).toEqual({ initials: "PR", kind: "initials" });
    const markup = renderToStaticMarkup(createElement(SpeakerAvatar, { name: "Priya Raman", url: null }));
    expect(markup).toContain(">PR<");
    expect(markup).not.toContain("<img");
  });

  it("falls back to initials when the headshot fails to load", () => {
    expect(headshotDisplay("Priya Raman", "/broken.png", true)).toEqual({ initials: "PR", kind: "initials" });
  });

  it("keeps the avatar decorative so the adjacent name is announced once", () => {
    const markup = renderToStaticMarkup(createElement(SpeakerAvatar, { name: "Priya Raman", url: "/p.png" }));
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('alt=""');
  });
});
