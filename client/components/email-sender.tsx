// ABOUTME: Reports whether this deployment can send email and what to do when it cannot.
// ABOUTME: Names the missing Worker secrets, who can set them, and what happens to letters meanwhile.
import { useEffect, useState } from "react";
import type { EmailSenderStatus } from "../../shared/api.ts";
import { StatusChip } from "./ui.tsx";

const setupDocumentationUrl = "https://github.com/twilwa/session-bored#connecting-an-email-sender";

/**
 * Reads the deployment's sender configuration. Returns null while it is still
 * loading, so a surface never claims a disconnected sender before it knows.
 */
export function useEmailSenderStatus(): EmailSenderStatus | null {
  const [status, setStatus] = useState<EmailSenderStatus | null>(null);
  useEffect(() => {
    let active = true;
    void fetch("/api/email-sender", { credentials: "same-origin" })
      .then((response) => response.ok ? response.json<EmailSenderStatus>() : null)
      .then((payload) => {
        if (active && payload !== null) {
          setStatus(payload);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  return status;
}

export function EmailSenderChip({ status }: { status: EmailSenderStatus | null }) {
  if (status === null) {
    return null;
  }
  return status.connected
    ? <StatusChip tone="good">Email sender connected</StatusChip>
    : <StatusChip tone="signal">Email sender not connected</StatusChip>;
}

/** Renders each secret name in its own code span, joined so it reads as a sentence. */
function SecretNames({ secrets, prefix = "" }: { secrets: string[]; prefix?: string }) {
  return (
    <>
      {secrets.map((secret, index) => (
        <span key={secret}>
          {index === 0 ? "" : " and "}
          <code>{prefix}{secret}</code>
        </span>
      ))}
    </>
  );
}

/**
 * The alert an organizer sees when Greenroom cannot send. It names the missing
 * secrets, says plainly that they are set at deploy time rather than in the
 * app, gives the exact request to make of whoever operates this deployment,
 * and states what happens to recorded decisions in the meantime.
 */
export function EmailSenderNotice({ status }: { status: EmailSenderStatus | null }) {
  if (status === null) {
    return null;
  }
  if (status.connected) {
    return (
      <section aria-label="Email delivery status" className="email-sender-notice email-sender-notice--connected">
        <span aria-hidden="true" className="email-sender-notice__mark">✓</span>
        <div>
          <strong>Email sender connected</strong>
          <p>Greenroom can send. Nothing sends by itself: every message still leaves on one explicit click.</p>
        </div>
      </section>
    );
  }
  const secrets = status.missingSecrets.length === 0
    ? ["RESEND_API_KEY", "RESEND_FROM_ADDRESS"]
    : status.missingSecrets;
  return (
    <section aria-label="Email delivery status" className="email-sender-notice">
      <span aria-hidden="true" className="email-sender-notice__mark">!</span>
      <div>
        <strong>Email sender not connected</strong>
        <p>
          You can draft, edit, and preview messages, and decisions you record are still saved.
          Decision letters stay in Communications marked as waiting to send, and go out once a
          sender is connected. Nothing will send until then.
        </p>
        <dl className="email-sender-notice__recourse">
          <dt>What is missing</dt>
          <dd>
            The <SecretNames secrets={secrets} /> Worker {secrets.length === 1 ? "secret" : "secrets"}.
          </dd>
          <dt>Who can set it</dt>
          <dd>
            Whoever deploys this Greenroom. These are Cloudflare Worker secrets supplied at deploy
            time, not settings inside the app, so they cannot be entered on this page.
          </dd>
          <dt>What to ask for</dt>
          <dd>
            Ask your Greenroom administrator to run{" "}
            <SecretNames prefix="npx wrangler secret put " secrets={secrets} />{" "}
            against the Worker, then redeploy. Full steps are in{" "}
            <a href={setupDocumentationUrl} rel="noreferrer" target="_blank">Connecting an email sender</a>.
          </dd>
        </dl>
      </div>
    </section>
  );
}
