// ABOUTME: Renders an attributed comment thread for an uploaded file across organizer and speaker views.
// ABOUTME: Uses the ownership-scoped content route so a speaker can only discuss their own upload.
import { useEffect, useState, type FormEvent } from "react";
import type { ContentComment } from "../../../shared/api.ts";
import { Button } from "../../components/ui.tsx";
import "./file-comments.css";

async function readJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  if (!response.ok) {
    const payload = await response.json<{ error?: string }>().catch(() => null);
    throw new Error(payload?.error ?? `Request failed (${response.status}).`);
  }
  return response.json<T>();
}

function formatCommentTime(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function FileComments({ eventId, fileId }: { eventId: string; fileId: string }) {
  const [items, setItems] = useState<ContentComment[]>([]);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(): Promise<void> {
    const payload = await readJson<{ items: ContentComment[] }>(
      `/api/content/files/${fileId}/comments?eventId=${encodeURIComponent(eventId)}`,
    );
    setItems(payload.items);
  }

  useEffect(() => {
    void load().catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : "Comments could not be loaded.");
    });
  }, [eventId, fileId]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (body.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await readJson(`/api/content/files/${fileId}/comments?eventId=${encodeURIComponent(eventId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      });
      setBody("");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Comment could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="file-comments">
      <summary>{items.length === 0 ? "Start a comment" : `${items.length} comment${items.length === 1 ? "" : "s"}`}</summary>
      <div className="file-comments__body">
        {error === null ? null : <p className="file-comments__error" role="alert">{error}</p>}
        {items.length === 0 ? <p className="quiet-copy">No comments yet.</p> : (
          <ol className="file-comments__thread">
            {items.map((comment) => (
              <li key={comment.id}>
                <div><strong>{comment.author.name}</strong><span>{comment.author.role}</span></div>
                <p>{comment.body}</p>
                <small>{formatCommentTime(comment.createdAt)}</small>
              </li>
            ))}
          </ol>
        )}
        <form className="file-comments__form" onSubmit={(event) => void submit(event)}>
          <label className="field">
            <span className="field__label">Add a comment</span>
            <textarea className="field__control" onChange={(event) => setBody(event.target.value)} required rows={3} value={body} />
          </label>
          <Button disabled={busy || body.trim().length === 0} type="submit">{busy ? "Posting…" : "Post comment"}</Button>
        </form>
      </div>
    </details>
  );
}
