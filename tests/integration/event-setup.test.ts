// ABOUTME: Exercises organizer event setup through the real Worker and D1 database.
// ABOUTME: Covers saved event identity, dates, venue, timezone, and branding as one contract.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../../worker/index.ts";

async function request(path: string, init?: RequestInit): Promise<Response> {
  return worker.request(`http://example.test${path}`, init, env);
}

async function organizerCookie(): Promise<string> {
  await request("/api/health");
  const response = await request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "sbek-organizer@example.com",
      password: "SbekTest!2027-org",
    }),
  });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

describe("organizer event setup", () => {
  it("keeps event setup behind organizer access", async () => {
    await request("/api/health");
    const payload = {
      name: "Hidden Summit",
      slug: "hidden-summit",
      tagline: null,
      description: null,
      startDate: "2027-09-08",
      endDate: "2027-09-10",
      venue: "Pier 27",
      timezone: "America/Los_Angeles",
      branding: { primaryColor: "#173B57", accentColor: "#F4B942" },
    };
    expect((await request("/api/events/evt_devflow_conf_2027", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })).status).toBe(401);
    expect((await request("/api/events/evt_devflow_conf_2027/branding/logo", {
      method: "POST",
      body: new FormData(),
    })).status).toBe(401);

    const reviewerSignIn = await request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "sbek-reviewer@example.com",
        password: "SbekTest!2027-rev",
      }),
    });
    const reviewerCookie = reviewerSignIn.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect((await request("/api/events/evt_devflow_conf_2027", {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: reviewerCookie },
      body: JSON.stringify(payload),
    })).status).toBe(403);
    expect((await request("/api/events/evt_devflow_conf_2027/branding/logo", {
      method: "POST",
      headers: { cookie: reviewerCookie },
      body: new FormData(),
    })).status).toBe(403);
  });

  it("updates the active event details and branding", async () => {
    const cookie = await organizerCookie();
    const response = await request("/api/events/evt_devflow_conf_2027", {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        name: "Signal Summit 2027",
        slug: "signal-summit-2027",
        tagline: "Where production systems meet their operators.",
        description: "A practical gathering for people who run software in the real world.",
        startDate: "2027-09-08",
        endDate: "2027-09-10",
        venue: "Pier 27, San Francisco",
        timezone: "America/New_York",
        branding: {
          primaryColor: "#173B57",
          accentColor: "#F4B942",
          logoUrl: "https://images.example.com/signal-mark.png",
          backgroundImageUrl: "https://images.example.com/signal-stage.png",
        },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: "evt_devflow_conf_2027",
      name: "Signal Summit 2027",
      slug: "signal-summit-2027",
      tagline: "Where production systems meet their operators.",
      description: "A practical gathering for people who run software in the real world.",
      startDate: "2027-09-08",
      endDate: "2027-09-10",
      venue: "Pier 27, San Francisco",
      timezone: "America/New_York",
      branding: {
        primaryColor: "#173B57",
        accentColor: "#F4B942",
        logoUrl: "https://images.example.com/signal-mark.png",
        backgroundImageUrl: "https://images.example.com/signal-stage.png",
      },
    });

    const agenda = await request("/api/events/evt_devflow_conf_2027/agenda", { headers: { cookie } });
    expect(agenda.status).toBe(200);
    await expect(agenda.json()).resolves.toMatchObject({
      event: { name: "Signal Summit 2027", timezone: "America/New_York" },
    });
  });

  it("stores an uploaded brand image and serves only its validated image bytes", async () => {
    const cookie = await organizerCookie();
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const form = new FormData();
    form.set("file", new File([pngBytes], "event-logo.png", { type: "image/png" }));
    const response = await request("/api/events/evt_devflow_conf_2027/branding/logo", {
      method: "POST",
      headers: { cookie },
      body: form,
    });

    expect(response.status).toBe(201);
    const event = await response.json<{ branding: { logoUrl: string } }>();
    expect(event.branding.logoUrl).toMatch(
      /^\/api\/public\/events\/evt_devflow_conf_2027\/branding\/logo\?version=/,
    );
    const image = await request(event.branding.logoUrl);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(pngBytes);
  });

  it("rejects a timezone the scheduling surfaces cannot format", async () => {
    const cookie = await organizerCookie();
    const response = await request("/api/events/evt_devflow_conf_2027", {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        name: "DevFlow Conf 2027",
        slug: "devflow-conf-2027",
        tagline: null,
        description: null,
        startDate: "2027-05-12",
        endDate: "2027-05-14",
        venue: "Moscone West",
        timezone: "Mars/Olympus_Mons",
        branding: { primaryColor: "#173B57", accentColor: "#F4B942" },
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_event_setup",
      fields: { timezone: "Choose a valid IANA timezone." },
      message: "Check the highlighted event details.",
    });
  });

  it("returns field guidance without saving invalid event details", async () => {
    const cookie = await organizerCookie();
    const response = await request("/api/events/evt_devflow_conf_2027", {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        name: "   ",
        slug: "Signal Summit!",
        tagline: null,
        description: null,
        startDate: "2027-09-10",
        endDate: "2027-09-08",
        venue: "Pier 27",
        timezone: "America/Los_Angeles",
        branding: {
          primaryColor: "#123",
          accentColor: "amber",
          logoUrl: "ftp://images.example.com/signal-mark.png",
          backgroundImageUrl: "javascript:alert(1)",
        },
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_event_setup",
      fields: {
        name: "Enter an event name.",
        slug: "Use lowercase letters, numbers, and single hyphens.",
        endDate: "The event must end on or after its start date.",
        "branding.primaryColor": "Choose a six-digit hex color.",
        "branding.accentColor": "Choose a six-digit hex color.",
        "branding.logoUrl": "Use an http or https image URL.",
        "branding.backgroundImageUrl": "Use an http or https image URL.",
      },
      message: "Check the highlighted event details.",
    });
  });
});
