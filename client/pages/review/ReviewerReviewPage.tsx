// ABOUTME: Shows reviewers only the proposals in their round, track, or explicit remit.
// ABOUTME: Opens each assignment into the shared permalink discussion and scorecard view.
import { useEffect, useState } from "react";
import { LoadingState, StatusChip, Toast } from "../../components/ui.tsx";
import { ReviewLink, reviewRequest } from "./reviewClient.tsx";
import { SubmissionReviewPage } from "./SubmissionReviewPage.tsx";
import "./review.css";

interface QueueItem {
  assignmentId: string | null;
  assignmentStatus: "assigned" | "completed" | "recused" | "unreviewed";
  roundId: string;
  roundName: string;
  anonymized: boolean;
  submissionId: string;
  title: string | null;
  status: string;
}

export function ReviewerReviewPage({ path }: { path: string }) {
  const detailPrefix = "/reviewer/submissions/";
  if (path.startsWith(detailPrefix)) {
    const roundId = new URLSearchParams(window.location.search).get("roundId") ?? undefined;
    return <SubmissionReviewPage role="reviewer" {...(roundId === undefined ? {} : { roundId })} submissionId={decodeURIComponent(path.slice(detailPrefix.length))} />;
  }
  return <ReviewerQueue />;
}

function ReviewerQueue() {
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    reviewRequest<{ items: QueueItem[] }>("/api/review/queue")
      .then((payload) => setItems(payload.items))
      .catch((error) => setMessage(error instanceof Error ? error.message : "The review queue could not be loaded."));
  }, []);
  const completed = items?.filter((item) => item.assignmentStatus === "completed").length ?? 0;
  const total = items?.length ?? 0;
  const completion = total === 0 ? 0 : Math.round((completed / total) * 100);

  return (
    <div className="review-workspace reviewer-workspace">
      <header className="review-hero review-hero--reviewer">
        <div><p className="eyebrow">YOUR COMMITTEE DESK</p><h1>Read the proposal.<br /><em>Join the conversation.</em></h1><p>Your queue is exactly your track remit plus any explicit additions. Assignment is never required before you can read within that remit.</p></div>
        <div className="coverage-dial"><strong>{completion}%</strong><span>complete</span><small>{completed} of {total} scorecards</small></div>
      </header>
      <section className="reviewer-note"><strong>Coverage worklist</strong><span>Open the talks still waiting on your read. Every proposal has one durable committee thread.</span>{items === null ? null : <StatusChip tone="signal">{items.length === 1 ? "1 assigned proposal" : `${items.length} proposals in remit`}</StatusChip>}</section>
      {items === null ? <LoadingState label="Loading your review queue" /> : (
        <section className="review-list" aria-label="Your review queue">
          {[...items]
            .sort((left, right) => Number(left.assignmentStatus === "completed") - Number(right.assignmentStatus === "completed"))
            .map((item, index) => (
              <article className="review-row reviewer-row" key={`${item.roundId}:${item.submissionId}`}>
                <span className="review-row__rank">{String(index + 1).padStart(2, "0")}</span>
                <div className="review-row__proposal">
                  <div className="review-tags"><span>{item.roundName}</span>{item.anonymized ? <span>Blind</span> : null}</div>
                  <ReviewLink href={`/reviewer/submissions/${item.submissionId}?roundId=${encodeURIComponent(item.roundId)}`}><h2>{item.title}</h2></ReviewLink>
                  <small>Permanent committee link · {item.submissionId}</small>
                </div>
                <StatusChip tone={item.assignmentStatus === "completed" ? "good" : "signal"}>{item.assignmentStatus}</StatusChip>
              </article>
            ))}
        </section>
      )}
      <Toast message={message} />
    </div>
  );
}
