// ABOUTME: Renders Greenroom's populated public and role-specific application shells.
// ABOUTME: Uses same-origin password sessions and client navigation without full-page reloads.
import { useEffect, useState, type FormEvent, type MouseEvent, type ReactNode } from "react";
import { Button, DataTable, LoadingState, Modal, StatusChip, TextField, Toast } from "./components/ui.tsx";
import { CfpPage as CfpSubmissionPage } from "./pages/cfp/CfpPage.tsx";
import { CfpBuilderPage } from "./pages/cfp-builder/CfpBuilderPage.tsx";
import { CommsPage } from "./pages/comms/CommsPage.tsx";
import { DispositionPage } from "./pages/disposition/DispositionPage.tsx";
import { AgendaPage } from "./pages/agenda/AgendaPage.tsx";
import { OrganizerReviewPage } from "./pages/review/OrganizerReviewPage.tsx";
import { ReviewerReviewPage } from "./pages/review/ReviewerReviewPage.tsx";
import { Link, PublicHeader, getJson, navigate, signedInDestination, type SessionUser } from "./lib.tsx";
import { AgendaPage as PublicAgendaPage } from "./pages/public/AgendaPage.tsx";
import { ItineraryPage } from "./pages/public/ItineraryPage.tsx";
import { PersonalSchedulePage } from "./pages/public/PersonalSchedulePage.tsx";
import { ProgramPage } from "./pages/public/ProgramPage.tsx";
import { SpeakerDetailPage } from "./pages/public/SpeakerDetailPage.tsx";
import { SpeakerGalleryPage } from "./pages/public/SpeakerGalleryPage.tsx";
import { SpeakersPage } from "./pages/public/SpeakersPage.tsx";
import { SubmitterDashboardPage } from "./pages/submitter/SubmitterDashboardPage.tsx";
import { RosterPage } from "./pages/roster/RosterPage.tsx";
import { PortalPage } from "./pages/portal/PortalPage.tsx";
import { formatFullDateTime } from "./pages/public/shared.ts";
import { ExportsPage } from "./pages/exports/ExportsPage.tsx";
import { ContentPage } from "./pages/content/ContentPage.tsx";
import { EmbedsPage } from "./pages/embeds/EmbedsPage.tsx";
import { EmbedFramePage } from "./pages/embeds/EmbedFramePage.tsx";
import { SignUpPage } from "./pages/account/SignUpPage.tsx";
import { InvitationPage } from "./pages/account/InvitationPage.tsx";
import { PeoplePage } from "./pages/people/PeoplePage.tsx";
import { EventSetupPage } from "./pages/event-setup/EventSetupPage.tsx";
import { eventSummary, type EventSetupRecord } from "./pages/event-setup/event-setup.ts";
import { SpeakerDirectoryPage } from "./pages/directory/SpeakerDirectoryPage.tsx";

type Role = "organizer" | "reviewer" | "speaker" | "attendee";
interface SessionPayload {
  user: SessionUser;
}
type EventRecord = EventSetupRecord;
interface NamedRecord { id: string; name: string }
interface SubmissionRecord { id: string; title: string | null; status: string; audienceLevel?: string | null }
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

function NotFoundPage() {
  return (
    <div className="public-page">
      <PublicHeader />
      <main className="hero">
        <div className="hero__copy">
          <p className="eyebrow">404 · PAGE NOT FOUND</p>
          <h1>This page isn’t<br /><em>in Greenroom.</em></h1>
          <p className="hero__lede">The address may be mistyped, or the page may have moved.</p>
          <div className="hero__actions">
            <Link className="button button--signal" href="/">Back to Greenroom</Link>
            <Link className="button button--quiet" href="/program">View the program</Link>
          </div>
        </div>
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
      navigate(signedInDestination(session.user, returnTo));
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
          <p className="login-form__note">No account yet? <Link href="/signup">Create one</Link>.</p>
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

function RoleShell({ role, children, event }: { role: Role; children: ReactNode; event?: EventSetupRecord | null }) {
  const [loadedEvent, setLoadedEvent] = useState<EventSetupRecord | null>(null);
  const activeEvent = event === undefined ? loadedEvent : event;
  const nav: Array<[string, string, string?]> = role === "organizer"
    ? [
      ["Overview", "/organizer"], ["Call for speakers", "/organizer/cfp"],
      ["Event setup", "/organizer/event"],
      ["Review", "/organizer/review"],
      ["Disposition", "/organizer/disposition"],
      ["Speaker directory", "/organizer/directory"],
      ["Speakers", "/organizer/roster"], ["Missing info", "/organizer/roster/missing"],
      ["Deliverables", "/organizer/content"],
      ["Agenda", "/organizer/agenda"],
      ["Communications", "/organizer/comms"],
      ["Exports", "/organizer/exports"],
      ["Embeds", "/organizer/embeds"],
      ["People", "/organizer/people"],
    ]
    : role === "reviewer"
      ? [["Assignments", "/reviewer"]]
      : [
        ["My proposals", "/speaker#proposals", "Submissions"],
        ["Profile", "/speaker#profile", "Bio and headshot"],
        ["Tasks", "/speaker#tasks", "Tasks and files"],
        ["Files", "/speaker#files", "File history"],
      ];

  useEffect(() => {
    if (role !== "organizer" || event !== undefined) return undefined;
    let active = true;
    const updateActiveEvent = (browserEvent: Event) => {
      setLoadedEvent((browserEvent as CustomEvent<EventSetupRecord>).detail);
    };
    window.addEventListener("greenroom:event-updated", updateActiveEvent);
    getJson<{ items: EventSetupRecord[] }>("/api/events")
      .then(({ items }) => {
        if (active) setLoadedEvent(items[0] ?? null);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      window.removeEventListener("greenroom:event-updated", updateActiveEvent);
    };
  }, [event, role]);

  function scrollToWorkspaceSection(event: MouseEvent<HTMLAnchorElement>, href: string, heading: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey) return;
    const section = [...document.querySelectorAll<HTMLElement>(".workspace-section")]
      .find((item) => item.querySelector("h2")?.textContent === heading);
    if (section === undefined) return;
    event.preventDefault();
    window.history.pushState({}, "", href);
    section.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <>
      <PublicHeader navigationLinkPrefix="Public" signedOutHref="/" />
      <div className="app-shell">
        <aside className="side-nav">
          <div className="event-switcher">
            <small>ACTIVE EVENT</small>
            <strong>{activeEvent?.name ?? "DevFlow Conf 2027"}</strong>
            <span>{activeEvent === null ? "May 12–14 · SFO" : eventSummary(activeEvent)}</span>
          </div>
          <nav aria-label={`${role} navigation`}>
            {nav.map(([label, href, heading]) => heading === undefined
              ? <Link className={window.location.pathname === href || (href.endsWith("/review") && window.location.pathname.startsWith(href)) ? "active" : ""} href={href} key={label}>{label}</Link>
              : <a href={href} key={label} onClick={(event) => scrollToWorkspaceSection(event, href, heading)}>{label}</a>)}
          </nav>
          <Link className="side-nav__public" href="/cfp/devflow-conf-2027">View call for speakers ↗</Link>
        </aside>
        <main className="workspace">{children}</main>
      </div>
    </>
  );
}

function OrganizerPage() {
  const [data, setData] = useState<{
    event: EventRecord;
    tracks: NamedRecord[];
    formats: NamedRecord[];
    submissions: SubmissionRecord[];
    cfp: CfpPayload;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  useEffect(() => {
    let active = true;
    setData(null);
    setError(null);
    Promise.all([
      getJson<{ items: EventRecord[] }>("/api/events"),
      getJson<{ items: NamedRecord[] }>("/api/events/evt_devflow_conf_2027/tracks"),
      getJson<{ items: NamedRecord[] }>("/api/events/evt_devflow_conf_2027/formats"),
      getJson<{ items: SubmissionRecord[] }>("/api/events/evt_devflow_conf_2027/submissions"),
      getJson<CfpPayload>("/api/public/cfp/devflow-conf-2027"),
    ]).then(([eventData, trackData, formatData, submissionData, cfp]) => {
      const event = eventData.items[0];
      if (active && event !== undefined) {
        setData({ event, tracks: trackData.items, formats: formatData.items, submissions: submissionData.items, cfp });
      }
    }).catch((caught: unknown) => {
      if (active) {
        const detail = caught instanceof Error && caught.message === "Request timed out. Try again."
          ? ` ${caught.message}`
          : "";
        setError(`Organizer workspace could not be loaded.${detail}`);
      }
    });
    return () => {
      active = false;
    };
  }, [retryToken]);
  const deadline = data?.cfp.form.closeAt === null || data?.cfp.form.closeAt === undefined
    ? "No deadline set"
    : formatFullDateTime(new Date(data.cfp.form.closeAt).getTime(), data.cfp.event.timezone);
  return (
    <RoleShell role="organizer" event={data?.event ?? null}>
      {data === null ? error === null ? <LoadingState label="Loading organizer workspace" /> : (
        <section className="state-card" role="alert">
          <p>{error}</p>
          <Button onClick={() => setRetryToken((token) => token + 1)} tone="signal">Try again</Button>
        </section>
      ) : (
        <>
          <header className="workspace-header"><div><p className="eyebrow">PROGRAM CONTROL / LIVE</p><h1>{data.event.name}</h1><p>{data.event.venue} · {data.event.timezone}</p></div><StatusChip tone="good">CFP open</StatusChip></header>
          <section className="metric-strip">
            <article><span>SUBMISSIONS</span><strong>{data.submissions.length}</strong><small>proposals received</small></article>
            <article><span>TRACKS</span><strong>{data.tracks.length}</strong><small>{data.tracks.map((item) => item.name).join(" · ")}</small></article>
            <article><span>FORMATS</span><strong>{data.formats.length}</strong><small>10–120 minutes</small></article>
            <article aria-label="CFP deadline"><span>DEADLINE</span><strong>{deadline}</strong><small>Event time · {data.cfp.event.timezone}</small></article>
          </section>
          <section className="workspace-section">
            <div className="section-heading"><div><p className="section-label">CALL FOR SPEAKERS</p><h2>Submission pulse</h2></div><Link className="text-link" href="/organizer/disposition">Disposition →</Link></div>
            <DataTable
              caption="Event submissions"
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

function WorkspaceNotFoundPage({ role }: { role: Role }) {
  const destination = role === "organizer" ? "organizer overview" : `${role} area`;
  return (
    <RoleShell role={role}>
      <section className="state-card">
        <p className="eyebrow">404 · PAGE NOT FOUND</p>
        <h1>This workspace page doesn’t exist.</h1>
        <p>The link may be out of date or the address may be mistyped.</p>
        <div className="hero__actions">
          <Link className="button button--signal" href={`/${role}`}>Back to {destination}</Link>
          <Link className="button button--quiet" href="/program">View the public program</Link>
        </div>
      </section>
    </RoleShell>
  );
}

function hasOnePathSegment(path: string, prefix: string): boolean {
  if (!path.startsWith(prefix)) return false;
  const segment = path.slice(prefix.length);
  return segment.length > 0 && !segment.includes("/");
}

function isCfpSubmissionPath(path: string): boolean {
  const segments = path.split("/").filter(Boolean);
  return segments[0] === "cfp" && (segments.length === 2
    || (segments.length === 4 && segments[2] === "submissions" && segments[3] !== ""));
}

function RoutedPage({ path }: { path: string }) {
  if (path === "/") return <HomePage />;
  if (path === "/login") return <LoginPage />;
  if (path === "/signup") return <SignUpPage />;
  if (hasOnePathSegment(path, "/invitations/")) {
    return <InvitationPage inviteId={path.split("/")[2] ?? ""} />;
  }
  if (isCfpSubmissionPath(path)) return <CfpSubmissionPage path={path} />;
  if (path === "/organizer/cfp") return <RoleShell role="organizer"><CfpBuilderPage /></RoleShell>;
  if (path === "/organizer/event") return <RoleShell role="organizer"><EventSetupPage /></RoleShell>;
  if (path === "/organizer/disposition") return <RoleShell role="organizer"><DispositionPage /></RoleShell>;
  if (path === "/organizer/agenda") return <RoleShell role="organizer"><AgendaPage /></RoleShell>;
  if (path === "/organizer/comms") return <RoleShell role="organizer"><CommsPage /></RoleShell>;
  if (path === "/organizer/exports") return <RoleShell role="organizer"><ExportsPage /></RoleShell>;
  if (path === "/organizer/embeds") return <RoleShell role="organizer"><EmbedsPage /></RoleShell>;
  if (path === "/organizer/people") return <RoleShell role="organizer"><PeoplePage /></RoleShell>;
  if (path === "/organizer/directory") return <RoleShell role="organizer"><SpeakerDirectoryPage /></RoleShell>;
  if (hasOnePathSegment(path, "/organizer/directory/")) {
    return <RoleShell role="organizer"><SpeakerDirectoryPage personId={path.split("/")[3]!} /></RoleShell>;
  }
  if (path === "/organizer/content") return <RoleShell role="organizer"><ContentPage /></RoleShell>;
  if (path === "/organizer/review" || path === "/organizer/review/setup" || hasOnePathSegment(path, "/organizer/review/submissions/")) {
    return <RoleShell role="organizer"><OrganizerReviewPage path={path} /></RoleShell>;
  }
  if (path === "/organizer/roster" || path === "/organizer/roster/missing" || path === "/organizer/roster/tasks") {
    return <RoleShell role="organizer"><RosterPage path={path} /></RoleShell>;
  }
  if (path === "/organizer") return <OrganizerPage />;
  if (path.startsWith("/organizer/")) return <WorkspaceNotFoundPage role="organizer" />;
  if (path === "/reviewer" || hasOnePathSegment(path, "/reviewer/submissions/")) {
    return <ReviewerPage path={path} />;
  }
  if (path.startsWith("/reviewer/")) return <WorkspaceNotFoundPage role="reviewer" />;
  if (path === "/program" || hasOnePathSegment(path, "/program/")) {
    const sessionId = path.split("/")[2];
    return <ProgramPage sessionId={sessionId} />;
  }
  if (path === "/speakers") return <SpeakersPage />;
  if (hasOnePathSegment(path, "/speakers/")) {
    const speakerId = path.split("/")[2] ?? "";
    return <SpeakerDetailPage speakerId={speakerId} />;
  }
  if (path === "/gallery") return <SpeakerGalleryPage />;
  if (path === "/agenda") return <PublicAgendaPage />;
  if (path === "/schedule/mine") return <PersonalSchedulePage />;
  if (path === "/schedule") return <ItineraryPage />;
  if (hasOnePathSegment(path, "/embed/")) return <EmbedFramePage publicToken={path.split("/")[2] ?? ""} />;
  if (path === "/speaker") return <RoleShell role="speaker"><PortalPage /></RoleShell>;
  if (path.startsWith("/speaker/")) return <WorkspaceNotFoundPage role="speaker" />;
  if (path === "/submitter") return <SubmitterDashboardPage />;
  return <NotFoundPage />;
}

export function App() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  return <RoutedPage key={path} path={path} />;
}
