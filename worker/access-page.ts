// ABOUTME: Renders the HTML page a browser navigation gets when a workspace route is closed to it.
// ABOUTME: API and XHR callers keep the JSON error body; only document requests reach this shell.
import type { Role } from "../db/schema.ts";
import type { ApiAccess } from "../shared/api.ts";

/**
 * A document navigation asks for a page; fetch/XHR asks for data. `Sec-Fetch-Dest` states
 * which one it is on every modern browser, and the `Accept` header answers for the rest.
 */
export function prefersHtmlDocument(headers: Headers): boolean {
  const destination = headers.get("sec-fetch-dest");
  if (destination !== null) {
    return destination === "document";
  }
  return (headers.get("accept") ?? "").includes("text/html");
}

const workspaceNames: Record<Role, string> = {
  organizer: "organizer",
  reviewer: "reviewer",
  speaker: "speaker",
};

function escapeHtml(value: string): string {
  return value.replaceAll(/[&<>"']/g, (character) => {
    if (character === "&") return "&amp;";
    if (character === "<") return "&lt;";
    if (character === ">") return "&gt;";
    if (character === '"') return "&quot;";
    return "&#39;";
  });
}

function workspaceNameFor(access: ApiAccess): string {
  return access === "authenticated" || access === "public" ? "signed-in" : workspaceNames[access];
}

const pageStyles = `
:root { --ink: #141425; --paper: #f4f0e6; --white: #fffdf7; --signal: #c9ff4a; --blue: #3155ff; --muted: #6d6b74; }
* { box-sizing: border-box; }
html { min-width: 320px; }
body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; background: var(--paper); color: var(--ink); font-family: "Avenir Next", "Segoe UI", sans-serif; line-height: 1.5; }
a { color: inherit; }
:focus-visible { outline: 3px solid var(--blue); outline-offset: 3px; }
.bar { min-height: 76px; padding: 12px 5vw; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--ink); }
.brand { display: inline-flex; align-items: center; gap: 10px; font-family: Georgia, "Times New Roman", serif; font-size: 1.35rem; font-weight: 700; text-decoration: none; }
.brand span:first-child { color: var(--signal); font-size: 1.8rem; -webkit-text-stroke: 1px var(--ink); }
.bar nav { display: flex; flex-wrap: wrap; gap: clamp(14px, 3vw, 40px); font-size: 0.8rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
main { flex: 1; padding: clamp(44px, 8vw, 96px) 5vw; max-width: 900px; }
.eyebrow { margin: 0 0 16px; font-family: "SFMono-Regular", Consolas, monospace; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; }
h1 { margin: 0; font-family: Georgia, "Times New Roman", serif; font-size: clamp(2.6rem, 7vw, 5rem); font-weight: 400; line-height: 0.95; letter-spacing: -0.04em; }
h1 em { color: var(--blue); font-style: normal; }
.lede { margin: 28px 0; font-size: clamp(1rem, 1.6vw, 1.25rem); max-width: 60ch; }
code { display: inline-block; max-width: 100%; padding: 2px 6px; background: var(--white); border: 1px solid var(--ink); font-size: 0.9em; overflow-wrap: anywhere; }
.actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 8px; }
.button { min-height: 44px; display: inline-flex; align-items: center; justify-content: center; padding: 10px 18px; border: 1px solid var(--ink); background: var(--ink); color: var(--white); font-weight: 800; text-decoration: none; }
.button--signal { background: var(--signal); color: var(--ink); }
.button--quiet { background: transparent; color: var(--ink); }
.note { margin-top: 34px; color: var(--muted); font-size: 0.9rem; max-width: 60ch; }
footer { min-height: 44px; padding: 12px 5vw; display: flex; align-items: center; justify-content: center; border-top: 1px solid var(--ink); font: 0.68rem "SFMono-Regular", Consolas, monospace; letter-spacing: 0.1em; text-transform: uppercase; text-align: center; }
`;

/**
 * The page a person sees when a workspace route refuses them: what happened, and somewhere
 * to go from here. Never a bare status body, and never a silent redirect.
 */
export function accessDeniedDocument(denial: {
  status: 401 | 403;
  path: string;
  returnTo: string;
  requiredAccess: ApiAccess;
  user: { name: string; role: Role | null } | null;
}): string {
  const workspace = workspaceNameFor(denial.requiredAccess);
  const path = escapeHtml(denial.path);
  const signInHref = `/login?returnTo=${encodeURIComponent(denial.returnTo)}`;
  const ownWorkspace = denial.user?.role ?? null;
  const signedOut = denial.status === 401;

  const title = signedOut ? "Sign in to continue · Greenroom" : "That workspace isn't yours · Greenroom";
  const eyebrow = signedOut ? "401 · SIGN IN REQUIRED" : "403 · WRONG WORKSPACE";
  const heading = signedOut
    ? `Sign in to reach the <em>${escapeHtml(workspace)}</em> workspace.`
    : `That page belongs to the <em>${escapeHtml(workspace)}</em> workspace.`;
  const lede = signedOut
    ? `<code>${path}</code> is only open to a signed-in ${escapeHtml(workspace)} account. Sign in and we'll bring you straight back here.`
    : `You're signed in as ${escapeHtml(denial.user?.name ?? "another account")}${
      ownWorkspace === null ? "" : `, ${escapeHtml(workspaceNames[ownWorkspace])} on this event`
    }, so <code>${path}</code> stays closed to you.`;
  const actions = signedOut
    ? [
      `<a class="button button--signal" href="${signInHref}">Sign in</a>`,
      `<a class="button button--quiet" href="/">Back to Greenroom</a>`,
      `<a class="button button--quiet" href="/cfp/devflow-conf-2027">Call for speakers</a>`,
    ]
    : [
      ...ownWorkspace === null
        ? []
        : [`<a class="button button--signal" href="/${ownWorkspace}">Go to my ${escapeHtml(workspaceNames[ownWorkspace])} workspace</a>`],
      `<a class="button button--quiet" href="/program">Public program</a>`,
      `<a class="button button--quiet" href="${signInHref}">Sign in as someone else</a>`,
    ];
  const note = signedOut
    ? "Bookmarks keep working — sessions expire, accounts don't."
    : "Roles are per account. Signing in with the account that owns this area opens it.";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${pageStyles}</style>
</head>
<body>
<header class="bar">
<a class="brand" href="/"><span aria-hidden="true">●</span><span>Greenroom</span></a>
<nav aria-label="Greenroom navigation">
<a href="/program">Program</a>
<a href="/agenda">Agenda</a>
<a href="/speakers">Speakers</a>
<a href="${signInHref}">Sign in</a>
</nav>
</header>
<main>
<p class="eyebrow">${eyebrow}</p>
<h1>${heading}</h1>
<p class="lede">${lede}</p>
<div class="actions">${actions.join("")}</div>
<p class="note">${escapeHtml(note)}</p>
</main>
<footer>Greenroom / event operations at speaking speed</footer>
</body>
</html>`;
}
