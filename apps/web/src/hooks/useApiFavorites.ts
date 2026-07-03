import type { SongRecord } from '@karaoke/schema';
import { useEffect, useState } from 'preact/hooks';
import type { SearchBackend } from '../lib/backend.js';

interface UseApiFavoritesInput {
  activeTab: 'browse' | 'favorites';
  favoriteIds: string[];
  /** Bumped by the Retry button to re-issue the failed request in place. */
  retryNonce: number;
}

export interface ApiFavoritesResult {
  /** Fetched favorite records in favorite order, or `null` before first fetch.
   *  Always `null` in offline mode (favorites resolve from the bundle). */
  apiFavorites: SongRecord[] | null;
  /** API favorites hydration failed while the Favorites tab is showing them —
   *  surfaced as an error, not an empty favorites view. */
  favoritesFailed: boolean;
}

/**
 * Hydrates the favorites set via the worker `/api/songs` endpoint and re-sorts
 * the returned records into favorite order (the worker does not guarantee
 * order). Query-within-favorites is a client-side filter over this set, done in
 * `useSearchResults`. Offline backend: no-op — favorites resolve from the loaded
 * bundle instead.
 */
export function useApiFavorites(
  backend: SearchBackend,
  { activeTab, favoriteIds, retryNonce }: UseApiFavoritesInput,
): ApiFavoritesResult {
  const [apiFavorites, setApiFavorites] = useState<SongRecord[] | null>(null);
  const [status, setStatus] = useState<'idle' | 'pending' | 'success' | 'error'>('idle');

  useEffect(() => {
    if (backend.requiresLocalCorpus) return;
    if (favoriteIds.length === 0) {
      setApiFavorites([]);
      setStatus('success');
      return;
    }
    let cancelled = false;
    const order = new Map(favoriteIds.map((id, i) => [id, i] as const));
    setStatus('pending');
    backend
      .getFavorites(favoriteIds)
      .then((records) => {
        if (cancelled) return;
        const sorted = [...records].sort(
          (a, b) =>
            (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
            (order.get(b.id) ?? Number.MAX_SAFE_INTEGER),
        );
        setApiFavorites(sorted);
        setStatus('success');
      })
      .catch(() => {
        if (!cancelled) {
          setApiFavorites([]);
          setStatus('error');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [backend, favoriteIds, retryNonce]);

  const favoritesFailed =
    !backend.requiresLocalCorpus &&
    activeTab === 'favorites' &&
    favoriteIds.length > 0 &&
    status === 'error';

  return { apiFavorites, favoritesFailed };
}
