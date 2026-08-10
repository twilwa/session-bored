// ABOUTME: Presents the organizer speaker roster, bulk onboarding tasks, and missing-information worklist.
// ABOUTME: Keeps profile edits and workflow changes silent while making daily chase work immediately visible.
import { useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  MissingInformationItem,
  RosterSpeakerSummary,
  RosterTaskSummary,
} from "../../../shared/api.ts";
import {
  Button,
  DataTable,
  EmptyState,
  LoadingState,
  Modal,
  SelectField,
  StatusChip,
  TextField,
  Toast,
} from "../../components/ui.tsx";

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

function RosterList() {
  const [speakers, setSpeakers] = useState<RosterSpeakerSummary[] | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<RosterSpeakerSummary | null>(null);
  const [message, setMessage] = useState<string | null>(null);

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
      await requestJson(`/api/events/${eventId}/speakers/${speaker.id}/invitation`, { method: "POST" });
      setMessage(`Portal invitation queued for ${speaker.name}.`);
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
            <div><p className="section-label">EVENT ROSTER / {filtered.length}</p><h2>Everyone taking the stage</h2></div>
            <span className="quiet-note">Workflow changes are silent.</span>
          </div>
          <DataTable
            caption="Event speakers"
            columns={[
              {
                key: "speaker",
                label: "Speaker",
                render: (speaker) => (
                  <div className="speaker-identity">
                    <span className="speaker-avatar" aria-hidden="true">{speaker.name.split(" ").map((part) => part[0]).join("").slice(0, 2)}</span>
                    <div><strong>{speaker.name}</strong><a href={`mailto:${speaker.email}`}>{speaker.email}</a></div>
                  </div>
                ),
              },
              { key: "role", label: "Role", render: (speaker) => <><strong>{speaker.jobTitle ?? "Role not set"}</strong><small>{speaker.organization ?? "Organization not set"}</small></> },
              {
                key: "profile",
                label: "Profile",
                render: (speaker) => (
                  <div className="completeness-pair">
                    <span className={speaker.profile.bioComplete ? "complete" : "missing"}>Bio</span>
                    <span className={speaker.profile.headshotComplete ? "complete" : "missing"}>Photo</span>
                  </div>
                ),
              },
              { key: "tasks", label: "Open work", render: (speaker) => <strong>{speaker.taskSummary.incomplete}<small> / {speaker.taskSummary.total} tasks</small></strong> },
              {
                key: "status",
                label: "Workflow",
                render: (speaker) => (
                  <select aria-label={`Workflow status for ${speaker.name}`} className="inline-select" onChange={(event) => void updateStatus(speaker, event.target.value)} value={speaker.status}>
                    {workflowStatuses.map((value) => <option key={value} value={value}>{formatStatus(value)}</option>)}
                  </select>
                ),
              },
              {
                key: "actions",
                label: "Actions",
                render: (speaker) => (
                  <div className="row-actions">
                    <Button onClick={() => setEditing(speaker)} tone="quiet">Edit</Button>
                    <Button onClick={() => void sendInvitation(speaker)} tone="quiet">Invite</Button>
                  </div>
                ),
              },
            ]}
            rows={filtered}
          />
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

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    const data = new FormData(event.currentTarget);
    const payload = Object.fromEntries(data.entries());
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
        <TextField defaultValue={speaker?.headshotUrl ?? ""} label="Headshot URL" name="headshotUrl" type="url" />
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
  const [selected, setSelected] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(): Promise<void> {
    const [roster, taskList] = await Promise.all([
      requestJson<{ items: RosterSpeakerSummary[] }>(`/api/events/${eventId}/roster`),
      requestJson<{ items: RosterTaskSummary[] }>(`/api/events/${eventId}/tasks`),
    ]);
    setSpeakers(roster.items);
    setTasks(taskList.items);
  }

  useEffect(() => { void load().catch(() => { setSpeakers([]); setTasks([]); }); }, []);

  async function createTask(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (selected.length === 0) {
      setMessage("Choose at least one speaker.");
      return;
    }
    setBusy(true);
    const data = new FormData(event.currentTarget);
    const dueDate = String(data.get("dueAt") ?? "");
    try {
      const result = await requestJson<{ assignmentCount: number; title: string }>(`/api/events/${eventId}/tasks`, {
        method: "POST",
        body: JSON.stringify({
          taskType: data.get("taskType"),
          title: data.get("title"),
          instructions: data.get("instructions"),
          dueAt: dueDate.length === 0 ? null : `${dueDate}T23:59:59.000Z`,
          speakerIds: selected,
        }),
      });
      setMessage(`${result.title} assigned to ${result.assignmentCount} speakers.`);
      setSelected([]);
      event.currentTarget.reset();
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (speakers === null || tasks === null) return <LoadingState label="Loading onboarding tasks" />;
  return (
    <>
      <section className="task-layout">
        <form className="workspace-section task-builder" onSubmit={(event) => void createTask(event)}>
          <p className="section-label">BULK ASSIGNMENT</p>
          <h2>Send one ask to the whole group.</h2>
          <SelectField label="Task kind" name="taskType"><option value="general">General task</option><option value="file_request">File request</option></SelectField>
          <TextField label="Task title" name="title" placeholder="Upload final slides" required />
          <label className="field" htmlFor="task-instructions"><span className="field__label">Instructions</span><textarea className="field__control roster-textarea" id="task-instructions" name="instructions" /></label>
          <TextField label="Due date" name="dueAt" type="date" />
          <fieldset className="speaker-picker">
            <legend>Assign speakers</legend>
            <label className="select-all"><input checked={selected.length === speakers.length && speakers.length > 0} onChange={(event) => setSelected(event.target.checked ? speakers.map((speaker) => speaker.id) : [])} type="checkbox" /> Select all {speakers.length}</label>
            {speakers.map((speaker) => (
              <label key={speaker.id}><input checked={selected.includes(speaker.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, speaker.id] : current.filter((id) => id !== speaker.id))} type="checkbox" /><span><strong>{speaker.name}</strong><small>{speaker.email}</small></span></label>
            ))}
          </fieldset>
          <Button disabled={busy} tone="signal" type="submit">{busy ? "Assigning…" : `Assign to ${selected.length} speaker${selected.length === 1 ? "" : "s"}`}</Button>
        </form>
        <section className="workspace-section task-ledger">
          <div className="section-heading"><div><p className="section-label">ONBOARDING LEDGER / {tasks.length}</p><h2>Tasks and file requests</h2></div></div>
          <DataTable
            caption="Onboarding tasks"
            columns={[
              { key: "title", label: "Task", render: (task) => <><strong>{task.title}</strong><small>{task.instructions}</small></> },
              { key: "type", label: "Type", render: (task) => <StatusChip tone={task.taskType === "file_request" ? "signal" : "neutral"}>{formatStatus(task.taskType)}</StatusChip> },
              { key: "due", label: "Due", render: (task) => task.dueAt === null ? "No date" : new Date(task.dueAt).toLocaleDateString() },
              { key: "assigned", label: "Assigned", render: (task) => <strong>{task.assignees.length}</strong> },
            ]}
            rows={tasks}
          />
        </section>
      </section>
      <Toast message={message} />
    </>
  );
}

function MissingInformationView() {
  const [data, setData] = useState<{
    acceptedSpeakerCount: number;
    incompleteSpeakerCount: number;
    generatedAt: string;
    items: MissingInformationItem[];
    activeTaskCount: number;
    activeTaskSpeakerCount: number;
  } | null>(null);
  useEffect(() => {
    Promise.all([
      requestJson<{
        acceptedSpeakerCount: number;
        incompleteSpeakerCount: number;
        generatedAt: string;
        items: MissingInformationItem[];
      }>(`/api/events/${eventId}/missing-information`),
      requestJson<{ items: RosterSpeakerSummary[] }>(`/api/events/${eventId}/roster`),
    ]).then(([missingInformation, roster]) => {
      const speakersWithActiveTasks = roster.items.filter((speaker) => speaker.taskSummary.incomplete > 0);
      setData({
        ...missingInformation,
        activeTaskCount: speakersWithActiveTasks.reduce(
          (total, speaker) => total + speaker.taskSummary.incomplete,
          0,
        ),
        activeTaskSpeakerCount: speakersWithActiveTasks.length,
      });
    }).catch(() => setData({
      acceptedSpeakerCount: 0,
      incompleteSpeakerCount: 0,
      generatedAt: new Date().toISOString(),
      items: [],
      activeTaskCount: 0,
      activeTaskSpeakerCount: 0,
    }));
  }, []);
  if (data === null) return <LoadingState label="Finding missing speaker information" />;
  return (
    <section className="missing-board">
      <header className="missing-hero">
        <div><p className="eyebrow">TODAY'S CHASE LIST / LIVE</p><h2>Who still owes us something?</h2><p>Derived from accepted sessions, profiles, assignments, uploads, and deadlines. Nothing here depends on a manually maintained flag.</p></div>
        <div className="missing-score"><strong>{data.incompleteSpeakerCount}</strong><span>of {data.acceptedSpeakerCount} accepted speakers need follow-up</span></div>
      </header>
      {data.items.length === 0 ? (
        <div>
          <EmptyState
            title="Accepted-session follow-up is clear"
            description={data.activeTaskCount === 0
              ? "Every accepted speaker has complete onboarding information."
              : `${data.activeTaskCount} active onboarding tasks for ${data.activeTaskSpeakerCount} ${data.activeTaskSpeakerCount === 1 ? "speaker" : "speakers"} remain outside this accepted-session view.`}
          />
          {data.activeTaskCount > 0 ? (
            <a className="text-link" href="/organizer/roster/tasks">Review outstanding tasks →</a>
          ) : null}
        </div>
      ) : (
        <div className="chase-list">
          {data.items.map((speaker, index) => (
            <article className="chase-card" key={speaker.speakerId}>
              <span className="chase-rank">{String(index + 1).padStart(2, "0")}</span>
              <div className="chase-person"><h3>{speaker.name}</h3><a href={`mailto:${speaker.email}`}>{speaker.email}</a><StatusChip>{formatStatus(speaker.status)}</StatusChip></div>
              <div className="missing-items">
                {speaker.missing.map((item) => (
                  <div className={item.overdueDays > 0 ? "missing-item overdue" : "missing-item"} key={`${item.kind}-${item.taskId ?? item.label}`}>
                    <span>{item.kind}</span><strong>{item.label}</strong><small>{item.overdueDays > 0 ? `${item.overdueDays} days overdue` : item.dueAt === null ? "No due date" : `Due ${new Date(item.dueAt).toLocaleDateString()}`}</small>
                  </div>
                ))}
              </div>
              <div className="chase-age">{speaker.mostOverdueDays > 0 ? <><strong>{speaker.mostOverdueDays}d</strong><span>most overdue</span></> : <><strong>{speaker.missingCount}</strong><span>open items</span></>}</div>
            </article>
          ))}
        </div>
      )}
    </section>
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
