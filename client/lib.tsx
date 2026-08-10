// ABOUTME: Shared client chrome for same-origin navigation, fetch, and the public page header.
// ABOUTME: Single source of truth so public pages and the app shell interoperate without drift.
import { type FormEvent, type ReactNode, useEffect, useState } from "react";

export function navigate(path: string): void {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function Link({
  href,
  children,
  className = "",
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
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

export async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin" });
  if (!response.ok) {
    throw new Error(`${response.status}`);
  }
  return response.json<T>();
}

export function Brand() {
  return (
    <Link className="brand" href="/">
      <span aria-hidden="true" className="brand__light">●</span>
      <span>Greenroom</span>
    </Link>
  );
}

export function PublicHeader() {
  return (
    <header className="public-header">
      <Brand />
      <nav aria-label="Public navigation">
        <Link href="/cfp/devflow-conf-2027">Call for speakers</Link>
        <Link href="/program">Program</Link>
        <Link href="/speakers">Speakers</Link>
        <Link className="nav-signin" href="/login">Sign in</Link>
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
