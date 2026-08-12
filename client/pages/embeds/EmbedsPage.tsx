// ABOUTME: Lets organizers create public, self-updating widgets and copy each supported delivery format.
// ABOUTME: Mirrors the approved workspace builder while limiting configuration to one public track filter.
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type {
  EmbedListResponse,
  EmbedStatus,
  EmbedSummary,
  EmbedWidgetType,
  PublicSessionsResponse,
} from "../../../shared/api.ts";
import { Button, LoadingState, SelectField, StatusChip, TextField } from "../../components/ui.tsx";
import { getJson, requestJson } from "../../lib.tsx";
import { DEVFLOW_EVENT_ID } from "../public/shared.ts";
import "./embeds.css";

const widgetOptions: Array<{ value: EmbedWidgetType; label: string; description: string }> = [
  { value: "sessions", label: "Sessions list", description: "Published programme cards" },
  { value: "speakers", label: "Speakers list", description: "Directory with roles" },
  { value: "agenda", label: "Agenda", description: "Time × room grid" },
  { value: "itinerary", label: "Itinerary", description: "Day-by-day list" },
  { value: "gallery", label: "Speaker gallery", description: "Public profile grid" },
];

type DeliveryFormat = "script" | "iframe" | "json" | "ical";

function widgetLabel(type: EmbedWidgetType): string {
  return widgetOptions.find((option) => option.value === type)?.label ?? type;
}

function tokenLabel(token: string): string {
  return `${token.slice(0, 12)}…`;
}

export function EmbedsPage() {
  const [items, setItems] = useState<EmbedSummary[]>([]);
  const [tracks, setTracks] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [name, setName] = useState("");
  const [widgetType, setWidgetType] = useState<EmbedWidgetType>("sessions");
  const [status, setStatus] = useState<EmbedStatus>("draft");
  const [track, setTrack] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [selected, setSelected] = useState<EmbedSummary | null>(null);
  const [format, setFormat] = useState<DeliveryFormat>("script");
  const formRef = useRef<HTMLElement>(null);

  async function load(): Promise<void> {
    setLoading(true);
    setLoadError(false);
    try {
      const [embedData, publicData] = await Promise.all([
        getJson<EmbedListResponse>(`/api/events/${DEVFLOW_EVENT_ID}/embeds`),
        getJson<PublicSessionsResponse>(`/api/public/events/${DEVFLOW_EVENT_ID}/sessions`),
      ]);
      setItems(embedData.items);
      setTracks(publicData.facets.tracks);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const created = await requestJson<EmbedSummary>(`/api/events/${DEVFLOW_EVENT_ID}/embeds`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, widgetType, status, track }),
      });
      setItems((current) => [created, ...current]);
      setSelected(created);
      setFormat("script");
      setName("");
      setMessage(status === "published" ? "Embed published. Its snippet is ready." : "Draft saved. Publish it before sharing the token.");
    } catch {
      setMessage("The embed could not be saved. Check its name and track, then try again.");
    } finally {
      setSaving(false);
    }
  }

  const delivery = useMemo(() => {
    if (selected === null) return null;
    const origin = window.location.origin;
    const frameUrl = `${origin}/embed/${selected.publicToken}`;
    const scriptUrl = `${origin}/embed/${selected.publicToken}.js`;
    const jsonUrl = `${origin}/api/public/embeds/${selected.publicToken}.json`;
    const icalUrl = `${origin}/api/public/embeds/${selected.publicToken}.ics`;
    return {
      frameUrl,
      scriptUrl,
      jsonUrl,
      icalUrl,
      values: {
        script: `<script src="${scriptUrl}" async></script>\n<div id="greenroom-${selected.publicToken}"></div>`,
        iframe: `<iframe src="${frameUrl}" title="Greenroom ${selected.name}" width="100%" height="480" style="border:0"></iframe>`,
        json: jsonUrl,
        ical: icalUrl,
      },
    };
  }, [selected]);

  async function copyOutput(): Promise<void> {
    if (delivery === null) return;
    try {
      await navigator.clipboard.writeText(delivery.values[format]);
      setMessage("Copied to clipboard.");
    } catch {
      setMessage("Copy was unavailable. Select the output and copy it manually.");
    }
  }

  const publishedCount = items.filter((item) => item.status === "published").length;

  if (loading) return <LoadingState label="Loading embeds" />;
  if (loadError) {
    return (
      <section className="state-card" role="alert">
        <p>The embed builder could not be loaded.</p>
        <Button onClick={() => void load()} tone="signal">Try again</Button>
      </section>
    );
  }

  return (
    <div className="embeds-page">
      <header className="workspace-header embeds-page__intro">
        <div>
          <p className="eyebrow">DEVFLOW CONF 2027 / EMBEDS</p>
          <h1>Put the programme on your own site.</h1>
          <p>Every embed is public and self-updating. It shows only approved, published content—the same thing an anonymous visitor sees.</p>
        </div>
        <Button onClick={() => formRef.current?.scrollIntoView({ behavior: "smooth" })} tone="signal">+ New embed</Button>
      </header>

      <section className="workspace-section">
        <div className="section-heading">
          <h2>Live embeds</h2>
          <StatusChip tone={publishedCount > 0 ? "good" : "neutral"}>{publishedCount} published</StatusChip>
        </div>
        {items.length === 0 ? (
          <p className="embeds-page__empty">No embeds yet. Create one below and publish it when it is ready to share.</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table embed-list">
              <thead><tr><th>Name</th><th>Widget</th><th>Filters</th><th>Status</th><th>Token</th></tr></thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td><button className="embed-list__name" onClick={() => setSelected(item)} type="button">{item.name}</button></td>
                    <td>{widgetLabel(item.widgetType)}</td>
                    <td>{item.config?.track === undefined ? "All tracks" : `Track = ${item.config.track}`}</td>
                    <td><StatusChip tone={item.status === "published" ? "good" : "neutral"}>{item.status}</StatusChip></td>
                    <td><code>{tokenLabel(item.publicToken)}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="workspace-section" ref={formRef}>
        <div className="section-heading">
          <h2>New embed</h2>
          <StatusChip tone="signal">Nothing is visible until you publish</StatusChip>
        </div>
        <form onSubmit={(event) => void save(event)}>
          <fieldset className="embed-type-fieldset">
            <legend>Widget type</legend>
            <div className="embed-type-grid">
              {widgetOptions.map((option) => (
                <button
                  aria-pressed={widgetType === option.value}
                  className={widgetType === option.value ? "embed-type embed-type--selected" : "embed-type"}
                  key={option.value}
                  onClick={() => setWidgetType(option.value)}
                  type="button"
                >
                  <strong>{option.label}</strong>
                  <span>{option.description}</span>
                </button>
              ))}
            </div>
          </fieldset>
          <div className="embed-form-grid">
            <TextField hint="Only organizers see this name." label="Name" name="embed-name" onChange={(event) => setName(event.target.value)} required value={name} />
            <SelectField label="Status" name="embed-status" onChange={(event) => setStatus(event.target.value as EmbedStatus)} value={status}>
              <option value="draft">Draft</option>
              <option value="published">Published</option>
            </SelectField>
          </div>
          <div className="embed-filter-heading">
            <h3>Content filter</h3>
            <p>This reuses the public programme filter and can only narrow content that is already public.</p>
          </div>
          <SelectField label="Track" name="embed-track" onChange={(event) => setTrack(event.target.value)} value={track}>
            <option value="">All tracks</option>
            {tracks.map((trackName) => <option key={trackName} value={trackName}>{trackName}</option>)}
          </SelectField>
          <Button disabled={saving} tone="signal" type="submit">{saving ? "Saving…" : "Save embed"}</Button>
        </form>
      </section>

      {selected === null || delivery === null ? null : (
        <>
          <section className="workspace-section embed-output" aria-live="polite">
            <div className="section-heading">
              <h2>Copy your snippet</h2>
              <StatusChip tone={selected.status === "published" ? "good" : "neutral"}>
                {selected.status === "published" ? "Live · updates without re-embedding" : "Draft · public URLs return 404"}
              </StatusChip>
            </div>
            <div className="embed-format-tabs" role="tablist" aria-label="Embed delivery format">
              {(["script", "iframe", "json", "ical"] as const).map((value) => (
                <button aria-selected={format === value} key={value} onClick={() => setFormat(value)} role="tab" type="button">
                  {{ script: "Script tag", iframe: "iframe", json: "JSON", ical: "iCal" }[value]}
                </button>
              ))}
            </div>
            <pre className="embed-code"><code>{delivery.values[format]}</code></pre>
            <div className="embed-output__actions">
              <Button onClick={() => void copyOutput()} tone="signal">Copy</Button>
              <a className="button button--quiet" href={delivery.scriptUrl} rel="noreferrer" target="_blank">Open script</a>
              <a className="button button--quiet" href={delivery.frameUrl} rel="noreferrer" target="_blank">Open iframe preview</a>
            </div>
          </section>

          {selected.status === "published" ? (
            <section className="workspace-section">
              <div className="section-heading"><h2>Preview</h2><StatusChip>Exactly what a visitor gets</StatusChip></div>
              <iframe className="embed-preview" src={delivery.frameUrl} title={`Preview ${selected.name}`} />
            </section>
          ) : null}
        </>
      )}
      {message === null ? null : <p className="embed-message" role="status">{message}</p>}
    </div>
  );
}
