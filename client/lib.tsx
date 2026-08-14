// ABOUTME: Shared client chrome for same-origin navigation, fetch, and the public page header.
// ABOUTME: Single source of truth so public pages and the app shell interoperate without drift.
import { type FormEvent, type ReactNode, useEffect, useState } from "react";

type Role = "organizer" | "reviewer" | "speaker" | "attendee";

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  roles: Role[];
}

interface SessionPayload {
  user: SessionUser;
}

interface AccountArea {
  href: string;
  label: string;
}

const roleAreas: Record<Role, AccountArea> = {
  organizer: { href: "/organizer", label: "Organizer area" },
  reviewer: { href: "/reviewer", label: "Reviewer area" },
  speaker: { href: "/speaker", label: "Speaker area" },
  // An attendee has no workspace. Their own schedule is the thing an account gets them.
  attendee: { href: "/schedule/mine", label: "My schedule" },
};

const publicSessionEvent = "greenroom:public-session";

export function updatePublicSession(user: SessionUser | null): void {
  window.dispatchEvent(new CustomEvent<SessionUser | null>(publicSessionEvent, { detail: user }));
}

export function observePublicSession(listener: (user: SessionUser | null) => void): () => void {
  const handleSession = (event: Event) => listener((event as CustomEvent<SessionUser | null>).detail);
  window.addEventListener(publicSessionEvent, handleSession);
  return () => window.removeEventListener(publicSessionEvent, handleSession);
}

/**
 * An attendee always lands on their own schedule, whether or not they happen to own
 * proposals. A destination that moves with state the person cannot see is a surprise, and
 * reaching a schedule should cost nothing while reaching proposals is worth a deliberate
 * step. A speaker with proposals and no portal work still lands on their submitter
 * dashboard, which is the work their account is actually for.
 */
export function accountAreaFor(role: Role, hasPortalWork: boolean, hasProposals: boolean): AccountArea {
  if (role === "speaker" && !hasPortalWork && hasProposals) {
    return { href: "/submitter", label: "Submitter area" };
  }
  return roleAreas[role];
}

/**
 * The areas a person can switch between, read straight off the grant union so a later
 * grant appears here without anything naming it. One area is a destination rather than a
 * choice, so an account with a single area has nothing to switch to and gets no switcher.
 */
export function switchableAreasFor(roles: readonly Role[]): AccountArea[] {
  return roles.length > 1 ? roles.map((role) => roleAreas[role]) : [];
}

/**
 * The switcher lists the areas the grant union itself opens, so every live grant is
 * reachable and no option leads to a page the header cannot bring the person back from.
 * The submitter dashboard is not a granted area - every authenticated account reaches it -
 * so it stands in only where it always has: for an account whose one area is its landing.
 */
export function accountAreasFor(
  roles: readonly Role[],
  hasPortalWork: boolean,
  hasProposals: boolean,
): AccountArea[] {
  const switchable = switchableAreasFor(roles);
  if (switchable.length > 0) return switchable;
  const onlyRole = roles[0];
  return onlyRole === undefined ? [] : [accountAreaFor(onlyRole, hasPortalWork, hasProposals)];
}

function pathIsInsideArea(path: string, areaRoot: string): boolean {
  if (path === areaRoot) return true;
  if (!path.startsWith(areaRoot)) return false;
  return path.charAt(areaRoot.length) === "/";
}

const sameOriginBase = "https://greenroom.invalid";

/**
 * The return path is resolved before it is judged and returned in that resolved form, so
 * the area the check reads is the area the browser lands on. Every answer is a destination:
 * a reference that will not resolve at all, resolves off this origin, or resolves into an
 * area no live grant opens gives way to the predictable home rather than failing the sign-in.
 */
export function signedInDestination(
  account: Pick<SessionUser, "role" | "roles">,
  returnTo: string | null,
): string {
  const home = roleAreas[account.role].href;
  if (returnTo === null || !returnTo.startsWith("/")) return home;
  let target: URL;
  try {
    target = new URL(returnTo, sameOriginBase);
  } catch {
    return home;
  }
  if (target.origin !== sameOriginBase) return home;
  const reachableAreaRoots = ["/submitter", ...account.roles.map((role) => roleAreas[role].href)];
  if (!reachableAreaRoots.some((areaRoot) => pathIsInsideArea(target.pathname, areaRoot))) return home;
  return `${target.pathname}${target.search}${target.hash}`;
}

/**
 * Portal work and owned proposals move the area of exactly one account shape - the one
 * whose single grant is the speaker area - so only that shape pays for the two reads.
 */
async function loadAccountAreas(session: SessionPayload): Promise<AccountArea[]> {
  const roles = session.user.roles;
  if (roles.length !== 1 || roles[0] !== "speaker") {
    return accountAreasFor(roles, false, false);
  }

  const [speakerResponse, submissionResponse] = await Promise.all([
    fetch("/api/speaker/content", { credentials: "same-origin" }),
    fetch("/api/submitter/submissions", { credentials: "same-origin" }),
  ]);
  const speaker = speakerResponse.ok
    ? await speakerResponse.json<{ sessions: unknown[]; tasks: unknown[] }>()
    : { sessions: [], tasks: [] };
  const ownedSubmissions = submissionResponse.ok
    ? await submissionResponse.json<{ items: unknown[] }>()
    : { items: [] };
  const hasPortalWork = speaker.sessions.length > 0 || speaker.tasks.length > 0;
  return accountAreasFor(roles, hasPortalWork, ownedSubmissions.items.length > 0);
}

export function navigate(path: string): void {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function Link({
  href,
  children,
  className = "",
  ariaLabel,
}: {
  href: string;
  children: ReactNode;
  className?: string;
  ariaLabel?: string | undefined;
}) {
  return (
    <a
      aria-label={ariaLabel}
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

const requestTimeoutMs = 15_000;

export async function requestJson<T>(
  path: string,
  init: RequestInit = {},
  timeoutMs = requestTimeoutMs,
): Promise<T> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, {
      credentials: "same-origin",
      ...init,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`${response.status}`);
    }
    return response.json<T>();
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("Request timed out. Try again.");
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

export function getJson<T>(path: string, timeoutMs = requestTimeoutMs): Promise<T> {
  return requestJson<T>(path, {}, timeoutMs);
}

export function Brand() {
  return (
    <Link className="brand" href="/">
      <span aria-hidden="true" className="brand__light">●</span>
      <span>Greenroom</span>
    </Link>
  );
}

/**
 * A page outside every granted area selects the placeholder, never a real area: the
 * control must not claim a location the person is not at, and every area option has to
 * stay selectable so each one fires a real change and navigates.
 */
export function AreaSwitcher({ areas }: { areas: AccountArea[] }) {
  const currentAreaHref =
    areas.find((area) => pathIsInsideArea(window.location.pathname, area.href))?.href ?? "";
  return (
    <label className="nav-area-switcher">
      <span>Area</span>
      <select
        aria-label="Switch area"
        onChange={(event) => navigate(event.target.value)}
        value={currentAreaHref}
      >
        {currentAreaHref === "" && <option disabled value="">Go to...</option>}
        {areas.map((area) => (
          <option key={area.href} value={area.href}>{area.label}</option>
        ))}
      </select>
    </label>
  );
}

export function PublicHeader({
  signedOutHref,
  navigationLinkPrefix,
}: {
  signedOutHref?: string;
  navigationLinkPrefix?: string;
} = {}) {
  const [account, setAccount] = useState<{ session: SessionPayload; areas: AccountArea[] } | null>(null);
  const [navigationOpen, setNavigationOpen] = useState(false);

  useEffect(() => {
    let active = true;
    let resolution = 0;
    async function resolveAccount(user: SessionUser | null): Promise<void> {
      const currentResolution = ++resolution;
      if (user === null) {
        setAccount(null);
        return;
      }
      const session = { user };
      const areas = await loadAccountAreas(session);
      if (active && resolution === currentResolution) setAccount({ session, areas });
    }
    const stopObservingSession = observePublicSession((user) => void resolveAccount(user));
    fetch("/api/session", { credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) return null;
        return (await response.json<SessionPayload>()).user;
      })
      .then((user) => resolveAccount(user))
      .catch(() => undefined);
    return () => {
      active = false;
      stopObservingSession();
    };
  }, []);

  async function signOut(): Promise<void> {
    const response = await fetch("/api/auth/sign-out", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    if (response.ok) {
      updatePublicSession(null);
      if (signedOutHref !== undefined) navigate(signedOutHref);
    }
  }

  return (
    <header className="public-header">
      <Brand />
      <button
        aria-controls="public-navigation"
        aria-expanded={navigationOpen}
        aria-label={navigationOpen ? "Close navigation" : "Open navigation"}
        className="public-header__menu"
        onClick={() => setNavigationOpen((open) => !open)}
        type="button"
      >
        {navigationOpen ? "Close" : "Menu"}
      </button>
      <nav
        aria-label="Public navigation"
        className={navigationOpen ? "public-header__nav public-header__nav--open" : "public-header__nav"}
        id="public-navigation"
      >
        <Link ariaLabel={navigationLinkPrefix === undefined ? undefined : `${navigationLinkPrefix} Call for speakers`} href="/cfp/devflow-conf-2027">Call for speakers</Link>
        <Link ariaLabel={navigationLinkPrefix === undefined ? undefined : `${navigationLinkPrefix} Program`} href="/program">Program</Link>
        <Link ariaLabel={navigationLinkPrefix === undefined ? undefined : `${navigationLinkPrefix} Agenda`} href="/agenda">Agenda</Link>
        <Link ariaLabel={navigationLinkPrefix === undefined ? undefined : `${navigationLinkPrefix} Itinerary`} href="/schedule">Itinerary</Link>
        <Link ariaLabel={navigationLinkPrefix === undefined ? undefined : `${navigationLinkPrefix} My schedule`} href="/schedule/mine">My schedule</Link>
        <Link ariaLabel={navigationLinkPrefix === undefined ? undefined : `${navigationLinkPrefix} Speakers`} href="/speakers">Speakers</Link>
        <Link ariaLabel={navigationLinkPrefix === undefined ? undefined : `${navigationLinkPrefix} Gallery`} href="/gallery">Gallery</Link>
        {account === null ? (
          <>
            <Link href="/signup">Sign up</Link>
            <Link className="nav-signin" href="/login">Sign in</Link>
          </>
        ) : (
          <>
            <span className="nav-identity">{account.session.user.name}</span>
            {account.areas.length === 1 ? (
              <Link className="nav-signin" href={account.areas[0]!.href}>{account.areas[0]!.label}</Link>
            ) : (
              <AreaSwitcher areas={account.areas} />
            )}
            <button className="nav-signout" onClick={() => void signOut()} type="button">Sign out</button>
          </>
        )}
      </nav>
    </header>
  );
}

export function useAsync<T>(loader: () => Promise<T>, deps: ReadonlyArray<unknown>): {
  data: T | null;
  error: boolean;
  loading: boolean;
} {
  const [state, setState] = useState<{ data: T | null; error: boolean; loading: boolean }>({
    data: null,
    error: false,
    loading: true,
  });
  useEffect(() => {
    let active = true;
    setState((prev) => ({ ...prev, loading: true, error: false }));
    loader()
      .then((data) => {
        if (active) {
          setState({ data, error: false, loading: false });
        }
      })
      .catch(() => {
        if (active) {
          setState({ data: null, error: true, loading: false });
        }
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

export function preventDefault(handler: () => void): (event: FormEvent) => void {
  return (event) => {
    event.preventDefault();
    handler();
  };
}
