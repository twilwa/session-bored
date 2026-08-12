// ABOUTME: Presents the organizer speaker roster, bulk onboarding tasks, and missing-information worklist.
// ABOUTME: Keeps profile edits and workflow changes silent while making daily chase work immediately visible.
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import type {
  MissingInformationItem,
  RosterSpeakerSummary,
  RosterTaskSummary,
} from "../../../shared/api.ts";
import {
  Button,
  EmptyState,
  LoadingState,
  Modal,
  SelectField,
  StatusChip,
  TextField,
  Toast,
} from "../../components/ui.tsx";
import { initialsOf } from "../public/shared.ts";

const eventId = "evt_devflow_conf_2027";
const workflowStatuses = [
  "invited",
  "confirmed",
  "pending_employer_approval",
  "onboarding",
  "ready",
  "withdrawn",
] as const;

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && init.body !== null) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers,
  });
  const payload = await response.json<{ error?: string; message?: string } & T>();
  if (!response.ok) {
    throw new Error(payload.message ?? payload.error ?? `Request failed (${response.status})`);
  }
  return payload;
}

function RosterTabs({ path }: { path: string }) {
  const links = [
    ["Roster", "/organizer/roster"],
    ["Tasks", "/organizer/roster/tasks"],
    ["Missing info", "/organizer/roster/missing"],
  ] as const;
  return (
    <nav aria-label="Speaker operations" className="roster-tabs">
      {links.map(([label, href]) => (
        <a className={path === href ? "active" : ""} href={href} key={href}>{label}</a>
      ))}
    </nav>
  );
}

function formatStatus(status: string): string {
  return status.replaceAll("_", " ");
}

function formatDateInput(value: string | null): string {
  return value === null ? "" : value.slice(0, 10);
}

function compareMissingItems(
  left: MissingInformationItem["missing"][number],
  right: MissingInformationItem["missing"][number],
): number {
  if (left.overdueDays !== right.overdueDays) return right.overdueDays - left.overdueDays;
  if (left.dueAt !== null && right.dueAt !== null) return left.dueAt.localeCompare(right.dueAt);
  if (left.dueAt !== null) return -1;
  if (right.dueAt !== null) return 1;
  return left.label.localeCompare(right.label);
}

function dueLabel(item: MissingInformationItem["missing"][number]): string {
  if (item.overdueDays > 0) return `${item.overdueDays} days overdue`;
  if (item.dueAt === null) return "No due date";
  return `Due ${new Date(item.dueAt).toLocaleDateString()}`;
}

function socialLabel(key: string): string {
  return key
    .replaceAll(/[-_]+/g, " ")
    .replaceAll(/\b\w/g, (letter) => letter.toUpperCase());
}

function speakerSocialLinks(speaker: RosterSpeakerSummary): Array<{ href: string; label: string; value: string }> {
  const links: Array<{ href: string; label: string; value: string }> = [];
  if (speaker.twitter !== null && speaker.twitter.trim().length > 0) {
    const value = speaker.twitter.trim();
    links.push({
      href: value.startsWith("@") ? `https://x.com/${value.slice(1)}` : value,
      label: "Twitter",
      value,
    });
  }
  if (speaker.linkedin !== null && speaker.linkedin.trim().length > 0) {
    const value = speaker.linkedin.trim();
    links.push({ href: value, label: "LinkedIn", value });
  }
  for (const [key, rawValue] of Object.entries(speaker.socialLinks ?? {})) {
    const value = rawValue.trim();
    if (value.length > 0 && key.toLowerCase() !== "twitter" && key.toLowerCase() !== "linkedin") {
      links.push({ href: value, label: socialLabel(key), value });
    }
  }
  return links;
}

function openWorkLabel(speaker: RosterSpeakerSummary): ReactNode {
  const { incomplete, total } = speaker.taskSummary;
  if (total === 0 && incomplete === 0) {
    return <><strong>No open work</strong><small>No onboarding tasks assigned</small></>;
  }
  return <><strong>{incomplete} open item{incomplete === 1 ? "" : "s"}</strong><small>{total === 0 ? "No onboarding tasks assigned" : `${total} task${total === 1 ? "" : "s"} assigned`}</small></>;
}

// The name is already announced beside it, so the avatar stays decorative whether
// it renders a headshot or initials. A headshot that fails to load falls back to
// the initials rather than leaving an empty block.
export function rosterAvatar(name: string, url: string | null, imageFailed: boolean):
  | { initials: string; kind: "initials" }
  | { kind: "photo"; src: string } {
  if (url === null || url === "" || imageFailed) {
    return { initials: initialsOf(name), kind: "initials" };
  }
  return { kind: "photo", src: url };
}

export function SpeakerAvatar({ name, url }: { name: string; url: string | null }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  const avatar = rosterAvatar(name, url, failed);
  if (avatar.kind === "initials") {
    return <span aria-hidden="true" className="speaker-avatar">{avatar.initials}</span>;
  }
  return (
    <img
      alt=""
      aria-hidden="true"
      className="speaker-avatar speaker-avatar--photo"
      loading="lazy"
      onError={() => setFailed(true)}
      src={avatar.src}
    />
  );
}

function RosterList() {
  const [speakers, setSpeakers] = useState<RosterSpeakerSummary[] | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<RosterSpeakerSummary | null>(null);
  const [removing, setRemoving] = useState<RosterSpeakerSummary | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [expandedSpeakerId, setExpandedSpeakerId] = useState<string | null>(null);

  async function loadRoster(): Promise<void> {
    const payload = await requestJson<{ items: RosterSpeakerSummary[] }>(`/api/events/${eventId}/roster`);
    setSpeakers(payload.items);
  }

  useEffect(() => { void loadRoster().catch(() => setSpeakers([])); }, []);

  const filtered = useMemo(() => {
    if (speakers === null) return [];
    const query = search.trim().toLowerCase();
    return speakers.filter((speaker) =>
      (status === "all" || speaker.status === status) &&
      (query.length === 0 || [speaker.name, speaker.email, speaker.jobTitle, speaker.organization]
        .some((value) => value?.toLowerCase().includes(query)))
    );
  }, [search, speakers, status]);

  async function updateStatus(speaker: RosterSpeakerSummary, nextStatus: string): Promise<void> {
    await requestJson(`/api/events/${eventId}/speakers/${speaker.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: nextStatus }),
    });
    setMessage(`${speaker.name} moved to ${formatStatus(nextStatus)}. No message was sent.`);
    await loadRoster();
  }

  async function sendInvitation(speaker: RosterSpeakerSummary): Promise<void> {
    try {
      const result = await requestJson<{ status: string; error?: string }>(`/api/events/${eventId}/speakers/${speaker.id}/invitation`, { method: "POST" });
      if (result.status === "sent") {
        setMessage(`Portal invitation sent to ${speaker.name}.`);
      } else if (result.status === "provider_not_configured") {
        setMessage(`No email provider is connected, so no invitation was sent to ${speaker.name}.`);
      } else if (result.status === "skipped_no_address") {
        setMessage(`${speaker.name} has no email address, so no invitation was sent.`);
      } else {
        setMessage(`Portal invitation for ${speaker.name} was not sent (${result.error ?? result.status}).`);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Portal invitation could not be queued.");
    }
  }

  return (
    <>
      <section className="roster-toolbar" aria-label="Roster controls">
        <TextField label="Search speakers" name="speaker-search" onChange={(event) => setSearch(event.target.value)} placeholder="Name, email, role, or company" type="search" value={search} />
        <SelectField label="Workflow status" name="speaker-status" onChange={(event) => setStatus(event.target.value)} value={status}>
          <option value="all">All statuses</option>
          {workflowStatuses.map((value) => <option key={value} value={value}>{formatStatus(value)}</option>)}
        </SelectField>
        <Button onClick={() => setAddOpen(true)} tone="signal">Add speaker</Button>
      </section>
      {speakers === null ? <LoadingState label="Loading speaker roster" /> : (
        <section className="workspace-section roster-table-card">
          <div className="section-heading">
            <div><p className="section-label">EVENT ROSTER / {filtered.length}</p><h2>Speaker records</h2></div>
            <span className="quiet-note">Open work matches the chase list: profile gaps plus active assignments. Workflow changes are silent.</span>
          </div>
          {filtered.length === 0 ? (
            <EmptyState title="No speaker records match" description="Change the search or workflow filter to see more records." />
          ) : (
            <div className="speaker-record-list">
              {filtered.map((speaker) => {
                const expanded = expandedSpeakerId === speaker.id;
                const socialLinks = speakerSocialLinks(speaker);
                return (
                  <article className="speaker-record" key={speaker.id}>
                    <div className="speaker-record__summary">
                      <button
                        aria-expanded={expanded}
                        aria-label={`${expanded ? "Hide" : "Show"} details for ${speaker.name}`}
                        className="disclosure-control speaker-record__disclosure"
                        onClick={() => setExpandedSpeakerId(expanded ? null : speaker.id)}
                        type="button"
                      >{expanded ? "⌄" : ">"}</button>
                      <div className="speaker-record__identity">
                        <SpeakerAvatar name={speaker.name} url={speaker.headshotUrl} />
                        <div className="speaker-record__identity-copy">
                          <strong className="speaker-record__name">{speaker.name}</strong>
                          <a href={`mailto:${speaker.email}`}>{speaker.email}</a>
                          <span className="speaker-record__subheading">{speaker.jobTitle ?? "Role not set"} · {speaker.organization ?? "Organization not set"}</span>
                        </div>
                      </div>
                      <div className="speaker-record__readiness">
                        <span>{openWorkLabel(speaker)}</span>
                        <div className="completeness-pair">
                          <span className={speaker.profile.bioComplete ? "complete" : "missing"}>{speaker.profile.bioComplete ? "Bio complete" : "Bio missing"}</span>
                          <span className={speaker.profile.headshotComplete ? "complete" : "missing"}>{speaker.profile.headshotComplete ? "Photo complete" : "Photo missing"}</span>
                        </div>
                      </div>
                      <select aria-label={`Workflow status for ${speaker.name}`} className="inline-select speaker-record__workflow" onChange={(event) => void updateStatus(speaker, event.target.value)} value={speaker.status}>
                        {workflowStatuses.map((value) => <option key={value} value={value}>{formatStatus(value)}</option>)}
                      </select>
                      <details className="row-menu speaker-record__menu">
                        <summary aria-label={`More actions for ${speaker.name}`}>•••</summary>
                        <div className="row-menu__panel">
                          <Button onClick={() => setEditing(speaker)} tone="quiet">Edit</Button>
                          <Button onClick={() => void sendInvitation(speaker)} tone="quiet">Send invitation</Button>
                          <Button aria-label={`Remove ${speaker.name}`} className="button--danger" onClick={() => setRemoving(speaker)} tone="quiet">Remove</Button>
                        </div>
                      </details>
                    </div>
                    {expanded ? (
                      <div className="speaker-record__details">
                        <p className="section-label">Speaker details</p>
                        <div>
                          <span>
                            <small>Current headshot</small>
                            {speaker.headshotUrl === null ? <strong>No headshot supplied</strong> : (
                              <img
                                alt={`${speaker.name} headshot`}
                                className="speaker-avatar"
                                src={speaker.headshotUrl}
                                style={{ aspectRatio: "1", height: "auto", maxWidth: "160px", objectFit: "cover", width: "100%" }}
                              />
                            )}
                          </span>
                          <span><small>Bio</small><strong>{speaker.bio ?? "No bio supplied"}</strong></span>
                          <span><small>Role</small><strong>{speaker.jobTitle ?? "Role not set"}</strong></span>
                          <span><small>Organization</small><strong>{speaker.organization ?? "Organization not set"}</strong></span>
                          {socialLinks.length === 0 ? (
                            <span><small>Social links</small><strong>No social links supplied</strong></span>
                          ) : socialLinks.map((link) => (
                            <span key={`${link.label}-${link.value}`}>
                              <small>{link.label}</small>
                              <a href={link.href} rel="noreferrer" style={{ overflowWrap: "anywhere" }} target="_blank">{link.value}</a>
                            </span>
                          ))}
                          <span><small>Profile readiness</small><strong>{speaker.profile.bioComplete && speaker.profile.headshotComplete ? "Complete" : "Needs follow-up"}</strong></span>
                          <span>
                            <small>Open work</small>
                            <strong>{speaker.taskSummary.incomplete} open item{speaker.taskSummary.incomplete === 1 ? "" : "s"}</strong>
                            <small>{speaker.taskSummary.total === 0 ? "No onboarding tasks assigned" : `${speaker.taskSummary.total} task${speaker.taskSummary.total === 1 ? "" : "s"} assigned`}</small>
                          </span>
                        </div>
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}
      <SpeakerFormModal
        onClose={() => setAddOpen(false)}
        onSaved={async (savedMessage) => { setAddOpen(false); setMessage(savedMessage); await loadRoster(); }}
        open={addOpen}
      />
      <SpeakerFormModal
        onClose={() => setEditing(null)}
        onSaved={async (savedMessage) => { setEditing(null); setMessage(savedMessage); await loadRoster(); }}
        open={editing !== null}
        speaker={editing}
      />
      {removing === null ? null : (
        <Modal onClose={() => setRemoving(null)} open title={`Remove ${removing.name}?`}>
          <p>This removes the speaker from active organizer lists. Their portal, assignments, uploads, and event history remain intact.</p>
          <div className="modal-actions">
            <Button onClick={() => setRemoving(null)} tone="quiet" type="button">Cancel</Button>
            <Button
              className="button--danger"
              onClick={() => {
                void requestJson(`/api/events/${eventId}/speakers/${removing.id}`, { method: "DELETE" })
                  .then(async () => {
                    const name = removing.name;
                    setRemoving(null);
                    setMessage(`${name} was removed from the active roster. Their history remains intact.`);
                    await loadRoster();
                  })
                  .catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Speaker could not be removed."));
              }}
              type="button"
            >Remove speaker</Button>
          </div>
        </Modal>
      )}
      <Toast message={message} />
    </>
  );
}

function SpeakerFormModal({
  open,
  speaker,
  onClose,
  onSaved,
}: {
  open: boolean;
  speaker?: RosterSpeakerSummary | null;
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const hasStoredHeadshot = speaker?.headshotUrl !== null && speaker?.headshotUrl !== undefined &&
    speaker.headshotUrl.trim().length > 0;

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    const data = new FormData(event.currentTarget);
    const payload: Record<string, FormDataEntryValue | null> = Object.fromEntries(data.entries());
    const removeStoredHeadshot = data.get("removeStoredHeadshot") === "on";
    delete payload.removeStoredHeadshot;
    if (speaker !== undefined && speaker !== null) {
      if (removeStoredHeadshot) {
        payload.headshotUrl = null;
      } else if (typeof payload.headshotUrl === "string" && payload.headshotUrl.trim().length === 0) {
        delete payload.headshotUrl;
      }
    }
    try {
      const result = speaker === undefined || speaker === null
        ? await requestJson<{ adoptedExistingPerson: boolean; createdSpeaker: boolean; name: string }>(`/api/events/${eventId}/speakers`, {
          method: "POST",
          body: JSON.stringify(payload),
        })
        : await requestJson<{ name: string }>(`/api/events/${eventId}/speakers/${speaker.id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
      const adopted = "adoptedExistingPerson" in result && result.adoptedExistingPerson;
      await onSaved(adopted ? `${result.name} was adopted from the existing people record.` : `${result.name} was saved.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} open={open} title={speaker === undefined || speaker === null ? "Add a speaker" : `Edit ${speaker.name}`}>
      <form className="roster-form" onSubmit={(event) => void submit(event)}>
        <TextField defaultValue={speaker?.name} label="Name" name="name" required />
        <TextField defaultValue={speaker?.email} label="Email" name="email" required type="email" />
        <TextField defaultValue={speaker?.jobTitle ?? ""} label="Job title" name="jobTitle" />
        <TextField defaultValue={speaker?.organization ?? ""} label="Organization" name="organization" />
        <label className="field" htmlFor="speaker-bio"><span className="field__label">Bio</span><textarea className="field__control roster-textarea" defaultValue={speaker?.bio ?? ""} id="speaker-bio" name="bio" /></label>
        <TextField
          defaultValue=""
          hint={hasStoredHeadshot
            ? "Leave this blank to keep the stored headshot, or enter a full URL including https:// to replace it."
            : "Enter a full URL including https://."}
          label={hasStoredHeadshot ? "Replacement headshot URL" : "Headshot URL"}
          name="headshotUrl"
          type="url"
        />
        {hasStoredHeadshot ? (
          <label className="field" htmlFor="remove-stored-headshot">
            <span><input id="remove-stored-headshot" name="removeStoredHeadshot" type="checkbox" /> Remove stored headshot</span>
            <span className="field__hint">Select this only if the speaker should no longer have a headshot.</span>
          </label>
        ) : null}
        <SelectField defaultValue={speaker?.status ?? "invited"} label="Workflow status" name="status">
          {workflowStatuses.map((value) => <option key={value} value={value}>{formatStatus(value)}</option>)}
        </SelectField>
        <div className="modal-actions"><Button onClick={onClose} tone="quiet" type="button">Cancel</Button><Button disabled={busy} type="submit">{busy ? "Saving…" : "Save speaker"}</Button></div>
      </form>
    </Modal>
  );
}

function TasksView() {
  const [speakers, setSpeakers] = useState<RosterSpeakerSummary[] | null>(null);
  const [tasks, setTasks] = useState<RosterTaskSummary[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<RosterTaskSummary | null>(null);
  const [removing, setRemoving] = useState<RosterTaskSummary | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);

  async function load(): Promise<void> {
    const [roster, taskList] = await Promise.all([
      requestJson<{ items: RosterSpeakerSummary[] }>(`/api/events/${eventId}/roster`),
      requestJson<{ items: RosterTaskSummary[] }>(`/api/events/${eventId}/tasks`),
    ]);
    setSpeakers(roster.items);
    setTasks(taskList.items);
  }

  async function updateAssignment(
    task: RosterTaskSummary,
    assignee: RosterTaskSummary["assignees"][number],
    nextStatus: "assigned" | "completed",
  ): Promise<void> {
    setBusy(true);
    try {
      await requestJson(`/api/events/${eventId}/tasks/${task.id}/assignees/${assignee.speakerId}`, {
        method: "PATCH",
        body: JSON.stringify({ status: nextStatus }),
      });
      setMessage(`${task.title} was marked ${nextStatus === "completed" ? "complete" : "open"} for ${assignee.speakerName}.`);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Task status could not be updated.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { void load().catch(() => { setSpeakers([]); setTasks([]); }); }, []);

  if (speakers === null || tasks === null) return <LoadingState label="Loading onboarding tasks" />;
  return (
    <>
      <section className="task-layout">
        <section className="workspace-section task-ledger">
          <div className="section-heading"><div><p className="section-label">ONBOARDING LEDGER / {tasks.length}</p><h2>Tasks and file requests</h2></div><Button onClick={() => setCreating(true)} tone="signal">Create task</Button></div>
          {tasks.length === 0 ? (
            <EmptyState title="No onboarding tasks yet" description="Create a task when the speaker group has work to complete." />
          ) : (
            <div className="task-list">
              {tasks.map((task) => {
                const completeCount = task.assignees.filter((assignee) => assignee.status === "completed").length;
                const openCount = task.assignees.length - completeCount;
                const expanded = expandedTaskId === task.id;
                return (
                  <article className="task-card" key={task.id}>
                    <div className="task-card__summary">
                      <button
                        aria-expanded={expanded}
                        aria-label={`${expanded ? "Hide" : "Show"} assignees for ${task.title}`}
                        className="disclosure-control"
                        onClick={() => setExpandedTaskId(expanded ? null : task.id)}
                        type="button"
                      >{expanded ? "⌄" : ">"}</button>
                      <div className="task-card__identity">
                        <strong>{task.title}</strong>
                        {task.instructions === null || task.instructions.length === 0 ? null : <small>{task.instructions}</small>}
                      </div>
                      <details className="row-menu task-card__actions">
                        <summary aria-label={`More actions for ${task.title}`}>•••</summary>
                        <div className="row-menu__panel">
                          <Button aria-label={`Edit ${task.title}`} onClick={() => setEditing(task)} tone="quiet">Edit</Button>
                          <Button aria-label={`Remove ${task.title}`} className="button--danger" onClick={() => setRemoving(task)} tone="quiet">Remove</Button>
                        </div>
                      </details>
                      <div className="task-card__facts">
                        <StatusChip tone={task.taskType === "file_request" ? "signal" : "neutral"}>{formatStatus(task.taskType)}</StatusChip>
                        <span>{task.dueAt === null ? "No date" : new Date(task.dueAt).toLocaleDateString()}</span>
                        <strong>{openCount} open · {completeCount} complete · {task.assignees.length} assigned</strong>
                      </div>
                    </div>
                    {expanded ? (
                      <div className="task-assignee-panel">
                        {task.assignees.map((assignee) => (
                          <div className="task-assignee" key={assignee.id}>
                            <span><strong>{assignee.speakerName}</strong><small>{assignee.status === "completed" ? "Complete" : "Open"}</small></span>
                            <Button
                              aria-label={`${assignee.status === "completed" ? "Reopen" : "Mark complete"} ${task.title} for ${assignee.speakerName}`}
                              disabled={busy}
                              onClick={() => void updateAssignment(task, assignee, assignee.status === "completed" ? "assigned" : "completed")}
                              tone="quiet"
                            >{assignee.status === "completed" ? "Reopen" : "Complete"}</Button>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </section>
      {creating ? (
        <TaskFormModal
          key="create-task"
          onClose={() => setCreating(false)}
          onSaved={async (savedMessage) => {
            setCreating(false);
            setMessage(savedMessage);
            await load();
          }}
          speakers={speakers}
        />
      ) : null}
      {editing === null ? null : (
        <TaskFormModal
          key={editing.id}
          onClose={() => setEditing(null)}
          onSaved={async (savedMessage) => {
            setEditing(null);
            setMessage(savedMessage);
            await load();
          }}
          speakers={speakers}
          task={editing}
        />
      )}
      {removing === null ? null : (
        <Modal onClose={() => setRemoving(null)} open title={`Remove ${removing.title}?`}>
          <p>Greenroom will remove this task from active onboarding while retaining completed work and uploaded files.</p>
          <div className="modal-actions">
            <Button onClick={() => setRemoving(null)} tone="quiet" type="button">Cancel</Button>
            <Button
              className="button--danger"
              onClick={() => {
                setBusy(true);
                void requestJson(`/api/events/${eventId}/tasks/${removing.id}`, { method: "DELETE" })
                  .then(async () => {
                    const removedTitle = removing.title;
                    setRemoving(null);
                    setMessage(`${removedTitle} was removed. Completed work and uploads were retained.`);
                    await load();
                  })
                  .catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Task could not be removed."))
                  .finally(() => setBusy(false));
              }}
              disabled={busy}
              type="button"
            >{busy ? "Removing…" : "Remove task"}</Button>
          </div>
        </Modal>
      )}
      <Toast message={message} />
    </>
  );
}

function TaskFormModal({
  task,
  speakers,
  onClose,
  onSaved,
}: {
  task?: RosterTaskSummary;
  speakers: RosterSpeakerSummary[];
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const [selected, setSelected] = useState(task?.assignees.map((assignee) => assignee.speakerId) ?? []);
  const [speakerSearch, setSpeakerSearch] = useState("");
  const [speakerStatus, setSpeakerStatus] = useState("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const matchingSpeakers = useMemo(() => {
    const query = speakerSearch.trim().toLowerCase();
    return speakers.filter((speaker) =>
      (speakerStatus === "all" || speaker.status === speakerStatus) &&
      (query.length === 0 || [speaker.name, speaker.email].some((value) => value.toLowerCase().includes(query)))
    );
  }, [speakerSearch, speakerStatus, speakers]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (selected.length === 0) {
      setError("Choose at least one speaker.");
      return;
    }
    setBusy(true);
    setError(null);
    const data = new FormData(event.currentTarget);
    const dueDate = String(data.get("dueAt") ?? "");
    try {
      const payload = {
        taskType: data.get("taskType"),
        title: data.get("title"),
        instructions: data.get("instructions"),
        dueAt: dueDate.length === 0 ? null : `${dueDate}T23:59:59.000Z`,
        speakerIds: selected,
      };
      if (task === undefined) {
        const result = await requestJson<{ assignmentCount: number; title: string }>(`/api/events/${eventId}/tasks`, {
          method: "POST",
          body: JSON.stringify(payload),
        });
        await onSaved(`${result.title} assigned to ${result.assignmentCount} speakers.`);
      } else {
        await requestJson(`/api/events/${eventId}/tasks/${task.id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        await onSaved(`${String(data.get("title"))} was updated for current and future assignees.`);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Task could not be updated.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} open title={task === undefined ? "Create onboarding task" : `Edit ${task.title}`}>
      <form className="roster-form" onSubmit={(event) => void submit(event)}>
        <SelectField defaultValue={task?.taskType ?? "general"} id="task-editor-type" label="Task kind" name="taskType">
          <option value="general">General task</option>
          <option value="file_request">File request</option>
        </SelectField>
        <TextField defaultValue={task?.title ?? ""} id="task-editor-title" label="Task title" name="title" placeholder="Upload final slides" required />
        <label className="field" htmlFor="task-editor-instructions">
          <span className="field__label">Instructions</span>
          <textarea className="field__control roster-textarea" defaultValue={task?.instructions ?? ""} id="task-editor-instructions" name="instructions" />
        </label>
        <TextField defaultValue={formatDateInput(task?.dueAt ?? null)} id="task-editor-due" label="Due date" name="dueAt" type="date" />
        <div className="task-audience-controls">
          <TextField label="Search assigned speakers" name="task-speaker-search" onChange={(event) => setSpeakerSearch(event.target.value)} type="search" value={speakerSearch} />
          <SelectField label="Workflow status" name="task-speaker-status" onChange={(event) => setSpeakerStatus(event.target.value)} value={speakerStatus}>
            <option value="all">All statuses</option>
            {workflowStatuses.map((value) => <option key={value} value={value}>{formatStatus(value)}</option>)}
          </SelectField>
        </div>
        <fieldset className="speaker-picker task-editor-speakers">
          <legend>Selected-speaker audience</legend>
          <div className="speaker-picker__summary">
            <strong>{selected.length} speaker{selected.length === 1 ? "" : "s"} selected</strong>
            <Button
              onClick={() => setSelected((current) => [...new Set([...current, ...matchingSpeakers.map((speaker) => speaker.id)])])}
              tone="quiet"
              type="button"
            >Select all matching</Button>
          </div>
          {matchingSpeakers.map((speaker) => (
            <label key={speaker.id}><input checked={selected.includes(speaker.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, speaker.id] : current.filter((id) => id !== speaker.id))} type="checkbox" /><span><strong>{speaker.name}</strong><small>{speaker.email}</small></span></label>
          ))}
          {matchingSpeakers.length === 0 ? <p className="speaker-picker__empty">No speakers match these filters.</p> : null}
        </fieldset>
        {error === null ? null : <p className="form-error" role="alert">{error}</p>}
        <div className="modal-actions">
          <Button onClick={onClose} tone="quiet" type="button">Cancel</Button>
          <Button disabled={busy} type="submit">{busy ? "Saving…" : task === undefined ? `Assign to ${selected.length} speaker${selected.length === 1 ? "" : "s"}` : "Save task"}</Button>
        </div>
      </form>
    </Modal>
  );
}

function MissingInformationView() {
  const [data, setData] = useState<{
    worklistSpeakerCount: number;
    incompleteSpeakerCount: number;
    generatedAt: string;
    items: MissingInformationItem[];
  } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [urgency, setUrgency] = useState("all");
  const [workType, setWorkType] = useState("all");
  const [workflow, setWorkflow] = useState("all");
  const [expandedSpeakerId, setExpandedSpeakerId] = useState<string | null>(null);

  async function load(): Promise<void> {
    const payload = await requestJson<{
      worklistSpeakerCount: number;
      incompleteSpeakerCount: number;
      generatedAt: string;
      items: MissingInformationItem[];
    }>(`/api/events/${eventId}/missing-information`);
    setData(payload);
  }

  async function completeAssignment(speaker: MissingInformationItem, taskId: string, title: string): Promise<void> {
    setBusyTaskId(taskId);
    try {
      await requestJson(`/api/events/${eventId}/tasks/${taskId}/assignees/${speaker.speakerId}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "completed" }),
      });
      setMessage(`${title} was marked complete for ${speaker.name}.`);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Task status could not be updated.");
    } finally {
      setBusyTaskId(null);
    }
  }

  useEffect(() => {
    void load().catch(() => setData({
      worklistSpeakerCount: 0,
      incompleteSpeakerCount: 0,
      generatedAt: new Date().toISOString(),
      items: [],
    }));
  }, []);
  if (data === null) return <LoadingState label="Finding missing speaker information" />;

  const query = search.trim().toLowerCase();
  const dueSoonCutoff = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const visibleItems = data.items.map((speaker): MissingInformationItem | null => {
    if (workflow !== "all" && speaker.status !== workflow) return null;
    if (query.length > 0 && ![speaker.name, speaker.email].some((value) => value.toLowerCase().includes(query))) return null;
    const missing = speaker.missing.filter((item) => {
      const matchesUrgency = urgency === "all" ||
        (urgency === "overdue" && item.overdueDays > 0) ||
        (urgency === "due_soon" && item.overdueDays === 0 && item.dueAt !== null && new Date(item.dueAt).getTime() <= dueSoonCutoff) ||
        (urgency === "undated" && item.dueAt === null);
      const matchesType = workType === "all" ||
        (workType === "profile" && (item.kind === "bio" || item.kind === "headshot")) ||
        (workType === "file" && item.kind === "file") ||
        (workType === "task" && (item.kind === "task" || item.kind === "form"));
      return matchesUrgency && matchesType;
    }).sort(compareMissingItems);
    if (missing.length === 0) return null;
    return {
      ...speaker,
      missing,
      missingCount: missing.length,
      mostOverdueDays: Math.max(...missing.map((item) => item.overdueDays)),
    };
  }).filter((speaker): speaker is MissingInformationItem => speaker !== null).sort((left, right) => {
    const itemComparison = compareMissingItems(left.missing[0]!, right.missing[0]!);
    return itemComparison === 0 ? left.name.localeCompare(right.name) : itemComparison;
  });

  return (
    <>
      <section className="missing-board">
      <header className="missing-hero">
        <div><p className="eyebrow">TODAY'S CHASE LIST / LIVE</p><h2>Who still owes us something?</h2><p>Includes profile gaps for accepted speakers and every active incomplete onboarding assignment across the roster.</p></div>
        <div className="missing-score"><strong>{data.incompleteSpeakerCount}</strong><span>of {data.worklistSpeakerCount} speakers need follow-up</span></div>
      </header>
      <section aria-label="Chase list filters" className="chase-toolbar">
        <TextField label="Search chase list" name="chase-search" onChange={(event) => setSearch(event.target.value)} placeholder="Name or email" type="search" value={search} />
        <SelectField label="Urgency" name="chase-urgency" onChange={(event) => setUrgency(event.target.value)} value={urgency}>
          <option value="all">All urgency</option>
          <option value="overdue">Overdue</option>
          <option value="due_soon">Due next 7 days</option>
          <option value="undated">No due date</option>
        </SelectField>
        <SelectField label="Work type" name="chase-type" onChange={(event) => setWorkType(event.target.value)} value={workType}>
          <option value="all">All work</option>
          <option value="profile">Profile gaps</option>
          <option value="file">File requests</option>
          <option value="task">Tasks and forms</option>
        </SelectField>
        <SelectField label="Workflow status" name="chase-workflow" onChange={(event) => setWorkflow(event.target.value)} value={workflow}>
          <option value="all">All statuses</option>
          {workflowStatuses.map((value) => <option key={value} value={value}>{formatStatus(value)}</option>)}
        </SelectField>
        <p className="chase-sort">Sorted by most overdue, then nearest due, then undated.</p>
      </section>
      {data.items.length === 0 ? (
        <EmptyState
          title="Nothing to chase"
          description="Accepted-speaker profile information is complete and every active onboarding assignment is done."
        />
      ) : visibleItems.length === 0 ? (
        <EmptyState title="No matching follow-up" description="Change the chase filters to see more open speaker work." />
      ) : (
        <div className="chase-list">
          {visibleItems.map((speaker, index) => {
            const expanded = expandedSpeakerId === speaker.speakerId;
            const mostUrgent = speaker.missing[0]!;
            return (
              <article className="chase-card" key={speaker.speakerId}>
                <div className="chase-card__summary">
                  <span className="chase-rank">{String(index + 1).padStart(2, "0")}</span>
                  <button
                    aria-expanded={expanded}
                    aria-label={`${expanded ? "Hide" : "Show"} all items for ${speaker.name}`}
                    className="disclosure-control"
                    onClick={() => setExpandedSpeakerId(expanded ? null : speaker.speakerId)}
                    type="button"
                  >{expanded ? "⌄" : ">"}</button>
                  <div className="chase-person"><h3>{speaker.name}</h3><a href={`mailto:${speaker.email}`}>{speaker.email}</a><StatusChip>{formatStatus(speaker.status)}</StatusChip></div>
                  <div className={mostUrgent.overdueDays > 0 ? "chase-priority overdue" : "chase-priority"}>
                    <span>{mostUrgent.kind}</span><strong>{mostUrgent.label}</strong><small>{dueLabel(mostUrgent)}</small>
                  </div>
                  <div className="chase-age"><strong>{speaker.missingCount}</strong><span>open item{speaker.missingCount === 1 ? "" : "s"}</span></div>
                </div>
                {expanded ? (
                  <div className="missing-items">
                    {speaker.missing.map((item) => (
                      <div className={item.overdueDays > 0 ? "missing-item overdue" : "missing-item"} key={`${item.kind}-${item.taskId ?? item.label}`}>
                        <span>{item.kind}</span><strong>{item.label}</strong><small>{dueLabel(item)}</small>
                        {item.taskId === null ? null : (
                          <Button
                            aria-label={`Mark ${item.label} complete for ${speaker.name}`}
                            disabled={busyTaskId === item.taskId}
                            onClick={() => void completeAssignment(speaker, item.taskId!, item.label)}
                            tone="quiet"
                          >{busyTaskId === item.taskId ? "Completing…" : "Mark complete"}</Button>
                        )}
                      </div>
                    ))}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
      </section>
      <Toast message={message} />
    </>
  );
}

export function RosterPage({ path }: { path: string }) {
  const view = path.endsWith("/missing") ? "missing" : path.endsWith("/tasks") ? "tasks" : "roster";
  return (
    <>
      <header className="workspace-header roster-header">
        <div><p className="eyebrow">SPEAKER OPERATIONS / DEVFLOW 2027</p><h1>{view === "missing" ? "Morning check." : view === "tasks" ? "Onboarding." : "Speaker roster."}</h1><p>{view === "missing" ? "Start with the oldest promise, then work down." : "One event-scoped record per person. No duplicate spreadsheets."}</p></div>
        <StatusChip tone={view === "missing" ? "signal" : "good"}>{view === "missing" ? "live worklist" : "organizer only"}</StatusChip>
      </header>
      <RosterTabs path={path} />
      {view === "missing" ? <MissingInformationView /> : view === "tasks" ? <TasksView /> : <RosterList />}
    </>
  );
}
