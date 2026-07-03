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

/**
 * Delay before the next attempt: honor a parseable `Retry-After` on the given
 * response, otherwise fall back to exponential backoff. Both clamped to
 * RETRY_AFTER_MAX_MS. `res` is null on a network error (no header available).
 */
function nextDelayMs(attempt: number, res: Response | null): number {
  if (res !== null) {
    const retryAfterMs = parseRetryAfter(res.headers.get('Retry-After'));
    if (retryAfterMs !== null) return Math.min(retryAfterMs, RETRY_AFTER_MAX_MS);
  }
  return Math.min(backoffMs(attempt), RETRY_AFTER_MAX_MS);
}

/**
 * A non-2xx status worth retrying: transient server/rate-limit conditions.
 * Other non-2xx (notably 4xx client errors) are NOT retried — retrying a bad
 * request never succeeds — so callers can surface their own status-coded error.
 */
function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
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

    await sleep(nextDelayMs(attempt, res));
  }

  // Unreachable, but satisfies TypeScript
  throw new Error(`fetch failed after retry: ${String(input)}`);
}

/**
 * Retry helper tuned for JSON API calls whose callers do their own response
 * validation (status codes, body shape). Shares the same Retry-After/backoff
 * pacing as `fetchWithRetry`, but differs in two ways:
 *   - Only TRANSIENT failures retry: network errors and 5xx/429 responses. A
 *     non-transient non-ok response (e.g. 400/404) is returned unretried so the
 *     caller emits its own status-coded error message.
 *   - It resolves with the final `Response` (even non-ok) rather than throwing
 *     on non-ok; it throws only when every attempt was a network error and there
 *     is therefore no response to hand back.
 * A `fetchImpl` may be injected (defaults to global `fetch`) for testability.
 */
export async function fetchWithTransientRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  options?: { maxAttempts?: number; fetchImpl?: typeof fetch | undefined },
): Promise<Response> {
  const maxAttempts = options?.maxAttempts ?? MAX_ATTEMPTS;
  const doFetch = options?.fetchImpl ?? fetch;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let res: Response | null = null;
    let networkErr: unknown = null;

    try {
      res = await doFetch(input, init);
    } catch (err) {
      networkErr = err;
    }

    // A response we won't retry (ok, or a non-transient non-ok) is handed back
    // to the caller for its own status/shape handling.
    if (networkErr === null && res !== null && (res.ok || !isTransientStatus(res.status))) {
      return res;
    }

    // Out of attempts: return the last transient response if we have one;
    // otherwise every attempt was a network error, so throw.
    if (attempt === maxAttempts - 1) {
      if (networkErr === null && res !== null) return res;
      const detail = networkErr instanceof Error ? networkErr.message : String(networkErr);
      throw new Error(`fetch failed after retry: ${String(input)} — ${detail}`);
    }

    await sleep(nextDelayMs(attempt, res));
  }

  // Unreachable, but satisfies TypeScript
  throw new Error(`fetch failed after retry: ${String(input)}`);
}
