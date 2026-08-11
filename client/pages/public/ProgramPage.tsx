// ABOUTME: Public program — searchable, faceted list of approved session cards (PRD F-10.1/2/3).
// ABOUTME: Filter state lives in the URL so any view is linkable and survives refresh.
import { useEffect, useMemo, useState } from "react";
import { EmptyState, LoadingState, StatusChip } from "../../components/ui.tsx";
import type {
  PublicEventFacets,
  PublicSessionCard,
  PublicSessionsResponse,
} from "../../../shared/api.ts";
import { Link, PublicHeader, getJson, navigate } from "../../lib.tsx";
import {
  DEVFLOW_EVENT_ID,
  EMPTY_FILTERS,
  activeFilterCount,
  formatSchedule,
  formatSpeakerLine,
  readFiltersFromUrl,
  truncate,
  writeFiltersToUrl,
  type ProgramFilters,
} from "./shared.ts";

const ABSTRACT_PREVIEW = 220;

function FacetGroup({
  label,
  values,
  selected,
  onSelect,
}: {
  label: string;
  values: string[];
  selected: string;
  onSelect: (value: string) => void;
}) {
  if (values.length === 0) {
    return null;
  }
  return (
    <fieldset className="facet-group">
      <legend>{label}</legend>
      <div className="facet-options">
        <button
          aria-pressed={selected === ""}
          className={selected === "" ? "facet-option facet-option--active" : "facet-option"}
          onClick={() => onSelect("")}
          type="button"
        >
          Any
        </button>
        {values.map((value) => (
          <button
            aria-pressed={selected === value}
            className={selected === value ? "facet-option facet-option--active" : "facet-option"}
            key={value}
            onClick={() => onSelect(value)}
            type="button"
          >
            {value}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function SessionCard({
  session,
  index,
  filteredOut,
  timezone,
}: {
  session: PublicSessionCard;
  index: number;
  filteredOut?: boolean;
  timezone: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const abstract = session.abstract ?? "";
  const canExpand = abstract.length > ABSTRACT_PREVIEW;
  const shownAbstract = expanded || !canExpand ? abstract : truncate(abstract, ABSTRACT_PREVIEW);
  return (
    <article
      aria-hidden={filteredOut ? "true" : undefined}
      className={filteredOut ? "program-session program-session--filtered" : "program-session"}
      key={session.id}
    >
      <span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
      <div className="program-session__body">
        <p className="program-session__meta">
          {[session.track, session.format].filter((value) => value !== null && value !== "").join(" · ") || "Session"}
        </p>
        <h2>
          <Link className="program-session__title-link" href={`/program/${session.id}`}>
            {session.title ?? "Untitled session"}
          </Link>
        </h2>
        <p className="program-session__abstract">{shownAbstract}</p>
        {canExpand ? (
          <button
            aria-expanded={expanded}
            className="program-session__expand"
            onClick={() => setExpanded((prev) => !prev)}
            type="button"
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        ) : null}
        <p className="program-session__speakers">{formatSpeakerLine(session.speakers)}</p>
      </div>
      <div className="program-session__aside">
        <StatusChip tone={session.scheduleStatus === "placed" ? "good" : "signal"}>
          {formatSchedule({ ...session, timezone })}
        </StatusChip>
        {session.room === null ? null : <span className="program-session__room">@ {session.room}</span>}
      </div>
    </article>
  );
}

export function ProgramPage({ sessionId }: { sessionId: string | undefined }) {
  const [filters, setFilters] = useState<ProgramFilters>(() => readFiltersFromUrl(window.location.search));
  const [data, setData] = useState<PublicSessionsResponse | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    writeFiltersToUrl(filters);
    setLoading(true);
    setError(false);
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== "") {
        params.set(key, value);
      }
    }
    const query = params.toString();
    const path = `/api/public/events/${DEVFLOW_EVENT_ID}/sessions${query === "" ? "" : `?${query}`}`;
    let active = true;
    getJson<PublicSessionsResponse>(path)
      .then((payload) => {
        if (active) {
          setData(payload);
          setLoading(false);
        }
      })
      .catch(() => {
        if (active) {
          setError(true);
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [filters, retryToken]);

  const facets: PublicEventFacets | null = data?.facets ?? null;
  const timezone = facets?.event.timezone ?? "UTC";
  const items = data?.items ?? [];
  const visibleItems = sessionId === undefined ? items : items.filter((item) => item.id === sessionId);
  const total = data?.total ?? 0;
  const filtered = data?.filtered ?? 0;
  const activeCount = useMemo(() => activeFilterCount(filters), [filters]);

  return (
    <div className="public-page">
      <PublicHeader />
      <main className="program-page program-page--list">
        <header className="program-intro">
          <p className="eyebrow">PUBLIC PROGRAM / {facets?.event.name ?? "DEVFLOW CONF 2027"}</p>
          <h1>{facets?.event.name ?? "Program"}</h1>
          <p>
            {facets?.event.venue ?? null}
            {facets?.event.startDate && facets?.event.endDate
              ? ` · ${facets.event.startDate} to ${facets.event.endDate}`
              : null}
          </p>
        </header>

        <section className="program-toolbar" aria-label="Search and filter sessions">
          <form
            className="program-search"
            onSubmit={(event) => {
              event.preventDefault();
            }}
            role="search"
          >
            <label className="field field--search">
              <span className="field__label">Search</span>
              <input
                aria-label="Search sessions and speakers"
                className="field__control"
                onChange={(event) => setFilters((prev) => ({ ...prev, q: event.target.value }))}
                placeholder="Title, abstract, or speaker name"
                type="search"
                value={filters.q}
              />
            </label>
          </form>
          <p className="program-count" role="status" aria-live="polite">
            {loading ? "Loading…" : `${sessionId === undefined ? filtered : visibleItems.length} of ${total} session${total === 1 ? "" : "s"}`}
          </p>
        </section>

        <section className="program-filters" aria-label="Filter sessions">
          <div className="program-filters__head">
            <p className="section-label">Filters</p>
            {activeCount === 0 ? null : (
              <button
                className="text-link"
                onClick={() => setFilters(EMPTY_FILTERS)}
                type="button"
              >
                Clear {activeCount} {activeCount === 1 ? "filter" : "filters"}
              </button>
            )}
          </div>
          <div className="program-filters__grid">
            <FacetGroup
              label="Track"
              onSelect={(value) => setFilters((prev) => ({ ...prev, track: value }))}
              selected={filters.track}
              values={facets?.tracks ?? []}
            />
            <FacetGroup
              label="Format"
              onSelect={(value) => setFilters((prev) => ({ ...prev, format: value }))}
              selected={filters.format}
              values={facets?.formats ?? []}
            />
            <FacetGroup
              label="Room"
              onSelect={(value) => setFilters((prev) => ({ ...prev, room: value }))}
              selected={filters.room}
              values={facets?.rooms ?? []}
            />
            <FacetGroup
              label="Day"
              onSelect={(value) => setFilters((prev) => ({ ...prev, day: value }))}
              selected={filters.day}
              values={facets?.days ?? []}
            />
          </div>
        </section>

        {loading ? <LoadingState label="Loading program" /> : null}
        {error ? (
          <p className="program-error" role="alert">
            The program could not be loaded.{" "}
            <button className="text-link" onClick={() => setRetryToken((token) => token + 1)} type="button">
              Try again
            </button>
            .
          </p>
        ) : null}
        {!loading && !error && visibleItems.length === 0 ? (
          sessionId !== undefined ? (
            <EmptyState
              description="This session is not part of the published program."
              title="Session unavailable"
            />
          ) : total === 0 ? (
            <EmptyState
              description="Once the committee approves sessions they will appear here."
              title="No sessions published yet"
            />
          ) : (
            <EmptyState
              description={
                activeCount === 0 && filters.q === ""
                  ? "Nothing matched. Try clearing your search."
                  : "No sessions match your search and filters."
              }
              title="No matches"
            />
          )
        ) : null}
        {!loading && !error && items.length > 0 ? (
          <section aria-label="Published sessions" className="program-list">
            {visibleItems.map((session, index) => (
              <SessionCard index={index} key={session.id} session={session} timezone={timezone} />
            ))}
          </section>
        ) : null}

        <footer className="program-foot">
          {sessionId === undefined ? null : <Link className="text-link" href="/program">Full program →</Link>}
          <Link className="text-link" href="/speakers">Browse speakers →</Link>
          <button
            className="text-link"
            onClick={() => navigate("/")}
            type="button"
          >
            Back to home
          </button>
        </footer>
      </main>
    </div>
  );
}
