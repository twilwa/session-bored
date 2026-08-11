// ABOUTME: Public speaker directory — surname-sorted, searchable, degrades without headshots (F-10.4).
import { useEffect, useState } from "react";
import { EmptyState, LoadingState } from "../../components/ui.tsx";
import type { PublicSpeakersResponse } from "../../../shared/api.ts";
import { Link, PublicHeader, getJson } from "../../lib.tsx";
import { DEVFLOW_EVENT_ID, initialsOf, truncate } from "./shared.ts";

function SpeakerCard({ speaker }: { speaker: PublicSpeakersResponse["items"][number] }) {
  const bio = speaker.bio ?? "";
  return (
    <article className="speaker-card">
      {speaker.headshotUrl === null ? (
        <span aria-hidden="true" className="speaker-card__avatar speaker-card__avatar--placeholder">
          {initialsOf(speaker.name)}
        </span>
      ) : (
        <img
          alt={`Headshot of ${speaker.name}`}
          className="speaker-card__avatar"
          loading="lazy"
          src={speaker.headshotUrl}
        />
      )}
      <div className="speaker-card__body">
        <h2>{speaker.name}</h2>
        <p className="speaker-card__title">
          {[speaker.jobTitle, speaker.organization].filter((value) => value !== null && value !== "").join(", ") || "Speaker"}
        </p>
        {bio === "" ? null : <p className="speaker-card__bio">{truncate(bio, 150)}</p>}
        <p className="speaker-card__count">
          {speaker.sessionCount === 0 ? "No sessions announced yet" : `${speaker.sessionCount} session${speaker.sessionCount === 1 ? "" : "s"}`}
        </p>
      </div>
      <Link className="speaker-card__link" href={`/speakers/${speaker.id}`}>
        View profile →
      </Link>
    </article>
  );
}

export function SpeakersPage() {
  const [query, setQuery] = useState(() => new URLSearchParams(window.location.search).get("q") ?? "");
  const [data, setData] = useState<PublicSpeakersResponse | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (query === "") {
      url.searchParams.delete("q");
    } else {
      url.searchParams.set("q", query);
    }
    window.history.replaceState({}, "", `${url.pathname}${url.search}`);
    setLoading(true);
    setError(false);
    const params = new URLSearchParams();
    if (query !== "") {
      params.set("q", query);
    }
    const path = `/api/public/events/${DEVFLOW_EVENT_ID}/speakers${params.toString() === "" ? "" : `?${params}`}`;
    let active = true;
    getJson<PublicSpeakersResponse>(path)
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
  }, [query, retryToken]);

  const facets = data?.facets ?? null;
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const filtered = data?.filtered ?? 0;

  return (
    <div className="public-page">
      <PublicHeader />
      <main className="program-page program-page--list">
        <header className="program-intro">
          <p className="eyebrow">SPEAKER DIRECTORY / {facets?.event.name ?? "DEVFLOW CONF 2027"}</p>
          <h1>Speakers</h1>
          <p>The people behind the talks, workshops, and panels{facets?.event.venue ? ` at ${facets.event.venue}` : ""}.</p>
        </header>

        <section className="program-toolbar" aria-label="Search speakers">
          <form
            className="program-search"
            onSubmit={(event) => event.preventDefault()}
            role="search"
          >
            <label className="field field--search">
              <span className="field__label">Search</span>
              <input
                aria-label="Search speakers by name"
                className="field__control"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search by name"
                type="search"
                value={query}
              />
            </label>
          </form>
          <p className="program-count" role="status" aria-live="polite">
            {loading ? "Loading…" : `${filtered} of ${total} speaker${total === 1 ? "" : "s"}`}
          </p>
        </section>

        {loading ? <LoadingState label="Loading speakers" /> : null}
        {error ? (
          <p className="program-error" role="alert">
            The speaker directory could not be loaded.{" "}
            <button className="text-link" onClick={() => setRetryToken((token) => token + 1)} type="button">
              Try again
            </button>
            .
          </p>
        ) : null}
        {!loading && !error && items.length === 0 ? (
          total === 0 ? (
            <EmptyState
              description="Confirmed speakers publish here as the program takes shape."
              title="No speakers announced yet"
            />
          ) : (
            <EmptyState
              description="No speakers match that name."
              title="No matches"
            />
          )
        ) : null}
        {!loading && !error && items.length > 0 ? (
          <section aria-label="Published speakers" className="speaker-grid">
            {items.map((speaker) => (
              <SpeakerCard key={speaker.id} speaker={speaker} />
            ))}
          </section>
        ) : null}

        <footer className="program-foot">
          <Link className="text-link" href="/program">Browse the program →</Link>
          <Link className="text-link" href="/">Back to home</Link>
        </footer>
      </main>
    </div>
  );
}
