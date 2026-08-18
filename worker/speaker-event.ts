// ABOUTME: Defines the event that speaker portal access currently serves.
// ABOUTME: Rejects missing or different event selections before speaker records are resolved.
export const activeSpeakerEventId = "evt_devflow_conf_2027";

export type ActiveSpeakerEventError = "speaker_event_required" | "invalid_speaker_event";

export function activeSpeakerEventFor(
  requestedEventId: unknown,
): { id: typeof activeSpeakerEventId } | { error: ActiveSpeakerEventError } {
  if (typeof requestedEventId !== "string" || requestedEventId.length === 0) {
    return { error: "speaker_event_required" };
  }
  return requestedEventId === activeSpeakerEventId
    ? { id: activeSpeakerEventId }
    : { error: "invalid_speaker_event" };
}
