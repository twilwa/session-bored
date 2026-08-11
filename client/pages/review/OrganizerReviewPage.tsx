// ABOUTME: Gives organizers the two canonical committee review views and live coverage.
// ABOUTME: Keeps reviewer, round, pool, scorecard, and assignment controls secondary but reachable.
import { useEffect, useState, type FormEvent } from "react";
import type { ReviewCriterion, ReviewProgress, ReviewSort, ReviewWorklistItem } from "../../../shared/api.ts";
import { Button, LoadingState, StatusChip, Toast } from "../../components/ui.tsx";
import { ReviewLink, reviewRequest } from "./reviewClient.tsx";
import { SubmissionReviewPage } from "./SubmissionReviewPage.tsx";
import "./review.css";

const eventId = "evt_devflow_conf_2027";

interface ReviewerSummary {
  id: string;
  name: string;
  email: string;
  trackIds: string[];
  assignedCount: number;
  completedCount: number;
}

interface RoundSummary {
  id: string;
  name: string;
  opensAt: string | null;
  closesAt: string | null;
  anonymized: boolean;
  status: "draft" | "open" | "closed";
  criteria: ReviewCriterion[];
  reviewerPool: Array<{ id: string; name: string; email: string }>;
}

interface ReviewConfig {
  tracks: Array<{ id: string; name: string }>;
  submissions: Array<{ id: string; title: string | null; status: string }>;
  reviewers: ReviewerSummary[];
  rounds: RoundSummary[];
}

interface AIReviewConfig {
  enabled: boolean;
}

interface WorklistPayload {
  sort: ReviewSort;
  progress: ReviewProgress;
  items: ReviewWorklistItem[];
}

function percent(completed: number, total: number): number {
  return total === 0 ? 0 : Math.round((completed / total) * 100);
}

export function OrganizerReviewPage({ path }: { path: string }) {
  const detailPrefix = "/organizer/review/submissions/";
  if (path.startsWith(detailPrefix)) {
    return <SubmissionReviewPage role="organizer" submissionId={decodeURIComponent(path.slice(detailPrefix.length))} />;
  }
  return <OrganizerReviewWorklist />;
}

function OrganizerReviewWorklist() {
  const [sort, setSort] = useState<ReviewSort>("coverage");
  const [worklist, setWorklist] = useState<WorklistPayload | null>(null);
  const [config, setConfig] = useState<ReviewConfig | null>(null);
  const [aiConfig, setAIConfig] = useState<AIReviewConfig | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [reviewerTrackIds, setReviewerTrackIds] = useState<string[]>([]);
  const [reviewerRoundIds, setReviewerRoundIds] = useState<string[]>([]);

  async function loadWorklist(nextSort = sort): Promise<void> {
    try {
      setWorklist(await reviewRequest<WorklistPayload>(`/api/review/events/${eventId}/worklist?sort=${nextSort}`));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The review worklist could not be loaded.");
    }
  }

  async function loadConfig(): Promise<void> {
    try {
      const [reviewConfig, assistanceConfig] = await Promise.all([
        reviewRequest<ReviewConfig>(`/api/review/events/${eventId}/config`),
        reviewRequest<AIReviewConfig>(`/api/review/events/${eventId}/ai-assistance`),
      ]);
      setConfig(reviewConfig);
      setAIConfig(assistanceConfig);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Committee setup could not be loaded.");
    }
  }

  useEffect(() => { void loadWorklist(sort); }, [sort]);
  useEffect(() => { void loadConfig(); }, []);

  async function setAIAssistance(enabled: boolean): Promise<void> {
    try {
      const saved = await reviewRequest<AIReviewConfig>(
        `/api/review/events/${eventId}/ai-assistance`,
        {
          method: "PATCH",
          body: JSON.stringify({ enabled }),
        },
      );
      setAIConfig(saved);
      setMessage(enabled
        ? "AI reading aids enabled. Reviewers still record every score themselves."
        : "AI reading aids turned off for this committee.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "AI reading aids could not be updated.");
    }
  }

  async function changeStatus(submissionId: string, status: string): Promise<void> {
    try {
      await reviewRequest(`/api/review/submissions/${submissionId}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      setMessage("Status saved silently. No message was sent.");
      await loadWorklist();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The status could not be saved.");
    }
  }

  async function provisionReviewer(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      await reviewRequest(`/api/review/events/${eventId}/reviewers`, {
        method: "POST",
        body: JSON.stringify({
          name: form.get("name"),
          email: form.get("email"),
          password: form.get("password"),
          trackIds: reviewerTrackIds,
          roundIds: reviewerRoundIds,
        }),
      });
      formElement.reset();
      setReviewerTrackIds([]);
      setReviewerRoundIds([]);
      setMessage("Reviewer added. Their password works immediately.");
      await loadConfig();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The reviewer could not be added.");
    }
  }

  async function createRound(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      await reviewRequest(`/api/review/events/${eventId}/rounds`, {
        method: "POST",
        body: JSON.stringify({
          name: form.get("name"),
          opensAt: form.get("opensAt"),
          closesAt: form.get("closesAt"),
          anonymized: form.get("anonymized") === "on",
          status: "open",
        }),
      });
      formElement.reset();
      setMessage("Round created. It stays out of the committee’s way until you add reviewers.");
      await loadConfig();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The round could not be created.");
    }
  }

  async function createCriterion(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(event.currentTarget);
    const roundId = String(form.get("roundId"));
    try {
      await reviewRequest(`/api/review/rounds/${roundId}/criteria`, {
        method: "POST",
        body: JSON.stringify({
          label: form.get("label"),
          criterionType: form.get("criterionType"),
          options: String(form.get("options") ?? "").split(",").map((item) => item.trim()).filter(Boolean),
          weight: Number(form.get("weight") || 1),
          required: form.get("required") === "on",
        }),
      });
      formElement.reset();
      setMessage("Scorecard criterion added.");
      await loadConfig();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The criterion could not be added.");
    }
  }

  async function updateCriterion(
    event: FormEvent<HTMLFormElement>,
    criterion: ReviewCriterion,
  ): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const weight = String(form.get("weight") ?? "").trim();
    try {
      await reviewRequest(`/api/review/criteria/${criterion.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          label: form.get("label"),
          criterionType: form.get("criterionType"),
          options: String(form.get("options") ?? "").split(",").map((item) => item.trim()).filter(Boolean),
          weight: weight === "" ? null : Number(weight),
          required: form.get("required") === "on",
        }),
      });
      setMessage("Criterion updated. Current rubric weights now drive the worklist.");
      await Promise.all([loadConfig(), loadWorklist()]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The criterion could not be updated.");
    }
  }

  async function removeCriterion(criterion: ReviewCriterion): Promise<void> {
    if (!window.confirm(`Remove “${criterion.label}” from this round's scorecard?`)) return;
    try {
      await reviewRequest(`/api/review/criteria/${criterion.id}`, { method: "DELETE" });
      setMessage("Criterion removed. Historical score values were preserved and aggregates recalculated.");
      await Promise.all([loadConfig(), loadWorklist()]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The criterion could not be removed.");
    }
  }

  async function addAssignment(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const roundId = String(form.get("roundId"));
    try {
      await reviewRequest(`/api/review/rounds/${roundId}/assignments`, {
        method: "POST",
        body: JSON.stringify({
          reviewerUserId: form.get("reviewerUserId"),
          submissionIds: [form.get("submissionId")],
        }),
      });
      setMessage("Explicit assignment added without narrowing the reviewer’s track remit.");
      await loadConfig();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The assignment could not be added.");
    }
  }

  const progress = worklist?.progress;
  const completion = progress === undefined
    ? 0
    : percent(progress.completedReadSlots, progress.totalReadSlots);

  return (
    <div className="review-workspace">
      <header className="review-hero">
        <div><p className="eyebrow">COMMITTEE REVIEW / DEVFLOW 2027</p><h1>Read together.<br /><em>Decide deliberately.</em></h1><p>Every proposal has a durable room for discussion. Status changes never send mail.</p></div>
        <div className="coverage-dial" aria-label={`${completion}% review coverage`}><strong>{completion}%</strong><span>coverage</span><small>{progress?.completedReadSlots ?? 0} of {progress?.totalReadSlots ?? 0} reads</small></div>
      </header>

      <nav className="review-modes" aria-label="Review order">
        <button aria-pressed={sort === "coverage"} className={sort === "coverage" ? "active" : ""} onClick={() => setSort("coverage")}>
          <span>01</span><strong>Coverage worklist</strong><small>Fewest ratings first · get every talk two reads</small>
        </button>
        <button aria-pressed={sort === "score"} className={sort === "score" ? "active" : ""} onClick={() => setSort("score")}>
          <span>02</span><strong>Decision meeting</strong><small>Average score descending · run the agenda</small>
        </button>
      </nav>

      <div className="coverage-bar" aria-hidden="true"><span style={{ width: `${completion}%` }} /></div>
      {worklist === null ? <LoadingState label="Loading committee review" /> : (
        <section className="review-list" aria-label={sort === "coverage" ? "Coverage worklist" : "Decision meeting agenda"}>
          {worklist.items.map((item, index) => (
            <article className="review-row" key={item.submissionId}>
              <span className="review-row__rank">{String(index + 1).padStart(2, "0")}</span>
              <div className="review-row__proposal">
                <div className="review-tags">{item.tracks.map((track) => <span key={track}>{track}</span>)}</div>
                <ReviewLink href={`/organizer/review/submissions/${item.submissionId}`}><h2>{item.title}</h2></ReviewLink>
                <small>Permanent link · {item.submissionId}</small>
              </div>
              <div className="review-row__measure"><strong>{item.ratingCount}</strong><span>ratings</span></div>
              <div className="review-row__measure"><strong>{item.averageScore?.toFixed(2) ?? "—"}</strong><span>average</span></div>
              <label className="silent-status"><span>Silent status</span><select name={`status-${item.submissionId}`} onChange={(event) => void changeStatus(item.submissionId, event.target.value)} value={item.status}><option value="submitted">Unreviewed</option><option value="under_review">Under review</option><option value="accepted">Approve</option><option value="maybe">Maybe</option><option value="declined">Deny</option></select><small>No email is sent</small></label>
            </article>
          ))}
        </section>
      )}

      <details className="review-setup">
        <summary><span><strong>Committee setup</strong><small>Reviewers, track remits, explicit assignments, rounds, pools, and scorecards</small></span><span>Open setup +</span></summary>
        {config === null ? <LoadingState label="Loading committee setup" /> : (
          <div className="setup-grid">
            <section className="setup-card setup-card--wide ai-review-config">
              <div>
                <p className="section-label">OPTIONAL READING AID</p>
                <h2>AI assistance stays in the margins.</h2>
                <p>Reviewers can request a short proposal summary and suggestions against each round’s existing criteria.</p>
              </div>
              {aiConfig === null ? <LoadingState label="Loading AI review setting" /> : (
                <div>
                  <label className="ai-review-toggle">
                    <input
                      checked={aiConfig.enabled}
                      onChange={(event) => void setAIAssistance(event.target.checked)}
                      type="checkbox"
                    />
                    <span>Enable optional AI reading aids</span>
                  </label>
                  <p>AI never records a score or decision.</p>
                  <small>Off by default · no email or notification is ever sent</small>
                </div>
              )}
            </section>
            <section className="setup-card setup-card--wide">
              <div className="setup-heading"><div><p className="section-label">LIVE PROGRESS</p><h2>Committee coverage</h2></div><StatusChip tone="signal">{config.reviewers.length} reviewers</StatusChip></div>
              <div className="reviewer-progress-list">
                {config.reviewers.map((reviewer) => {
                  const reviewerPercent = percent(reviewer.completedCount, reviewer.assignedCount);
                  return <article key={reviewer.id}><div><strong>{reviewer.name}</strong><span>{reviewer.completedCount} / {reviewer.assignedCount}</span></div><div><span style={{ width: `${reviewerPercent}%` }} /></div><small>{reviewer.trackIds.length === config.tracks.length ? "All submissions" : `${reviewer.trackIds.length} track remit`}</small></article>;
                })}
              </div>
            </section>

            <form className="setup-card setup-form" onSubmit={(event) => void provisionReviewer(event)}>
              <p className="section-label">ADD REVIEWER</p><h2>Usable access, now.</h2><p>All submissions is the default. Select tracks only to narrow the remit.</p>
              <label className="review-field"><span>Name</span><input autoComplete="name" name="name" required /></label>
              <label className="review-field"><span>Email</span><input autoComplete="email" name="email" required type="email" /></label>
              <label className="review-field"><span>Temporary password</span><input autoComplete="new-password" minLength={8} name="password" required type="password" /></label>
              <fieldset className="track-checks"><legend>Track remit · none selected means all</legend>{config.tracks.map((track) => <label key={track.id}><input checked={reviewerTrackIds.includes(track.id)} onChange={(event) => setReviewerTrackIds((current) => event.target.checked ? [...current, track.id] : current.filter((id) => id !== track.id))} type="checkbox" />{track.name}</label>)}</fieldset>
              <fieldset className="track-checks"><legend>Review pool · none selected means the first open round</legend>{config.rounds.filter((round) => round.status === "open").map((round) => <label key={round.id}><input checked={reviewerRoundIds.includes(round.id)} onChange={(event) => setReviewerRoundIds((current) => event.target.checked ? [...current, round.id] : current.filter((id) => id !== round.id))} type="checkbox" />{round.name}</label>)}</fieldset>
              <Button type="submit">Add reviewer</Button>
            </form>

            <section className="setup-card rounds-card">
              <p className="section-label">ROUNDS & POOLS</p><h2>Available, never required.</h2>
              <p className="criterion-policy">Weight changes recalculate worklist averages. Removing a criterion preserves submitted score values but excludes it from aggregates. Types lock after scoring begins.</p>
              <div className="round-list">{config.rounds.map((round) => (
                <article data-testid={`review-round-${round.id}`} key={round.id}>
                  <div><strong>{round.name}</strong><StatusChip tone={round.status === "open" ? "good" : "neutral"}>{round.status}</StatusChip></div>
                  <p>{round.anonymized ? "Blind review on" : "Speaker identity visible"} · {round.reviewerPool.length} reviewers</p>
                  <ul>{round.criteria.map((criterion) => (
                    <li className="criterion-row" key={criterion.id}>
                      <div><strong>{criterion.label}</strong><span>{criterion.criterionType.replace("_", " ")}{criterion.weight === null ? "" : ` · ×${criterion.weight}`}</span></div>
                      <details>
                        <summary>Edit</summary>
                        <form onSubmit={(event) => void updateCriterion(event, criterion)}>
                          <label className="review-field"><span>Criterion label</span><input defaultValue={criterion.label} name="label" required /></label>
                          <label className="review-field"><span>Type</span><select defaultValue={criterion.criterionType} name="criterionType"><option value="numeric">Numeric</option><option value="dropdown">Dropdown</option><option value="free_text">Free text</option></select></label>
                          <label className="review-field"><span>Dropdown options · comma separated</span><input defaultValue={criterion.options?.join(", ") ?? ""} name="options" /></label>
                          <label className="review-field"><span>Weight</span><input defaultValue={criterion.weight ?? ""} min="0.1" name="weight" step="0.1" type="number" /></label>
                          <label className="check-line"><input defaultChecked={criterion.required} name="required" type="checkbox" /> Required</label>
                          <div className="criterion-actions">
                            <Button type="submit">Save changes</Button>
                            <Button onClick={() => void removeCriterion(criterion)} tone="quiet" type="button">Remove criterion</Button>
                          </div>
                        </form>
                      </details>
                    </li>
                  ))}</ul>
                </article>
              ))}</div>
            </section>

            <form className="setup-card setup-form" onSubmit={(event) => void createRound(event)}>
              <p className="section-label">ADD ROUND</p><h2>Turn on another pass.</h2>
              <label className="review-field"><span>Round name</span><input name="name" required /></label>
              <label className="review-field"><span>Opens</span><input name="opensAt" type="datetime-local" /></label>
              <label className="review-field"><span>Closes</span><input name="closesAt" type="datetime-local" /></label>
              <label className="check-line"><input name="anonymized" type="checkbox" /> Hide speaker identity from reviewers</label>
              <Button type="submit">Create round</Button>
            </form>

            <form className="setup-card setup-form" onSubmit={(event) => void createCriterion(event)}>
              <p className="section-label">SCORECARD EDITOR</p><h2>Add one useful signal.</h2>
              <label className="review-field"><span>Round</span><select name="roundId" required>{config.rounds.map((round) => <option key={round.id} value={round.id}>{round.name}</option>)}</select></label>
              <label className="review-field"><span>Criterion</span><input name="label" required /></label>
              <label className="review-field"><span>Type</span><select name="criterionType"><option value="numeric">Numeric</option><option value="dropdown">Dropdown</option><option value="free_text">Free text</option></select></label>
              <label className="review-field"><span>Dropdown options · comma separated</span><input name="options" /></label>
              <label className="review-field"><span>Weight</span><input min="0.1" name="weight" step="0.1" type="number" defaultValue="1" /></label>
              <label className="check-line"><input name="required" type="checkbox" /> Required</label>
              <Button type="submit">Add criterion</Button>
            </form>

            <form className="setup-card setup-form" onSubmit={(event) => void addAssignment(event)}>
              <p className="section-label">EXPLICIT OVERRIDE</p><h2>Add one proposal.</h2><p>This adds to a track remit. It never becomes a gate for reading.</p>
              <label className="review-field"><span>Round</span><select name="roundId" required>{config.rounds.map((round) => <option key={round.id} value={round.id}>{round.name}</option>)}</select></label>
              <label className="review-field"><span>Reviewer</span><select name="reviewerUserId" required>{config.reviewers.map((reviewer) => <option key={reviewer.id} value={reviewer.id}>{reviewer.name}</option>)}</select></label>
              <label className="review-field"><span>Proposal</span><select name="submissionId" required>{config.submissions.map((submission) => <option key={submission.id} value={submission.id}>{submission.title}</option>)}</select></label>
              <Button type="submit">Add assignment</Button>
            </form>
          </div>
        )}
      </details>
      <Toast message={message} />
    </div>
  );
}
