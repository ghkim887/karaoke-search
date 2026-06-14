import type { SongRecord } from '@karaoke/schema';
import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useFavorites } from '../lib/favorites.js';
import { filterByVendors } from '../lib/filter.js';
import type { IndexBundle } from '../lib/search.js';
import {
  type SearchVendor,
  buildIndex,
  fetchSongsByIds,
  getApiSearchBaseUrl,
  loadIndex,
  searchApi,
  searchLocalIndex,
} from '../lib/search.js';
import { EmptyState } from './EmptyState.js';
import { ErrorState } from './ErrorState.js';
import { FavoritesEmpty } from './FavoritesEmpty.js';
import { NoResults } from './NoResults.js';
import { ResultList } from './ResultList.js';
import { SearchBox } from './SearchBox.js';
import type { TabId } from './TabBar.js';
import { TabBar } from './TabBar.js';
import type { Vendor } from './VendorChips.js';
import { VendorChips } from './VendorChips.js';

const RESULT_LIMIT = 50;
const DEBOUNCE_MS = 150;

interface ApiBrowseState {
  key: string;
  records: SongRecord[] | null;
  status: 'idle' | 'pending' | 'success' | 'error';
}

interface AppProps {
  /** Build-time record count from `apps/web/public/data/songs.json`. Surfaces
   *  in the loading-state label so it always tracks the live corpus. Wired
   *  through from `index.astro` Astro frontmatter. */
  songCount: number;
}

/**
 * Render-branch discriminator. The order in which `renderBody()` checks these
 * is fixed by spec (see the docstring on `renderBody` below). Keep this union
 * exhaustive — adding a new mode means adding a new case to the switch.
 */
type RenderMode =
  | 'error'
  | 'loading'
  | 'favorites-empty'
  | 'favorites'
  | 'browse-empty'
  | 'browse-searching'
  | 'browse';

/**
 * Single root island. Fetches `/data/songs.json` once on mount, builds the
 * MiniSearch index, then re-runs queries reactively on `query` changes.
 * Results are capped at 50 (spec §UI).
 *
 * `inputValue` is the controlled value shown in the `<input>` — it updates
 * immediately on every keystroke (or when a featured chip is clicked).
 * `query` is the debounced value that actually drives `index.search()`.
 */

/** The selected vendors as a stable, sorted `SearchVendor[]` for the API
 *  `vendors` union param. Empty when no vendor chip is active. */
function selectedVendorsForApi(selectedVendors: ReadonlySet<Vendor>): SearchVendor[] {
  return Array.from(selectedVendors).sort() as SearchVendor[];
}

function apiBrowseKey(query: string, selectedVendors: ReadonlySet<Vendor>): string {
  const vendorKey = Array.from(selectedVendors).sort().join(',');
  return `${query}\u0000${vendorKey}`;
}

export function App({ songCount }: AppProps) {
  const [bundle, setBundle] = useState<IndexBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Controlled input value — reflects what the user sees in the box.
  const [inputValue, setInputValue] = useState('');
  // Debounced search query — only updated after 150 ms of quiet.
  const [query, setQuery] = useState('');
  const [selectedVendors, setSelectedVendors] = useState<ReadonlySet<Vendor>>(() => new Set());
  const [activeTab, setActiveTab] = useState<TabId>('browse');
  const [apiBrowse, setApiBrowse] = useState<ApiBrowseState>({
    key: '',
    records: null,
    status: 'idle',
  });
  // Favorites hydrated via the worker `/api/songs` endpoint when in API mode.
  // `null` until the first fetch resolves; replaced wholesale on every fetch.
  const [apiFavorites, setApiFavorites] = useState<SongRecord[] | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { isFavorite, toggle: toggleFavorite, orderedIds: favoriteIds } = useFavorites();
  const apiBaseUrl = getApiSearchBaseUrl();
  // The bundled MiniSearch index is now ONLY the offline / local-dev fallback.
  // When an API base URL is configured, every data path (Browse, Favorites,
  // multi-vendor) is served by the worker and the full songs.json is never
  // downloaded.
  const localIndexRequiredForCurrentView = apiBaseUrl === null;
  const controlsDisabled = loading && localIndexRequiredForCurrentView;

  useEffect(() => {
    // API mode: skip the full-corpus download entirely. The UI is usable
    // immediately; all data comes from the worker.
    if (apiBaseUrl !== null) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const bundle = await loadIndex();
        if (cancelled) return;
        setBundle(bundle);
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl]);

  // Clean up the debounce timer on unmount.
  useEffect(() => {
    return () => {
      if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
    };
  }, []);

  useEffect(() => {
    if (apiBaseUrl === null || activeTab !== 'browse' || query === '') {
      setApiBrowse({ key: '', records: null, status: 'idle' });
      return;
    }
    let cancelled = false;
    const key = apiBrowseKey(query, selectedVendors);
    const vendors = selectedVendorsForApi(selectedVendors);
    const apiOptions = { query, limit: RESULT_LIMIT };
    if (vendors.length > 0) Object.assign(apiOptions, { vendors });
    setApiBrowse({ key, records: null, status: 'pending' });
    searchApi(apiBaseUrl, apiOptions)
      .then((records) => {
        if (!cancelled) setApiBrowse({ key, records, status: 'success' });
      })
      .catch(() => {
        if (!cancelled) setApiBrowse({ key, records: [], status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl, activeTab, query, selectedVendors]);

  // API mode: hydrate the favorites set via `/api/songs?ids=...` and re-sort the
  // returned records into favorite order (the worker does not guarantee order).
  // Query-within-favorites is a CLIENT-SIDE filter over this fetched set — the
  // favorites set is user-bounded, so there is no server query param.
  useEffect(() => {
    if (apiBaseUrl === null) return;
    if (favoriteIds.length === 0) {
      setApiFavorites([]);
      return;
    }
    let cancelled = false;
    const order = new Map(favoriteIds.map((id, i) => [id, i] as const));
    fetchSongsByIds(apiBaseUrl, favoriteIds)
      .then((records) => {
        if (cancelled) return;
        const sorted = [...records].sort(
          (a, b) =>
            (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
            (order.get(b.id) ?? Number.MAX_SAFE_INTEGER),
        );
        setApiFavorites(sorted);
      })
      .catch(() => {
        if (!cancelled) setApiFavorites([]);
      });
    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl, favoriteIds]);

  /** Called on every keystroke from SearchBox. Updates the visible input
   *  immediately and schedules a debounced search-query update. */
  const handleInputChange = (value: string) => {
    setInputValue(value);
    if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      setQuery(value);
    }, DEBOUNCE_MS);
  };

  /** Called when a featured-artist chip is clicked. Updates both the visible
   *  input and the search query synchronously (no debounce needed). */
  const handlePickArtist = (name: string) => {
    if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
    setInputValue(name);
    setQuery(name);
  };

  /** Called when the user clicks a tab. Resets all filter/search state to
   *  defaults so the incoming tab always shows a clean view. No-ops if the
   *  user clicks the already-active tab (preserves current state). */
  const handleTabChange = (newTab: TabId) => {
    if (newTab === activeTab) return;
    if (debounceTimer.current !== null) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    setInputValue('');
    setQuery('');
    setSelectedVendors(new Set());
    setActiveTab(newTab);
  };

  /** Pick the candidate set per (activeTab, query), then run the existing
   *  chip + slice pipeline. Browse uses the API (MiniSearch fallback offline);
   *  Favorites resolves the user-bounded favorite set (API `/api/songs` or the
   *  local bundle) and narrows queries client-side. */
  const results: SongRecord[] = useMemo(() => {
    let candidates: SongRecord[];
    if (activeTab === 'favorites') {
      if (apiBaseUrl !== null) {
        // API mode: favorites are fetched + re-sorted in the effect above.
        // Query-within-favorites is a CLIENT-SIDE filter over the bounded set,
        // run through a tiny MiniSearch index so it stays alias-aware and
        // consistent with Browse search semantics.
        const favRecords = apiFavorites ?? [];
        if (query === '') {
          candidates = favRecords;
        } else {
          const favIndex = buildIndex(favRecords);
          const byId = new Map(favRecords.map((r) => [r.id, r] as const));
          const order = new Map(favRecords.map((r, i) => [r.id, i] as const));
          const hits = searchLocalIndex(favIndex, query);
          candidates = [];
          for (const hit of hits) {
            const rec = byId.get(String(hit.id));
            if (rec !== undefined) candidates.push(rec);
          }
          // Preserve favorite order — MiniSearch returns by relevance score.
          candidates.sort(
            (a, b) =>
              (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
              (order.get(b.id) ?? Number.MAX_SAFE_INTEGER),
          );
        }
      } else {
        if (bundle === null) return [];
        // Favorites candidate set: ids resolved against byId, stale dropped.
        const favRecords: SongRecord[] = [];
        for (const id of favoriteIds) {
          const rec = bundle.byId.get(id);
          if (rec !== undefined) favRecords.push(rec);
        }
        if (query === '') {
          candidates = favRecords;
        } else {
          const favIdSet = new Set(favoriteIds);
          const hits = searchLocalIndex(bundle.index, query);
          candidates = [];
          for (const hit of hits) {
            const id = String(hit.id);
            if (favIdSet.has(id)) {
              const rec = bundle.byId.get(id);
              if (rec !== undefined) candidates.push(rec);
            }
          }
        }
      }
    } else {
      // Browse candidate set. API mode (apiBaseUrl set): exclusively the worker
      // search result for the current (query, vendors) key — there is no local
      // bundle to fall back to, so a pending/failed request yields no results
      // until the API resolves. Offline mode (apiBaseUrl null): MiniSearch over
      // the downloaded bundle.
      if (query === '') return [];
      const currentApiKey = apiBrowseKey(query, selectedVendors);
      if (apiBaseUrl !== null && apiBrowse.key === currentApiKey && apiBrowse.records !== null) {
        candidates = apiBrowse.records;
      } else {
        if (bundle === null) return [];
        const hits = searchLocalIndex(bundle.index, query);
        const records: SongRecord[] = [];
        for (const hit of hits) {
          const rec = bundle.byId.get(String(hit.id));
          if (rec !== undefined) records.push(rec);
        }
        candidates = records;
      }
    }
    const filtered = filterByVendors(candidates, selectedVendors);
    return filtered.slice(0, RESULT_LIMIT);
  }, [bundle, query, activeTab, favoriteIds, selectedVendors, apiBaseUrl, apiBrowse, apiFavorites]);

  const toggleVendor = (v: Vendor) => {
    setSelectedVendors((prev) => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return next;
    });
  };

  // Memoized count exposed via aria-live so screen readers announce only when
  // the result count changes — not on every keystroke before debounce settles.
  const resultCount = results.length;
  const currentBrowseApiKey =
    activeTab === 'browse' && query !== '' ? apiBrowseKey(query, selectedVendors) : '';
  const browseApiSearchPending =
    apiBaseUrl !== null &&
    activeTab === 'browse' &&
    query !== '' &&
    (apiBrowse.key !== currentBrowseApiKey || apiBrowse.status === 'pending');
  const resultStatusLabel = browseApiSearchPending
    ? '검색 중 / Searching'
    : `${resultCount}건 / ${resultCount} results`;

  // Build-time record count, formatted with thousands separators (en-US to
  // match the prior hard-coded "26,401" format).
  const songCountDisplay = songCount.toLocaleString('en-US');

  const loadingNode = (
    <p class="loading">
      {songCountDisplay}곡 검색 인덱스 빌드 중 / Building {songCountDisplay}-song index
      <span class="loading-dot" aria-hidden="true">
        .
      </span>
      <span class="loading-dot" aria-hidden="true">
        .
      </span>
      <span class="loading-dot" aria-hidden="true">
        .
      </span>
    </p>
  );

  const searchLoadingNode = (
    <p class="search-loading">
      검색 중 / Searching
      <span class="loading-dot" aria-hidden="true">
        .
      </span>
      <span class="loading-dot" aria-hidden="true">
        .
      </span>
      <span class="loading-dot" aria-hidden="true">
        .
      </span>
    </p>
  );

  /**
   * Pick the active render mode. The order here is the spec's render-branch
   * order (preserved from the prior nested-ternary chain):
   *   1. error !== null               → 'error'
   *   2. loading === true             → 'loading'    (covers Favorites + Browse;
   *                                                   Browse+empty additionally
   *                                                   co-renders <EmptyState>
   *                                                   inside renderBody to
   *                                                   preserve commit cd54633's
   *                                                   loading-mitigation.)
   *   3. activeTab === 'favorites' && favoriteIds.length === 0
   *                                   → 'favorites-empty'
   *   4. activeTab === 'favorites'    → 'favorites'  (NoResults if 0 filtered)
   *   5. activeTab === 'browse' && query === ''
   *                                   → 'browse-empty'
   *   6. activeTab === 'browse' && API search pending
   *                                   → 'browse-searching'
   *   7. activeTab === 'browse'       → 'browse'     (NoResults if 0 filtered)
   */
  const mode: RenderMode =
    error !== null
      ? 'error'
      : loading && localIndexRequiredForCurrentView
        ? 'loading'
        : activeTab === 'favorites' && favoriteIds.length === 0
          ? 'favorites-empty'
          : activeTab === 'favorites'
            ? 'favorites'
            : query === ''
              ? 'browse-empty'
              : browseApiSearchPending
                ? 'browse-searching'
                : 'browse';

  const renderBody = (): JSX.Element => {
    switch (mode) {
      case 'error':
        return <ErrorState message={error ?? ''} />;
      case 'loading':
        // Loading-state mitigation: on Browse+empty during the loading window,
        // co-render <EmptyState> alongside the loading message so first-paint
        // shows the featured-artist landing chrome (commit cd54633).
        if (activeTab === 'browse' && query === '') {
          return (
            <>
              <EmptyState onPickArtist={handlePickArtist} />
              {loadingNode}
            </>
          );
        }
        return loadingNode;
      case 'favorites-empty':
        return <FavoritesEmpty />;
      case 'browse-empty':
        return <EmptyState onPickArtist={handlePickArtist} />;
      case 'browse-searching':
        return searchLoadingNode;
      case 'favorites':
      case 'browse':
        // Identical render output post-`results` computation; the candidate-
        // set divergence happens upstream in the useMemo above.
        return results.length === 0 ? (
          <NoResults />
        ) : (
          <ResultList records={results} isFavorite={isFavorite} onToggleFavorite={toggleFavorite} />
        );
      default: {
        const _exhaustive: never = mode;
        throw new Error(`Unhandled RenderMode: ${_exhaustive}`);
      }
    }
  };

  return (
    <main class="results">
      <SearchBox value={inputValue} onInput={handleInputChange} disabled={controlsDisabled} />
      <TabBar activeTab={activeTab} onChange={handleTabChange} disabled={loading} />
      <VendorChips selected={selectedVendors} onToggle={toggleVendor} />
      <span class="sr-only" aria-live="polite" aria-atomic="true" data-testid="result-count">
        {resultStatusLabel}
      </span>
      {renderBody()}
    </main>
  );
}
