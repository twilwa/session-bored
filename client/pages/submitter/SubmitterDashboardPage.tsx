// ABOUTME: Renders the signed-in submitter's account-owned proposals and communicated decisions.
// ABOUTME: Links each owned proposal back to the shared CFP edit flow without private keys.
import { useEffect, useState } from "react";
import type { SubmitterSubmissionSummary } from "../../../shared/api.ts";
import "./submitter.css";

interface SubmitterListPayload {
  items: SubmitterSubmissionSummary[];
}

interface SignedInAccount {
  name: string;
  email: string;
}

function statusLabel(status: SubmitterSubmissionSummary["status"]): string {
  return status.replace("_", " ");
}

export function SubmitterDashboardPage() {
  const [items, setItems] = useState<SubmitterSubmissionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [account, setAccount] = useState<SignedInAccount | null>(null);

  useEffect(() => {
    fetch("/api/session", { credentials: "same-origin" })
      .then(async (response) => (response.ok ? (await response.json<{ user: SignedInAccount }>()).user : null))
      .then((user) => setAccount(user))
      .catch(() => setAccount(null));
  }, []);

  async function signOut(): Promise<void> {
    const response = await fetch("/api/auth/sign-out", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    if (response.ok) {
      window.location.assign("/");
    }
  }

  useEffect(() => {
    fetch("/api/submitter/submissions", { credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(response.status === 401
            ? "Sign in to view your proposals."
            : "Your proposals could not be loaded.");
        }
        return response.json<SubmitterListPayload>();
      })
      .then((payload) => setItems(payload.items))
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Your proposals could not be loaded."));
  }, []);

  return (
    <div className="submitter-dashboard">
      <header className="submitter-dashboard__nav">
        <a className="brand" href="/"><span aria-hidden="true" className="brand__light">●</span><span>Greenroom</span></a>
        <nav aria-label="Submitter navigation">
          <a href="/cfp/devflow-conf-2027">New proposal</a>
          {account === null ? <a href="/login?returnTo=/submitter">Sign in</a> : (
            <>
              <span className="submitter-dashboard__identity" title={account.email}>{account.name}</span>
              <a href="/login?returnTo=/submitter">Switch account</a>
              <button onClick={() => void signOut()} type="button">Sign out</button>
            </>
          )}
        </nav>
      </header>
      <main>
        <header className="submitter-dashboard__heading">
          <div>
            <p className="eyebrow">SUBMITTER DASHBOARD</p>
            <h1>Your proposals.<br /><em>Clearly tracked.</em></h1>
          </div>
          <p>Committee decisions appear here after the decision letter is sent. Viewing this page never sends a notification.</p>
        </header>

        {error === null ? null : (
          <section className="submitter-dashboard__state" role="alert">
            <p>{error}</p><a className="button button--signal" href="/login?returnTo=/submitter">Sign in</a>
          </section>
        )}
        {items === null && error === null ? <p className="submitter-dashboard__state" aria-label="Loading proposals">Loading your proposals…</p> : null}
        {items?.length === 0 ? (
          <section className="submitter-dashboard__state">
            <h2>No account-owned proposals yet.</h2>
            <p>Anonymous proposals stay available through their private return links and are never claimed by email.</p>
            <a className="button button--signal" href="/cfp/devflow-conf-2027">Start a proposal</a>
          </section>
        ) : null}
        {items === null || items.length === 0 ? null : (
          <section className="submitter-proposals" aria-label="Your proposals">
            {items.map((item, index) => (
              <article key={item.id}>
                <span className="submitter-proposals__number">{String(index + 1).padStart(2, "0")}</span>
                <div>
                  <p>{item.isDraft ? "Draft" : "Submitted"} · {item.id}</p>
                  <h2><a href={`/cfp/${item.formSlug}/submissions/${item.id}`}>{item.title ?? "Untitled proposal"}</a></h2>
                  <small>Updated {new Date(item.updatedAt).toLocaleString()}</small>
                </div>
                <span className={`submitter-proposals__status submitter-proposals__status--${item.status}`}>
                  {statusLabel(item.status)}
                </span>
              </article>
            ))}
          </section>
        )}
      </main>
    </div>
  );
}
