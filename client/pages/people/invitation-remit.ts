// ABOUTME: Decides what remit an organizer's reviewer invitation carries to the send route.
// ABOUTME: Keeps a half-chosen remit intact so a narrowed choice is never widened on the way out.

/** The remit fields an invitation request carries, each present only when it was chosen. */
export interface InvitationRemitSelection {
  trackIds?: string[];
  roundIds?: string[];
}

/**
 * Each half is sent exactly as the organizer ticked it. A half they left untouched is omitted
 * so the route applies its default to that half alone: ticking tracks but no round must send
 * those tracks with the first open round, never the whole taxonomy back again.
 */
export function invitationRemitSelection(
  trackIds: readonly string[],
  roundIds: readonly string[],
): InvitationRemitSelection {
  return {
    ...(trackIds.length > 0 ? { trackIds: [...trackIds] } : {}),
    ...(roundIds.length > 0 ? { roundIds: [...roundIds] } : {}),
  };
}
