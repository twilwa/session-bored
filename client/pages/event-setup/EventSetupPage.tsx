// ABOUTME: Gives organizers one place to edit the active event's identity, timing, venue, and brand.
// ABOUTME: Saves through the organizer-only event route and previews the public visual treatment.
import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { Button, LoadingState, SelectField, TextField, Toast } from "../../components/ui.tsx";
import { getJson } from "../../lib.tsx";
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
              <TextField label="Venue" name="event-venue" onChange={(input) => update("venue", input.target.value)} required value={event.venue ?? ""} />
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
      <Toast message={message} />
    </section>
  );
}
