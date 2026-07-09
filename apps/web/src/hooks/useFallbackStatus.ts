import { useEffect, useState } from 'preact/hooks';
import { type SearchBackend, isFallbackStatusSource } from '../lib/backend.js';

/** Per-source fallback-active snapshot (T4-6). Each flag is true while that
 *  view's most recent data operation was served from the local corpus because
 *  the API failed. Kept separate so the App can gate the offline hint on the
 *  ACTIVE view — a background favorites prefetch failure must not mark the
 *  Browse results on screen as offline. */
export interface FallbackStatus {
  browse: boolean;
  favorites: boolean;
}

const INACTIVE: FallbackStatus = { browse: false, favorites: false };

/**
 * Subscribes to a backend's per-source fallback signal (T4-6). Backends without
 * the fallback capability (the offline/local-dev backend, or a plain API
 * backend) report every source `false` forever — the hook is a no-op for them,
 * so the healthy-path DOM is unchanged.
 */
export function useFallbackStatus(backend: SearchBackend): FallbackStatus {
  const [status, setStatus] = useState<FallbackStatus>(INACTIVE);

  useEffect(() => {
    if (!isFallbackStatusSource(backend)) {
      setStatus(INACTIVE);
      return;
    }
    // Sync to the current values on mount, then track changes.
    const sync = () =>
      setStatus({
        browse: backend.isFallbackActive('browse'),
        favorites: backend.isFallbackActive('favorites'),
      });
    sync();
    return backend.subscribeFallback(sync);
  }, [backend]);

  return status;
}
