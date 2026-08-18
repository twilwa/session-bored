// ABOUTME: Lets a signed-in speaker manage their own bio, headshot, sessions, tasks, and files.
// ABOUTME: Every mutation writes through the shared speaker/session/task records the organizer reads.
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  fileRequestKindOf,
  speakerFacingSubmissionLabels,
  type PortalSession,
  type PortalTask,
  type SpeakerContentPayload,
} from "../../../shared/api.ts";
import { Button, DataTable, LoadingState, StatusChip, TextField, Toast } from "../../components/ui.tsx";
import { Headshot } from "../../components/Headshot.tsx";
import "./portal.css";
import { FileComments } from "../content/FileComments.tsx";
import { FileVersionList, formatFileSize } from "../content/FileVersionList.tsx";

const eventId = "evt_devflow_conf_2027";

function eventScopedPath(path: string): string {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}eventId=${encodeURIComponent(eventId)}`;
}

async function readJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  if (!response.ok) {
    const body = await response.json<{ message?: string; error?: string }>().catch(() => null);
    throw new Error(body?.message ?? body?.error ?? `Request failed (${response.status}).`);
  }
  return response.json<T>();
}

async function uploadFile<T = unknown>(path: string, file: File, fields?: Record<string, string>): Promise<T> {
  const formData = new FormData();
  formData.append("file", file);
  for (const [name, value] of Object.entries(fields ?? {})) {
    formData.append(name, value);
  }
  const response = await fetch(path, { method: "POST", credentials: "same-origin", body: formData });
  if (!response.ok) {
    const body = await response.json<{ message?: string; error?: string }>().catch(() => null);
    throw new Error(body?.message ?? body?.error ?? `Upload failed (${response.status}).`);
  }
  return response.json<T>();
}

function formatDueDate(dueAt: string | null): string {
  if (dueAt === null) return "No due date";
  return `Due ${new Date(dueAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
}

// The server resolves what a request accepts and answers with it, so the hint a speaker
// reads is the same list the upload is judged against.
function uploadRules(task: PortalTask): string | null {
  if (task.taskType !== "file_request" || task.acceptedFileTypes === null || task.maximumFileBytes === null) {
    return null;
  }
  return `Accepted: ${task.acceptedFileTypes.join(", ")} · up to ${formatFileSize(task.maximumFileBytes)}`;
}

function appliesAsPublicHeadshot(task: PortalTask): boolean {
  return task.taskType === "file_request" && fileRequestKindOf(task.acceptedFileTypes) === "picture";
}

function TaskRow({ task, onComplete, onUpload, busy }: {
  task: PortalTask;
  onComplete: (taskId: string) => void;
  onUpload: (taskId: string, file: File, displayedRequestKind: "document" | "picture") => void;
  busy: boolean;
}) {
  const done = task.status === "completed";
  const appliesToHeadshot = appliesAsPublicHeadshot(task);
  return (
    <li className={`task-row${done ? " task-row--done" : ""}`}>
      <div className="task-row__info">
        <strong>{task.title}</strong>
        {task.instructions === null ? null : <p>{task.instructions}</p>}
        {appliesToHeadshot ? <p>This picture will become your public profile photo.</p> : null}
        <small>{formatDueDate(task.dueAt)}</small>
      </div>
      <div className="task-row__action">
        <StatusChip tone={done ? "good" : "neutral"}>{task.status.replaceAll("_", " ")}</StatusChip>
        {task.taskType === "file_request" ? (
          <div className="task-row__upload">
            <label className="file-picker">
              <span>{task.file === null ? "Upload file" : "Replace file"}</span>
              <input
                accept={task.acceptedFileTypes === null ? undefined : task.acceptedFileTypes.map((type) => `.${type}`).join(",")}
                disabled={busy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file !== undefined) onUpload(task.id, file, appliesToHeadshot ? "picture" : "document");
                  event.target.value = "";
                }}
                type="file"
              />
            </label>
            {appliesToHeadshot ? <small>Uploading will replace your public profile photo.</small> : null}
            <small className="task-row__rules">{uploadRules(task)}</small>
          </div>
        ) : (
          <Button disabled={busy || done} onClick={() => onComplete(task.id)} tone="quiet">
            {done ? "Completed" : "Mark complete"}
          </Button>
        )}
      </div>
      {task.file === null ? null : (
        <p className="task-row__file">
          <a href={eventScopedPath(`/api/portal/files/${task.file.fileId}`)}>{task.file.displayName}</a>
          <span>{task.file.supersededByMerge ? "Superseded — merged" : `v${task.file.version}`}</span>
        </p>
      )}
    </li>
  );
}

function SessionCard({ session, onSave, busy }: {
  session: PortalSession;
  onSave: (sessionId: string, title: string, abstract: string) => Promise<void>;
  busy: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(session.title ?? "");
  const [abstract, setAbstract] = useState(session.abstract ?? "");

  if (!editing) {
    return (
      <article className="session-card">
        <div>
          <p className="section-label">{session.contentStatus.replaceAll("_", " ")}</p>
          <h3>{session.title ?? "Untitled session"}</h3>
          <p>{session.abstract}</p>
        </div>
        {session.editable
          ? <Button onClick={() => { setTitle(session.title ?? ""); setAbstract(session.abstract ?? ""); setEditing(true); }} tone="quiet">Edit</Button>
          : <StatusChip>Locked after approval</StatusChip>}
      </article>
    );
  }
  return (
    <article className="session-card session-card--editing">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void onSave(session.id, title, abstract).then(() => setEditing(false));
        }}
      >
        <TextField label="Title" onChange={(event) => setTitle(event.target.value)} required value={title} />
        <label className="field">
          <span className="field__label">Abstract</span>
          <textarea className="field__control" onChange={(event) => setAbstract(event.target.value)} required rows={4} value={abstract} />
        </label>
        <div className="session-card__actions">
          <Button disabled={busy} type="submit">Save session</Button>
          <Button onClick={() => setEditing(false)} tone="quiet" type="button">Cancel</Button>
        </div>
      </form>
    </article>
  );
}

export function PortalPage() {
  const [content, setContent] = useState<SpeakerContentPayload | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bio, setBio] = useState("");
  const [twitter, setTwitter] = useState("");
  const [linkedin, setLinkedin] = useState("");
  const initialized = useRef(false);

  async function load(): Promise<void> {
    const payload = await readJson<SpeakerContentPayload>(eventScopedPath("/api/speaker/content"));
    setContent(payload);
    if (!initialized.current && payload.profile !== null) {
      initialized.current = true;
      setBio(payload.profile.bio ?? "");
      setTwitter(payload.profile.twitter ?? "");
      setLinkedin(payload.profile.linkedin ?? "");
    }
  }

  useEffect(() => {
    void load().catch((error: unknown) => {
      setMessage(error instanceof Error ? error.message : "The speaker portal could not be loaded.");
    });
  }, []);

  async function saveProfile(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    try {
      await readJson(eventScopedPath("/api/portal/profile"), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bio, twitter, linkedin }),
      });
      await load();
      setMessage("Profile saved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Profile could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  async function saveHeadshot(file: File): Promise<void> {
    setBusy(true);
    try {
      await uploadFile(eventScopedPath("/api/portal/profile/headshot"), file);
      await load();
      setMessage("Headshot uploaded.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Headshot could not be uploaded.");
    } finally {
      setBusy(false);
    }
  }

  async function saveSession(sessionId: string, title: string, abstract: string): Promise<void> {
    setBusy(true);
    try {
      await readJson(eventScopedPath(`/api/portal/sessions/${sessionId}`), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, abstract }),
      });
      await load();
      setMessage("Session updated.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Session could not be updated.");
      throw error;
    } finally {
      setBusy(false);
    }
  }

  async function completeTask(taskId: string): Promise<void> {
    setBusy(true);
    try {
      await readJson(eventScopedPath(`/api/portal/tasks/${taskId}`), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "completed" }),
      });
      await load();
      setMessage("Task marked complete.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Task could not be updated.");
    } finally {
      setBusy(false);
    }
  }

  async function uploadTaskFile(
    taskId: string,
    file: File,
    displayedRequestKind: "document" | "picture",
  ): Promise<void> {
    setBusy(true);
    try {
      const result = await uploadFile<{ headshotUrl: string | null }>(
        eventScopedPath(`/api/portal/tasks/${taskId}/files`),
        file,
        {
          displayedRequestKind,
        },
      );
      await load();
      setMessage(result.headshotUrl === null
        ? "File uploaded. Task marked complete."
        : "File uploaded. This is now your profile photo on the public programme.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "File could not be uploaded.");
    } finally {
      setBusy(false);
    }
  }

  if (content === null) {
    return <LoadingState label="Loading speaker portal" />;
  }
  if (content.profile === null) {
    return <p role="alert">No speaker profile is linked to this account yet.</p>;
  }

  const outstanding = content.tasks.filter((task) => task.status !== "completed");

  return (
    <div className="portal-page">
      <header className="workspace-header">
        <div>
          <p className="eyebrow">SPEAKER PORTAL / DEVFLOW 2027</p>
          <h1>{content.profile.name}</h1>
          <p>{content.profile.jobTitle} · {content.profile.organization}</p>
        </div>
        <StatusChip tone="signal">{content.profile.status}</StatusChip>
      </header>

      <section className="workspace-section owe-strip" aria-label="What you still owe">
        <p className="section-label">WHAT YOU STILL OWE</p>
        {outstanding.length === 0
          ? <p className="quiet-copy">Nothing outstanding. You're all set.</p>
          : (
            <ul className="owe-list">
              {outstanding.map((task) => <li key={task.id}><strong>{task.title}</strong><span>{formatDueDate(task.dueAt)}</span></li>)}
            </ul>
          )}
      </section>

      <section className="workspace-section portal-profile" id="profile">
        <div className="section-heading"><div><p className="section-label">PROFILE</p><h2>Bio and headshot</h2></div></div>
        <div className="portal-profile__grid">
          <div className="headshot-picker">
            <Headshot alt={`${content.profile.name} headshot`} fallbackAriaLabel="No headshot uploaded" fallbackClassName="headshot-picker__placeholder" imageClassName="headshot-picker__image" name={content.profile.name} url={content.profile.headshotUrl} />
            <label className="file-picker">
              <span>{content.profile.headshotUrl === null ? "Upload headshot" : "Replace headshot"}</span>
              <input
                accept="image/png,image/jpeg,image/webp"
                disabled={busy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file !== undefined) void saveHeadshot(file);
                  event.target.value = "";
                }}
                type="file"
              />
            </label>
          </div>
          <form onSubmit={(event) => void saveProfile(event)}>
            <label className="field">
              <span className="field__label">Bio</span>
              <textarea className="field__control" onChange={(event) => setBio(event.target.value)} rows={5} value={bio} />
            </label>
            <TextField label="Twitter" onChange={(event) => setTwitter(event.target.value)} value={twitter} />
            <TextField label="LinkedIn" onChange={(event) => setLinkedin(event.target.value)} value={linkedin} />
            <Button disabled={busy} type="submit">Save profile</Button>
          </form>
        </div>
      </section>

      <section className="workspace-section" id="proposals">
        <div className="section-heading"><div><p className="section-label">MY PROPOSALS</p><h2>Submissions</h2></div></div>
        <DataTable caption="My proposals" columns={[
          { key: "title", label: "Proposal", render: (row) => <strong>{row.title}</strong> },
          {
            key: "speakerStatus",
            label: "Status",
            render: (row) => (
              <StatusChip tone={row.speakerStatus === "accepted" ? "good" : "neutral"}>
                {speakerFacingSubmissionLabels[row.speakerStatus]}
              </StatusChip>
            ),
          },
        ]} rows={content.submissions} />
        <p className="quiet-copy">
          An accepted proposal also appears below as a session to prepare. Anything still in review
          stays with the committee until they write to you.
        </p>
      </section>

      <section className="workspace-section" id="sessions">
        <div className="section-heading"><div><p className="section-label">MY SESSIONS</p><h2>Session content</h2></div></div>
        {content.sessions.length === 0
          ? <p className="quiet-copy">No sessions assigned yet.</p>
          : <div className="session-list">{content.sessions.map((session) => <SessionCard busy={busy} key={session.id} onSave={saveSession} session={session} />)}</div>}
      </section>

      <section className="workspace-section" id="tasks">
        <div className="section-heading"><div><p className="section-label">ONBOARDING TASKS</p><h2>Tasks and files</h2></div></div>
        {content.tasks.length === 0
          ? <p className="quiet-copy">No tasks assigned yet.</p>
          : (
            <ul className="task-list">
              {content.tasks.map((task) => (
                <TaskRow busy={busy} key={task.id} onComplete={(taskId) => void completeTask(taskId)} onUpload={(taskId, file, displayedRequestKind) => void uploadTaskFile(taskId, file, displayedRequestKind)} task={task} />
              ))}
            </ul>
          )}
      </section>

      <section className="workspace-section" id="files">
        <div className="section-heading"><div><p className="section-label">UPLOADED FILES</p><h2>File history</h2></div></div>
        {content.files.length === 0
          ? <p className="quiet-copy">No task files uploaded yet.</p>
          : (
            <ul className="file-history">
              {content.files.map((file) => (
                <li key={file.fileId}>
                  <div>
                    <strong>{file.taskTitle}</strong>
                    <a href={file.downloadUrl}>{file.displayName}</a>
                    <FileVersionList versions={file.versions} />
                    <FileComments fileId={file.fileId} />
                  </div>
                  <StatusChip tone={file.archived ? "neutral" : "good"}>
                    {file.archived ? "Archived task" : file.supersededByMerge ? "Superseded — merged" : `Version ${file.version}`}
                  </StatusChip>
                </li>
              ))}
            </ul>
          )}
      </section>

      <Toast message={message} />
    </div>
  );
}
