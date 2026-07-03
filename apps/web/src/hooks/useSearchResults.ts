import type { SongRecord } from '@karaoke/schema';
import { useMemo } from 'preact/hooks';
import type { Vendor } from '../components/VendorChips.js';
import type { SearchBackend } from '../lib/backend.js';
import { RESULT_LIMIT } from '../lib/constants.js';
import {
  type ApiBrowseState,
  finalizeResults,
  resolveBrowseCandidates,
  resolveFavoriteCandidates,
} from '../lib/results.js';
import { buildIndex } from '../lib/search.js';
import type { IndexBundle } from '../lib/search.js';

interface UseSearchResultsInput {
  activeTab: 'browse' | 'favorites';
  query: string;
  selectedVendors: ReadonlySet<Vendor>;
  bundle: IndexBundle | null;
  apiBrowse: ApiBrowseState;
  apiFavorites: SongRecord[] | null;
  favoriteIds: string[];
}

/**
 * The single results pipeline: pick the candidate set for the active
 * (tab, query, backend), then apply the vendor filter + result cap. Replaces
 * the former four-path inline `useMemo` in `App`; the backend-mode branch lives
 * in the pure `resolve*Candidates` helpers.
 */
export function useSearchResults(
  backend: SearchBackend,
  {
    activeTab,
    query,
    selectedVendors,
    bundle,
    apiBrowse,
    apiFavorites,
    favoriteIds,
  }: UseSearchResultsInput,
): SongRecord[] {
  const requiresLocalCorpus = backend.requiresLocalCorpus;

  // P5 fix: build the favorites-only search index from the fetched favorites
  // once (keyed on the records), not on every keystroke inside the query memo.
  // Offline mode narrows against the full bundle, so no favorites index is used.
  const apiFavoriteIndex = useMemo(
    () => (requiresLocalCorpus ? null : buildIndex(apiFavorites ?? [])),
    [requiresLocalCorpus, apiFavorites],
  );

  return useMemo(() => {
    const candidates =
      activeTab === 'favorites'
        ? resolveFavoriteCandidates(requiresLocalCorpus, {
            query,
            favoriteIds,
            bundle,
            apiFavorites,
            apiFavoriteIndex,
          })
        : resolveBrowseCandidates(requiresLocalCorpus, {
            query,
            selectedVendors,
            bundle,
            apiBrowse,
          });
    return finalizeResults(candidates, selectedVendors, RESULT_LIMIT);
  }, [
    requiresLocalCorpus,
    activeTab,
    query,
    selectedVendors,
    bundle,
    apiBrowse,
    apiFavorites,
    apiFavoriteIndex,
    favoriteIds,
  ]);
}
