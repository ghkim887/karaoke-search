import type { SongRecord } from '@karaoke/schema';
import type MiniSearch from 'minisearch';
import type { Vendor } from '../components/VendorChips.js';
import { filterByVendors } from './filter.js';
import { type SearchVendor, searchLocalIndex } from './search.js';
import type { IndexBundle } from './search.js';

/**
 * Per-(query, vendors) browse fetch state for the API backend. `key` identifies
 * the request the `records` belong to so a stale response never leaks into a
 * newer query (see `apiBrowseKey`).
 */
export interface ApiBrowseState {
  key: string;
  records: SongRecord[] | null;
  status: 'idle' | 'pending' | 'success' | 'error';
}

/** The selected vendors as a stable, sorted `SearchVendor[]` for the API
 *  `vendors` union param. Empty when no vendor chip is active. */
export function selectedVendorsForApi(selectedVendors: ReadonlySet<Vendor>): SearchVendor[] {
  return Array.from(selectedVendors).sort();
}

/** Stable identity for an API browse request: the debounced query plus the
 *  sorted vendor selection, joined by a NUL so query text can never collide
 *  with the vendor segment. Matched against `ApiBrowseState.key` so a resolved
 *  response is only consumed by the query that issued it. */
const KEY_SEP = String.fromCharCode(0);
export function apiBrowseKey(query: string, selectedVendors: ReadonlySet<Vendor>): string {
  const vendorKey = Array.from(selectedVendors).sort().join(',');
  return `${query}${KEY_SEP}${vendorKey}`;
}

interface BrowseInput {
  query: string;
  selectedVendors: ReadonlySet<Vendor>;
  bundle: IndexBundle | null;
  apiBrowse: ApiBrowseState;
}

/**
 * Browse candidate set (before vendor filter + slice).
 *
 * API mode (`requiresLocalCorpus` false): exclusively the worker result for the
 * current (query, vendors) key — there is no local bundle to fall back to, so a
 * pending/failed request yields no results until the API resolves. Offline mode
 * (`requiresLocalCorpus` true): MiniSearch over the downloaded bundle.
 */
export function resolveBrowseCandidates(
  requiresLocalCorpus: boolean,
  { query, selectedVendors, bundle, apiBrowse }: BrowseInput,
): SongRecord[] {
  if (query === '') return [];
  if (!requiresLocalCorpus) {
    const currentApiKey = apiBrowseKey(query, selectedVendors);
    if (apiBrowse.key === currentApiKey && apiBrowse.records !== null) {
      return apiBrowse.records;
    }
    // API mode has no local bundle to fall back to; a pending/failed request
    // yields no candidates until the API resolves.
    return [];
  }
  if (bundle === null) return [];
  // Vendor chips scope karaoke-number matches to the selected providers, so the
  // offline number path converges with the worker's `kn.provider IN (...)`
  // filter. `finalizeResults` still applies the OR vendor filter afterwards.
  const hits = searchLocalIndex(bundle.index, query, { vendors: selectedVendors });
  const records: SongRecord[] = [];
  for (const hit of hits) {
    const rec = bundle.byId.get(String(hit.id));
    if (rec !== undefined) records.push(rec);
  }
  return records;
}

interface FavoritesInput {
  query: string;
  favoriteIds: string[];
  bundle: IndexBundle | null;
  apiFavorites: SongRecord[] | null;
  /** Prebuilt search index over the API favorites set (P5: depends only on the
   *  favorites records, not on `query`). Ignored in offline mode. */
  apiFavoriteIndex: MiniSearch<SongRecord> | null;
}

/**
 * Favorites candidate set (before vendor filter + slice).
 *
 * Offline mode: ids resolved against the bundle, then narrowed (if a query is
 * present) by searching the whole corpus and keeping favorite hits in relevance
 * order. API mode: the fetched, favorite-ordered set, narrowed client-side
 * through a favorites-only index and re-sorted back into favorite order.
 */
export function resolveFavoriteCandidates(
  requiresLocalCorpus: boolean,
  { query, favoriteIds, bundle, apiFavorites, apiFavoriteIndex }: FavoritesInput,
): SongRecord[] {
  if (requiresLocalCorpus) {
    if (bundle === null) return [];
    const favRecords: SongRecord[] = [];
    for (const id of favoriteIds) {
      const rec = bundle.byId.get(id);
      if (rec !== undefined) favRecords.push(rec);
    }
    if (query === '') return favRecords;
    const favIdSet = new Set(favoriteIds);
    const hits = searchLocalIndex(bundle.index, query);
    const candidates: SongRecord[] = [];
    for (const hit of hits) {
      const id = String(hit.id);
      if (favIdSet.has(id)) {
        const rec = bundle.byId.get(id);
        if (rec !== undefined) candidates.push(rec);
      }
    }
    return candidates;
  }

  const favRecords = apiFavorites ?? [];
  if (query === '' || apiFavoriteIndex === null) return favRecords;
  const byId = new Map(favRecords.map((r) => [r.id, r] as const));
  const order = new Map(favRecords.map((r, i) => [r.id, i] as const));
  const hits = searchLocalIndex(apiFavoriteIndex, query);
  const candidates: SongRecord[] = [];
  for (const hit of hits) {
    const rec = byId.get(String(hit.id));
    if (rec !== undefined) candidates.push(rec);
  }
  // Preserve favorite order — MiniSearch returns by relevance score.
  candidates.sort(
    (a, b) =>
      (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  );
  return candidates;
}

/** Apply the vendor chip filter and the result cap to a candidate set. */
export function finalizeResults(
  candidates: SongRecord[],
  selectedVendors: ReadonlySet<Vendor>,
  limit: number,
): SongRecord[] {
  return filterByVendors(candidates, selectedVendors).slice(0, limit);
}
