import type { Category, SongRecord } from '@karaoke/schema';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { filterByCategories, filterByVendors } from '../lib/filter.js';
import type { IndexBundle } from '../lib/search.js';
import { loadIndex } from '../lib/search.js';
import { CategoryChips } from './CategoryChips.js';
import { EmptyState } from './EmptyState.js';
import { ErrorState } from './ErrorState.js';
import { NoResults } from './NoResults.js';
import { ResultCard } from './ResultCard.js';
import { SearchBox } from './SearchBox.js';
import type { Vendor } from './VendorChips.js';
import { VendorChips } from './VendorChips.js';

const RESULT_LIMIT = 50;
const DEBOUNCE_MS = 150;

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
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const results: SongRecord[] = useMemo(() => {
    if (bundle === null || query === '') return [];
    const hits = bundle.index.search(query);
    const records: SongRecord[] = [];
    for (const hit of hits) {
      const rec = bundle.byId.get(String(hit.id));
      if (rec !== undefined) records.push(rec);
    }
    const byCategory = filterByCategories(records, selectedCategories);
    return filterByVendors(byCategory, selectedVendors).slice(0, RESULT_LIMIT);
  }, [bundle, query, selectedCategories, selectedVendors]);

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

  return (
    <main class="results">
      <SearchBox value={inputValue} onInput={handleInputChange} />
      <CategoryChips selected={selectedCategories} onToggle={toggleCategory} />
      <VendorChips selected={selectedVendors} onToggle={toggleVendor} />
      <span class="sr-only" aria-live="polite" aria-atomic="true" data-testid="result-count">
        {resultCount}건 / {resultCount} results
      </span>
      {loading ? (
        <p class="loading">검색 인덱스 로딩 중 / 検索インデックス読み込み中…</p>
      ) : error !== null ? (
        <ErrorState message={error} />
      ) : query === '' ? (
        <EmptyState onPickArtist={handlePickArtist} />
      ) : results.length === 0 ? (
        <NoResults />
      ) : (
        <ul class="result-list">
          {results.map((r) => (
            <li key={r.id} class="result-list-item">
              <ResultCard record={r} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
