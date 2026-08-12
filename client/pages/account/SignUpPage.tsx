// ABOUTME: The public front door: anyone can create an account, and it always lands on attendee.
// ABOUTME: States the outcome plainly, because no self-service path can produce anything more.
import { useState, type FormEvent } from "react";
import { Button, TextField, Toast } from "../../components/ui.tsx";
import { Link, PublicHeader, getJson, navigate, updatePublicSession, type SessionUser } from "../../lib.tsx";

interface SessionPayload {
  user: SessionUser;
}

export function SignUpPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/auth/sign-up/email", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });
      if (!response.ok) {
        const body = await response.json<{ message?: string }>().catch((): { message?: string } => ({}));
        throw new Error(body.message ?? "That account could not be created.");
      }
      const session = await getJson<SessionPayload>("/api/session");
      updatePublicSession(session.user);
      setMessage(`Welcome, ${session.user.name}.`);
      navigate("/schedule/mine");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "That account could not be created.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <PublicHeader />
      <main className="login-grid">
        <section className="login-intro">
          <p className="eyebrow">JOIN THE ROOM</p>
          <h1>Get a seat,<br />then a stage.</h1>
          <p>An account keeps your schedule and your proposals in one place. Everyone starts as an attendee.</p>
          <p className="login-intro__alt">
            Already have one? <Link href="/login">Sign in</Link>
          </p>
        </section>
        <form className="login-form" onSubmit={(event) => void submit(event)}>
          <h2>Create account</h2>
          <TextField autoComplete="name" label="Name" name="name" onChange={(event) => setName(event.target.value)} required value={name} />
          <TextField autoComplete="email" label="Email" name="email" onChange={(event) => setEmail(event.target.value)} required type="email" value={email} />
          <TextField autoComplete="new-password" label="Password" minLength={8} name="password" onChange={(event) => setPassword(event.target.value)} required type="password" value={password} />
          <Button disabled={busy} type="submit">{busy ? "Creating account…" : "Create account"}</Button>
          <p className="signup-outcome">
            You'll join as an <strong>attendee</strong>. An organizer grants speaker, reviewer, or organizer access.
          </p>
        </form>
      </main>
      <Toast message={message} />
    </div>
  );
}
