// ABOUTME: The emailed reviewer invitation's one landing page for every account state.
// ABOUTME: One link upgrades an existing account or starts a sign-up, never a dead end.
import { useEffect, useState, type ReactNode } from "react";
import { Button, LoadingState, Toast } from "../../components/ui.tsx";
import { Link, PublicHeader, getJson, navigate, updatePublicSession, type SessionUser } from "../../lib.tsx";

interface InvitationInfo {
  status: "open" | "redeemed" | "revoked";
  event: { id: string; name: string };
}

interface InvitationSession {
  email: string;
  emailVerified: boolean;
}

export function InvitationPage({ inviteId }: { inviteId: string }) {
  const [invite, setInvite] = useState<InvitationInfo | null>(null);
  const [missing, setMissing] = useState(false);
  const [session, setSession] = useState<InvitationSession | "signed-out" | "loading">("loading");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const invitedEmail = new URLSearchParams(window.location.search).get("email");

  useEffect(() => {
    let active = true;
    getJson<InvitationInfo>(`/api/reviewer-invites/${inviteId}`)
      .then((info) => { if (active) setInvite(info); })
      .catch(() => { if (active) setMissing(true); });
    fetch("/api/session", { credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok || !active) return "signed-out" as const;
        const payload = await response.json<{ user: InvitationSession }>();
        return payload.user;
      })
      .then((account) => { if (active) setSession(account); })
      .catch(() => { if (active) setSession("signed-out"); });
    return () => { active = false; };
  }, [inviteId]);

  async function accept(): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/reviewer-invites/${inviteId}/accept`, {
        method: "POST",
        credentials: "same-origin",
      });
      if (response.ok) {
        const result = await response.json<{ accepted: boolean }>();
        if (!result.accepted) {
          setMessage("Reviewer access for this event is already open.");
          return;
        }
        // The grant union changed with this acceptance, so the session the header shows is stale.
        const refreshed = await getJson<{ user: SessionUser }>("/api/session");
        updatePublicSession(refreshed.user);
        navigate("/reviewer");
        return;
      }
      const body = await response.json<{ error?: string }>().catch(() => ({ error: undefined }));
      if (body.error === "email_unconfirmed") {
        setMessage("Confirm your address first - then open reviewer access from here.");
      } else if (body.error === "invite_email_mismatch") {
        setMessage("You are signed in as a different address than the one this invitation was sent to.");
      } else if (body.error === "invite_revoked") {
        setMessage("This invitation was withdrawn by the organizer.");
      } else {
        setMessage("This invitation could not be opened.");
      }
    } catch {
      setMessage("This invitation could not be opened.");
    } finally {
      setBusy(false);
    }
  }

  async function resendConfirmation(): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/auth/send-verification-email", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: session === "loading" || session === "signed-out" ? null : session.email }),
      });
      setMessage(response.ok
        ? "Confirmation email sent. Open it, then come back to this invitation."
        : "The confirmation email could not be sent. Try again in a moment.");
    } catch {
      setMessage("The confirmation email could not be sent. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  if (invite === null && !missing) {
    return (
      <div className="login-page">
        <PublicHeader />
        <main className="login-grid"><LoadingState label="Loading invitation" /></main>
        <Toast message={message} />
      </div>
    );
  }

  const eventName = invite?.event.name ?? "this event";

  let body: ReactNode;
  if (missing) {
    body = (
      <>
        <p className="hero__lede">
          This invitation no longer exists. It may have been withdrawn, or the link may be mistyped.
        </p>
        <p className="login-intro__alt"><Link href="/">Back to Greenroom</Link></p>
      </>
    );
  } else if (invite?.status === "revoked") {
    body = (
      <>
        <p className="hero__lede">This invitation was withdrawn by the organizer.</p>
        <p className="login-intro__alt"><Link href="/">Back to Greenroom</Link></p>
      </>
    );
  } else if (invite?.status === "redeemed") {
    body = (
      <>
        <p className="hero__lede">Reviewer access for {eventName} is already open.</p>
        <div className="hero__actions">
          <Link className="button button--signal" href="/reviewer">Go to the review workspace</Link>
        </div>
      </>
    );
  } else if (session === "loading") {
    body = <LoadingState label="Checking your account" />;
  } else if (session === "signed-out") {
    const signupHref = invitedEmail === null ? "/signup" : `/signup?email=${encodeURIComponent(invitedEmail)}`;
    body = (
      <>
        <p className="hero__lede">
          You've been invited to review proposals for {eventName}. Create an account using the invited
          address - reviewer access opens as soon as you confirm it.
        </p>
        <div className="hero__actions">
          <Link className="button button--signal" href={signupHref}>Create your account</Link>
          <Link className="button button--quiet" href="/login">Sign in</Link>
        </div>
        <p className="login-intro__alt">
          Already have an account? Sign in with the invited address, then open this invitation link again.
        </p>
      </>
    );
  } else if (invitedEmail !== null && session.email.trim().toLowerCase() !== invitedEmail.trim().toLowerCase()) {
    body = (
      <p className="hero__lede">
        This invitation was sent to {invitedEmail}. You are signed in as {session.email} - sign out and
        sign in with the invited address to accept it.
      </p>
    );
  } else if (!session.emailVerified) {
    body = (
      <>
        <p className="hero__lede">
          You're invited to review proposals for {eventName}. Confirm your address to open reviewer
          access from here.
        </p>
        <div className="hero__actions">
          <Button disabled={busy} onClick={() => void resendConfirmation()}>
            {busy ? "Sending…" : "Resend confirmation email"}
          </Button>
        </div>
        <p className="login-intro__alt">Once confirmed, open this invitation link again to start reviewing.</p>
      </>
    );
  } else {
    body = (
      <>
        <p className="hero__lede">
          You're invited to review proposals for {eventName}. Open reviewer access for your account now.
        </p>
        <div className="hero__actions">
          <Button disabled={busy} onClick={() => void accept()} tone="signal">
            {busy ? "Opening…" : "Open reviewer access"}
          </Button>
        </div>
      </>
    );
  }

  return (
    <div className="login-page">
      <PublicHeader />
      <main className="login-grid">
        <section className="login-intro">
          <p className="eyebrow">REVIEWER INVITATION</p>
          <h1>Join the<br /><em>review committee.</em></h1>
          {body}
        </section>
      </main>
      <Toast message={message} />
    </div>
  );
}
