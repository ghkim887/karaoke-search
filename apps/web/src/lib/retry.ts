/**
 * Fetch with retry on network error or non-2xx response.
 *
 * Retry strategy (up to MAX_ATTEMPTS total):
 *   1. If the response carries a parseable `Retry-After` header, use that
 *      delay (clamped to RETRY_AFTER_MAX_MS) so the server drives the pacing.
 *   2. Otherwise use exponential backoff: `1000 * 2^attempt` ms base, ±20% jitter.
 *
 * Network errors (throw from fetch) also use the backoff path — no Retry-After
 * header is available in that case.
 *
 * A 200 OK with malformed JSON is the caller's responsibility — this helper
 * only retries the network/HTTP layer, not body parsing.
 */

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 1000;
const RETRY_AFTER_MAX_MS = 30_000;

/** Parse RFC 7231 §7.1.3 Retry-After header value. Returns ms or null. */
function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  // Integer seconds form
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  // HTTP-date form
  const ts = Date.parse(trimmed);
  if (!Number.isNaN(ts)) {
    return Math.max(0, ts - Date.now());
  }
  return null;
}

/** Backoff for attempt index (0-based): base * 2^attempt ± 20% jitter. */
function backoffMs(attempt: number): number {
  const base = BASE_DELAY_MS * 2 ** attempt;
  return Math.round(base * (0.8 + 0.4 * Math.random()));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  _delayMs = 1000, // kept for backwards-compat; ignored — backoff drives timing now
  options?: { maxAttempts?: number },
): Promise<Response> {
  const maxAttempts = options?.maxAttempts ?? MAX_ATTEMPTS;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let res: Response | null = null;
    let networkErr: unknown = null;

    try {
      res = await fetch(input, init);
    } catch (err) {
      networkErr = err;
    }

    // Success
    if (networkErr === null && res !== null && res.ok) return res;

    // Last attempt — throw
    if (attempt === maxAttempts - 1) {
      const detail =
        networkErr !== null
          ? networkErr instanceof Error
            ? networkErr.message
            : String(networkErr)
          : res !== null
            ? `${res.status} ${res.statusText}`
            : 'no response';
      throw new Error(`fetch failed after retry: ${String(input)} — ${detail}`);
    }

    // Compute delay before next attempt
    let delay: number;
    if (networkErr === null && res !== null) {
      // Non-2xx response: honor Retry-After if present
      const retryAfterMs = parseRetryAfter(res.headers.get('Retry-After'));
      delay =
        retryAfterMs !== null
          ? Math.min(retryAfterMs, RETRY_AFTER_MAX_MS)
          : Math.min(backoffMs(attempt), RETRY_AFTER_MAX_MS);
    } else {
      // Network failure: use backoff only
      delay = Math.min(backoffMs(attempt), RETRY_AFTER_MAX_MS);
    }

    await sleep(delay);
  }

  // Unreachable, but satisfies TypeScript
  throw new Error(`fetch failed after retry: ${String(input)}`);
}
