// ABOUTME: Public speaker gallery — photo grid alphabetized by surname with search (F-10.10).
// ABOUTME: Reuses the merged public speakers endpoint, gating, and speaker detail page; degrades without a headshot.
import { useEffect, useState } from "react";
import { EmptyState, LoadingState } from "../../components/ui.tsx";
import type { PublicSpeakersResponse } from "../../../shared/api.ts";
import { Link, PublicHeader, getJson } from "../../lib.tsx";
import { DEVFLOW_EVENT_ID, initialsOf } from "./shared.ts";

function GalleryCard({ speaker }: { speaker: PublicSpeakersResponse["items"][number] }) {
  return (
    <Link className="gallery-card" href={`/speakers/${speaker.id}`}>
      {speaker.headshotUrl === null ? (
        <span aria-hidden="true" className="gallery-card__photo gallery-card__photo--placeholder">
          {initialsOf(speaker.name)}
        </span>
      ) : (
        <img
          alt={`Headshot of ${speaker.name}`}
          className="gallery-card__photo"
          loading="lazy"
          src={speaker.headshotUrl}
        />
      )}
      <div className="gallery-card__caption">
        <h2>{speaker.name}</h2>
        <p>
          {[speaker.jobTitle, speaker.organization].filter((value) => value !== null && value !== "").join(", ") || "Speaker"}
        </p>
      </div>
    </Link>
  );
}

export function SpeakerGalleryPage() {
  const [query, setQuery] = useState(() => new URLSearchParams(window.location.search).get("q") ?? "");
  const [data, setData] = useState<PublicSpeakersResponse | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

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
  }, [query]);

  const facets = data?.facets ?? null;
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const filtered = data?.filtered ?? 0;

  return (
    <div className="public-page">
      <PublicHeader />
      <main className="program-page program-page--list gallery-page">
        <header className="program-intro">
          <p className="eyebrow">SPEAKER GALLERY / {facets?.event.name ?? "DEVFLOW CONF 2027"}</p>
          <h1>Gallery</h1>
          <p>Every confirmed speaker at a glance{facets?.event.venue ? ` — ${facets.event.venue}` : ""}.</p>
        </header>

        <section className="program-toolbar" aria-label="Search speakers">
          <form className="program-search" onSubmit={(event) => event.preventDefault()} role="search">
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

        {loading ? <LoadingState label="Loading gallery" /> : null}
        {error ? (
          <p className="program-error" role="alert">
            The speaker gallery could not be loaded. <Link href="/gallery">Try again</Link>.
          </p>
        ) : null}
        {!loading && !error && items.length === 0 ? (
          total === 0 ? (
            <EmptyState description="Confirmed speakers publish here as the program takes shape." title="No speakers announced yet" />
          ) : (
            <EmptyState description="No speakers match that name." title="No matches" />
          )
        ) : null}
        {!loading && !error && items.length > 0 ? (
          <section aria-label="Published speakers" className="gallery-grid">
            {items.map((speaker) => (
              <GalleryCard key={speaker.id} speaker={speaker} />
            ))}
          </section>
        ) : null}

        <footer className="program-foot">
          <Link className="text-link" href="/speakers">Directory list →</Link>
          <Link className="text-link" href="/program">Browse the program →</Link>
        </footer>
      </main>
    </div>
  );
}
