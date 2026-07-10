import { useState } from 'preact/hooks';

export interface RetrySignal {
  /** Monotonically-increasing nonce. Wired into the API browse/favorites hooks'
   *  effect deps so bumping it re-issues the failed request in place. */
  retryNonce: number;
  /** Bump the nonce — re-runs the API browse + favorites effects with the
   *  current query/favorites; the active view's request is retried and the
   *  other is a harmless idempotent refetch. */
  retry: () => void;
}

/**
 * Owns the retry signal shared by the API browse and favorites hooks. Kept as a
 * standalone counter (not per-view) because a single Retry button re-issues
 * whichever request failed; the inactive view's refetch is idempotent.
 */
export function useRetryNonce(): RetrySignal {
  const [retryNonce, setRetryNonce] = useState(0);
  const retry = () => setRetryNonce((n) => n + 1);
  return { retryNonce, retry };
}
