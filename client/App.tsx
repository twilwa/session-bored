// ABOUTME: Renders Greenroom's populated public and role-specific application shells.
// ABOUTME: Uses same-origin password sessions and client navigation without full-page reloads.
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Button, DataTable, LoadingState, Modal, StatusChip, TextField, Toast } from "./components/ui.tsx";
import { CfpPage as CfpSubmissionPage } from "./pages/cfp/CfpPage.tsx";
import { DispositionPage } from "./pages/disposition/DispositionPage.tsx";
import { OrganizerReviewPage } from "./pages/review/OrganizerReviewPage.tsx";
import { ReviewerReviewPage } from "./pages/review/ReviewerReviewPage.tsx";
import { Brand, Link, PublicHeader, getJson, navigate } from "./lib.tsx";
import { ProgramPage } from "./pages/public/ProgramPage.tsx";
import { SpeakerDetailPage } from "./pages/public/SpeakerDetailPage.tsx";
import { SpeakersPage } from "./pages/public/SpeakersPage.tsx";
import { SubmitterDashboardPage } from "./pages/submitter/SubmitterDashboardPage.tsx";

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
      const returnTo = new URLSearchParams(window.location.search).get("returnTo");
      navigate(session.user.role === "speaker" && returnTo === "/submitter" ? returnTo : `/${session.user.role}`);
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
  const nav: Array<[string, string]> = role === "organizer"
    ? [
      ["Overview", "/organizer"], ["Call for speakers", "/organizer"],
      ["Submissions", "/organizer"], ["Review", "/organizer/review"],
      ["Speakers", "/organizer"], ["Sessions", "/organizer"],
      ["Agenda", "/organizer"], ["Files", "/organizer"],
    ]
    : role === "reviewer"
      ? [["Assignments", "/reviewer"], ["Completed", "/reviewer"]]
      : [["My proposals", "/speaker"], ["Profile", "/speaker"], ["Tasks", "/speaker"], ["Files", "/speaker"]];
  return (
    <div className="app-shell">
      <aside className="side-nav">
        <Brand />
        <div className="event-switcher"><small>ACTIVE EVENT</small><strong>DevFlow Conf 2027</strong><span>May 12–14 · SFO</span></div>
        <nav aria-label={`${role} navigation`}>
          {nav.map(([label, href]) => <Link className={window.location.pathname === href || (href.endsWith("/review") && window.location.pathname.startsWith(href)) ? "active" : ""} href={href} key={label}>{label}</Link>)}
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
            <div className="section-heading"><div><p className="section-label">CALL FOR SPEAKERS</p><h2>Submission pulse</h2></div><Link className="text-link" href="/organizer/disposition">Disposition →</Link></div>
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

function ReviewerPage({ path }: { path: string }) {
  return (
    <RoleShell role="reviewer">
      <ReviewerReviewPage path={path} />
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

export function App() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  if (path === "/login") return <LoginPage />;
  if (path.startsWith("/cfp/")) return <CfpSubmissionPage path={path} />;
  if (path === "/organizer/disposition") return <RoleShell role="organizer"><DispositionPage /></RoleShell>;
  if (path.startsWith("/organizer/review")) return <RoleShell role="organizer"><OrganizerReviewPage path={path} /></RoleShell>;
  if (path.startsWith("/organizer")) return <OrganizerPage />;
  if (path.startsWith("/reviewer")) return <ReviewerPage path={path} />;
  if (path === "/program" || path.startsWith("/program/")) {
    const sessionId = path.split("/")[2];
    return <ProgramPage sessionId={sessionId} />;
  }
  if (path === "/speakers") return <SpeakersPage />;
  if (path.startsWith("/speakers/")) {
    const speakerId = path.split("/")[2] ?? "";
    return <SpeakerDetailPage speakerId={speakerId} />;
  }
  if (path.startsWith("/speaker")) return <SpeakerPage />;
  if (path.startsWith("/submitter")) return <SubmitterDashboardPage />;
  return <HomePage />;
}
