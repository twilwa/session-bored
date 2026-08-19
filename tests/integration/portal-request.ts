// ABOUTME: Adds the application’s active event context to speaker portal integration requests.
// ABOUTME: Leaves explicitly event-scoped requests unchanged so multi-event tests choose their own event.
const activeEventId = "evt_devflow_conf_2027";

export function withActiveSpeakerEvent(path: string): string {
  if (
    path !== "/api/speaker/content"
    && !path.startsWith("/api/speaker/submissions/")
    && !path.startsWith("/api/portal/")
  ) {
    return path;
  }
  const url = new URL(path, "http://example.test");
  if (!url.searchParams.has("eventId")) {
    url.searchParams.set("eventId", activeEventId);
  }
  return `${url.pathname}${url.search}`;
}
