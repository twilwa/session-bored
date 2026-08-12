// ABOUTME: Offers Better Auth password account creation directly inside the public CFP portal.
// ABOUTME: Keeps anonymous submission available while explaining account-owned proposal tracking.
import { useState, type FormEvent } from "react";
import "./submitter.css";

export interface SubmitterAccountUser {
  id: string;
  name: string;
  email: string;
  role: "organizer" | "reviewer" | "speaker" | "attendee";
}

interface SessionPayload {
  user: SubmitterAccountUser;
}

export function SubmitterAccountPanel({
  user,
  onAuthenticated,
}: {
  user: SubmitterAccountUser | null;
  onAuthenticated: (user: SubmitterAccountUser) => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createAccount(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/sign-up/email", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });
      if (!response.ok) {
        const body = await response.json<{ message?: string }>().catch((): { message?: string } => ({}));
        throw new Error(body.message ?? "The account could not be created.");
      }
      const sessionResponse = await fetch("/api/session", { credentials: "same-origin" });
      if (!sessionResponse.ok) {
        throw new Error("The account was created, but the session could not be opened.");
      }
      const session = await sessionResponse.json<SessionPayload>();
      onAuthenticated(session.user);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The account could not be created.");
    } finally {
      setBusy(false);
    }
  }

  if (user !== null) {
    return (
      <section className="submitter-account submitter-account--active" aria-label="Submitter account">
        <div>
          <p className="section-label">TRACK THIS PROPOSAL</p>
          <h2>Signed in as {user.name}</h2>
          <p>New proposals using <strong>{user.email}</strong> appear on your private dashboard.</p>
        </div>
        <a className="button button--signal" href="/submitter">Open my proposals</a>
      </section>
    );
  }

  return (
    <section className="submitter-account" aria-labelledby="submitter-account-heading">
      <div className="submitter-account__intro">
        <p className="section-label">OPTIONAL ACCOUNT</p>
        <h2 id="submitter-account-heading">Keep every proposal in view.</h2>
        <p>Create a password account before submitting to track drafts and decisions in one private list.</p>
        <p className="submitter-account__anonymous">Prefer no account? Continue below. Anonymous drafts and private return links work exactly as before.</p>
        <a href="/login?returnTo=/submitter">Use an existing account</a>
      </div>
      <form onSubmit={(event) => void createAccount(event)}>
        <label htmlFor="submitter-account-name">Name</label>
        <input id="submitter-account-name" name="name" onChange={(event) => setName(event.target.value)} required value={name} />
        <label htmlFor="submitter-account-email">Account address</label>
        <input autoComplete="email" id="submitter-account-email" name="email" onChange={(event) => setEmail(event.target.value)} required type="email" value={email} />
        <label htmlFor="submitter-account-password">Password</label>
        <input autoComplete="new-password" id="submitter-account-password" minLength={8} name="password" onChange={(event) => setPassword(event.target.value)} required type="password" value={password} />
        <small>Use 8–128 characters. Password sign-in is always available.</small>
        {error === null ? null : <p className="submitter-account__error" role="alert">{error}</p>}
        <button className="button button--signal" disabled={busy} type="submit">
          {busy ? "Creating account…" : "Create tracking account"}
        </button>
      </form>
    </section>
  );
}
