// ABOUTME: Renders a proposal permalink with committee discussion and lightweight scoring.
// ABOUTME: Hides speaker identity during blind rounds while preserving organizer visibility.
import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  AIReviewAssistance,
  ReviewCriterion,
  ReviewSubmissionDetail,
} from "../../../shared/api.ts";
import { Button, LoadingState, StatusChip, Toast } from "../../components/ui.tsx";
import { humanScoreChoiceMessage, ReviewLink, reviewRequest } from "./reviewClient.tsx";

function displayAnswer(value: ReviewSubmissionDetail["answers"][number]["value"]): string {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return value === null ? "No answer" : String(value);
}

function ScoreField({
  criterion,
  value,
  onChange,
}: {
  criterion: ReviewCriterion;
  value: string | number | undefined;
  onChange: (value: string | number) => void;
}) {
  const label = <span>{criterion.label}{criterion.required ? " · required" : ""}</span>;
  if (criterion.criterionType === "numeric") {
    return (
      <label className="review-field">
        {label}
        <input
          max="5"
          min="1"
          onChange={(event) => onChange(Number(event.target.value))}
          required={criterion.required}
          type="number"
          value={value ?? ""}
        />
        <small>1–5{criterion.weight === null ? "" : ` · weight ${criterion.weight}`}</small>
      </label>
    );
  }
  if (criterion.criterionType === "dropdown") {
    return (
      <label className="review-field">
        {label}
        <select
          onChange={(event) => onChange(event.target.value)}
          required={criterion.required}
          value={value ?? ""}
        >
          <option value="">Choose…</option>
          {(criterion.options ?? []).map((option) => <option key={option}>{option}</option>)}
        </select>
      </label>
    );
  }
  return (
    <label className="review-field">
      {label}
      <textarea
        onChange={(event) => onChange(event.target.value)}
        required={criterion.required}
        rows={3}
        value={value ?? ""}
      />
    </label>
  );
}

export function SubmissionReviewPage({
  role,
  submissionId,
  roundId,
}: {
  role: "organizer" | "reviewer";
  submissionId: string;
  roundId?: string;
}) {
  const [detail, setDetail] = useState<ReviewSubmissionDetail | null>(null);
  const [assistance, setAssistance] = useState<AIReviewAssistance | null>(null);
  const [assistanceLoading, setAssistanceLoading] = useState(false);
  const [comment, setComment] = useState("");
  const [scores, setScores] = useState<Record<string, string | number>>({});
  const [aiStartingPointId, setAIStartingPointId] = useState<string | null>(null);
  const [confirmedAiScoreCriterionIds, setConfirmedAiScoreCriterionIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [reviewComment, setReviewComment] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scorecardError, setScorecardError] = useState<string | null>(null);
  const scorecardRef = useRef<HTMLFormElement>(null);

  async function load({
    hydrateScorecard = false,
    showLoadError = false,
  }: {
    hydrateScorecard?: boolean;
    showLoadError?: boolean;
  } = {}): Promise<void> {
    try {
      const roundQuery = roundId === undefined ? "" : `?roundId=${encodeURIComponent(roundId)}`;
      const loadedDetail = await reviewRequest<ReviewSubmissionDetail>(
        `/api/review/submissions/${submissionId}${roundQuery}`,
      );
      setDetail(loadedDetail);
      if (hydrateScorecard) {
        const savedReview = role === "reviewer" ? loadedDetail.reviews[0] : undefined;
        setScores(savedReview?.scores ?? {});
        setReviewComment(savedReview?.comment ?? "");
      }
      if (role === "reviewer" && loadedDetail.round !== null) {
        try {
          const availability = await reviewRequest<AIReviewAssistance>(
            `/api/review/submissions/${submissionId}/ai-assistance?roundId=${encodeURIComponent(loadedDetail.round.id)}`,
          );
          setAssistance((current) =>
            current?.status === "ready" && availability.status === "available"
              ? current
              : availability
          );
        } catch {
          setAssistance({ status: "unavailable" });
        }
      } else {
        setAssistance(null);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "The proposal could not be loaded.";
      if (showLoadError) setLoadError(errorMessage);
      else setMessage(errorMessage);
    }
  }

  useEffect(() => {
    setDetail(null);
    setLoadError(null);
    setAIStartingPointId(null);
    setConfirmedAiScoreCriterionIds(new Set());
    void load({ hydrateScorecard: true, showLoadError: true });
  }, [submissionId, roundId]);

  async function requestAssistance(): Promise<void> {
    if (detail?.round === null || detail?.round === undefined) return;
    setAssistanceLoading(true);
    try {
      setAssistance(await reviewRequest<AIReviewAssistance>(
        `/api/review/submissions/${submissionId}/ai-assistance`,
        {
          method: "POST",
          body: JSON.stringify({ roundId: detail.round.id }),
        },
      ));
    } catch {
      setAssistance({ status: "unavailable" });
    } finally {
      setAssistanceLoading(false);
    }
  }

  async function addComment(event: FormEvent): Promise<void> {
    event.preventDefault();
    try {
      await reviewRequest(`/api/review/submissions/${submissionId}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: comment }),
      });
      setComment("");
      setMessage("Comment added to the committee thread.");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The comment could not be added.");
    }
  }

  async function submitScorecard(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (detail?.round === null || detail?.round === undefined) return;
    setScorecardError(null);
    try {
      await reviewRequest(`/api/review/submissions/${submissionId}/reviews`, {
        method: "POST",
        body: JSON.stringify({
          roundId: detail.round.id,
          scores,
          comment: reviewComment,
          aiSuggestionId: aiStartingPointId,
          confirmedAiScoreCriterionIds: [...confirmedAiScoreCriterionIds],
        }),
      });
      setAIStartingPointId(null);
      setConfirmedAiScoreCriterionIds(new Set());
      setScorecardError(null);
      setMessage("Scorecard saved. Your discussion stays separate and editable.");
      await load({ hydrateScorecard: true });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "The scorecard could not be saved.";
      if (errorMessage === humanScoreChoiceMessage) {
        setScorecardError(errorMessage);
        requestAnimationFrame(() => {
          scorecardRef.current
            ?.querySelector<HTMLInputElement>(".ai-score-confirmation input:not(:checked)")
            ?.focus();
        });
      } else {
        setMessage(errorMessage);
      }
    }
  }

  const backHref = role === "organizer" ? "/organizer/review" : "/reviewer";
  if (detail === null) {
    if (loadError !== null) {
      return (
        <section className="review-detail">
          <section className="state-card" role="alert">
            <p className="eyebrow">PROPOSAL UNAVAILABLE</p>
            <h1>This proposal isn’t available to you.</h1>
            <p>{loadError}</p>
            <ReviewLink className="button button--signal" href={backHref}>
              Back to {role === "reviewer" ? "Assigned proposals" : "committee review"}
            </ReviewLink>
          </section>
        </section>
      );
    }
    return <section className="review-detail"><ReviewLink href={backHref}>← Back to review</ReviewLink><LoadingState label="Loading proposal" /><Toast message={message} /></section>;
  }

  return (
    <section className="review-detail">
      <ReviewLink className="review-back" href={backHref}>← Back to review</ReviewLink>
      <header className="review-detail__header">
        <div>
          <p className="eyebrow">PROPOSAL PERMALINK · {detail.id}</p>
          <h1>{detail.title}</h1>
          <div className="review-tags">
            {detail.tracks.map((track) => <span key={track.id}>{track.name}</span>)}
            <StatusChip>{detail.status.replace("_", " ")}</StatusChip>
          </div>
        </div>
        {detail.round?.anonymized === true ? <span className="blind-badge">Identity hidden · this round only</span> : null}
      </header>

      <div className="review-detail__grid">
        <div>
          {role === "reviewer" && assistance?.status === "available" ? (
            <section className="ai-review-assistance" aria-labelledby="ai-assistance-heading">
              <p className="section-label">OPTIONAL AI READING AID</p>
              <h2 id="ai-assistance-heading">Ask for a faster first read.</h2>
              <p>Generate a short summary and suggestions against this round’s criteria when you want them.</p>
              <Button
                disabled={assistanceLoading}
                onClick={() => void requestAssistance()}
                type="button"
              >
                {assistanceLoading ? "Generating reading aid…" : "Generate AI reading aid"}
              </Button>
              <small>No proposal content is sent until you choose to generate.</small>
            </section>
          ) : null}
          {role === "reviewer" && assistance?.status === "ready" ? (
            <section className="ai-review-assistance" aria-labelledby="ai-assistance-heading">
              <div className="ai-review-assistance__heading">
                <div>
                  <p className="section-label">SUGGESTION ONLY</p>
                  <h2 id="ai-assistance-heading">AI-generated reading aid</h2>
                </div>
                <span>{assistance.cached ? "Cached" : "Generated now"}</span>
              </div>
              <p className="ai-review-summary">{assistance.summary}</p>
              <div className="ai-review-suggestions">
                {detail.criteria.map((criterion) => {
                  const suggestion = assistance.suggestedScores[criterion.id];
                  if (suggestion === undefined) return null;
                  return (
                    <article key={criterion.id}>
                      <div><strong>{criterion.label}</strong><span>{suggestion}</span></div>
                      {assistance.reasoning[criterion.id] === undefined
                        ? null
                        : <p>{assistance.reasoning[criterion.id]}</p>}
                    </article>
                  );
                })}
              </div>
              <Button
                disabled={Object.keys(assistance.suggestedScores).length === 0}
                onClick={() => {
                  setScores({ ...assistance.suggestedScores });
                  setAIStartingPointId(assistance.suggestionId);
                  setConfirmedAiScoreCriterionIds(new Set());
                }}
                type="button"
              >
                Use as a starting point
              </Button>
              <small>{assistance.attribution}. Change or explicitly confirm each suggested value before submitting.</small>
            </section>
          ) : null}
          {role === "reviewer" && assistance?.status === "unavailable" ? (
            <section className="ai-review-assistance ai-review-assistance--unavailable" aria-labelledby="ai-assistance-heading">
              <p className="section-label">AI-GENERATED READING AID</p>
              <h2 id="ai-assistance-heading">Unavailable right now.</h2>
              <p>Review normally. Your scorecard and committee thread still work.</p>
            </section>
          ) : null}
          <article className="proposal-copy">
            <p className="section-label">THE PROPOSAL</p>
            <p>{detail.abstract}</p>
            <dl className="proposal-facts">
              <div><dt>Format</dt><dd>{detail.format?.name ?? "Not specified"}</dd></div>
              <div><dt>Audience level</dt><dd>{detail.audienceLevel ?? "Not specified"}</dd></div>
              <div><dt>Tracks</dt><dd>{detail.tracks.map((track) => track.name).join(", ") || "Not specified"}</dd></div>
            </dl>
            {detail.answers.length === 0 ? null : (
              <section className="proposal-answers" aria-labelledby="proposal-answers-heading">
                <h2 id="proposal-answers-heading">Submitted answers</h2>
                <dl>
                  {detail.answers.map((answer) => (
                    <div key={answer.key}>
                      <dt>{answer.label}</dt>
                      <dd>{displayAnswer(answer.value)}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}
            {detail.notesForReviewers === null ? null : <aside><strong>Reviewer note</strong><p>{detail.notesForReviewers}</p></aside>}
          </article>
          <section className="discussion-panel" aria-labelledby="discussion-heading">
            <div className="discussion-panel__heading">
              <div><p className="section-label">COMMITTEE THREAD</p><h2 id="discussion-heading">Talk it through here.</h2></div>
              <span>{detail.comments.length} comments</span>
            </div>
            <div className="comment-stream">
              {detail.comments.length === 0 ? <p className="thread-empty">Start the conversation. This link is the shared room for this proposal.</p> : null}
              {detail.comments.map((item) => (
                <article className="review-comment" key={item.id}>
                  <div><strong>{item.author.name}</strong><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time></div>
                  <p>{item.body}</p>
                </article>
              ))}
            </div>
            <form className="comment-composer" onSubmit={(event) => void addComment(event)}>
              <label htmlFor="committee-comment">Add to the committee thread</label>
              <textarea id="committee-comment" onChange={(event) => setComment(event.target.value)} required rows={4} value={comment} />
              <Button type="submit">Post comment</Button>
            </form>
          </section>
        </div>

        <aside className="review-sidebar">
          <section>
            <p className="section-label">SPEAKERS</p>
            {detail.participants.length === 0 ? <p>Speaker identity is hidden for this round.</p> : detail.participants.map((participant) => (
              <div className="participant" key={participant.id}>
                <strong>{participant.name}</strong>
                <span>{participant.roleLabel}</span>
                <small>{[participant.jobTitle, participant.organization].filter(Boolean).join(" · ")}</small>
              </div>
            ))}
          </section>
          {role === "reviewer" && detail.round !== null ? (
            <form className="scorecard" onSubmit={(event) => void submitScorecard(event)} ref={scorecardRef}>
              <div>
                <p className="section-label">LIGHTWEIGHT SCORECARD</p>
                <h2>{detail.round.name}</h2>
                {detail.reviews.length === 0
                  ? <p>Conversation comes first. Ratings help order the meeting.</p>
                  : <p className="scorecard__state">Editing saved scorecard</p>}
              </div>
              {scorecardError === null ? null : <p className="scorecard__state" role="alert">{scorecardError}</p>}
              {detail.criteria.map((criterion) => {
                const suggestion = assistance?.status === "ready"
                  ? assistance.suggestedScores[criterion.id]
                  : undefined;
                const needsConfirmation = aiStartingPointId !== null &&
                  suggestion !== undefined && scores[criterion.id] === suggestion;
                return (
                  <div key={criterion.id}>
                    <ScoreField
                      criterion={criterion}
                      onChange={(value) => setScores((current) => ({ ...current, [criterion.id]: value }))}
                      value={scores[criterion.id]}
                    />
                    {needsConfirmation ? (
                      <label className="ai-score-confirmation">
                        <input
                          checked={confirmedAiScoreCriterionIds.has(criterion.id)}
                          onChange={(event) => setConfirmedAiScoreCriterionIds((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(criterion.id);
                            else next.delete(criterion.id);
                            return next;
                          })}
                          type="checkbox"
                        />
                        <span>I confirm {criterion.label} as my choice</span>
                      </label>
                    ) : null}
                  </div>
                );
              })}
              <label className="review-field"><span>Scorecard note</span><textarea onChange={(event) => setReviewComment(event.target.value)} rows={3} value={reviewComment} /></label>
              <Button type="submit">{detail.reviews.length === 0 ? "Save scorecard" : "Update scorecard"}</Button>
            </form>
          ) : null}
          {role === "organizer" ? (
            <section className="recorded-reviews">
              <p className="section-label">RECORDED SCORECARDS</p>
              {detail.reviews.length === 0 ? <p>No ratings yet.</p> : detail.reviews.map((review) => (
                <article key={review.id}>
                  <div><strong>{review.author.name}</strong><span>{review.aggregateScore?.toFixed(2) ?? "—"}</span></div>
                  <small>{review.round.name}</small>
                  {review.comment === null ? null : <p>{review.comment}</p>}
                </article>
              ))}
            </section>
          ) : null}
        </aside>
      </div>
      <Toast message={message} />
    </section>
  );
}
