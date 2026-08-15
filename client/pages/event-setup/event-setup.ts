// ABOUTME: Formats event setup values for the compact active-event shell context.
// ABOUTME: Treats date-only values as calendar dates so browser timezone never shifts them.
export interface EventBranding {
  primaryColor: string;
  accentColor: string;
  logoUrl?: string;
  backgroundImageUrl?: string;
}

export interface EventSetupRecord {
  id: string;
  slug: string;
  name: string;
  tagline: string | null;
  description: string | null;
  startDate: string | null;
  endDate: string | null;
  venue: string | null;
  timezone: string;
  branding: EventBranding | null;
}

interface EventSummaryInput {
  startDate: string | null;
  endDate: string | null;
  venue: string | null;
}

function calendarDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

export function eventSummary(event: EventSummaryInput): string {
  let dates = "Dates TBD";
  if (event.startDate !== null && event.endDate !== null) {
    const start = calendarDate(event.startDate);
    const end = calendarDate(event.endDate);
    const month = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });
    const startMonth = month.format(start);
    const endMonth = month.format(end);
    const startYear = start.getUTCFullYear();
    const endYear = end.getUTCFullYear();
    dates = startMonth === endMonth && startYear === endYear
      ? `${startMonth} ${start.getUTCDate()}–${end.getUTCDate()}, ${endYear}`
      : `${startMonth} ${start.getUTCDate()}, ${startYear}–${endMonth} ${end.getUTCDate()}, ${endYear}`;
  }
  return `${dates} · ${event.venue?.trim() || "Venue TBD"}`;
}
