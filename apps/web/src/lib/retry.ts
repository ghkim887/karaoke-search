/**
 * Fetch with a single retry on network error or non-2xx response. The retry
 * waits `delayMs` (default 1000) before the second attempt. A 200 OK with
 * malformed JSON is the caller's responsibility — this helper only retries
 * the network/HTTP layer, not body parsing.
 */
export async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  delayMs = 1000,
): Promise<Response> {
  try {
    const res = await fetch(input, init);
    if (res.ok) return res;
    // Non-2xx — wait then retry once.
    await sleep(delayMs);
    const retry = await fetch(input, init);
    if (retry.ok) return retry;
    throw new Error(
      `fetch failed after retry: ${String(input)} — ${retry.status} ${retry.statusText}`,
    );
  } catch (firstErr) {
    // If the error came from the explicit throw above, surface it directly.
    if (firstErr instanceof Error && firstErr.message.startsWith('fetch failed after retry:')) {
      throw firstErr;
    }
    // Otherwise the *first* attempt threw (network failure). Wait and retry once.
    await sleep(delayMs);
    try {
      const retry = await fetch(input, init);
      if (retry.ok) return retry;
      throw new Error(
        `fetch failed after retry: ${String(input)} — ${retry.status} ${retry.statusText}`,
      );
    } catch (secondErr) {
      const cause = secondErr instanceof Error ? secondErr.message : String(secondErr);
      const orig = firstErr instanceof Error ? firstErr.message : String(firstErr);
      throw new Error(`fetch failed after retry: ${String(input)} — ${cause} (original: ${orig})`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
