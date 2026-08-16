// ABOUTME: Verifies browser journeys use the same representative files as Greenroom's public demo records.
// ABOUTME: Prevents production-style QA from replacing a demo profile with a placeholder artifact.
import { describe, expect, it } from "vitest";
import sampleData from "../../fixtures/sample-data.json";

describe("demo data", () => {
  it("uses the published speaker portrait for headshot upload journeys", () => {
    const publicPortraitPath = `public${sampleData.identities.speaker.headshotUrl}`;

    expect(sampleData.files.headshot).toBe(publicPortraitPath);
  });
});
