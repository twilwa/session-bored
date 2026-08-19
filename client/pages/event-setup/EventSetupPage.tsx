// ABOUTME: Gives organizers one place to edit the active event's identity, timing, venue, and brand.
// ABOUTME: Saves through the organizer-only event route and previews the public visual treatment.
import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { Button, LoadingState, SelectField, TextField, Toast } from "../../components/ui.tsx";
import { getJson } from "../../lib.tsx";
import type {
  AgentCredentialRole,
  AgentCredentialsResponse,
  IssuedAgentCredentialResponse,
} from "../../../shared/api.ts";
import type { EventBranding, EventSetupRecord } from "./event-setup.ts";
import "./event-setup.css";

const defaultBranding: EventBranding = {
  primaryColor: "#3155FF",
  accentColor: "#C9FF4A",
};

const timezoneOptions = [
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "Europe/London",
  "Europe/Paris",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "UTC",
];

interface EventSetupError {
  error: string;
  fields?: Record<string, string>;
  message?: string;
  scheduleReviewRequired?: boolean;
}

function errorText(fields: Record<string, string>, name: string): React.ReactNode {
  const message = fields[name];
  return message === undefined ? null : <span className="event-setup__error" role="alert">{message}</span>;
}

export function EventSetupPage() {
  const [event, setEvent] = useState<EventSetupRecord | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState<"background" | "logo" | null>(null);
  const [credentials, setCredentials] = useState<AgentCredentialsResponse["items"]>([]);
  const [issuableRoles, setIssuableRoles] = useState<AgentCredentialRole[]>([]);
  const [credentialName, setCredentialName] = useState("");
  const [credentialRole, setCredentialRole] = useState<AgentCredentialRole>("organizer");
  const [issuedCredential, setIssuedCredential] = useState<{ id: string; token: string } | null>(null);
  const [credentialBusy, setCredentialBusy] = useState<string | null>(null);
  const [credentialError, setCredentialError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getJson<{ items: EventSetupRecord[] }>("/api/events")
      .then(({ items }) => {
        if (!active) return;
        const activeEvent = items[0];
        if (activeEvent === undefined) {
          setLoadError("No event is available to set up.");
        } else {
          setEvent({ ...activeEvent, branding: { ...defaultBranding, ...activeEvent.branding } });
        }
      })
      .catch(() => active && setLoadError("Event setup could not be loaded."));
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    getJson<AgentCredentialsResponse>("/api/agent-credentials")
      .then((response) => {
        if (!active) return;
        setCredentials(response.items);
        setIssuableRoles(response.issuableRoles);
        setCredentialRole(response.issuableRoles[0] ?? "organizer");
      })
      .catch(() => active && setCredentialError("Agent credentials could not be loaded."));
    return () => {
      active = false;
    };
  }, []);

  function update<K extends keyof EventSetupRecord>(key: K, value: EventSetupRecord[K]): void {
    setEvent((current) => current === null ? null : { ...current, [key]: value });
  }

  function updateBranding<K extends keyof EventBranding>(key: K, value: EventBranding[K]): void {
    setEvent((current) => current === null
      ? null
      : { ...current, branding: { ...defaultBranding, ...current.branding, [key]: value } });
  }

  async function save(formEvent: FormEvent<HTMLFormElement>): Promise<void> {
    formEvent.preventDefault();
    if (event === null) return;
    setBusy(true);
    setFields({});
    setMessage(null);
    try {
      const response = await fetch(`/api/events/${event.id}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
      });
      const body = await response.json<EventSetupRecord & EventSetupError>();
      if (!response.ok) {
        setFields(body.fields ?? {});
        setMessage(body.message ?? "Event setup could not be saved.");
        return;
      }
      const saved = body as EventSetupRecord;
      setEvent(saved);
      setMessage(body.scheduleReviewRequired
        ? "Event setup saved. Review and republish placed sessions after the timezone change."
        : "Event setup saved.");
      window.dispatchEvent(new CustomEvent("greenroom:event-updated", { detail: saved }));
    } catch {
      setMessage("Event setup could not be saved. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function uploadBrandImage(asset: "background" | "logo", file: File): Promise<void> {
    if (event === null) return;
    setUploading(asset);
    setMessage(null);
    const form = new FormData();
    form.set("file", file);
    try {
      const response = await fetch(`/api/events/${event.id}/branding/${asset}`, {
        method: "POST",
        credentials: "same-origin",
        body: form,
      });
      const body = await response.json<EventSetupRecord & { message?: string }>();
      if (!response.ok) {
        setMessage(body.message ?? "Brand image could not be uploaded.");
        return;
      }
      const urlField = asset === "logo" ? "logoUrl" : "backgroundImageUrl";
      setEvent((current) => current === null
        ? body
        : {
          ...current,
          branding: {
            ...defaultBranding,
            ...current.branding,
            [urlField]: body.branding?.[urlField],
          },
        });
      setMessage(`${asset === "logo" ? "Logo" : "Background"} image uploaded.`);
    } catch {
      setMessage("Brand image could not be uploaded. Check your connection and try again.");
    } finally {
      setUploading(null);
    }
  }

  async function issueCredential(formEvent: FormEvent<HTMLFormElement>): Promise<void> {
    formEvent.preventDefault();
    setCredentialBusy("issue");
    setCredentialError(null);
    setIssuedCredential(null);
    try {
      const response = await fetch("/api/agent-credentials", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: credentialName, role: credentialRole }),
      });
      const body = await response.json<IssuedAgentCredentialResponse & { error?: string }>();
      if (!response.ok) {
        setCredentialError(body.error === "issued_role_not_granted"
          ? "Your account no longer holds that role. Refresh and choose a live grant."
          : "The credential could not be issued.");
        return;
      }
      setCredentials((current) => [body.credential, ...current]);
      setCredentialName("");
      setIssuedCredential({ id: body.credential.id, token: body.token });
      setMessage("Agent credential issued. Copy the token now; Greenroom will not show it again.");
    } catch {
      setCredentialError("The credential could not be issued. Check your connection and try again.");
    } finally {
      setCredentialBusy(null);
    }
  }

  async function revokeCredential(credentialId: string): Promise<void> {
    setCredentialBusy(credentialId);
    setCredentialError(null);
    try {
      const response = await fetch(`/api/agent-credentials/${credentialId}/revoke`, {
        method: "POST",
        credentials: "same-origin",
      });
      const body = await response.json<{ credential?: AgentCredentialsResponse["items"][number] }>();
      if (!response.ok || body.credential === undefined) {
        setCredentialError("The credential could not be revoked.");
        return;
      }
      setCredentials((current) => current.map((credential) => (
        credential.id === credentialId ? body.credential! : credential
      )));
      if (issuedCredential?.id === credentialId) {
        setIssuedCredential(null);
      }
      setMessage("Agent credential revoked.");
    } catch {
      setCredentialError("The credential could not be revoked. Check your connection and try again.");
    } finally {
      setCredentialBusy(null);
    }
  }

  if (loadError !== null) return <section className="state-card" role="alert"><p>{loadError}</p></section>;
  if (event === null) return <LoadingState label="Loading event setup" />;
  const branding = { ...defaultBranding, ...event.branding };
  const previewStyle = {
    "--event-primary": branding.primaryColor,
    "--event-accent": branding.accentColor,
    backgroundImage: branding.backgroundImageUrl === undefined ? undefined : `url(${branding.backgroundImageUrl})`,
  } as CSSProperties;

  return (
    <section className="event-setup-page">
      <header className="workspace-header event-setup-page__header">
        <div>
          <p className="eyebrow">EVENT SETTINGS / IDENTITY</p>
          <h1>Event setup</h1>
          <p>Set the details every organizer and schedule surface should agree on.</p>
        </div>
      </header>

      <form className="event-setup" onSubmit={(formEvent) => void save(formEvent)}>
        <div className="event-setup__fields">
          <section className="workspace-section">
            <div className="section-heading"><div><p className="section-label">EVENT DETAILS</p><h2>Identity</h2></div></div>
            <div className="event-setup__grid">
              <div>
                <TextField aria-invalid={fields.name === undefined ? undefined : true} label="Event name" name="event-name" onChange={(input) => update("name", input.target.value)} required value={event.name} />
                {errorText(fields, "name")}
              </div>
              <div>
                <TextField aria-invalid={fields.slug === undefined ? undefined : true} hint="Lowercase letters, numbers, and hyphens." label="Public slug" name="event-slug" onChange={(input) => update("slug", input.target.value)} required value={event.slug} />
                {errorText(fields, "slug")}
              </div>
              <TextField label="Tagline" name="event-tagline" onChange={(input) => update("tagline", input.target.value)} value={event.tagline ?? ""} />
              <TextField label="Venue" name="event-venue" onChange={(input) => update("venue", input.target.value)} value={event.venue ?? ""} />
              <label className="field event-setup__wide" htmlFor="event-description">
                <span className="field__label">Description</span>
                <textarea className="field__control" id="event-description" onChange={(input) => update("description", input.target.value)} rows={5} value={event.description ?? ""} />
              </label>
            </div>
          </section>

          <section className="workspace-section">
            <div className="section-heading"><div><p className="section-label">EVENT TIME</p><h2>Dates and timezone</h2></div></div>
            <div className="event-setup__grid event-setup__grid--three">
              <div>
                <TextField aria-invalid={fields.startDate === undefined ? undefined : true} label="Start date" name="event-start-date" onChange={(input) => update("startDate", input.target.value)} required type="date" value={event.startDate ?? ""} />
                {errorText(fields, "startDate")}
              </div>
              <div>
                <TextField aria-invalid={fields.endDate === undefined ? undefined : true} label="End date" name="event-end-date" onChange={(input) => update("endDate", input.target.value)} required type="date" value={event.endDate ?? ""} />
                {errorText(fields, "endDate")}
              </div>
              <div>
                <SelectField aria-invalid={fields.timezone === undefined ? undefined : true} label="Timezone" name="event-timezone" onChange={(input) => update("timezone", input.target.value)} value={event.timezone}>
                  {[...new Set([event.timezone, ...timezoneOptions])].map((timezone) => <option key={timezone} value={timezone}>{timezone}</option>)}
                </SelectField>
                {errorText(fields, "timezone")}
              </div>
            </div>
            <p className="event-setup__note">Agenda entry, public schedule times, and deadline copy all render in this timezone.</p>
          </section>

          <section className="workspace-section">
            <div className="section-heading"><div><p className="section-label">PUBLIC BRAND</p><h2>Colors and imagery</h2></div></div>
            <div className="event-setup__grid">
              <div>
                <TextField aria-invalid={fields["branding.primaryColor"] === undefined ? undefined : true} label="Primary color" name="event-primary-color" onChange={(input) => updateBranding("primaryColor", input.target.value)} type="color" value={branding.primaryColor} />
                {errorText(fields, "branding.primaryColor")}
              </div>
              <div>
                <TextField aria-invalid={fields["branding.accentColor"] === undefined ? undefined : true} label="Accent color" name="event-accent-color" onChange={(input) => updateBranding("accentColor", input.target.value)} type="color" value={branding.accentColor} />
                {errorText(fields, "branding.accentColor")}
              </div>
              <div>
                <TextField aria-invalid={fields["branding.logoUrl"] === undefined ? undefined : true} inputMode="url" label="Logo image URL" name="event-logo-url" onChange={(input) => updateBranding("logoUrl", input.target.value)} placeholder="https://…" value={branding.logoUrl ?? ""} />
                {errorText(fields, "branding.logoUrl")}
                <label className="event-setup__upload" htmlFor="event-logo-upload">
                  <span>Upload logo image</span>
                  <input
                    accept=".jpg,.jpeg,.png,.webp"
                    disabled={uploading !== null}
                    id="event-logo-upload"
                    onChange={(input) => {
                      const file = input.target.files?.[0];
                      if (file !== undefined) void uploadBrandImage("logo", file);
                    }}
                    type="file"
                  />
                </label>
              </div>
              <div>
                <TextField aria-invalid={fields["branding.backgroundImageUrl"] === undefined ? undefined : true} inputMode="url" label="Background image URL" name="event-background-url" onChange={(input) => updateBranding("backgroundImageUrl", input.target.value)} placeholder="https://…" value={branding.backgroundImageUrl ?? ""} />
                {errorText(fields, "branding.backgroundImageUrl")}
                <label className="event-setup__upload" htmlFor="event-background-upload">
                  <span>Upload background image</span>
                  <input
                    accept=".jpg,.jpeg,.png,.webp"
                    disabled={uploading !== null}
                    id="event-background-upload"
                    onChange={(input) => {
                      const file = input.target.files?.[0];
                      if (file !== undefined) void uploadBrandImage("background", file);
                    }}
                    type="file"
                  />
                </label>
              </div>
            </div>
          </section>
        </div>

        <aside className="event-setup__preview-column">
          <div className="event-brand-preview" style={previewStyle}>
            <div className="event-brand-preview__scrim">
              {branding.logoUrl === undefined || branding.logoUrl === ""
                ? <span className="event-brand-preview__mark" aria-hidden="true">{event.name.slice(0, 2).toUpperCase()}</span>
                : <img alt={`${event.name} logo preview`} src={branding.logoUrl} />}
              <p>CALL FOR SPEAKERS</p>
              <h2>{event.name}</h2>
              <span>{event.tagline || "Your event tagline appears here."}</span>
            </div>
          </div>
          <Button disabled={busy || uploading !== null} type="submit">{busy ? "Saving…" : "Save event"}</Button>
          <p className="event-setup__note">This preview uses the same saved brand values delivered with the event.</p>
        </aside>
      </form>

      <section aria-labelledby="agent-access-heading" className="workspace-section agent-access">
        <div className="section-heading">
          <div>
            <p className="section-label">DELEGATED OPERATIONS</p>
            <h2 id="agent-access-heading">Agent access</h2>
          </div>
          <a href="/llms.txt">Read the agent guide</a>
        </div>
        <p>
          Issue a revocable credential instead of sharing your password. Each credential acts as
          your account through one live role; programme publishing, sends, decisions, and deletes still require you here.
        </p>

        <form className="agent-access__issue" onSubmit={(formEvent) => void issueCredential(formEvent)}>
          <TextField
            label="Credential name"
            name="agent-credential-name"
            onChange={(input) => setCredentialName(input.target.value)}
            placeholder="CFP operations"
            required
            value={credentialName}
          />
          <SelectField
            label="Issued role"
            name="agent-credential-role"
            onChange={(input) => setCredentialRole(input.target.value as AgentCredentialRole)}
            value={credentialRole}
          >
            {issuableRoles.map((role) => (
              <option key={role} value={role}>{role[0]!.toUpperCase() + role.slice(1)}</option>
            ))}
          </SelectField>
          <Button disabled={credentialBusy !== null || issuableRoles.length === 0} type="submit">
            {credentialBusy === "issue" ? "Issuing…" : "Issue credential"}
          </Button>
        </form>

        {issuedCredential === null ? null : (
          <div className="agent-access__token">
            <div>
              <strong>Copy this token now</strong>
              <p>It is shown once and cannot be recovered later.</p>
            </div>
            <label className="field" htmlFor="issued-agent-token">
              <span className="field__label">Issued agent token</span>
              <input
                className="field__control"
                id="issued-agent-token"
                readOnly
                value={issuedCredential.token}
              />
            </label>
            <Button
              onClick={() => void navigator.clipboard.writeText(issuedCredential.token).then(
                () => setMessage("Agent token copied."),
                () => setMessage("Copy failed. Select the token and copy it manually."),
              )}
              tone="quiet"
              type="button"
            >
              Copy token
            </Button>
          </div>
        )}

        {credentialError === null ? null : <p className="agent-access__error" role="alert">{credentialError}</p>}
        {credentials.length === 0 ? (
          <p className="event-setup__note">No agent credentials have been issued.</p>
        ) : (
          <ul className="agent-access__list">
            {credentials.map((credential) => (
              <li key={credential.id}>
                <div>
                  <strong>{credential.name}</strong>
                  <span>{credential.role[0]!.toUpperCase() + credential.role.slice(1)}</span>
                  <small>
                    {credential.revokedAt !== null
                      ? "Revoked"
                      : !credential.active
                        ? "Inactive · role access revoked"
                        : credential.lastUsedAt === null ? "Active · never used" : "Active · used"}
                  </small>
                </div>
                {credential.revokedAt === null ? (
                  <Button
                    aria-label={`Revoke ${credential.name}`}
                    disabled={credentialBusy !== null}
                    onClick={() => void revokeCredential(credential.id)}
                    tone="quiet"
                    type="button"
                  >
                    {credentialBusy === credential.id ? "Revoking…" : "Revoke"}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      <Toast message={message} />
    </section>
  );
}
