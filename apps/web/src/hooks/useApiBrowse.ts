import { useEffect, useState } from 'preact/hooks';
import type { Vendor } from '../components/VendorChips.js';
import type { SearchBackend } from '../lib/backend.js';
import { RESULT_LIMIT } from '../lib/constants.js';
import { type ApiBrowseState, apiBrowseKey, selectedVendorsForApi } from '../lib/results.js';

interface UseApiBrowseInput {
  activeTab: 'browse' | 'favorites';
  query: string;
  selectedVendors: ReadonlySet<Vendor>;
  /** Bumped by the Retry button to re-issue the failed request in place. */
  retryNonce: number;
}

export interface ApiBrowseResult {
  apiBrowse: ApiBrowseState;
  /** API Browse request in flight (or superseded) for the current query — the
   *  view should show a searching state, not NoResults. */
  browseSearchPending: boolean;
  /** API Browse request for the current query failed — an ERROR, distinct from
   *  a genuine zero-result search. Keyed to the current query so a stale error
   *  never leaks into a new view. */
  browseSearchFailed: boolean;
}

const IDLE: ApiBrowseState = { key: '', records: null, status: 'idle' };

/**
 * Drives the API Browse fetch (worker `/api/search`) and derives the
 * pending/failed signals for the current query. Offline backend: no-op — the
 * offline Browse path searches the in-memory bundle synchronously, so this
 * stays idle and both signals are `false`.
 */
export function useApiBrowse(
  backend: SearchBackend,
  { activeTab, query, selectedVendors, retryNonce }: UseApiBrowseInput,
): ApiBrowseResult {
  const [apiBrowse, setApiBrowse] = useState<ApiBrowseState>(IDLE);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retryNonce is intentionally in the deps to re-run the fetch when the user presses Retry.
  useEffect(() => {
    if (backend.requiresLocalCorpus || activeTab !== 'browse' || query === '') {
      setApiBrowse(IDLE);
      return;
    }
    let cancelled = false;
    const key = apiBrowseKey(query, selectedVendors);
    const vendors = selectedVendorsForApi(selectedVendors);
    setApiBrowse({ key, records: null, status: 'pending' });
    backend
      .browse(query, vendors, RESULT_LIMIT)
      .then((records) => {
        if (!cancelled) setApiBrowse({ key, records, status: 'success' });
      })
      .catch(() => {
        if (!cancelled) setApiBrowse({ key, records: [], status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [backend, activeTab, query, selectedVendors, retryNonce]);

  const currentKey =
    activeTab === 'browse' && query !== '' ? apiBrowseKey(query, selectedVendors) : '';
  const active = !backend.requiresLocalCorpus && activeTab === 'browse' && query !== '';
  const browseSearchPending =
    active && (apiBrowse.key !== currentKey || apiBrowse.status === 'pending');
  const browseSearchFailed = active && apiBrowse.key === currentKey && apiBrowse.status === 'error';

  return { apiBrowse, browseSearchPending, browseSearchFailed };
}
