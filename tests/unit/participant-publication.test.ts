// ABOUTME: Verifies organizers can discover why a participant is private and where to publish them.
// ABOUTME: Renders the shared pending-publication notice used by proposal and roster views.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PendingPublicationNotice } from "../../client/components/PendingPublicationNotice.tsx";

describe("pending participant publication", () => {
  it("names the hidden session and links to the deliberate republish action", () => {
    const markup = renderToStaticMarkup(createElement(PendingPublicationNotice, {
      sessions: [{
        id: "ses_panel",
        title: "What a panel actually owes its audience",
        awaitingContentApproval: false,
        awaitingPlacement: false,
      }],
    }));

    expect(markup).toContain("Pending publication");
    expect(markup).toContain("What a panel actually owes its audience");
    expect(markup).toContain("The participant change for What a panel actually owes its audience stays off every public page and embed");
    expect(markup).toContain('href="/organizer/agenda"');
    expect(markup).toContain("Review and republish agenda");
  });

  it("names content approval as the step before republishing when the session lost its approval", () => {
    const markup = renderToStaticMarkup(createElement(PendingPublicationNotice, {
      sessions: [{
        id: "ses_panel",
        title: "What a panel actually owes its audience",
        awaitingContentApproval: true,
        awaitingPlacement: false,
      }],
    }));

    expect(markup).toContain("Pending publication");
    expect(markup).toContain("while the session content is unapproved");
    expect(markup).toContain("Approve the content again, then republish");
    // A republish alone would skip this session, so the notice must not claim it is all that is left.
    expect(markup).not.toContain("stays off every public page and embed until you");
  });

  it("names placement as the step before republishing when the session left the schedule", () => {
    const markup = renderToStaticMarkup(createElement(PendingPublicationNotice, {
      sessions: [{
        id: "ses_panel",
        title: "What a panel actually owes its audience",
        awaitingContentApproval: false,
        awaitingPlacement: true,
      }],
    }));

    expect(markup).toContain("Pending publication");
    expect(markup).toContain("while the session is off the schedule");
    expect(markup).toContain("Put the session back on the schedule, then republish");
    expect(markup).not.toContain("stays off every public page and embed until you");
  });

  it("names both steps when the session is off the schedule and unapproved", () => {
    const markup = renderToStaticMarkup(createElement(PendingPublicationNotice, {
      sessions: [{
        id: "ses_panel",
        title: "What a panel actually owes its audience",
        awaitingContentApproval: true,
        awaitingPlacement: true,
      }],
    }));

    expect(markup).toContain("while the session is off the schedule and its content is unapproved");
    expect(markup).toContain("Put it back on the schedule and approve the content again, then republish");
    expect(markup).not.toContain("stays off every public page and embed until you");
  });
});
