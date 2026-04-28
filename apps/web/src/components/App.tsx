import type { Category, SongRecord } from '@karaoke/schema';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useFavorites } from '../lib/favorites.js';
import { filterByCategories, filterByVendors } from '../lib/filter.js';
import type { IndexBundle } from '../lib/search.js';
import { loadIndex } from '../lib/search.js';
import { CategoryChips } from './CategoryChips.js';
import { EmptyState } from './EmptyState.js';
import { ErrorState } from './ErrorState.js';
import { FavoritesEmpty } from './FavoritesEmpty.js';
import { NoResults } from './NoResults.js';
import { ResultCard } from './ResultCard.js';
import { SearchBox } from './SearchBox.js';
import type { TabId } from './TabBar.js';
import { TabBar } from './TabBar.js';
import type { Vendor } from './VendorChips.js';
import { VendorChips } from './VendorChips.js';

const RESULT_LIMIT = 50;
const DEBOUNCE_MS = 150;

// Hard-coded record count surfaced in the loading state. Update whenever
// `apps/web/public/data/songs.json` is regenerated. Keep in sync with the
// merger's final record count (currently 26,401 records).
const SONG_COUNT_DISPLAY = '26,401';

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
 * Single root island. Fetches `/data/songs.json` once on mount, builds the
 * MiniSearch index, then re-runs queries reactively on `query` /
 * `selectedCategories` changes. Results are capped at 50 (spec §UI).
 *
 * `inputValue` is the controlled value shown in the `<input>` — it updates
 * immediately on every keystroke (or when a featured-chip is clicked).
 * `query` is the debounced value that actually drives `index.search()`.
 */
export function App() {
  const [bundle, setBundle] = useState<IndexBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Controlled input value — reflects what the user sees in the box.
  const [inputValue, setInputValue] = useState('');
  // Debounced search query — only updated after 150 ms of quiet.
  const [query, setQuery] = useState('');
  const [selectedCategories, setSelectedCategories] = useState<ReadonlySet<Category>>(
    () => new Set(),
  );
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
    const byCategory = filterByCategories(candidates, selectedCategories);
    return filterByVendors(byCategory, selectedVendors).slice(0, RESULT_LIMIT);
  }, [bundle, query, activeTab, favoriteIds, selectedCategories, selectedVendors]);

  const toggleCategory = (c: Category) => {
    setSelectedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
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
  const resultCount = useMemo(() => results.length, [results]);

  // Render-branch selection follows spec §Body rendering rules. Order matters:
  //   1. error !== null → ErrorState (beats everything).
  //   2. loading === true → loading message (covers "Either / corpus still loading" row;
  //      takes precedence over FavoritesEmpty / favorites pipeline / Browse search).
  //   2a. ON the Browse tab when query === '', the loading message renders as a sibling
  //       of the EmptyState landing view — preserves the prior loading-mitigation
  //       behavior so users see featured-artist chips immediately on first paint.
  //   3. activeTab === 'favorites' && favoriteIds.length === 0 → FavoritesEmpty.
  //   4. activeTab === 'favorites' → favorites pipeline body (NoResults if 0 filtered).
  //   5. activeTab === 'browse' && query === '' → EmptyState (featured-artist landing).
  //   6. activeTab === 'browse' → search-results pipeline body (existing flow).
  const loadingNode = (
    <p class="loading">
      {SONG_COUNT_DISPLAY}곡 검색 인덱스 빌드 중 / Building {SONG_COUNT_DISPLAY}-song index
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

  return (
    <main class="results">
      <SearchBox value={inputValue} onInput={handleInputChange} disabled={loading} />
      <TabBar
        activeTab={activeTab}
        onChange={setActiveTab}
        favoriteCount={favoriteIds.length}
        disabled={loading}
      />
      <CategoryChips selected={selectedCategories} onToggle={toggleCategory} />
      <VendorChips selected={selectedVendors} onToggle={toggleVendor} />
      <span class="sr-only" aria-live="polite" aria-atomic="true" data-testid="result-count">
        {resultCount}건 / {resultCount} results
      </span>
      {error !== null ? (
        <ErrorState message={error} />
      ) : loading ? (
        // During the loading window, render the loading message — but keep the
        // featured-artist landing chrome alongside it on the Browse+empty path
        // so first-paint shows useful content (matches prior mitigation test).
        activeTab === 'browse' && query === '' ? (
          <>
            <EmptyState onPickArtist={handlePickArtist} />
            {loadingNode}
          </>
        ) : (
          loadingNode
        )
      ) : activeTab === 'favorites' && favoriteIds.length === 0 ? (
        <FavoritesEmpty />
      ) : activeTab === 'favorites' ? (
        results.length === 0 ? (
          <NoResults />
        ) : (
          <ul class="result-list">
            {results.map((r) => (
              <li key={r.id} class="result-list-item">
                <ResultCard
                  record={r}
                  isFavorite={isFavorite(r.id)}
                  onToggleFavorite={toggleFavorite}
                />
              </li>
            ))}
          </ul>
        )
      ) : activeTab === 'browse' && query === '' ? (
        <EmptyState onPickArtist={handlePickArtist} />
      ) : results.length === 0 ? (
        <NoResults />
      ) : (
        <ul class="result-list">
          {results.map((r) => (
            <li key={r.id} class="result-list-item">
              <ResultCard
                record={r}
                isFavorite={isFavorite(r.id)}
                onToggleFavorite={toggleFavorite}
              />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
