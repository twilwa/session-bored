// ABOUTME: Provides same-origin review requests and client-side permalink navigation.
// ABOUTME: Keeps review pages fast without full document reloads or duplicated fetch handling.
import type { MouseEvent, ReactNode } from "react";

const reviewErrorMessages: Record<string, string> = {
  forbidden: "This proposal is not in your current assignment or review round.",
  human_score_choice_required: "Change or confirm each AI-suggested score before saving.",
};

export const humanScoreChoiceMessage = reviewErrorMessages.human_score_choice_required!;

export function reviewErrorMessage(errorKey: string, status: number): string {
  const fallback = errorKey.replaceAll("_", " ");
  return reviewErrorMessages[errorKey] ?? (fallback === "" ? `Request failed (${status})` : fallback);
}

export async function reviewRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers,
  });
  if (!response.ok) {
    const payload: { error?: string } = await response.json<{ error?: string }>()
      .catch(() => ({} as { error?: string }));
    const errorKey = payload.error;
    throw new Error(
      errorKey === undefined
        ? `Request failed (${response.status})`
        : reviewErrorMessage(errorKey, response.status),
    );
  }
  return response.json<T>();
}

export function navigateReview(path: string): void {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function ReviewLink({
  href,
  children,
  className = "",
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  function follow(event: MouseEvent<HTMLAnchorElement>): void {
    if (!event.metaKey && !event.ctrlKey && !event.shiftKey) {
      event.preventDefault();
      navigateReview(href);
    }
  }

  return <a className={className} href={href} onClick={follow}>{children}</a>;
}
