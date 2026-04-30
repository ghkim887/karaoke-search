import type { SongRecord } from '@karaoke/schema';
import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useFavorites } from '../lib/favorites.js';
import { filterByCategory, filterByVendors } from '../lib/filter.js';
import type { IndexBundle } from '../lib/search.js';
import { loadIndex } from '../lib/search.js';
import type { CategoryFilter } from './CategoryChips.js';
import { CategoryChips } from './CategoryChips.js';
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

interface AppProps {
  /** Build-time record count from `apps/web/public/data/songs.json`. Surfaces
   *  in the loading-state label so it always tracks the live corpus. Wired
   *  through from `index.astro` Astro frontmatter. */
  songCount: number;
}

/** Case-insensitive substring match against the four MiniSearch fields. Used
 *  ONLY by the Favorites tab — Browse uses the real MiniSearch index. The
 *  favorites set is bounded by the user (in the dozens), so a linear pass is
 *  sub-millisecond and avoids building a second index. */
function matchesQuery(record: SongRecord, query: string): boolean {
  const q = query.toLowerCase();
  return (
    record.title_primary.toLowerCase().includes(q) ||
    (record.title_ko?.toLowerCase().includes(q) ?? false) ||
    record.artist_primary.toLowerCase().includes(q) ||
    (record.artist_ko?.toLowerCase().includes(q) ?? false)
  );
}

/**
 * Render-branch discriminator. The order in which `renderBody()` checks these
 * is fixed by spec (see the docstring on `renderBody` below). Keep this union
 * exhaustive — adding a new mode means adding a new case to the switch.
 */
type RenderMode = 'error' | 'loading' | 'favorites-empty' | 'favorites' | 'browse-empty' | 'browse';

/**
 * Single root island. Fetches `/data/songs.json` once on mount, builds the
 * MiniSearch index, then re-runs queries reactively on `query` /
 * `categoryFilter` changes. Results are capped at 50 (spec §UI).
 *
 * `inputValue` is the controlled value shown in the `<input>` — it updates
 * immediately on every keystroke (or when a featured-chip is clicked).
 * `query` is the debounced value that actually drives `index.search()`.
 */
export function App({ songCount }: AppProps) {
  const [bundle, setBundle] = useState<IndexBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Controlled input value — reflects what the user sees in the box.
  const [inputValue, setInputValue] = useState('');
  // Debounced search query — only updated after 150 ms of quiet.
  const [query, setQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all');
  const [selectedVendors, setSelectedVendors] = useState<ReadonlySet<Vendor>>(() => new Set());
  const [activeTab, setActiveTab] = useState<TabId>('browse');
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { isFavorite, toggle: toggleFavorite, orderedIds: favoriteIds } = useFavorites();

  useEffect(() => {
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
  }, []);

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
    setCategoryFilter('all');
    setSelectedVendors(new Set());
    setActiveTab(newTab);
  };

  /** Pick the candidate set per (activeTab, query), then run the existing
   *  chip + slice pipeline. Browse uses MiniSearch; Favorites does a linear
   *  substring pass over the user-bounded favorites set. */
  const results: SongRecord[] = useMemo(() => {
    if (bundle === null) return [];
    let candidates: SongRecord[];
    if (activeTab === 'favorites') {
      // Favorites candidate set: ids resolved against byId, stale dropped.
      const favRecords: SongRecord[] = [];
      for (const id of favoriteIds) {
        const rec = bundle.byId.get(id);
        if (rec !== undefined) favRecords.push(rec);
      }
      candidates = query === '' ? favRecords : favRecords.filter((r) => matchesQuery(r, query));
    } else {
      // Browse candidate set: full-corpus MiniSearch on a non-empty query.
      if (query === '') return [];
      const hits = bundle.index.search(query);
      const records: SongRecord[] = [];
      for (const hit of hits) {
        const rec = bundle.byId.get(String(hit.id));
        if (rec !== undefined) records.push(rec);
      }
      candidates = records;
    }
    const byCategory = filterByCategory(candidates, categoryFilter);
    return filterByVendors(byCategory, selectedVendors).slice(0, RESULT_LIMIT);
  }, [bundle, query, activeTab, favoriteIds, categoryFilter, selectedVendors]);

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
  const resultCount = useMemo(() => results.length, [results]);

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
   *   6. activeTab === 'browse'       → 'browse'     (NoResults if 0 filtered)
   */
  const mode: RenderMode =
    error !== null
      ? 'error'
      : loading
        ? 'loading'
        : activeTab === 'favorites' && favoriteIds.length === 0
          ? 'favorites-empty'
          : activeTab === 'favorites'
            ? 'favorites'
            : query === ''
              ? 'browse-empty'
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
      <SearchBox value={inputValue} onInput={handleInputChange} disabled={loading} />
      <TabBar activeTab={activeTab} onChange={handleTabChange} disabled={loading} />
      <CategoryChips selected={categoryFilter} onChange={setCategoryFilter} />
      <VendorChips selected={selectedVendors} onToggle={toggleVendor} />
      <span class="sr-only" aria-live="polite" aria-atomic="true" data-testid="result-count">
        {resultCount}건 / {resultCount} results
      </span>
      {renderBody()}
    </main>
  );
}
