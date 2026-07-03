import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useApiBrowse } from '../hooks/useApiBrowse.js';
import { useApiFavorites } from '../hooks/useApiFavorites.js';
import { useCorpus } from '../hooks/useCorpus.js';
import { useSearchResults } from '../hooks/useSearchResults.js';
import { createSearchBackend } from '../lib/backend.js';
import { DEBOUNCE_MS } from '../lib/constants.js';
import { useFavorites } from '../lib/favorites.js';
import { t } from '../lib/i18n.js';
import { EmptyState } from './EmptyState.js';
import { ErrorState } from './ErrorState.js';
import { FavoritesEmpty } from './FavoritesEmpty.js';
import { NoResults } from './NoResults.js';
import { ResultList } from './ResultList.js';
import { SearchBox } from './SearchBox.js';
import type { TabId } from './TabBar.js';
import { TAB_PANEL_ID, TabBar, tabButtonId } from './TabBar.js';
import type { Vendor } from './VendorChips.js';
import { VendorChips } from './VendorChips.js';

interface AppProps {
  /** Build-time record count from `apps/web/public/data/songs.json`. Surfaces
   *  in the loading-state label so it always tracks the live corpus. Wired
   *  through from `index.astro` Astro frontmatter. */
  songCount: number;
}

/**
 * Render-branch discriminator. The order in which `renderBody()` checks these
 * is fixed by spec (see the docstring on `mode` below). Keep this union
 * exhaustive — adding a new mode means adding a new case to the switch.
 */
type RenderMode =
  | 'error'
  | 'loading'
  | 'favorites-empty'
  | 'favorites-error'
  | 'favorites'
  | 'browse-empty'
  | 'browse-searching'
  | 'browse-error'
  | 'browse';

/**
 * Single root island. In offline mode it fetches `/data/songs.json` once on
 * mount, builds the MiniSearch index, then re-runs queries reactively; in API
 * mode every data path is served by the worker and the corpus is never
 * downloaded. The mode is decided once by `createSearchBackend`.
 *
 * `inputValue` is the controlled value shown in the `<input>` — it updates
 * immediately on every keystroke (or when a featured chip is clicked).
 * `query` is the debounced value that actually drives the search. Results are
 * capped at 50 (spec §UI).
 */
export function App({ songCount }: AppProps) {
  // Controlled input value — reflects what the user sees in the box.
  const [inputValue, setInputValue] = useState('');
  // Debounced search query — only updated after 150 ms of quiet.
  const [query, setQuery] = useState('');
  const [selectedVendors, setSelectedVendors] = useState<ReadonlySet<Vendor>>(() => new Set());
  const [activeTab, setActiveTab] = useState<TabId>('browse');
  // Bumped by the ErrorState retry button; a dep of the API browse/favorites
  // hooks so a retry re-issues the failed request in place.
  const [retryNonce, setRetryNonce] = useState(0);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { isFavorite, toggle: toggleFavorite, orderedIds: favoriteIds } = useFavorites();

  // Single mode-decision point: API worker vs offline bundle. Every downstream
  // branch keys off `backend.requiresLocalCorpus`.
  const backend = useMemo(() => createSearchBackend(), []);

  const { bundle, loading, error } = useCorpus(backend);
  const { apiBrowse, browseSearchPending, browseSearchFailed } = useApiBrowse(backend, {
    activeTab,
    query,
    selectedVendors,
    retryNonce,
  });
  const { apiFavorites, favoritesFailed } = useApiFavorites(backend, {
    activeTab,
    favoriteIds,
    retryNonce,
  });
  const results = useSearchResults(backend, {
    activeTab,
    query,
    selectedVendors,
    bundle,
    apiBrowse,
    apiFavorites,
    favoriteIds,
  });

  // The bundled MiniSearch index is only the offline / local-dev fallback; when
  // the API backend is active the controls are usable immediately.
  const controlsDisabled = loading && backend.requiresLocalCorpus;

  // Clean up the debounce timer on unmount.
  useEffect(() => {
    return () => {
      if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
    };
  }, []);

  /** Called on every keystroke from SearchBox. Updates the visible input
   *  immediately and schedules a debounced search-query update. */
  const handleInputChange = (value: string) => {
    setInputValue(value);
    if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      setQuery(value);
    }, DEBOUNCE_MS);
  };

  /** Re-issues the failed API request in place. Bumping `retryNonce` re-runs the
   *  API browse + favorites effects with the current query/favorites; the active
   *  view's request is retried and the other is a harmless idempotent refetch. */
  const handleRetry = () => setRetryNonce((n) => n + 1);

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
  const resultStatusLabel = browseSearchPending
    ? t.searching
    : browseSearchFailed || favoritesFailed
      ? t.errorOccurred
      : t.resultCount(resultCount);

  // Build-time record count, formatted with thousands separators (en-US to
  // match the prior hard-coded "26,401" format).
  const songCountDisplay = songCount.toLocaleString('en-US');

  const loadingNode = (
    <p class="loading">
      {t.buildingIndex(songCountDisplay)}
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
      {t.searching}
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
   *   4. activeTab === 'favorites' && API favorites fetch failed
   *                                   → 'favorites-error'
   *   5. activeTab === 'favorites'    → 'favorites'  (NoResults if 0 filtered)
   *   6. activeTab === 'browse' && query === ''
   *                                   → 'browse-empty'
   *   7. activeTab === 'browse' && API search pending
   *                                   → 'browse-searching'
   *   8. activeTab === 'browse' && API search failed
   *                                   → 'browse-error'
   *   9. activeTab === 'browse'       → 'browse'     (NoResults if 0 filtered)
   */
  const mode: RenderMode =
    error !== null
      ? 'error'
      : controlsDisabled
        ? 'loading'
        : activeTab === 'favorites' && favoriteIds.length === 0
          ? 'favorites-empty'
          : favoritesFailed
            ? 'favorites-error'
            : activeTab === 'favorites'
              ? 'favorites'
              : query === ''
                ? 'browse-empty'
                : browseSearchPending
                  ? 'browse-searching'
                  : browseSearchFailed
                    ? 'browse-error'
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
      case 'favorites-error':
        return <ErrorState message={t.favoritesLoadFailed} onRetry={handleRetry} />;
      case 'browse-empty':
        return <EmptyState onPickArtist={handlePickArtist} />;
      case 'browse-searching':
        return searchLoadingNode;
      case 'browse-error':
        return <ErrorState message={t.searchRequestFailed} onRetry={handleRetry} />;
      case 'favorites':
      case 'browse':
        // Identical render output post-`results` computation; the candidate-
        // set divergence happens upstream in useSearchResults.
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
      {/* The single results region is the tabpanel controlled by both tabs.
          `aria-labelledby` tracks the active tab so the panel's accessible
          name follows the current view. */}
      <div id={TAB_PANEL_ID} role="tabpanel" aria-labelledby={tabButtonId(activeTab)}>
        {renderBody()}
      </div>
    </main>
  );
}
