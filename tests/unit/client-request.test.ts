// ABOUTME: Verifies shared browser requests stop waiting and report an actionable timeout.
// ABOUTME: Keeps every page using the shared JSON client from spinning indefinitely.
import { afterEach, describe, expect, it, vi } from "vitest";
import { getJson } from "../../client/lib.tsx";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("shared client requests", () => {
  it("rejects a request that exceeds its deadline", async () => {
    vi.useFakeTimers();
    const fetchRequest = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      })
    ));
    vi.stubGlobal("fetch", fetchRequest);

    const request = getJson("/api/never-finishes", 50);
    const rejection = expect(request).rejects.toThrow("Request timed out. Try again.");
    await vi.advanceTimersByTimeAsync(50);

    await rejection;
    expect(fetchRequest).toHaveBeenCalledOnce();
  });
});
