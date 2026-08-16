// ABOUTME: Presents the organizer-only speaker memory shared across every event.
// ABOUTME: Supports contact metadata, filtering, notes, history, and explicit identity merges.
import { useEffect, useState } from "react";
import type {
  SpeakerDirectoryDetailResponse,
  SpeakerDirectoryDuplicate,
  SpeakerDirectoryFilters,
  SpeakerDirectoryListItem,
  SpeakerDirectoryListResponse,
  SpeakerDirectoryMergeResult,
  SpeakerDirectoryMetadata,
  SpeakerDirectoryNote,
  SpeakerDirectorySavedFilters,
  SpeakerDirectorySegment,
} from "../../../shared/speaker-directory.ts";
import { Headshot } from "../../components/Headshot.tsx";
import {
  Button,
  EmptyState,
  LoadingState,
  Modal,
  SelectField,
  StatusChip,
  TextField,
  Toast,
} from "../../components/ui.tsx";
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

const initialFilters: SpeakerDirectoryFilters = {
  search: "",
  tags: [],
  customFields: [],
  sort: "name",
  direction: "asc",
  page: 1,
  pageSize: 25,
};

function directoryListPath(filters: SpeakerDirectoryFilters): string {
  const parameters = new URLSearchParams();
  if (filters.search.trim() !== "") parameters.set("q", filters.search.trim());
  for (const tag of filters.tags) parameters.append("tag", tag);
  for (const field of filters.customFields) parameters.append("field", `${field.name}:${field.value}`);
  parameters.set("sort", filters.sort);
  parameters.set("direction", filters.direction);
  parameters.set("page", String(filters.page));
  parameters.set("pageSize", String(filters.pageSize));
  return `/api/speaker-directory?${parameters.toString()}`;
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

function DirectoryList({
  data,
  filters,
  onApply,
  onSaveSegment,
  savingSegment,
}: {
  data: SpeakerDirectoryListResponse;
  filters: SpeakerDirectoryFilters;
  onApply: (filters: SpeakerDirectoryFilters) => void;
  onSaveSegment: (name: string, filters: SpeakerDirectorySavedFilters) => Promise<boolean>;
  savingSegment: boolean;
}) {
  const [search, setSearch] = useState(filters.search);
  const [tags, setTags] = useState(filters.tags);
  const [customFields, setCustomFields] = useState(filters.customFields);
  const [sort, setSort] = useState(filters.sort);
  const [direction, setDirection] = useState(filters.direction);
  const [segmentName, setSegmentName] = useState("");
  const [selectedSegmentId, setSelectedSegmentId] = useState("");

  function toggleTag(tag: string): void {
    setTags((selected) => selected.includes(tag)
      ? selected.filter((value) => value !== tag)
      : [...selected, tag]);
  }

  function toggleField(name: string, value: string): void {
    setCustomFields((selected) => selected.some((field) => field.name === name && field.value === value)
      ? selected.filter((field) => field.name !== name || field.value !== value)
      : [...selected, { name, value }]);
  }

  function apply(page = 1): void {
    onApply({ ...filters, search, tags, customFields, sort, direction, page });
  }

  function clear(): void {
    setSearch("");
    setTags([]);
    setCustomFields([]);
    setSort("name");
    setDirection("asc");
    onApply(initialFilters);
  }

  function runSegment(): void {
    const segment = data.savedSegments.find((candidate) => candidate.id === selectedSegmentId);
    if (segment === undefined) return;
    setSearch(segment.filters.search);
    setTags(segment.filters.tags);
    setCustomFields(segment.filters.customFields);
    setSort(segment.filters.sort);
    setDirection(segment.filters.direction);
    onApply({ ...segment.filters, page: 1, pageSize: filters.pageSize });
  }

  async function saveSegment(): Promise<void> {
    const saved = await onSaveSegment(segmentName, {
      search,
      tags,
      customFields,
      sort,
      direction,
    });
    if (saved) setSegmentName("");
  }

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
        <article><span>PEOPLE</span><strong>{data.overview.people}</strong><small>with speaker history</small></article>
        <article><span>EVENTS</span><strong>{data.overview.events}</strong><small>represented here</small></article>
        <article><span>SESSIONS</span><strong>{data.overview.sessions}</strong><small>linked to people</small></article>
        <article><span>TAGGED</span><strong>{data.overview.taggedPeople}</strong><small>curated contacts</small></article>
      </section>

      <form className="directory-toolbar" aria-label="Directory controls" onSubmit={(event) => {
        event.preventDefault();
        apply();
      }}>
        <div className="directory-toolbar__primary">
          <TextField
            label="Search directory"
            name="directory-search"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Name, email, company, role, event, tag, or field"
            type="search"
            value={search}
          />
          <SelectField label="Sort by" name="directory-sort" onChange={(event) => setSort(event.target.value as typeof sort)} value={sort}>
            <option value="name">Name</option>
            <option value="updated">Last updated</option>
            <option value="events">Event count</option>
          </SelectField>
          <SelectField label="Direction" name="directory-direction" onChange={(event) => setDirection(event.target.value as typeof direction)} value={direction}>
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </SelectField>
        </div>
        {data.facets.tags.length === 0 && data.facets.customFields.length === 0 ? (
          <p className="directory-toolbar__empty">Add tags or custom fields from a contact record to unlock reusable criteria.</p>
        ) : (
          <div className="directory-filter-groups">
            {data.facets.tags.length === 0 ? null : (
              <fieldset>
                <legend>Tags</legend>
                <div>{data.facets.tags.map((tag) => (
                  <label key={tag}><input checked={tags.includes(tag)} onChange={() => toggleTag(tag)} type="checkbox" />{tag}</label>
                ))}</div>
              </fieldset>
            )}
            {data.facets.customFields.map((field) => (
              <fieldset key={field.name}>
                <legend>{field.name}</legend>
                <div>{field.values.map((value) => (
                  <label key={value}>
                    <input
                      aria-label={`${field.name}: ${value}`}
                      checked={customFields.some((selected) => selected.name === field.name && selected.value === value)}
                      onChange={() => toggleField(field.name, value)}
                      type="checkbox"
                    />
                    {value}
                  </label>
                ))}</div>
              </fieldset>
            ))}
          </div>
        )}
        <div className="directory-segments">
          <SelectField
            disabled={data.savedSegments.length === 0}
            label="Saved segment"
            name="directory-saved-segment"
            onChange={(event) => setSelectedSegmentId(event.target.value)}
            value={selectedSegmentId}
          >
            <option value="">{data.savedSegments.length === 0 ? "No saved segments" : "Choose a segment"}</option>
            {data.savedSegments.map((segment) => <option key={segment.id} value={segment.id}>{segment.name}</option>)}
          </SelectField>
          <Button disabled={selectedSegmentId === ""} onClick={runSegment} tone="quiet" type="button">Run segment</Button>
          <TextField
            label="Segment name"
            maxLength={60}
            name="directory-segment-name"
            onChange={(event) => setSegmentName(event.target.value)}
            placeholder="EMEA keynotes"
            value={segmentName}
          />
          <Button
            disabled={savingSegment || segmentName.trim() === ""}
            onClick={() => void saveSegment()}
            type="button"
          >
            {savingSegment ? "Saving segment…" : "Save segment"}
          </Button>
        </div>
        <div className="directory-toolbar__actions">
          <p>{plural(data.total, "record")} in this view</p>
          <Button onClick={clear} tone="quiet" type="button">Clear filters</Button>
          <Button type="submit">Apply filters</Button>
        </div>
      </form>

      <section className="workspace-section directory-index">
        <div className="section-heading">
          <div><p className="section-label">CROSS-EVENT INDEX / {data.total}</p><h2>Speaker records</h2></div>
          <Link className="text-link" href="/organizer/roster">Current event roster →</Link>
        </div>
        {data.items.length === 0 ? (
          <EmptyState title="No speaker records match" description="Change the search to see more of the directory." />
        ) : (
          <div className="directory-list">
            {data.items.map((person) => (
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
                  {person.tags.length === 0 ? null : <div className="directory-tag-list">{person.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>}
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
        {data.pageCount <= 1 ? null : (
          <nav aria-label="Directory pages" className="directory-pagination">
            <Button disabled={data.page === 1} onClick={() => onApply({ ...filters, page: data.page - 1 })} tone="quiet">Previous</Button>
            <span>Page {data.page} of {data.pageCount}</span>
            <Button disabled={data.page === data.pageCount} onClick={() => onApply({ ...filters, page: data.page + 1 })} tone="quiet">Next</Button>
          </nav>
        )}
      </section>
    </>
  );
}

function DirectoryDetail({
  detail,
  addingNote,
  onAddNote,
  onChooseMerge,
  onEditMetadata,
}: {
  detail: SpeakerDirectoryDetailResponse;
  addingNote: boolean;
  onAddNote: (body: string) => Promise<boolean>;
  onChooseMerge: (choice: MergeChoice) => void;
  onEditMetadata: () => void;
}) {
  const person = detail.person;
  const current: MergeIdentity = { id: person.id, name: person.name, email: person.email };
  const [noteBody, setNoteBody] = useState("");
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

      <section className="workspace-section directory-metadata">
        <div className="section-heading">
          <div><p className="section-label">PRIVATE ORGANIZER CONTEXT</p><h2>Tags & custom fields</h2></div>
          <Button onClick={onEditMetadata} tone="quiet">Edit directory details</Button>
        </div>
        {person.tags.length === 0 ? (
          <p className="directory-metadata__empty">No tags saved.</p>
        ) : (
          <div className="directory-tag-list directory-tag-list--detail">
            {person.tags.map((tag) => <span key={tag}>{tag}</span>)}
          </div>
        )}
        {Object.keys(person.customFields).length === 0 ? (
          <p className="directory-metadata__empty">No custom fields saved.</p>
        ) : (
          <dl className="directory-custom-fields">
            {Object.entries(person.customFields).map(([name, value]) => (
              <div key={name}><dt>{name}</dt><dd>{value}</dd></div>
            ))}
          </dl>
        )}
      </section>

      <section className="workspace-section directory-notes">
        <div className="section-heading">
          <div><p className="section-label">PRIVATE & ATTRIBUTED</p><h2>Internal notes</h2></div>
          <span>{plural(detail.notes.length, "note")}</span>
        </div>
        <form onSubmit={(event) => {
          event.preventDefault();
          void onAddNote(noteBody).then((saved) => { if (saved) setNoteBody(""); });
        }}>
          <label className="field" htmlFor="directory-note">
            <span className="field__label">Add internal note</span>
            <textarea
              className="field__control"
              id="directory-note"
              maxLength={2_000}
              onChange={(event) => setNoteBody(event.target.value)}
              rows={3}
              value={noteBody}
            />
          </label>
          <Button disabled={addingNote || noteBody.trim() === ""} type="submit">
            {addingNote ? "Adding note…" : "Add private note"}
          </Button>
        </form>
        {detail.notes.length === 0 ? (
          <p className="directory-metadata__empty">No internal notes yet.</p>
        ) : (
          <div className="directory-note-list">
            {detail.notes.map((note) => (
              <article key={note.id}>
                <p>{note.body}</p>
                <small>{note.author} · {new Date(note.createdAt).toLocaleString()}</small>
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
          <p className="directory-duplicates__intro">Choose which record remains. Greenroom moves the archived record’s programme, proposals, tasks, and files to the one you keep, and resolves their roster status at any event both records speak at.</p>
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

function customFieldsFromText(value: string): Record<string, string> | null {
  const fields: Record<string, string> = {};
  for (const rawLine of value.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    const separator = line.indexOf(":");
    if (separator < 1 || separator === line.length - 1) return null;
    fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return fields;
}

export function SpeakerDirectoryPage({ personId }: { personId?: string }) {
  const [activePersonId, setActivePersonId] = useState(personId);
  const [listFilters, setListFilters] = useState<SpeakerDirectoryFilters>(initialFilters);
  const [reloadCount, setReloadCount] = useState(0);
  const [list, setList] = useState<SpeakerDirectoryListResponse | null>(null);
  const [detail, setDetail] = useState<SpeakerDirectoryDetailResponse | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [mergeChoice, setMergeChoice] = useState<MergeChoice | null>(null);
  const [merging, setMerging] = useState(false);
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [metadataTags, setMetadataTags] = useState("");
  const [metadataFields, setMetadataFields] = useState("");
  const [savingMetadata, setSavingMetadata] = useState(false);
  const [savingSegment, setSavingSegment] = useState(false);
  const [addingNote, setAddingNote] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => setActivePersonId(personId), [personId]);
  useEffect(() => {
    let active = true;
    setLoadFailed(false);
    if (activePersonId !== undefined) setDetail(null);
    const path = activePersonId === undefined
      ? directoryListPath(listFilters)
      : `/api/speaker-directory/${activePersonId}`;
    getJson<SpeakerDirectoryListResponse | SpeakerDirectoryDetailResponse>(path)
      .then((payload) => {
        if (!active) return;
        if (activePersonId === undefined) setList(payload as SpeakerDirectoryListResponse);
        else setDetail(payload as SpeakerDirectoryDetailResponse);
      })
      .catch(() => { if (active) setLoadFailed(true); });
    return () => { active = false; };
  }, [activePersonId, listFilters, reloadCount]);

  function openMetadataEditor(): void {
    if (detail === null) return;
    setMetadataTags(detail.person.tags.join(", "));
    setMetadataFields(
      Object.entries(detail.person.customFields).map(([name, value]) => `${name}: ${value}`).join("\n"),
    );
    setMetadataOpen(true);
  }

  async function saveMetadata(): Promise<void> {
    if (detail === null) return;
    const customFields = customFieldsFromText(metadataFields);
    if (customFields === null) {
      setMessage("Write each custom field as Name: value on its own line.");
      return;
    }
    setSavingMetadata(true);
    try {
      const saved = await requestJson<SpeakerDirectoryMetadata>(`/api/speaker-directory/${detail.person.id}/metadata`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tags: metadataTags.split(",").map((tag) => tag.trim()).filter((tag) => tag !== ""),
          customFields,
        }),
      });
      setDetail((current) => current === null ? null : {
        ...current,
        person: { ...current.person, tags: saved.tags, customFields: saved.customFields },
      });
      setMetadataOpen(false);
      setMessage("Directory details saved privately.");
    } catch {
      setMessage("Those directory details could not be saved. Nothing was changed.");
    } finally {
      setSavingMetadata(false);
    }
  }

  async function addNote(body: string): Promise<boolean> {
    if (detail === null) return false;
    setAddingNote(true);
    try {
      const saved = await requestJson<SpeakerDirectoryNote>(`/api/speaker-directory/${detail.person.id}/notes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      });
      setDetail((current) => current === null ? null : {
        ...current,
        notes: [saved, ...current.notes],
      });
      setMessage("Private note added.");
      return true;
    } catch {
      setMessage("That private note could not be added.");
      return false;
    } finally {
      setAddingNote(false);
    }
  }

  async function saveSegment(
    name: string,
    filters: SpeakerDirectorySavedFilters,
  ): Promise<boolean> {
    setSavingSegment(true);
    try {
      const saved = await requestJson<SpeakerDirectorySegment>("/api/speaker-directory/segments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, filters }),
      });
      setList((current) => current === null ? null : {
        ...current,
        savedSegments: [...current.savedSegments, saved]
          .sort((first, second) => first.name.localeCompare(second.name)),
      });
      setMessage("Segment saved. Run it whenever you need this view again.");
      return true;
    } catch {
      setMessage("That segment could not be saved. Choose a unique name and try again.");
      return false;
    } finally {
      setSavingSegment(false);
    }
  }

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
        ? list === null ? <LoadingState label="Loading speaker directory" /> : (
          <DirectoryList
            data={list}
            filters={listFilters}
            onApply={setListFilters}
            onSaveSegment={saveSegment}
            savingSegment={savingSegment}
          />
        )
        : detail === null ? <LoadingState label="Loading speaker record" /> : (
          <DirectoryDetail
            addingNote={addingNote}
            detail={detail}
            onAddNote={addNote}
            onChooseMerge={setMergeChoice}
            onEditMetadata={openMetadataEditor}
          />
        )}
      <Modal onClose={() => setMetadataOpen(false)} open={metadataOpen} title="Edit directory details">
        <form className="directory-metadata-form" onSubmit={(event) => {
          event.preventDefault();
          void saveMetadata();
        }}>
          <TextField
            hint="Separate tags with commas. Tags remain private to organizers."
            label="Tags"
            name="directory-tags"
            onChange={(event) => setMetadataTags(event.target.value)}
            value={metadataTags}
          />
          <label className="field" htmlFor="directory-custom-fields">
            <span className="field__label">Custom fields</span>
            <textarea
              className="field__control"
              id="directory-custom-fields"
              onChange={(event) => setMetadataFields(event.target.value)}
              placeholder={"Region: EMEA\nLanguage: English"}
              rows={5}
              value={metadataFields}
            />
            <span className="field__hint">Write one Name: value pair per line.</span>
          </label>
          <div>
            <Button onClick={() => setMetadataOpen(false)} tone="quiet" type="button">Cancel</Button>
            <Button disabled={savingMetadata} type="submit">
              {savingMetadata ? "Saving…" : "Save directory details"}
            </Button>
          </div>
        </form>
      </Modal>
      <Modal onClose={() => setMergeChoice(null)} open={mergeChoice !== null} title="Confirm speaker merge">
        {mergeChoice === null ? null : (
          <div className="directory-merge-confirmation">
            <p><strong>Keep {mergeChoice.kept.email}</strong> as the canonical speaker record.</p>
            <p><strong>Archive {mergeChoice.archived.email}</strong> after its event, proposal, task, and file links move to the kept record.</p>
            <p>This preserves the archived profile in the merge log and sends no message.</p>
            <p>Where both records speak at the same event, the kept record takes the further-along roster status — and stays withdrawn if either was withdrawn. That can change whether this person is listed on the public programme for that event.</p>
            <div><Button onClick={() => setMergeChoice(null)} tone="quiet">Cancel</Button><Button disabled={merging} onClick={() => void merge()} tone="signal">{merging ? "Merging…" : `Merge and keep ${mergeChoice.kept.email}`}</Button></div>
          </div>
        )}
      </Modal>
      <Toast message={message} />
    </>
  );
}
