// ABOUTME: Presents the organizer-only speaker memory shared across every event.
// ABOUTME: Supports directory search, person history, duplicate review, and explicit canonical-record merges.
import { useEffect, useMemo, useState } from "react";
import type {
  SpeakerDirectoryDetailResponse,
  SpeakerDirectoryDuplicate,
  SpeakerDirectoryListItem,
  SpeakerDirectoryListResponse,
  SpeakerDirectoryMergeResult,
} from "../../../shared/speaker-directory.ts";
import { Headshot } from "../../components/Headshot.tsx";
import { Button, EmptyState, LoadingState, Modal, StatusChip, TextField, Toast } from "../../components/ui.tsx";
import { getJson, Link, requestJson } from "../../lib.tsx";
import "./speaker-directory.css";

interface MergeIdentity {
  id: string;
  name: string;
  email: string;
}

interface MergeChoice {
  kept: MergeIdentity;
  archived: MergeIdentity;
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function formatDate(value: string | null): string | null {
  if (value === null) return null;
  return new Date(`${value}T00:00:00`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function eventDates(startDate: string | null, endDate: string | null): string {
  const start = formatDate(startDate);
  const end = formatDate(endDate);
  if (start === null && end === null) return "Dates not set";
  if (start === end || end === null) return start ?? "Dates not set";
  if (start === null) return end;
  return `${start} – ${end}`;
}

function duplicateReason(candidate: SpeakerDirectoryDuplicate): string {
  if (candidate.reasons.includes("same_email")) return "Same email address";
  return "Same name and organization";
}

function DirectoryAvatar({ person }: { person: Pick<SpeakerDirectoryListItem, "headshotUrl" | "name"> }) {
  return (
    <Headshot
      alt=""
      fallbackClassName="directory-avatar"
      imageClassName="directory-avatar directory-avatar--photo"
      loading="lazy"
      name={person.name}
      url={person.headshotUrl}
    />
  );
}

function DirectoryList({ data }: { data: SpeakerDirectoryListResponse }) {
  const [search, setSearch] = useState("");
  const term = search.trim().toLocaleLowerCase("en-US");
  const visible = useMemo(() => data.items.filter((person) => term === "" || [
    person.name,
    person.email,
    person.organization,
    person.jobTitle,
    ...person.events,
  ].some((value) => value?.toLocaleLowerCase("en-US").includes(term))), [data.items, term]);
  const eventNames = new Set(data.items.flatMap((person) => person.events));

  return (
    <>
      <header className="workspace-header directory-header">
        <div>
          <p className="eyebrow">SPEAKER MEMORY / ALL EVENTS</p>
          <h1>Speaker directory.</h1>
          <p>One private record of who has submitted or spoken, beyond any single event roster.</p>
        </div>
        <StatusChip tone={data.possibleDuplicateGroups > 0 ? "signal" : "good"}>
          {plural(data.possibleDuplicateGroups, "duplicate group")}
        </StatusChip>
      </header>

      <section className="metric-strip directory-metrics" aria-label="Directory summary">
        <article><span>PEOPLE</span><strong>{data.items.length}</strong><small>with speaker history</small></article>
        <article><span>EVENTS</span><strong>{eventNames.size}</strong><small>represented here</small></article>
        <article><span>SESSIONS</span><strong>{data.items.reduce((sum, person) => sum + person.sessionCount, 0)}</strong><small>linked to people</small></article>
        <article><span>REVIEW</span><strong>{data.possibleDuplicateGroups}</strong><small>possible duplicate groups</small></article>
      </section>

      <section className="directory-toolbar" aria-label="Directory controls">
        <TextField
          label="Search directory"
          name="directory-search"
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Name, email, company, role, or event"
          type="search"
          value={search}
        />
        <p>{plural(visible.length, "record")} in this view</p>
      </section>

      <section className="workspace-section directory-index">
        <div className="section-heading">
          <div><p className="section-label">CROSS-EVENT INDEX / {visible.length}</p><h2>Speaker records</h2></div>
          <Link className="text-link" href="/organizer/roster">Current event roster →</Link>
        </div>
        {visible.length === 0 ? (
          <EmptyState title="No speaker records match" description="Change the search to see more of the directory." />
        ) : (
          <div className="directory-list">
            {visible.map((person) => (
              <article className="directory-row" key={person.id}>
                <DirectoryAvatar person={person} />
                <div className="directory-row__identity">
                  <strong>{person.name}</strong>
                  <a href={`mailto:${person.email}`}>{person.email}</a>
                  <small>{[person.jobTitle, person.organization].filter(Boolean).join(" · ") || "Profile details not provided"}</small>
                </div>
                <div className="directory-row__history">
                  <strong>{plural(person.eventCount, "event")} · {plural(person.sessionCount, "session")}</strong>
                  <small>{person.events.join(" · ") || "No event names available"}</small>
                </div>
                <div className="directory-row__action">
                  {person.possibleDuplicateCount > 0
                    ? <StatusChip tone="signal">Possible duplicate</StatusChip>
                    : <StatusChip tone="good">Canonical</StatusChip>}
                  <Link ariaLabel={`View ${person.name}`} className="button button--quiet" href={`/organizer/directory/${person.id}`}>
                    View record
                  </Link>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function DirectoryDetail({
  detail,
  onChooseMerge,
}: {
  detail: SpeakerDirectoryDetailResponse;
  onChooseMerge: (choice: MergeChoice) => void;
}) {
  const person = detail.person;
  const current: MergeIdentity = { id: person.id, name: person.name, email: person.email };
  return (
    <>
      <Link className="directory-back" href="/organizer/directory">← All speaker records</Link>
      <header className="workspace-header directory-detail-header">
        <div className="directory-detail-header__identity">
          <DirectoryAvatar person={person} />
          <div>
            <p className="eyebrow">PRIVATE SPEAKER RECORD / ALL EVENTS</p>
            <h1>{person.name}</h1>
            <p>{[person.jobTitle, person.organization].filter(Boolean).join(" · ") || "Profile details not provided"}</p>
          </div>
        </div>
        {person.possibleDuplicateCount > 0
          ? <StatusChip tone="signal">Review duplicates</StatusChip>
          : <StatusChip tone="good">Canonical record</StatusChip>}
      </header>

      <div className="directory-detail-grid">
        <section className="workspace-section directory-profile">
          <p className="section-label">CONTACT & PROFILE</p>
          <h2>Private record</h2>
          <dl>
            <div><dt>Email</dt><dd><a href={`mailto:${person.email}`}>{person.email}</a></dd></div>
            <div><dt>Biography</dt><dd>{person.bio ?? "No biography saved."}</dd></div>
            <div><dt>Twitter</dt><dd>{person.twitter ?? "Not provided"}</dd></div>
            <div><dt>LinkedIn</dt><dd>{person.linkedin ?? "Not provided"}</dd></div>
          </dl>
        </section>
        <section className="workspace-section directory-profile directory-profile--counts">
          <p className="section-label">HISTORY AT A GLANCE</p>
          <h2>Across Greenroom</h2>
          <div><strong>{person.eventCount}</strong><span>Events</span></div>
          <div><strong>{person.proposalCount}</strong><span>Proposals</span></div>
          <div><strong>{person.sessionCount}</strong><span>Sessions</span></div>
        </section>
      </div>

      <section className="workspace-section directory-history">
        <div className="section-heading">
          <div><p className="section-label">PROGRAMME MEMORY</p><h2>Event history</h2></div>
          <span>{plural(person.events.length, "event")}</span>
        </div>
        {person.events.length === 0 ? (
          <EmptyState title="No event history" description="This record is not linked to an active event." />
        ) : (
          <div className="directory-events">
            {person.events.map((event) => (
              <article className="directory-event" key={event.id}>
                <div>
                  <p className="section-label">{eventDates(event.startDate, event.endDate)}</p>
                  <h3>{event.name}</h3>
                  <small>{event.speakerStatus === null ? "Proposal participant" : `Roster status: ${event.speakerStatus.replaceAll("_", " ")}`}</small>
                </div>
                <div className="directory-event__work">
                  <strong>{plural(event.proposalCount, "proposal")}</strong>
                  {event.sessions.length === 0 ? <small>No programme sessions</small> : event.sessions.map((session) => (
                    <span key={session.id}>{session.title ?? "Untitled session"} <StatusChip>{session.contentStatus.replaceAll("_", " ")}</StatusChip></span>
                  ))}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {detail.possibleDuplicates.length === 0 ? null : (
        <section className="workspace-section directory-duplicates">
          <div className="section-heading">
            <div><p className="section-label">IDENTITY REVIEW / {detail.possibleDuplicates.length}</p><h2>Possible duplicates</h2></div>
          </div>
          <p className="directory-duplicates__intro">Choose which record remains. Greenroom moves the archived record’s programme, proposals, tasks, and files to the one you keep.</p>
          <div className="directory-duplicate-list">
            {detail.possibleDuplicates.map((candidate) => {
              const candidateIdentity: MergeIdentity = { id: candidate.id, name: candidate.name, email: candidate.email };
              return (
                <article className="directory-duplicate" key={candidate.id}>
                  <div><StatusChip tone="signal">{duplicateReason(candidate)}</StatusChip><h3>{candidate.name}</h3><a href={`mailto:${candidate.email}`}>{candidate.email}</a><small>{candidate.organization ?? "Organization not provided"}</small></div>
                  <div className="directory-duplicate__counts"><span>{plural(candidate.eventCount, "event")}</span><span>{plural(candidate.proposalCount, "proposal")}</span><span>{plural(candidate.sessionCount, "session")}</span></div>
                  {candidate.accountConflict ? (
                    <p className="directory-duplicate__blocked">Both records belong to different accounts, so they cannot be merged.</p>
                  ) : (
                    <div className="directory-duplicate__actions">
                      <Button onClick={() => onChooseMerge({ kept: candidateIdentity, archived: current })} tone="signal">Keep {candidate.email}</Button>
                      <Button onClick={() => onChooseMerge({ kept: current, archived: candidateIdentity })} tone="quiet">Keep {person.email}</Button>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      )}
    </>
  );
}

export function SpeakerDirectoryPage({ personId }: { personId?: string }) {
  const [activePersonId, setActivePersonId] = useState(personId);
  const [reloadCount, setReloadCount] = useState(0);
  const [list, setList] = useState<SpeakerDirectoryListResponse | null>(null);
  const [detail, setDetail] = useState<SpeakerDirectoryDetailResponse | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [mergeChoice, setMergeChoice] = useState<MergeChoice | null>(null);
  const [merging, setMerging] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => setActivePersonId(personId), [personId]);
  useEffect(() => {
    let active = true;
    setLoadFailed(false);
    setList(null);
    setDetail(null);
    const path = activePersonId === undefined
      ? "/api/speaker-directory"
      : `/api/speaker-directory/${activePersonId}`;
    getJson<SpeakerDirectoryListResponse | SpeakerDirectoryDetailResponse>(path)
      .then((payload) => {
        if (!active) return;
        if (activePersonId === undefined) setList(payload as SpeakerDirectoryListResponse);
        else setDetail(payload as SpeakerDirectoryDetailResponse);
      })
      .catch(() => { if (active) setLoadFailed(true); });
    return () => { active = false; };
  }, [activePersonId, reloadCount]);

  async function merge(): Promise<void> {
    if (mergeChoice === null) return;
    setMerging(true);
    try {
      const result = await requestJson<SpeakerDirectoryMergeResult>(`/api/speaker-directory/${mergeChoice.kept.id}/merge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ duplicatePersonId: mergeChoice.archived.id }),
      });
      const message = `${mergeChoice.archived.name} merged into ${mergeChoice.kept.name}.`;
      setMergeChoice(null);
      // Replaces rather than pushes: the record just archived answers 404 now, so leaving its URL
      // in history would give the organizer a Back button that lands on a record that cannot load.
      window.history.replaceState({}, "", `/organizer/directory/${result.keptPersonId}`);
      setActivePersonId(result.keptPersonId);
      setReloadCount((count) => count + 1);
      setMessage(message);
    } catch {
      setMessage("Those records could not be merged. Nothing was changed.");
    } finally {
      setMerging(false);
    }
  }

  return (
    <>
      {loadFailed ? (
        <section className="state-card" role="alert"><p>The speaker directory could not be loaded.</p></section>
      ) : activePersonId === undefined
        ? list === null ? <LoadingState label="Loading speaker directory" /> : <DirectoryList data={list} />
        : detail === null ? <LoadingState label="Loading speaker record" /> : <DirectoryDetail detail={detail} onChooseMerge={setMergeChoice} />}
      <Modal onClose={() => setMergeChoice(null)} open={mergeChoice !== null} title="Confirm speaker merge">
        {mergeChoice === null ? null : (
          <div className="directory-merge-confirmation">
            <p><strong>Keep {mergeChoice.kept.email}</strong> as the canonical speaker record.</p>
            <p><strong>Archive {mergeChoice.archived.email}</strong> after its event, proposal, task, and file links move to the kept record.</p>
            <p>This preserves the archived profile in the merge log. It does not send a message or change what is publicly published.</p>
            <div><Button onClick={() => setMergeChoice(null)} tone="quiet">Cancel</Button><Button disabled={merging} onClick={() => void merge()} tone="signal">{merging ? "Merging…" : `Merge and keep ${mergeChoice.kept.email}`}</Button></div>
          </div>
        )}
      </Modal>
      <Toast message={message} />
    </>
  );
}
