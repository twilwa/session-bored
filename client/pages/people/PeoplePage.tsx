// ABOUTME: The organizer's gate: who has an account, what it opens, and who decided that.
// ABOUTME: Shows the evidence behind every grant so nobody is promoted or revoked blind.
import { useEffect, useState } from "react";
import { Button, EmptyState, LoadingState, SelectField, StatusChip, TextField, Toast } from "../../components/ui.tsx";
import { getJson, requestJson } from "../../lib.tsx";
import type { PersonAccountSummary } from "../../../shared/api.ts";
import { effectiveRoleOf, evidenceSummary } from "../../../shared/people.ts";
import "./people.css";

const eventId = "evt_devflow_conf_2027";
const grantableRoles = ["speaker", "reviewer", "organizer"] as const;
type GrantableRole = (typeof grantableRoles)[number];

interface OpenInvite {
  id: string;
  email: string;
  eventId: string;
  createdAt: string;
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

export function PeoplePage() {
  const [data, setData] = useState<PeoplePayload | null>(null);
  const [reviewerGrantOptions, setReviewerGrantOptions] = useState<ReviewerGrantOptions | null>(null);
  const [reviewerGrant, setReviewerGrant] = useState<ReviewerGrantSelection | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "awaiting">("all");
  const [search, setSearch] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
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

  async function invite(): Promise<void> {
    try {
      await requestJson(`/api/events/${eventId}/reviewer-invites`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: inviteEmail }),
      });
      setMessage(`Invitation recorded. ${inviteEmail} becomes a reviewer once they confirm that address.`);
      setInviteEmail("");
      setReload((token) => token + 1);
    } catch {
      setMessage("That invitation could not be recorded.");
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
                          {reviewerGrantOptions.rounds
                            .filter((round) => round.status === "open")
                            .map((round) => (
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
            invited address grants nothing on its own.
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
          <Button disabled={!inviteEmail.includes("@")} onClick={() => void invite()} tone="signal">
            Send invitation
          </Button>
        </div>
        {data.invites.length === 0 ? (
          <EmptyState title="No invitations open" description="Every invitation has been confirmed or withdrawn." />
        ) : (
          <ul className="people-invite-list">
            {data.invites.map((openInvite) => (
              <li key={openInvite.id}>
                <div>
                  <strong>{openInvite.email}</strong>
                  <small>Invited {formatDate(openInvite.createdAt)} · waiting on confirmation</small>
                </div>
                <Button onClick={() => void revokeInvite(openInvite)} tone="quiet">Withdraw</Button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <Toast message={message} />
    </>
  );
}
