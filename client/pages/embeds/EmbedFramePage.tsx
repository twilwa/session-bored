// ABOUTME: Renders a saved public widget in a chromeless document isolated from the host website.
// ABOUTME: Uses only the token-resolved public read model and reports its height to the iframe loader.
import { Fragment, useEffect, useMemo, useState, type CSSProperties } from "react";
import type {
  EmbedConfig,
  PublicEmbedResponse,
  PublicSessionCard,
  PublicSpeakerCard,
} from "../../../shared/api.ts";
import { embedFieldIsVisible } from "../../../shared/embed-config.ts";
import { EmptyState, LoadingState } from "../../components/ui.tsx";
import { Headshot } from "../../components/Headshot.tsx";
import { getJson } from "../../lib.tsx";
import {
  agendaCellKey,
  buildAgendaGrid,
  formatDayLabel,
  formatSpeakerLine,
  formatTimeRange,
  groupSessionsByDay,
  sortSessionsChronologically,
} from "../public/shared.ts";
import "./embeds.css";

function isSession(item: PublicSessionCard | PublicSpeakerCard): item is PublicSessionCard {
  return "scheduleStatus" in item;
}

function SessionList({ config, items, timezone }: { config: EmbedConfig; items: PublicSessionCard[]; timezone: string }) {
  return (
    <ul className="embed-session-list">
      {sortSessionsChronologically(items).map((session) => {
        const meta = [
          embedFieldIsVisible(config, "showTrack") ? session.track : null,
          embedFieldIsVisible(config, "showFormat") ? session.format : null,
        ].filter((value): value is string => value !== null);
        return (
          <li key={session.id}>
            {!embedFieldIsVisible(config, "showTime") && !embedFieldIsVisible(config, "showLocation") ? null : (
              <div className="embed-session-list__time">
                {embedFieldIsVisible(config, "showTime") ? <strong>{formatTimeRange(session.startsAt, session.endsAt, timezone)}</strong> : null}
                {embedFieldIsVisible(config, "showLocation") ? <span>{session.room ?? "Room TBD"}</span> : null}
              </div>
            )}
            <div>
              {meta.length === 0 ? null : <p className="embed-frame__meta">{meta.join(" · ")}</p>}
              <h2>{session.title ?? "Untitled session"}</h2>
              {embedFieldIsVisible(config, "showSpeakers") ? <p className="embed-frame__speakers">{formatSpeakerLine(session.speakers)}</p> : null}
              {!embedFieldIsVisible(config, "showDescription") || session.abstract === null ? null : <p className="embed-frame__abstract">{session.abstract}</p>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function ItineraryWidget({ config, items, timezone }: { config: EmbedConfig; items: PublicSessionCard[]; timezone: string }) {
  const { byDay, unscheduled } = groupSessionsByDay(items);
  return (
    <div className="embed-itinerary">
      {[...byDay.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([day, sessions]) => (
        <section key={day}>
          {embedFieldIsVisible(config, "showTime") ? <h2 className="embed-frame__day">{formatDayLabel(day)}</h2> : null}
          <SessionList config={config} items={sessions} timezone={timezone} />
        </section>
      ))}
      {unscheduled.length === 0 ? null : <section>{embedFieldIsVisible(config, "showTime") ? <h2 className="embed-frame__day">Schedule TBD</h2> : null}<SessionList config={config} items={unscheduled} timezone={timezone} /></section>}
    </div>
  );
}

function AgendaWidget({ config, items, rooms, timezone }: { config: EmbedConfig; items: PublicSessionCard[]; rooms: string[]; timezone: string }) {
  const { byDay } = groupSessionsByDay(items);
  return (
    <div className="embed-itinerary">
      {[...byDay.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([day, sessions]) => {
        const grid = buildAgendaGrid(sessions, rooms, timezone);
        return (
          <section key={day}>
            {embedFieldIsVisible(config, "showTime") ? <h2 className="embed-frame__day">{formatDayLabel(day)}</h2> : null}
            <div className="embed-agenda-scroll">
              <div className="embed-agenda" style={{ gridTemplateColumns: `84px repeat(${grid.columns.length}, minmax(160px, 1fr))` }}>
                <div />
                {grid.columns.map((column) => <strong className="embed-agenda__header" key={column.key}>{embedFieldIsVisible(config, "showLocation") ? column.label : ""}</strong>)}
                {grid.rows.map((row) => (
                  <Fragment key={row.key}>
                    <strong className="embed-agenda__time">{embedFieldIsVisible(config, "showTime") ? row.label : ""}</strong>
                    {grid.columns.map((column) => (
                      <div className="embed-agenda__cell" key={column.key}>
                        {(grid.cells.get(agendaCellKey(row.key, column.key)) ?? []).map((session) => (
                          <article key={session.id}>
                            {!embedFieldIsVisible(config, "showTrack") && !embedFieldIsVisible(config, "showFormat") ? null : (
                              <small>{[
                                embedFieldIsVisible(config, "showTrack") ? session.track ?? "Track TBD" : null,
                                embedFieldIsVisible(config, "showFormat") ? session.format ?? "Format TBD" : null,
                              ].filter(Boolean).join(" · ")}</small>
                            )}
                            <span>{session.title ?? "Untitled session"}</span>
                            {embedFieldIsVisible(config, "showSpeakers") ? <p className="embed-agenda__speakers">{formatSpeakerLine(session.speakers)}</p> : null}
                          </article>
                        ))}
                      </div>
                    ))}
                  </Fragment>
                ))}
              </div>
            </div>
          </section>
        );
      })}
    </div>
  );
}

function SpeakerWidget({ config, items, gallery }: { config: EmbedConfig; items: PublicSpeakerCard[]; gallery: boolean }) {
  return (
    <ul className={gallery ? "embed-speakers embed-speakers--gallery" : "embed-speakers"}>
      {items.map((speaker) => (
        <li key={speaker.id}>
          {gallery && embedFieldIsVisible(config, "showSpeakerImage") ? (
            <Headshot alt="" fallbackClassName="embed-speakers__initials" imageClassName="" name={speaker.name} url={speaker.headshotUrl} />
          ) : null}
          <div>
            <h2>{speaker.name}</h2>
            {embedFieldIsVisible(config, "showSpeakerDetails") ? <p className="embed-speaker-details">{[speaker.jobTitle, speaker.organization].filter(Boolean).join(" · ") || "Speaker"}</p> : null}
            {!embedFieldIsVisible(config, "showDescription") || speaker.bio === null ? null : <p className="embed-speaker-bio">{speaker.bio}</p>}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function EmbedFramePage({ publicToken }: { publicToken: string }) {
  const [data, setData] = useState<PublicEmbedResponse | null>(null);
  const [error, setError] = useState(false);
  const version = new URLSearchParams(window.location.search).get("version");

  useEffect(() => {
    const query = version === null ? "" : `?version=${encodeURIComponent(version)}`;
    getJson<PublicEmbedResponse>(`/api/public/embeds/${publicToken}${query}`)
      .then(setData)
      .catch(() => setError(true));
  }, [publicToken, version]);

  useEffect(() => {
    const reportHeight = () => window.parent.postMessage({
      type: "greenroom:embed-height",
      token: publicToken,
      height: document.documentElement.scrollHeight,
    }, "*");
    const observer = new ResizeObserver(reportHeight);
    observer.observe(document.documentElement);
    reportHeight();
    return () => observer.disconnect();
  }, [publicToken]);

  const sessions = useMemo(() => data?.items.filter(isSession) ?? [], [data]);
  const speakers = useMemo(() => data?.items.filter((item): item is PublicSpeakerCard => !isSession(item)) ?? [], [data]);

  if (error) return <main className="embed-frame-page"><p role="alert">This embed is not available.</p></main>;
  if (data === null) return <main className="embed-frame-page"><LoadingState label="Loading embed" /></main>;

  const empty = data.items.length === 0;
  const config = data.embed.config ?? {};
  return (
    <main
      className="embed-frame-page"
      style={{
        backgroundColor: config.backgroundColor,
        color: config.textColor,
        "--embed-accent": config.accentColor,
        "--embed-background": config.backgroundColor,
        "--embed-text": config.textColor,
      } as CSSProperties}
    >
      <header className="embed-frame__header">
        {embedFieldIsVisible(config, "showEventName") ? <p>{data.facets.event.name}</p> : null}
        <h1>{data.embed.name}</h1>
      </header>
      {empty ? <EmptyState title="Nothing published yet" description="Published content matching this embed will appear automatically." /> : null}
      {!empty && data.embed.widgetType === "sessions" ? <SessionList config={config} items={sessions} timezone={data.facets.event.timezone} /> : null}
      {!empty && data.embed.widgetType === "itinerary" ? <ItineraryWidget config={config} items={sessions} timezone={data.facets.event.timezone} /> : null}
      {!empty && data.embed.widgetType === "agenda" ? <AgendaWidget config={config} items={sessions} rooms={data.facets.rooms} timezone={data.facets.event.timezone} /> : null}
      {!empty && data.embed.widgetType === "speakers" ? <SpeakerWidget config={config} gallery={false} items={speakers} /> : null}
      {!empty && data.embed.widgetType === "gallery" ? <SpeakerWidget config={config} gallery items={speakers} /> : null}
      <footer className="embed-frame__footer">Powered by Greenroom</footer>
    </main>
  );
}
