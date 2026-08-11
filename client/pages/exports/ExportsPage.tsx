// ABOUTME: Gives organizers a discoverable download center for portable event records.
// ABOUTME: Explains each format's contents and reconstruction limits before download.
import "./exports.css";

const eventId = "evt_devflow_conf_2027";

const exports = [
  {
    filename: "sessions.json",
    format: "JSON",
    description: "Program records with stable IDs, content and schedule states, track, format, room, speakers, source decision, saved form answers, and calendar identity.",
  },
  {
    filename: "speakers.json",
    format: "JSON",
    description: "Speaker profiles and private contact details, statuses, social links, custom fields, and their linked submissions and sessions.",
  },
  {
    filename: "reviews.csv",
    format: "CSV",
    description: "One spreadsheet row per criterion score, with its label, reviewer, round, proposal decision, review notes, and attributed committee discussion.",
  },
  {
    filename: "schedule.ics",
    format: "ICAL",
    description: "Every currently placed session with a start and end time, using durable calendar IDs so calendar applications can recognize updates.",
  },
] as const;

export function ExportsPage() {
  return (
    <>
      <header className="workspace-header exports-header">
        <div>
          <p className="eyebrow">EXPORTS / PORTABLE BY DEFAULT</p>
          <h1>Take the whole program with you.</h1>
          <p>These are working records, not a public feed. Downloads include private and unpublished organizer data.</p>
        </div>
      </header>

      <section aria-label="Event exports" className="exports-grid">
        {exports.map((item, index) => (
          <article className="export-card" key={item.filename}>
            <div className="export-card__index">{String(index + 1).padStart(2, "0")}</div>
            <div className="export-card__body">
              <div className="export-card__heading">
                <h2>{item.filename}</h2>
                <span>{item.format}</span>
              </div>
              <p>{item.description}</p>
              <a
                className="button button--signal"
                download={item.filename}
                href={`/api/events/${eventId}/exports/${item.filename}`}
              >
                Download {item.filename}
              </a>
            </div>
          </article>
        ))}
      </section>

      <section className="workspace-section exports-notes" aria-labelledby="export-boundaries">
        <div className="section-heading">
          <div><p className="section-label">READ THIS FIRST</p><h2 id="export-boundaries">What can be rebuilt</h2></div>
        </div>
        <div className="exports-notes__columns">
          <div>
            <h3>Included</h3>
            <p>The program, people, source proposal links and answers, live decisions, review work, committee discussion, and placed calendar events.</p>
          </div>
          <div>
            <h3>Not included</h3>
            <p>Uploaded file contents, email delivery history, task history, authentication accounts, form-builder configuration, or unpublished calendar slots without a real time.</p>
          </div>
        </div>
        <p className="exports-notes__privacy">
          CFP answer visibility for blind reviewers does not remove answers here. This page is organizer-only, and a complete owner export must preserve the event's submitted source data.
        </p>
      </section>
    </>
  );
}
