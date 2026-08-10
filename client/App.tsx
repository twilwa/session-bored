// ABOUTME: Renders Greenroom's populated public and role-specific application shells.
// ABOUTME: Uses same-origin password sessions and client navigation without full-page reloads.
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Button, DataTable, LoadingState, Modal, StatusChip, TextField, Toast } from "./components/ui.tsx";
import { CfpPage as CfpSubmissionPage } from "./pages/cfp/CfpPage.tsx";

type Role = "organizer" | "reviewer" | "speaker";
interface SessionPayload {
  user: { id: string; name: string; email: string; role: Role };
}
interface EventRecord {
  id: string;
  name: string;
  tagline: string | null;
  startDate: string | null;
  endDate: string | null;
  venue: string | null;
  timezone: string;
}
interface NamedRecord { id: string; name: string }
interface SubmissionRecord { id: string; title: string | null; status: string; audienceLevel?: string | null }
interface AssignmentRecord { id: string; submissionId: string; status: string; title: string | null }
interface PublicSessionRecord {
  id: string;
  title: string;
  abstract: string | null;
  scheduledDate: string | null;
  scheduleStatus: string;
  track: string | null;
  format: string | null;
}
interface SpeakerContent {
  profile: { name: string; email: string; jobTitle: string | null; organization: string | null; status: string } | null;
  submissions: SubmissionRecord[];
  tasks: Array<{ id: string; title: string; status: string; dueAt: string | null }>;
}
interface CfpPayload {
  event: EventRecord & { description: string | null };
  form: { closeAt: string | null; welcomeCopy: string | null; minimumSpeakers: number };
  tracks: string[];
  formats: string[];
  fields: Array<{ id: string; label: string; fieldType: string; required: boolean; conditionalValue: string | null }>;
}

function navigate(path: string): void {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function Link({ href, children, className = "" }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a
      className={className}
      href={href}
      onClick={(event) => {
        if (!event.metaKey && !event.ctrlKey && !event.shiftKey) {
          event.preventDefault();
          navigate(href);
        }
      }}
    >
      {children}
    </a>
  );
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin" });
  if (!response.ok) {
    throw new Error(`${response.status}`);
  }
  return response.json<T>();
}

function Brand() {
  return (
    <Link className="brand" href="/">
      <span aria-hidden="true" className="brand__light">●</span>
      <span>Greenroom</span>
    </Link>
  );
}

function PublicHeader() {
  return (
    <header className="public-header">
      <Brand />
      <nav aria-label="Public navigation">
        <Link href="/cfp/devflow-conf-2027">Call for speakers</Link>
        <Link href="/program">Program</Link>
        <Link className="nav-signin" href="/login">Sign in</Link>
      </nav>
    </header>
  );
}

function HomePage() {
  return (
    <div className="public-page">
      <PublicHeader />
      <main className="hero">
        <div className="hero__copy">
          <p className="eyebrow">OPEN SOURCE · BUILT AT THE EDGE</p>
          <h1>Run the program.<br /><em>Lose the drag.</em></h1>
          <p className="hero__lede">
            Call for speakers, review, onboarding, scheduling, and publishing—one fast line from idea to stage.
          </p>
          <div className="hero__actions">
            <Link className="button button--signal" href="/cfp/devflow-conf-2027">Submit to DevFlow →</Link>
            <Link className="button button--quiet" href="/login">Organizer sign in</Link>
          </div>
        </div>
        <aside className="run-sheet" aria-label="Event workflow">
          <span className="run-sheet__tape">LIVE RUN</span>
          {[
            ["01", "Collect", "Proposals arrive"],
            ["02", "Decide", "Review stays scoped"],
            ["03", "Prepare", "Speakers get ready"],
            ["04", "Publish", "The room fills"],
          ].map(([number, title, detail]) => (
            <div className="run-sheet__row" key={number}>
              <span>{number}</span><strong>{title}</strong><small>{detail}</small>
            </div>
          ))}
        </aside>
      </main>
      <footer className="public-footer">Greenroom / event operations at speaking speed</footer>
    </div>
  );
}

function CfpPage() {
  const [data, setData] = useState<CfpPayload | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    getJson<CfpPayload>("/api/public/cfp/devflow-conf-2027").then(setData).catch(() => setError(true));
  }, []);
  return (
    <div className="public-page public-page--cfp">
      <PublicHeader />
      <main className="cfp-page">
        {data === null && !error ? <LoadingState label="Loading call for speakers" /> : null}
        {error ? <p role="alert">The call for speakers could not be loaded.</p> : null}
        {data === null ? null : (
          <>
            <section className="cfp-hero">
              <div>
                <p className="eyebrow">CALL FOR SPEAKERS · OPEN</p>
                <h1>{data.event.name}</h1>
                <p className="cfp-hero__tagline">{data.event.tagline}</p>
                <p>{data.event.description}</p>
              </div>
              <dl className="deadline-card">
                <div><dt>Closes</dt><dd>April 30, 2027</dd></div>
                <div><dt>Event</dt><dd>May 12–14, 2027</dd></div>
                <div><dt>Place</dt><dd>{data.event.venue}</dd></div>
              </dl>
            </section>
            <section className="taxonomy-grid">
              <div><p className="section-label">Tracks / 03</p><div className="tag-list">{data.tracks.map((item) => <span key={item}>{item}</span>)}</div></div>
              <div><p className="section-label">Formats / 05</p><div className="tag-list">{data.formats.map((item) => <span key={item}>{item}</span>)}</div></div>
            </section>
            <section className="form-preview">
              <div>
                <p className="section-label">Published form / v1</p>
                <h2>Bring us the useful part.</h2>
                <p>{data.form.welcomeCopy}</p>
              </div>
              <ol className="field-list">
                {data.fields.map((field, index) => (
                  <li key={field.id}>
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <strong>{field.label}</strong>
                    <small>{field.fieldType.replace("_", " ")}{field.required ? " · required" : " · optional"}</small>
                    {field.conditionalValue === null ? null : <StatusChip tone="signal">when {field.conditionalValue}</StatusChip>}
                  </li>
                ))}
              </ol>
              <Link className="button button--signal" href="/login">Sign in to submit →</Link>
              <p className="save-note">Drafts save even when incomplete. Validation happens only when you submit.</p>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [showCredentials, setShowCredentials] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/auth/sign-in/email", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!response.ok) {
        throw new Error("The email or password didn't match.");
      }
      const session = await getJson<SessionPayload>("/api/session");
      setMessage(`Welcome, ${session.user.name}.`);
      navigate(`/${session.user.role}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Sign in failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <PublicHeader />
      <main className="login-grid">
        <section className="login-intro">
          <p className="eyebrow">CREW ACCESS</p>
          <h1>Backstage<br />starts here.</h1>
          <p>One password. One origin. Exactly the work your role needs.</p>
          <Button onClick={() => setShowCredentials(true)} tone="quiet">View demo credentials</Button>
        </section>
        <form className="login-form" onSubmit={(event) => void submit(event)}>
          <h2>Sign in</h2>
          <TextField autoComplete="email" label="Email" name="email" onChange={(event) => setEmail(event.target.value)} required type="email" value={email} />
          <TextField autoComplete="current-password" label="Password" name="password" onChange={(event) => setPassword(event.target.value)} required type="password" value={password} />
          <Button disabled={busy} type="submit">{busy ? "Signing in…" : "Sign in"}</Button>
          <p className="login-form__note">Password login is always available. No inbox required.</p>
        </form>
      </main>
      <Modal onClose={() => setShowCredentials(false)} open={showCredentials} title="Demo crew">
        <div className="credential-list">
          <p><strong>Organizer</strong><code>sbek-organizer@example.com</code></p>
          <p><strong>Reviewer</strong><code>sbek-reviewer@example.com</code></p>
          <p><strong>Speaker</strong><code>sbek-speaker@example.com</code></p>
          <small>Passwords are documented in the README.</small>
        </div>
      </Modal>
      <Toast message={message} />
    </div>
  );
}

function RoleShell({ role, children }: { role: Role; children: ReactNode }) {
  const nav = role === "organizer"
    ? ["Overview", "Call for speakers", "Submissions", "Review", "Speakers", "Sessions", "Agenda", "Files"]
    : role === "reviewer" ? ["Assignments", "Completed"] : ["My proposals", "Profile", "Tasks", "Files"];
  return (
    <div className="app-shell">
      <aside className="side-nav">
        <Brand />
        <div className="event-switcher"><small>ACTIVE EVENT</small><strong>DevFlow Conf 2027</strong><span>May 12–14 · SFO</span></div>
        <nav aria-label={`${role} navigation`}>
          {nav.map((item, index) => <Link className={index === 0 ? "active" : ""} href={`/${role}`} key={item}>{item}</Link>)}
        </nav>
        <Link className="side-nav__public" href="/cfp/devflow-conf-2027">View public portal ↗</Link>
      </aside>
      <main className="workspace">{children}</main>
    </div>
  );
}

function OrganizerPage() {
  const [data, setData] = useState<{
    event: EventRecord;
    tracks: NamedRecord[];
    formats: NamedRecord[];
    submissions: SubmissionRecord[];
  } | null>(null);
  useEffect(() => {
    Promise.all([
      getJson<{ items: EventRecord[] }>("/api/events"),
      getJson<{ items: NamedRecord[] }>("/api/events/evt_devflow_conf_2027/tracks"),
      getJson<{ items: NamedRecord[] }>("/api/events/evt_devflow_conf_2027/formats"),
      getJson<{ items: SubmissionRecord[] }>("/api/events/evt_devflow_conf_2027/submissions"),
    ]).then(([eventData, trackData, formatData, submissionData]) => {
      const event = eventData.items[0];
      if (event !== undefined) setData({ event, tracks: trackData.items, formats: formatData.items, submissions: submissionData.items });
    }).catch(() => undefined);
  }, []);
  return (
    <RoleShell role="organizer">
      {data === null ? <LoadingState label="Loading organizer workspace" /> : (
        <>
          <header className="workspace-header"><div><p className="eyebrow">PROGRAM CONTROL / LIVE</p><h1>{data.event.name}</h1><p>{data.event.venue} · {data.event.timezone}</p></div><StatusChip tone="good">CFP open</StatusChip></header>
          <section className="metric-strip">
            <article><span>SUBMISSIONS</span><strong>{data.submissions.length}</strong><small>fixture proposals</small></article>
            <article><span>TRACKS</span><strong>{data.tracks.length}</strong><small>{data.tracks.map((item) => item.name).join(" · ")}</small></article>
            <article><span>FORMATS</span><strong>{data.formats.length}</strong><small>10–120 minutes</small></article>
            <article><span>DEADLINE</span><strong>APR 30</strong><small>2027 · 11:59 PM</small></article>
          </section>
          <section className="workspace-section">
            <div className="section-heading"><div><p className="section-label">CALL FOR SPEAKERS</p><h2>Submission pulse</h2></div><Link className="text-link" href="/cfp/devflow-conf-2027">Call for speakers →</Link></div>
            <DataTable
              caption="Seeded submissions"
              columns={[
                { key: "title", label: "Proposal", render: (row) => <strong>{row.title}</strong> },
                { key: "level", label: "Audience", render: (row) => row.audienceLevel ?? "TBD" },
                { key: "status", label: "Status", render: (row) => <StatusChip>{row.status.replace("_", " ")}</StatusChip> },
              ]}
              rows={data.submissions}
            />
          </section>
        </>
      )}
    </RoleShell>
  );
}

function ReviewerPage() {
  const [items, setItems] = useState<AssignmentRecord[] | null>(null);
  useEffect(() => { getJson<{ items: AssignmentRecord[] }>("/api/reviewer/assignments").then((data) => setItems(data.items)).catch(() => setItems([])); }, []);
  return (
    <RoleShell role="reviewer">
      <header className="workspace-header"><div><p className="eyebrow">REVIEW DESK / SAM WHITFIELD</p><h1>Your review queue</h1><p>Only explicitly assigned proposals appear here.</p></div>{items === null ? null : <StatusChip tone="signal">{items.length} assigned proposal</StatusChip>}</header>
      {items === null ? <LoadingState /> : (
        <section className="workspace-section">
          <DataTable caption="Review assignments" columns={[
            { key: "title", label: "Proposal", render: (row) => <strong>{row.title}</strong> },
            { key: "round", label: "Round", render: () => "Initial review" },
            { key: "status", label: "Status", render: (row) => <StatusChip>{row.status}</StatusChip> },
          ]} rows={items} />
        </section>
      )}
    </RoleShell>
  );
}

function SpeakerPage() {
  const [content, setContent] = useState<SpeakerContent | null>(null);
  useEffect(() => { getJson<SpeakerContent>("/api/speaker/content").then(setContent).catch(() => undefined); }, []);
  return (
    <RoleShell role="speaker">
      {content === null || content.profile === null ? <LoadingState label="Loading speaker portal" /> : (
        <>
          <header className="workspace-header"><div><p className="eyebrow">SPEAKER PORTAL / DEVFLOW 2027</p><h1>{content.profile.name}</h1><p>{content.profile.jobTitle} · {content.profile.organization}</p></div><StatusChip tone="signal">{content.profile.status}</StatusChip></header>
          <section className="split-workspace">
            <div className="workspace-section"><p className="section-label">MY PROPOSALS</p><DataTable caption="My proposals" columns={[
              { key: "title", label: "Proposal", render: (row) => <strong>{row.title}</strong> },
              { key: "status", label: "Status", render: (row) => <StatusChip>{row.status.replace("_", " ")}</StatusChip> },
            ]} rows={content.submissions} /></div>
            <div className="workspace-section"><p className="section-label">ONBOARDING TASKS</p><DataTable caption="My tasks" columns={[
              { key: "title", label: "Task", render: (row) => <strong>{row.title}</strong> },
              { key: "status", label: "Status", render: (row) => <StatusChip>{row.status.replace("_", " ")}</StatusChip> },
            ]} rows={content.tasks} /></div>
          </section>
        </>
      )}
    </RoleShell>
  );
}

function ProgramPage() {
  const [sessions, setSessions] = useState<PublicSessionRecord[] | null>(null);
  useEffect(() => {
    getJson<{ items: PublicSessionRecord[] }>("/api/public/events/evt_devflow_conf_2027/sessions")
      .then((data) => setSessions(data.items))
      .catch(() => setSessions([]));
  }, []);
  return (
    <div className="public-page">
      <PublicHeader />
      <main className="program-page">
        <header className="program-intro">
          <p className="eyebrow">PUBLIC PROGRAM / PREVIEW</p>
          <h1>DevFlow Conf 2027 program</h1>
          <p>Approved sessions publish from the same source of truth. Exact times may remain TBD while the run of show takes shape.</p>
        </header>
        {sessions === null ? <LoadingState label="Loading program" /> : (
          <section className="program-list" aria-label="Published sessions">
            {sessions.map((session, index) => (
              <article className="program-session" key={session.id}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <div>
                  <p>{session.track ?? "Track TBD"} · {session.format ?? "Format TBD"}</p>
                  <h2>{session.title}</h2>
                  <p>{session.abstract}</p>
                </div>
                <StatusChip tone="signal">{session.scheduledDate ?? "TBD"}</StatusChip>
              </article>
            ))}
          </section>
        )}
      </main>
    </div>
  );
}

export function App() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  if (path === "/login") return <LoginPage />;
  if (path.startsWith("/cfp/")) return <CfpSubmissionPage path={path} />;
  if (path.startsWith("/organizer")) return <OrganizerPage />;
  if (path.startsWith("/reviewer")) return <ReviewerPage />;
  if (path.startsWith("/speaker")) return <SpeakerPage />;
  if (path.startsWith("/program")) return <ProgramPage />;
  return <HomePage />;
}
