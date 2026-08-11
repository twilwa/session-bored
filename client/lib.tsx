// ABOUTME: Shared client chrome for same-origin navigation, fetch, and the public page header.
// ABOUTME: Single source of truth so public pages and the app shell interoperate without drift.
import { type FormEvent, type ReactNode, useEffect, useState } from "react";

type Role = "organizer" | "reviewer" | "speaker";

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: Role;
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

export function accountAreaFor(role: Role, hasPortalWork: boolean, hasProposals: boolean): AccountArea {
  if (role === "speaker" && !hasPortalWork && hasProposals) {
    return { href: "/submitter", label: "Submitter area" };
  }
  return roleAreas[role];
}

async function loadAccountArea(session: SessionPayload): Promise<AccountArea> {
  if (session.user.role !== "speaker") return accountAreaFor(session.user.role, false, false);

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
  return accountAreaFor(session.user.role, hasPortalWork, ownedSubmissions.items.length > 0);
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

export function PublicHeader({
  signedOutHref,
  navigationLinkPrefix,
}: {
  signedOutHref?: string;
  navigationLinkPrefix?: string;
} = {}) {
  const [account, setAccount] = useState<{ session: SessionPayload; area: AccountArea } | null>(null);
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
      const area = await loadAccountArea(session);
      if (active && resolution === currentResolution) setAccount({ session, area });
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
        <Link ariaLabel={navigationLinkPrefix === undefined ? undefined : `${navigationLinkPrefix} Speakers`} href="/speakers">Speakers</Link>
        <Link ariaLabel={navigationLinkPrefix === undefined ? undefined : `${navigationLinkPrefix} Gallery`} href="/gallery">Gallery</Link>
        {account === null ? (
          <Link className="nav-signin" href="/login">Sign in</Link>
        ) : (
          <>
            <span className="nav-identity">{account.session.user.name}</span>
            <Link className="nav-signin" href={account.area.href}>{account.area.label}</Link>
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
