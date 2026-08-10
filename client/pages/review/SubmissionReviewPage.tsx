// ABOUTME: Renders a proposal permalink with committee discussion and lightweight scoring.
// ABOUTME: Hides speaker identity during blind rounds while preserving organizer visibility.
import { useEffect, useState, type FormEvent } from "react";
import type {
  AIReviewAssistance,
  ReviewCriterion,
  ReviewSubmissionDetail,
} from "../../../shared/api.ts";
import { Button, LoadingState, StatusChip, Toast } from "../../components/ui.tsx";
import { ReviewLink, reviewRequest } from "./reviewClient.tsx";

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
  const [comment, setComment] = useState("");
  const [scores, setScores] = useState<Record<string, string | number>>({});
  const [reviewComment, setReviewComment] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      const roundQuery = roundId === undefined ? "" : `?roundId=${encodeURIComponent(roundId)}`;
      const loadedDetail = await reviewRequest<ReviewSubmissionDetail>(
        `/api/review/submissions/${submissionId}${roundQuery}`,
      );
      setDetail(loadedDetail);
      if (role === "reviewer" && loadedDetail.round !== null) {
        try {
          setAssistance(await reviewRequest<AIReviewAssistance>(
            `/api/review/submissions/${submissionId}/ai-assistance`,
            {
              method: "POST",
              body: JSON.stringify({ roundId: loadedDetail.round.id }),
            },
          ));
        } catch {
          setAssistance({ status: "unavailable" });
        }
      } else {
        setAssistance(null);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The proposal could not be loaded.");
    }
  }

  useEffect(() => { void load(); }, [submissionId, roundId]);

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
    try {
      await reviewRequest(`/api/review/submissions/${submissionId}/reviews`, {
        method: "POST",
        body: JSON.stringify({ roundId: detail.round.id, scores, comment: reviewComment }),
      });
      setMessage("Scorecard saved. Your discussion stays separate and editable.");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The scorecard could not be saved.");
    }
  }

  const backHref = role === "organizer" ? "/organizer/review" : "/reviewer";
  if (detail === null) {
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
                onClick={() => setScores({ ...assistance.suggestedScores })}
                type="button"
              >
                Use as a starting point
              </Button>
              <small>{assistance.attribution}. Nothing is saved until you submit the scorecard.</small>
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
            <form className="scorecard" onSubmit={(event) => void submitScorecard(event)}>
              <div><p className="section-label">LIGHTWEIGHT SCORECARD</p><h2>{detail.round.name}</h2><p>Conversation comes first. Ratings help order the meeting.</p></div>
              {detail.criteria.map((criterion) => (
                <ScoreField
                  criterion={criterion}
                  key={criterion.id}
                  onChange={(value) => setScores((current) => ({ ...current, [criterion.id]: value }))}
                  value={scores[criterion.id]}
                />
              ))}
              <label className="review-field"><span>Scorecard note</span><textarea onChange={(event) => setReviewComment(event.target.value)} rows={3} value={reviewComment} /></label>
              <Button type="submit">Save scorecard</Button>
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
