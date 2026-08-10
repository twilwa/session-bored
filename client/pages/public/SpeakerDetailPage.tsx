// ABOUTME: Public speaker detail — bio, headshot (or graceful fallback), and approved sessions (F-10.5).
import { useEffect, useState } from "react";
import { EmptyState, LoadingState, StatusChip } from "../../components/ui.tsx";
import type { PublicSpeakerDetailResponse } from "../../../shared/api.ts";
import { Link, PublicHeader, getJson } from "../../lib.tsx";
import { DEVFLOW_EVENT_ID, formatDayLabel, formatSchedule, formatTime, initialsOf } from "./shared.ts";

export function SpeakerDetailPage({ speakerId }: { speakerId: string }) {
  const [data, setData] = useState<PublicSpeakerDetailResponse | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setError(false);
    let active = true;
    getJson<PublicSpeakerDetailResponse>(
      `/api/public/events/${DEVFLOW_EVENT_ID}/speakers/${speakerId}`,
    )
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
  }, [speakerId]);

  const speaker = data?.speaker ?? null;
  const facets = data?.facets ?? null;
  const timezone = facets?.event.timezone ?? "UTC";

  return (
    <div className="public-page">
      <PublicHeader />
      <main className="program-page program-page--detail">
        <Link className="text-link speaker-detail__back" href="/speakers">← Back to speakers</Link>
        {loading ? <LoadingState label="Loading speaker" /> : null}
        {error ? (
          <EmptyState
            description="This speaker could not be found, or their profile is not public yet."
            title="Speaker unavailable"
          />
        ) : null}
        {!loading && !error && speaker ? (
          <>
            <header className="speaker-detail__head">
              {speaker.headshotUrl === null ? (
                <span aria-hidden="true" className="speaker-card__avatar speaker-card__avatar--placeholder speaker-card__avatar--lg">
                  {initialsOf(speaker.name)}
                </span>
              ) : (
                <img
                  alt={`Headshot of ${speaker.name}`}
                  className="speaker-detail__avatar"
                  src={speaker.headshotUrl}
                />
              )}
              <div className="speaker-detail__intro">
                <p className="eyebrow">SPEAKER / {facets?.event.name ?? "DEVFLOW CONF 2027"}</p>
                <h1>{speaker.name}</h1>
                <p className="speaker-detail__role">
                  {[speaker.jobTitle, speaker.organization].filter((value) => value !== null && value !== "").join(", ") || "Speaker"}
                </p>
                {speaker.twitter === null && speaker.linkedin === null ? null : (
                  <p className="speaker-detail__social">
                    {speaker.twitter === null ? null : (
                      <a href={`https://twitter.com/${speaker.twitter.replace(/^@/, "")}`} rel="noreferrer" target="_blank">{speaker.twitter}</a>
                    )}
                    {speaker.linkedin === null ? null : (
                      <a href={speaker.linkedin} rel="noreferrer" target="_blank">LinkedIn</a>
                    )}
                  </p>
                )}
              </div>
            </header>

            <section className="speaker-detail__bio">
              <p className="section-label">About</p>
              {speaker.bio === null || speaker.bio === "" ? (
                <p className="speaker-detail__thin">Bio coming soon.</p>
              ) : (
                <p>{speaker.bio}</p>
              )}
            </section>

            <section className="speaker-detail__sessions">
              <div className="section-heading">
                <div>
                  <p className="section-label">SESSIONS</p>
                  <h2>{speaker.sessionCount} session{speaker.sessionCount === 1 ? "" : "s"}</h2>
                </div>
                <Link className="text-link" href="/program">Full program →</Link>
              </div>
              {speaker.sessions.length === 0 ? (
                <EmptyState
                  description="This speaker's session will appear here once the committee finalizes the program."
                  title="No sessions announced yet"
                />
              ) : (
                <ul className="speaker-sessions">
                  {speaker.sessions.map((session) => (
                    <li className="speaker-sessions__item" key={session.id}>
                      <div className="speaker-sessions__main">
                        <p className="speaker-sessions__track">{session.track ?? "Track TBD"}</p>
                        <h3>
                          <Link href={`/program/${session.id}`}>{session.title ?? "Untitled session"}</Link>
                        </h3>
                        <p className="speaker-sessions__when">
                          {formatDayLabel(session.scheduledDate ?? "")}
                          {session.startsAt !== null && session.endsAt !== null
                            ? ` · ${formatTime(session.startsAt, timezone)}–${formatTime(session.endsAt, timezone)}`
                            : ""}
                        </p>
                      </div>
                      <div className="speaker-sessions__aside">
                        <StatusChip tone={session.startsAt !== null ? "good" : "signal"}>
                          {formatSchedule({
                            scheduledDate: session.scheduledDate,
                            startsAt: session.startsAt,
                            endsAt: session.endsAt,
                            scheduleStatus: session.startsAt !== null ? "placed" : "tbd",
                            timezone,
                          })}
                        </StatusChip>
                        {session.room === null ? null : <span>@ {session.room}</span>}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        ) : null}
      </main>
    </div>
  );
}
