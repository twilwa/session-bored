// ABOUTME: The organizer's gate: who has an account, what it opens, and who decided that.
// ABOUTME: Shows the evidence behind every grant so nobody is promoted or revoked blind.
import { useEffect, useState } from "react";
import { Button, EmptyState, LoadingState, SelectField, StatusChip, TextField, Toast } from "../../components/ui.tsx";
import { getJson, RequestFailure, requestJson } from "../../lib.tsx";
import type { PersonAccountSummary } from "../../../shared/api.ts";
import { effectiveRoleOf, evidenceSummary } from "../../../shared/people.ts";
import { invitationRemitSelection } from "./invitation-remit.ts";
import "./people.css";

const eventId = "evt_devflow_conf_2027";
const grantableRoles = ["speaker", "reviewer", "organizer"] as const;
type GrantableRole = (typeof grantableRoles)[number];

interface OpenInvite {
  id: string;
  email: string;
  eventId: string;
  createdAt: string;
  emailDelivery: "sent" | "failed" | "not_attempted";
  canResend: boolean;
  accountStatus: "none" | "unconfirmed" | "confirmed";
}

interface InviteResult {
  invite: { id: string; email: string; eventId: string };
  emailDelivery: "sent" | "failed" | "not_configured";
  accountStatus: "none" | "unconfirmed" | "confirmed";
  upgraded: boolean;
  account?: { userId: string; name: string };
  grantedReviewerRole?: boolean;
}

interface PeoplePayload {
  items: PersonAccountSummary[];
  invites: OpenInvite[];
}

interface ReviewerGrantOptions {
  tracks: Array<{ id: string; name: string }>;
  rounds: Array<{ id: string; name: string; status: "draft" | "open" | "closed" }>;
}

interface ReviewerGrantSelection {
  personId: string;
  trackIds: string[];
  roundIds: string[];
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** Prefers what the server said about a refusal, and never swallows a request that gave up. */
function failureMessage(error: unknown, fallback: string): string {
  if (error instanceof RequestFailure) {
    return error.payload?.note ?? fallback;
  }
  return error instanceof Error && error.message.includes("timed out") ? error.message : fallback;
}

export function PeoplePage() {
  const [data, setData] = useState<PeoplePayload | null>(null);
  const [reviewerGrantOptions, setReviewerGrantOptions] = useState<ReviewerGrantOptions | null>(null);
  const [reviewerGrant, setReviewerGrant] = useState<ReviewerGrantSelection | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "awaiting">("all");
  const [search, setSearch] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [inviteRemitOpen, setInviteRemitOpen] = useState(false);
  const [inviteTrackIds, setInviteTrackIds] = useState<string[]>([]);
  const [inviteRoundIds, setInviteRoundIds] = useState<string[]>([]);
  const [upgradeTarget, setUpgradeTarget] = useState<{ inviteId: string; email: string } | null>(null);
  const [upgradeTrackIds, setUpgradeTrackIds] = useState<string[]>([]);
  const [upgradeRoundIds, setUpgradeRoundIds] = useState<string[]>([]);
  const [resendingInviteId, setResendingInviteId] = useState<string | null>(null);
  const [notify, setNotify] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    getJson<PeoplePayload>("/api/people")
      .then((payload) => { if (active) setData(payload); })
      .catch(() => { if (active) setMessage("People could not be loaded."); });
    getJson<ReviewerGrantOptions>(`/api/review/events/${eventId}/config`)
      .then((payload) => { if (active) setReviewerGrantOptions(payload); })
      .catch(() => { if (active) setMessage("Reviewer remit options could not be loaded."); });
    return () => { active = false; };
  }, [reload]);

  async function grant(
    person: PersonAccountSummary,
    role: GrantableRole,
    remit?: Omit<ReviewerGrantSelection, "personId">,
  ): Promise<void> {
    try {
      const result = await requestJson<{ granted: boolean; notified: boolean }>(
        `/api/people/${person.id}/grants`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            role,
            notify,
            ...(remit === undefined ? {} : { reviewerRemit: { eventId, ...remit } }),
          }),
        },
      );
      setMessage(
        result.granted
          ? `${person.name} is now a ${role}.${result.notified ? " They were emailed." : ""}`
          : `${person.name} already had ${role} access.`,
      );
      setReviewerGrant(null);
      setReload((token) => token + 1);
    } catch {
      setMessage(`${person.name} could not be granted ${role}.`);
    }
  }

  async function revoke(person: PersonAccountSummary, role: string): Promise<void> {
    try {
      await requestJson(`/api/people/${person.id}/grants/${role}`, { method: "DELETE" });
      setMessage(`${person.name} no longer has ${role} access.`);
      setReload((token) => token + 1);
    } catch {
      setMessage(`${person.name}'s ${role} access could not be removed.`);
    }
  }

  /**
   * The delivery suffix every outcome shares, so an organizer is never told an email went out
   * when it did not.
   */
  function deliverySuffix(delivery: "sent" | "failed" | "not_configured"): string {
    return delivery === "sent"
      ? " The invitation email was sent."
      : delivery === "failed"
      ? " Email delivery failed - open Communications for the details."
      : " No email sender is connected, so nothing was sent.";
  }

  function upgradeOutcomeCopy(name: string, grantedReviewerRole: boolean): string {
    // An existing reviewer does not need reviewer access granted; they need their remit for
    // this event. The copy says which of the two happened.
    return grantedReviewerRole
      ? `${name} already had a confirmed account - reviewer access is open for DevFlow Conf 2027.`
      : `${name} is already a reviewer - their remit now covers DevFlow Conf 2027.`;
  }

  async function invite(): Promise<void> {
    setInviting(true);
    try {
      // Naming both halves is what lets the route open access immediately for an address that
      // already has a confirmed account; a half-chosen remit still travels as chosen.
      const result = await requestJson<InviteResult>(
        `/api/events/${eventId}/reviewer-invites`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email: inviteEmail,
            ...invitationRemitSelection(inviteTrackIds, inviteRoundIds),
          }),
        },
      );
      const suffix = deliverySuffix(result.emailDelivery);
      if (result.accountStatus === "confirmed" && result.upgraded && result.account !== undefined) {
        setMessage(upgradeOutcomeCopy(result.account.name, result.grantedReviewerRole ?? true) + suffix);
      } else if (result.accountStatus === "confirmed") {
        setUpgradeTarget({ inviteId: result.invite.id, email: result.invite.email });
        setUpgradeTrackIds(inviteTrackIds);
        setUpgradeRoundIds(inviteRoundIds);
        setMessage(
          `${result.invite.email} already has a confirmed account. Choose what they review to open their access now, or leave the invitation to open through its link.${suffix}`,
        );
      } else if (result.accountStatus === "unconfirmed") {
        setMessage(
          `An account already exists for ${result.invite.email}, but its address is not confirmed yet. Reviewer access opens once they confirm it.${suffix}`,
        );
      } else {
        setMessage(result.emailDelivery === "sent"
          ? `Invitation sent to ${result.invite.email}. They become a reviewer once they confirm that address.`
          : result.emailDelivery === "failed"
          ? "Invitation recorded, but email delivery failed. Open Communications for the failure details."
          : "Invitation recorded, but no email sender is connected. Connect one before asking them to respond.");
      }
      setInviteEmail("");
      setInviteTrackIds([]);
      setInviteRoundIds([]);
      setInviteRemitOpen(false);
      setReload((token) => token + 1);
    } catch (error) {
      setMessage(failureMessage(error, "That invitation could not be recorded."));
    } finally {
      setInviting(false);
    }
  }

  async function upgradeInvite(): Promise<void> {
    if (upgradeTarget === null) return;
    try {
      const result = await requestJson<{
        account: { userId: string; name: string };
        grantedReviewerRole: boolean;
      }>(
        `/api/events/${eventId}/reviewer-invites/${upgradeTarget.inviteId}/upgrade`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ trackIds: upgradeTrackIds, roundIds: upgradeRoundIds }),
        },
      );
      setMessage(upgradeOutcomeCopy(result.account.name, result.grantedReviewerRole));
      setUpgradeTarget(null);
      setUpgradeTrackIds([]);
      setUpgradeRoundIds([]);
      setReload((token) => token + 1);
    } catch {
      setMessage("Reviewer access could not be opened for that invitation.");
    }
  }

  async function revokeInvite(openInvite: OpenInvite): Promise<void> {
    try {
      await requestJson(`/api/reviewer-invites/${openInvite.id}`, { method: "DELETE" });
      setMessage(`The invitation to ${openInvite.email} was withdrawn.`);
      setReload((token) => token + 1);
    } catch {
      setMessage("That invitation could not be withdrawn.");
    }
  }

  async function resendInvite(openInvite: OpenInvite): Promise<void> {
    setResendingInviteId(openInvite.id);
    try {
      const result = await requestJson<{ emailDelivery: "sent" | "failed" | "not_configured" }>(
        `/api/events/${openInvite.eventId}/reviewer-invites/${openInvite.id}/resend`,
        { method: "POST" },
      );
      setMessage(result.emailDelivery === "sent"
        ? `Invitation resent to ${openInvite.email}.`
        : result.emailDelivery === "failed"
        ? "Invitation is still open, but email delivery failed. Open Communications for the failure details."
        : "Invitation is still open, but no email sender is connected. Connect one and resend it here.");
      setReload((token) => token + 1);
    } catch (error) {
      setMessage(failureMessage(error, "That invitation could not be resent."));
    } finally {
      setResendingInviteId(null);
    }
  }

  if (data === null) {
    return (
      <>
        <header className="workspace-header">
          <div><p className="eyebrow">PLATFORM ACCESS / ALL EVENTS</p><h1>People.</h1></div>
        </header>
        <LoadingState label="Loading people" />
        <Toast message={message} />
      </>
    );
  }

  const term = search.trim().toLowerCase();
  const visible = data.items.filter((person) => {
    if (filter === "awaiting" && person.grants.length > 0) return false;
    if (term === "") return true;
    return person.name.toLowerCase().includes(term) || person.email.toLowerCase().includes(term);
  });
  const awaiting = data.items.filter((person) => person.grants.length === 0).length;
  const openRounds = reviewerGrantOptions?.rounds.filter((round) => round.status === "open") ?? [];
  const remitBlockers = reviewerGrantOptions === null ? [] : [
    ...(reviewerGrantOptions.tracks.length === 0 ? ["no tracks"] : []),
    ...(openRounds.length === 0 ? ["no open review round"] : []),
  ];

  return (
    <>
      <header className="workspace-header">
        <div>
          <p className="eyebrow">PLATFORM ACCESS / ALL EVENTS</p>
          <h1>People.</h1>
          <p>Who has an account, and what it lets them do. Access is platform-wide, not per event.</p>
        </div>
        <StatusChip tone="good">{awaiting} awaiting a role</StatusChip>
      </header>

      <section className="people-toolbar" aria-label="People controls">
        <TextField
          label="Search people"
          name="people-search"
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Name or email"
          value={search}
        />
        <SelectField
          label="Show"
          name="people-filter"
          onChange={(event) => setFilter(event.target.value === "awaiting" ? "awaiting" : "all")}
          value={filter}
        >
          <option value="all">Everyone</option>
          <option value="awaiting">Awaiting a role</option>
        </SelectField>
        <label className="people-notify">
          <input checked={notify} onChange={(event) => setNotify(event.target.checked)} type="checkbox" />
          <span>Email them when I grant access</span>
        </label>
      </section>

      <section className="workspace-section people-card" aria-label="Accounts">
        <div className="people-card__head">
          <h2>Accounts</h2>
          <p>A grant opens an area everywhere, for now. Removing one keeps its history.</p>
          <p>
            Reviewer access requires tracks and a review round here. Existing reviewer remit can
            be changed on <a href="/organizer/review">Committee setup</a>.
          </p>
        </div>
        {visible.length === 0 ? (
          <EmptyState title="Nobody here" description="No account matches this view." />
        ) : (
          <ul className="people-list">
            {visible.map((person) => {
              const evidence = evidenceSummary(person);
              const role = effectiveRoleOf(person);
              return (
                <li className="people-row" key={person.id}>
                  <div className="people-row__who">
                    <strong>{person.name}</strong>
                    <a href={`mailto:${person.email}`}>{person.email}</a>
                    <small>
                      Joined {formatDate(person.joinedAt)} · {person.signInMethods.join(", ") || "no sign-in method"}
                      {person.emailVerified ? "" : " · address unconfirmed"}
                    </small>
                  </div>
                  <div className="people-row__evidence">
                    <StatusChip tone={evidence.tone}>{evidence.text}</StatusChip>
                    <small>{evidence.detail}</small>
                  </div>
                  <div className="people-row__access">
                    <StatusChip tone={role === "attendee" ? "neutral" : "good"}>{role}</StatusChip>
                    {person.grants.map((grant) => (
                      <small key={grant.role}>
                        {grant.role} granted by {grant.grantedByName ?? "system backfill"} · {formatDate(grant.grantedAt)}
                      </small>
                    ))}
                  </div>
                  <div className="people-row__actions">
                    {grantableRoles
                      .filter((role) => !person.grants.some((grant) => grant.role === role))
                      .map((role) => (
                        <Button
                          disabled={role === "reviewer" && reviewerGrantOptions === null}
                          key={role}
                          onClick={() => role === "reviewer"
                            ? setReviewerGrant({ personId: person.id, trackIds: [], roundIds: [] })
                            : void grant(person, role)}
                          tone="quiet"
                        >
                          Grant {role}
                        </Button>
                      ))}
                    {person.grants.map((grant) => (
                      <Button key={grant.role} onClick={() => void revoke(person, grant.role)} tone="quiet">
                        Remove {grant.role}
                      </Button>
                    ))}
                    {reviewerGrant?.personId === person.id && reviewerGrantOptions !== null ? (
                      <form
                        aria-label={`Reviewer remit for ${person.name}`}
                        className="reviewer-grant"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void grant(person, "reviewer", {
                            trackIds: reviewerGrant.trackIds,
                            roundIds: reviewerGrant.roundIds,
                          });
                        }}
                      >
                        {remitBlockers.length > 0 ? (
                          <>
                            <p>
                              Granting reviewer access is blocked: this event has {remitBlockers.join(" and ")},
                              and a reviewer needs at least one of each. Set that up on{" "}
                              <a href="/organizer/review">Committee setup</a>, then grant from here.
                            </p>
                            <div>
                              <Button onClick={() => setReviewerGrant(null)} tone="quiet" type="button">Cancel</Button>
                            </div>
                          </>
                        ) : (
                          <>
                            <p>Choose what this reviewer can read now.</p>
                            <fieldset>
                              <legend>Track remit</legend>
                              {reviewerGrantOptions.tracks.map((track) => (
                                <label key={track.id}>
                                  <input
                                    checked={reviewerGrant.trackIds.includes(track.id)}
                                    onChange={(event) => setReviewerGrant((selection) => selection === null
                                      ? null
                                      : {
                                        ...selection,
                                        trackIds: event.target.checked
                                          ? [...selection.trackIds, track.id]
                                          : selection.trackIds.filter((id) => id !== track.id),
                                      })}
                                    type="checkbox"
                                  />
                                  {track.name}
                                </label>
                              ))}
                            </fieldset>
                            <fieldset>
                              <legend>Review round</legend>
                              {openRounds.map((round) => (
                                <label key={round.id}>
                                  <input
                                    checked={reviewerGrant.roundIds.includes(round.id)}
                                    onChange={(event) => setReviewerGrant((selection) => selection === null
                                      ? null
                                      : {
                                        ...selection,
                                        roundIds: event.target.checked
                                          ? [...selection.roundIds, round.id]
                                          : selection.roundIds.filter((id) => id !== round.id),
                                      })}
                                    type="checkbox"
                                  />
                                  {round.name}
                                </label>
                              ))}
                            </fieldset>
                            <div>
                              <Button
                                disabled={reviewerGrant.trackIds.length === 0 || reviewerGrant.roundIds.length === 0}
                                type="submit"
                              >
                                Grant reviewer with remit
                              </Button>
                              <Button onClick={() => setReviewerGrant(null)} tone="quiet" type="button">Cancel</Button>
                            </div>
                          </>
                        )}
                      </form>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="workspace-section people-card" aria-label="Reviewer invitations">
        <div className="people-card__head">
          <h2>Reviewer invitations</h2>
          <p>
            An invitation is your grant, held until the person proves the address. Signing up as an
            invited address grants nothing on its own. An address that already has a confirmed
            account can be opened straight away - name what they review when you invite them.
          </p>
        </div>
        <div className="people-invite">
          <TextField
            label="Invite a reviewer by email"
            name="invite-email"
            onChange={(event) => setInviteEmail(event.target.value)}
            placeholder="reviewer@example.com"
            type="email"
            value={inviteEmail}
          />
          <Button disabled={inviting || !inviteEmail.includes("@")} onClick={() => void invite()} tone="signal">
            {inviting ? "Sending…" : "Send invitation"}
          </Button>
        </div>
        <button
          className="text-link"
          onClick={() => setInviteRemitOpen((open) => !open)}
          type="button"
        >
          {inviteRemitOpen ? "Hide remit choice" : "Choose what they review (optional)"}
        </button>
        {inviteRemitOpen && reviewerGrantOptions !== null ? (
          <form
            aria-label="Invitation remit"
            className="reviewer-grant"
            onSubmit={(event) => {
              event.preventDefault();
              void invite();
            }}
          >
            <p>
              The invitation carries exactly what you tick here. Ticking both a track and a round
              opens reviewer access immediately for an address that already has a confirmed
              account. A half you leave untouched falls back to its own default - every track, and
              the first open review round - and the invitation opens when the person uses its link.
            </p>
            <fieldset>
              <legend>Track remit</legend>
              {reviewerGrantOptions.tracks.map((track) => (
                <label key={track.id}>
                  <input
                    checked={inviteTrackIds.includes(track.id)}
                    onChange={(event) => setInviteTrackIds((ids) => event.target.checked
                      ? [...ids, track.id]
                      : ids.filter((id) => id !== track.id))}
                    type="checkbox"
                  />
                  {track.name}
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend>Review round</legend>
              {openRounds.map((round) => (
                <label key={round.id}>
                  <input
                    checked={inviteRoundIds.includes(round.id)}
                    onChange={(event) => setInviteRoundIds((ids) => event.target.checked
                      ? [...ids, round.id]
                      : ids.filter((id) => id !== round.id))}
                    type="checkbox"
                  />
                  {round.name}
                </label>
              ))}
            </fieldset>
          </form>
        ) : null}
        {upgradeTarget !== null && reviewerGrantOptions !== null ? (
          <form
            aria-label={`Open reviewer access for ${upgradeTarget.email}`}
            className="reviewer-grant"
            onSubmit={(event) => {
              event.preventDefault();
              void upgradeInvite();
            }}
          >
            <p>
              {upgradeTarget.email} already has a confirmed account. Choose what they review to
              open reviewer access for DevFlow Conf 2027 now.
            </p>
            <fieldset>
              <legend>Track remit</legend>
              {reviewerGrantOptions.tracks.map((track) => (
                <label key={track.id}>
                  <input
                    checked={upgradeTrackIds.includes(track.id)}
                    onChange={(event) => setUpgradeTrackIds((ids) => event.target.checked
                      ? [...ids, track.id]
                      : ids.filter((id) => id !== track.id))}
                    type="checkbox"
                  />
                  {track.name}
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend>Review round</legend>
              {openRounds.map((round) => (
                <label key={round.id}>
                  <input
                    checked={upgradeRoundIds.includes(round.id)}
                    onChange={(event) => setUpgradeRoundIds((ids) => event.target.checked
                      ? [...ids, round.id]
                      : ids.filter((id) => id !== round.id))}
                    type="checkbox"
                  />
                  {round.name}
                </label>
              ))}
            </fieldset>
            <div>
              <Button disabled={upgradeTrackIds.length === 0 || upgradeRoundIds.length === 0} type="submit">
                Open reviewer access
              </Button>
              <Button onClick={() => setUpgradeTarget(null)} tone="quiet" type="button">Leave the invitation open</Button>
            </div>
          </form>
        ) : null}
        {data.invites.length === 0 ? (
          <EmptyState title="No invitations open" description="Every invitation has been confirmed or withdrawn." />
        ) : (
          <ul className="people-invite-list">
            {data.invites.map((openInvite) => (
              <li key={openInvite.id}>
                <div>
                  <strong>{openInvite.email}</strong>
                  <small>
                    Invited {formatDate(openInvite.createdAt)} · {
                      openInvite.accountStatus === "confirmed"
                        ? "confirmed account, access not opened yet"
                        : openInvite.accountStatus === "unconfirmed"
                        ? "account exists, address unconfirmed"
                        : "waiting on sign-up"
                    } · {
                      openInvite.emailDelivery === "sent"
                        ? "email sent"
                        : openInvite.emailDelivery === "failed"
                        ? "email failed"
                        : "email not sent"
                    }
                  </small>
                </div>
                <div className="people-invite-list__actions">
                  {openInvite.accountStatus === "confirmed" ? (
                    <Button
                      onClick={() => {
                        setUpgradeTarget({ inviteId: openInvite.id, email: openInvite.email });
                        setUpgradeTrackIds([]);
                        setUpgradeRoundIds([]);
                      }}
                      tone="signal"
                    >
                      Open reviewer access
                    </Button>
                  ) : null}
                  {openInvite.canResend ? (
                    <Button
                      disabled={resendingInviteId === openInvite.id}
                      onClick={() => void resendInvite(openInvite)}
                      tone="signal"
                    >
                      {resendingInviteId === openInvite.id ? "Sending…" : "Resend invitation"}
                    </Button>
                  ) : null}
                  <Button onClick={() => void revokeInvite(openInvite)} tone="quiet">Withdraw</Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <Toast message={message} />
    </>
  );
}
