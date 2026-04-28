# Favorites Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL — use `superpowers:executing-plans` (or `superpowers:subagent-driven-development`) to implement this plan phase-by-phase. Steps use checkbox (`- [ ]`) syntax for tracking. Each phase is independently verifiable: scope → tests → implementation → verification.

**Goal:** Promote the favorites preview out of the empty-state into a dedicated tab on the search page. Add a sticky two-button tab bar (`검색` / `즐겨찾기`) above the category chips. Body rendering switches on `(activeTab, query, favoriteIds)`. No router, no URL hash, no persistence — `activeTab` resets to `'browse'` on every page load. Frontend-only, no schema or crawler change.

**Spec:** `docs/superpowers/specs/2026-04-28-favorites-tab-design.md` (HEAD `faec6a4`, status: Approved for plan).

**Architecture:** Pure additive Astro+Preact changes inside `apps/web`. Two new presentational components (`TabBar.tsx`, `FavoritesEmpty.tsx`). One state field added to `App.tsx`. The `results` memo now picks its candidate set from a small two-way switch on `activeTab`. `EmptyState.tsx` loses its favorites-section block and four props. CSS for the segmented-control tab bar is added to `apps/web/src/pages/index.astro`. No new dependencies. No changes to `useFavorites`, MiniSearch, schema, crawler, or `songs.json`.

**Tech stack:** Astro 4.x · Preact 10.x · MiniSearch · Vitest (jsdom opt-in) · TypeScript · Biome · vanilla CSS.

**Pre-flight environment notes:**

- Use `corepack pnpm` for every command — plain `pnpm` is not on PATH on the Windows host.
- The web workspace's `vitest.config.ts` uses `environment: 'node'`. Tests that render Preact components MUST opt into jsdom via the `// @vitest-environment jsdom` file-level pragma at the top of the test file. `jsdom` is already a `@karaoke/web` devDependency — no install needed. New tests in this plan (`TabBar.test.tsx`, `FavoritesEmpty.test.tsx`) use this pragma; existing `App.test.tsx` and `EmptyState.test.tsx` already use it.
- Tab labels are the exact literal Korean strings `검색` and `즐겨찾기` — **no star prefix, no count badge, no English half**. This is a deliberate decision in the spec (Components → New → TabBar) and is locked at the test level (TabBar Test 1).
- Decision taken in plan: pass `favoriteCount` to `<TabBar>` as a prop (per spec) so a future enhancement can add a count badge without re-plumbing. The current rendering ignores it. This keeps the prop surface forward-compatible and the unit test simply asserts the literal labels regardless of `favoriteCount` value.
- Decision taken in plan: the TabBar's `aria-controls` and `tabpanel`/`role="tabpanel"` wiring is **not added** in this round. The spec calls for `role="tablist"` + `role="tab"` + `aria-selected` only. Adding `aria-controls` requires giving the body a stable `id` and `role="tabpanel"`, which doubles the surface area for an inert behavior change. If a follow-up tightens a11y, re-open the spec.
- Decision taken in plan: substring matcher for the Favorites tab lives inline in `App.tsx`'s `results` memo (helper named `matchesQuery(record, query)`). It does **not** become a `lib/` module — single call site, eight lines, no reuse value yet.
- Decision taken in plan: `<NoResults>` is the fallback for "Favorites tab + typed query + zero matches" per spec edge case 3. `<FavoritesEmpty>` is **only** rendered when `favoriteIds.length === 0`. Order-of-checks in the render block matters and is spelled out in Phase 2.
- Decision taken in plan: switching tabs preserves the `inputValue` and `query` (debounced) state. No `setInputValue('')` on tab switch — the spec explicitly says chip selections and search box value carry over.
- Decision taken in plan: the sticky offset for the tab bar uses a CSS custom property `--header-height` declared on `header.site-header` (per spec Risks & mitigations §1). The tab bar reads `top: var(--header-height)`. The header's height is hardcoded at the property declaration site (e.g. `--header-height: 5.25rem`) calculated against the existing 1rem padding + 1.4rem h1 + 0.75rem margin + ~2.4rem input — small calc done once at the property declaration; consumed on the tab bar.

---

## Phase 1: Scaffold `TabBar.tsx` and `FavoritesEmpty.tsx` (TDD, components in isolation)

**Goal:** Land the two new components with their unit tests. No `App.tsx` or `EmptyState.tsx` wiring yet — both files compile and pass tests in isolation. The build still works because nothing imports them yet.

**Files (new):**
- `apps/web/src/components/TabBar.tsx`
- `apps/web/src/components/TabBar.test.tsx`
- `apps/web/src/components/FavoritesEmpty.tsx`
- `apps/web/src/components/FavoritesEmpty.test.tsx`

**Files unchanged in this phase:** `App.tsx`, `EmptyState.tsx`, `index.astro`.

### Step 1: Write `FavoritesEmpty.test.tsx` (TDD — write the test first)

Create `apps/web/src/components/FavoritesEmpty.test.tsx` with these cases:

1. **Renders the bilingual placeholder text (Korean + English) in a single paragraph.**
   - Asserts the rendered DOM contains the substring `즐겨찾기가 아직 없어요` AND the substring `No favorites yet — tap ★ on a result to add one`.
2. **Mentions the ★ glyph in the instruction.**
   - Asserts `host.querySelector('.favorites-empty')?.textContent` matches `/★/`.

Use the `// @vitest-environment jsdom` pragma at the top. Mirror the existing test harness in `EmptyState.test.tsx` (`render` from `preact`, `host = document.createElement('div')` mount/teardown pattern).

### Step 2: Write `TabBar.test.tsx` (TDD — write the test first)

Create `apps/web/src/components/TabBar.test.tsx` with these cases:

1. **Browse button label is exactly `검색`; Favorites button label is exactly `즐겨찾기` — no star, no count, regardless of `favoriteCount`.**
   - Render once with `favoriteCount={0}` and once with `favoriteCount={42}`. In both renders assert `tabs[0].textContent === '검색'` and `tabs[1].textContent === '즐겨찾기'` (use `.trim()` to normalize whitespace if needed).
2. **Active tab has `aria-selected="true"`; inactive has `aria-selected="false"`.**
   - With `activeTab='browse'`, assert the first tab's `aria-selected === 'true'` and the second's `=== 'false'`. Re-render with `activeTab='favorites'` and assert the inverse.
3. **Clicking the inactive tab fires `onChange` with the right id; clicking the already-active tab is a no-op.**
   - Use a `vi.fn()` spy. Click the inactive button → spy called once with `'favorites'` (or `'browse'` symmetrically). Reset the spy, click the active button → spy not called. (If the implementation does call `onChange` and the parent dedupes, that's also acceptable; this test asserts the simpler "active click is a no-op" path. **Decision taken in plan: implement as a no-op at the source — the click handler in `TabBar.tsx` checks `if (id === activeTab) return;` before firing `onChange`.**)
4. **Arrow-Left / Arrow-Right move focus between the two buttons.**
   - Mirror `CategoryChips`'s `handleKeyDown` test pattern. Mount, focus button 0, dispatch `KeyboardEvent('keydown', { key: 'ArrowRight' })` → `document.activeElement === button[1]`. Dispatch ArrowLeft → focus is back on button 0. Wraps modulo length per the existing chip group pattern.
5. **While `disabled` (loading), buttons are inert and don't fire on click.**
   - Render with `disabled={true}`. Click each button → `onChange` spy not called. Assert the buttons have the `disabled` attribute set.

Use the `// @vitest-environment jsdom` pragma at the top.

### Step 3: Implement `FavoritesEmpty.tsx`

Create `apps/web/src/components/FavoritesEmpty.tsx`:

```tsx
/**
 * Placeholder shown on the Favorites tab when the user has zero favorites.
 * Rendered ONLY when `favoriteIds.length === 0` on the Favorites tab; if the
 * user has favorites but the query yields no matches, the parent renders
 * <NoResults /> instead.
 */
export function FavoritesEmpty() {
  return (
    <div class="favorites-empty">
      <p>
        즐겨찾기가 아직 없어요 — 결과 카드의 ★ 버튼으로 추가하세요. / No favorites yet — tap ★ on a
        result to add one.
      </p>
    </div>
  );
}
```

Pure presentational. No props. Single short paragraph. The bilingual sweep (`grep -rnE "[ぁ-んァ-ヶ]" apps/web/src/components apps/web/src/pages`) MUST still return zero hits after this file lands — confirm the Korean/English string contains no hiragana/katakana.

### Step 4: Implement `TabBar.tsx`

Create `apps/web/src/components/TabBar.tsx`. Mirror the `CategoryChips.tsx` / `VendorChips.tsx` pattern (fieldset-free, but uses `role="tablist"` instead). Key shape:

```tsx
import { useRef } from 'preact/hooks';

export type TabId = 'browse' | 'favorites';

interface TabBarProps {
  activeTab: TabId;
  onChange: (tab: TabId) => void;
  /**
   * Currently unused in render — kept on the prop surface for forward
   * compatibility (e.g. a future count badge). The spec explicitly forbids
   * surfacing the count in the label string itself.
   */
  favoriteCount: number;
  disabled: boolean;
}

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'browse', label: '검색' },
  { id: 'favorites', label: '즐겨찾기' },
];

export function TabBar({ activeTab, onChange, disabled }: TabBarProps) {
  const buttonsRef = useRef<Array<HTMLButtonElement | null>>([]);

  const handleKeyDown = (e: KeyboardEvent, idx: number) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    const next = (idx + dir + TABS.length) % TABS.length;
    buttonsRef.current[next]?.focus();
  };

  const handleClick = (id: TabId) => {
    if (id === activeTab) return;
    onChange(id);
  };

  return (
    <div class="tab-bar" role="tablist" aria-label="결과 보기 모드">
      {TABS.map((tab, idx) => {
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            ref={(el) => {
              buttonsRef.current[idx] = el;
            }}
            type="button"
            role="tab"
            class={`tab-button ${isActive ? 'tab-button-active' : ''}`}
            aria-selected={isActive}
            disabled={disabled}
            onClick={() => handleClick(tab.id)}
            onKeyDown={(e) => handleKeyDown(e, idx)}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
```

Note: the `TABS` constant lives at module scope (matching `CategoryChips.tsx`). The `favoriteCount` prop is destructured-out of the function arg list above — the function signature still accepts it via the `TabBarProps` type, but it's intentionally unused. **Decision taken in plan: omit `favoriteCount` from the destructure to silence Biome's `noUnusedVariables`; keep it on `TabBarProps` so callers pass a real value and the prop surface is forward-compatible.** If Biome complains about an unused property on the type, prefix with `_favoriteCount` in the destructure: `({ activeTab, onChange, disabled, favoriteCount: _favoriteCount })`.

### Step 5: Verification (Phase 1)

```bash
corepack pnpm exec biome check apps/web/src/components/TabBar.tsx apps/web/src/components/TabBar.test.tsx apps/web/src/components/FavoritesEmpty.tsx apps/web/src/components/FavoritesEmpty.test.tsx
corepack pnpm --filter @karaoke/web test
corepack pnpm -r build
```

Expected:

- Biome: 0 errors.
- Vitest: previous baseline + new TabBar tests (5) + FavoritesEmpty tests (2). All green.
- Build: clean. Bundle size guard passes (gzipped island ≤ 50 KB). Two new files but neither is imported yet, so the bundle is effectively unchanged — astro's tree-shaking drops them.

### Step 6: Bilingual sweep (sanity)

```bash
grep -rnE "[ぁ-んァ-ヶ]" apps/web/src/components apps/web/src/pages
```

Expected: zero hits. The new files contain no hiragana/katakana.

### Risks & rollback (Phase 1)

- **Risk:** Biome's unused-prop lint surfaces on `favoriteCount`.
  **Mitigation:** the `_favoriteCount` rename above silences it; alternatively, drop it from `TabBarProps` and re-add when a count badge actually lands. Going with the rename is preferred.
- **Risk:** ArrowLeft/Right test flakes in jsdom because `KeyboardEvent.key` typing is finicky.
  **Mitigation:** dispatch via `new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })` (matching the existing chip-group test, which has been green for weeks).
- **Rollback:** revert the four new files. No other files touched.

---

## Phase 2: Wire `activeTab` into `App.tsx`; strip favorites preview from `EmptyState.tsx`

**Goal:** Land the actual mode switch. `App.tsx` adds the `activeTab` state, mounts `<TabBar>`, expands `results` memo to handle the favorites candidate set, and adds the `<FavoritesEmpty>` render branch. `EmptyState.tsx` loses its favorites preview block and four props. `EmptyState.test.tsx` drops three favorites cases. `App.test.tsx` adds ten new behavior tests. After this phase, the feature is functional in dev — only CSS polish remains.

**Files (modified):**
- `apps/web/src/components/App.tsx`
- `apps/web/src/components/App.test.tsx`
- `apps/web/src/components/EmptyState.tsx`
- `apps/web/src/components/EmptyState.test.tsx`

**Files unchanged in this phase:** `index.astro`, `useFavorites`, all `lib/*` modules, `ResultCard.tsx`, `SearchBox.tsx`, `CategoryChips.tsx`, `VendorChips.tsx`, `NoResults.tsx`, `ErrorState.tsx`.

### Step 1: Update `App.test.tsx` (TDD — add the new behavior tests first)

Append to `apps/web/src/components/App.test.tsx`. Each new test mounts `<App />` into a host div under jsdom (the file already has the `// @vitest-environment jsdom` pragma).

**Critical:** these tests need a populated `byId` map. Two acceptable fixtures:
- **Option A** (preferred — matches existing pattern): use `vi.mock('../lib/search.js', () => ({ loadIndex: vi.fn().mockResolvedValue({ index: <fake>, byId: <map> }) }))` to short-circuit the corpus fetch. Requires constructing a tiny fake `MiniSearch`-shaped object with a `.search(query)` method that returns hits matching the test fixtures. **Decision taken in plan: use Option A.** Mock at the test-file scope; pass a Map of 3–4 fixture records (one per category, mix of starred/unstarred) and a stub `index.search()` that filters the records by lowercase substring match on `title_primary` so the Browse-typed-query tests work without a real MiniSearch index.
- **Option B** (rejected): build a real MiniSearch over a fixture corpus inside the test. Slower; more setup; not worth it for these tests.

Add a top-of-file fixture block (above the `describe(...)` calls):

```tsx
import type { SongRecord } from '@karaoke/schema';
import { vi } from 'vitest';

const fixtureRecords: SongRecord[] = [
  { id: 'r1', title_primary: 'Idol', title_ko: '아이돌', artist_primary: 'YOASOBI', artist_ko: '요아소비', categories: ['jpop'], karaoke_numbers: { tj: '12345', ky: null, joysound: null }, source_url: 'https://example.invalid/1' },
  { id: 'r2', title_primary: 'KICK BACK', title_ko: null, artist_primary: '米津玄師', artist_ko: '요네즈 켄시', categories: ['jpop', 'anime'], karaoke_numbers: { tj: '67890', ky: null, joysound: null }, source_url: 'https://example.invalid/2' },
  { id: 'r3', title_primary: 'Senbonzakura', title_ko: '천본앵', artist_primary: '初音ミク', artist_ko: '하츠네 미쿠', categories: ['vocaloid'], karaoke_numbers: { tj: null, ky: '11111', joysound: null }, source_url: 'https://example.invalid/3' },
];
const byId = new Map(fixtureRecords.map((r) => [r.id, r] as const));
const fakeIndex = {
  search: (q: string) => {
    const lower = q.toLowerCase();
    return fixtureRecords
      .filter((r) =>
        r.title_primary.toLowerCase().includes(lower) ||
        r.artist_primary.toLowerCase().includes(lower),
      )
      .map((r) => ({ id: r.id }));
  },
};
vi.mock('../lib/search.js', () => ({
  loadIndex: vi.fn().mockResolvedValue({ index: fakeIndex, byId }),
}));
```

Test cases (each its own `it(...)` block; some may share a `describe('App tab behavior', ...)` group):

1. **Default tab on first render is Browse.**
   - Mount, await `loadIndex` resolution (use `await new Promise((r) => setTimeout(r, 0))` or a `flushPromises` helper). Assert the first tab button has `aria-selected="true"` AND its label is `검색`.
2. **Clicking Favorites with N starred records → body shows all N records, newest-first.**
   - Pre-seed `localStorage.setItem('karaoke-favorites:v1', JSON.stringify(['r2', 'r1']))` (newest-first means `r2` first). Mount, await load. Click the Favorites tab. Assert the rendered `[data-testid="result-card"]` count is 2 AND the first card's text contains `KICK BACK` AND the second contains `Idol`.
3. **With Favorites active and an empty search box, applying a category chip narrows the body to favorites in that category.**
   - Pre-seed favorites = `['r3', 'r1', 'r2']`. Mount, click Favorites tab, click the Vocaloid chip. Assert the rendered card count is 1 AND it contains `Senbonzakura` (only `r3` is `vocaloid`).
4. **With Favorites active, typing a query narrows the body to favorites whose title or artist contains the query (case-insensitive).**
   - Pre-seed favorites = `['r1', 'r2', 'r3']`. Mount, click Favorites tab, type `idol` in the search box (use `fireEvent.input` or mutate `input.value` and dispatch an `input` event), advance debounce (`vi.useFakeTimers()` + `vi.advanceTimersByTime(150)`). Assert exactly 1 card renders AND its text contains `Idol`.
5. **With Favorites active and zero favorites, `<FavoritesEmpty>` renders — not the search-results path.**
   - Ensure `localStorage` is empty for the favorites key. Mount, click Favorites tab. Assert `host.querySelector('.favorites-empty')` is non-null AND `host.querySelector('.result-list')` IS null.
6. **Toggling off the last favorite while on the Favorites tab → placeholder appears; tab stays Favorites.**
   - Pre-seed favorites = `['r1']`. Mount, click Favorites tab. Confirm 1 card renders. Click the star button on that card (look up by `[data-testid="favorite-star"]` or by aria-label) to unfavorite. Assert `host.querySelector('.favorites-empty')` becomes non-null AND the Favorites tab is still `aria-selected="true"`.
7. **Toggling on a favorite while on Browse → tab does not switch; body unchanged.**
   - No pre-seeded favorites. Mount, type a query that matches `r1` (e.g. `idol`), advance debounce. Confirm `r1` card renders. Click its favorite-star. Assert the Browse tab is still `aria-selected="true"` AND the same `r1` card is still rendered.
8. **Switching Favorites → Browse with a query in the box preserves the query; Browse re-runs full-corpus search.**
   - Pre-seed favorites = `['r1']`. Mount, click Favorites tab, type `idol`, advance debounce. Confirm 1 favorite card. Click Browse tab. Assert the input's `.value` is still `idol` AND the rendered cards now include all corpus records whose title/artist contains `idol` (here, just `r1`, but the assertion is "the corpus search ran" — assert `host.querySelector('.result-list')` is non-null and `host.querySelector('.empty-state')` is null because the query is non-empty).
9. **With Favorites active, typing a query that matches no favorites → `<NoResults>` renders (NOT `<FavoritesEmpty>`).**
   - Pre-seed favorites = `['r1']`. Mount, click Favorites tab, type `xyznomatch`, advance debounce. Assert `host.querySelector('.no-results')` is non-null AND `host.querySelector('.favorites-empty')` IS null.
10. **Tab buttons inert during the loading window; clicks ignored until the corpus resolves.**
    - Mock `loadIndex` to return a never-resolving promise (`new Promise(() => {})`) for this test only. Mount. Assert both tab buttons have the `disabled` attribute. Click the Favorites tab. The Favorites tab's `aria-selected` must remain `false`.

Notes for the executor:
- Tests 4 and 8 require fake timers for the 150 ms debounce. Reset timers via `vi.useRealTimers()` in `afterEach` to keep test isolation.
- Tests 2, 3, 6, 8, 9 require `localStorage` seeding before mount. Use `beforeEach` to clear it (`localStorage.removeItem('karaoke-favorites:v1')`).
- Test 10 needs a per-test `loadIndex` override that supersedes the file-level `vi.mock`. Use `vi.mocked(loadIndex).mockReturnValueOnce(new Promise(() => {}))` or restructure that one test into its own `describe` with its own mock.

### Step 2: Update `EmptyState.test.tsx` (drop three favorites cases)

In `apps/web/src/components/EmptyState.test.tsx`, remove the entire `describe('EmptyState favorites surfacing', ...)` block (cases "does not render a favorites section when favoriteIds is empty", "renders a favorites section first with N cards in newest-first order", "silently skips ids that no longer exist in the loaded corpus") — three tests total.

What stays: any tests in that file that exercise the featured-artist sections. **Decision taken in plan: at HEAD `faec6a4`, the file ONLY contains the favorites-surfacing describe block — there are no featured-artist tests. After dropping the block, the file contains only imports and the helper fixtures.** The cleanest move is to delete the entire file. If that leaves `pnpm` complaining about an empty test file, replace its body with a single trivial smoke test:

```tsx
// @vitest-environment jsdom
import { render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import { EmptyState } from './EmptyState.js';

describe('EmptyState featured-artist sections', () => {
  let host: HTMLElement;
  afterEach(() => {
    if (host?.parentNode) host.parentNode.removeChild(host);
  });

  it('renders the three featured-artist sections (J-POP, Vocaloid, Anime)', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    render(<EmptyState onPickArtist={() => {}} />, host);
    const titles = host.querySelectorAll('.empty-section-title');
    expect(titles.length).toBe(3);
    expect(titles[0]?.textContent).toContain('J-POP');
    expect(titles[1]?.textContent).toContain('Vocaloid');
    expect(titles[2]?.textContent).toContain('Anime');
  });
});
```

This new test exercises the post-Phase-2 prop surface (`onPickArtist` only) and locks the featured-artist contract. Use this replacement.

### Step 3: Edit `EmptyState.tsx` — drop the favorites preview block and four props

Replace the file's contents with:

```tsx
import { featured } from '../data/featured.js';

interface EmptyStateProps {
  onPickArtist: (name: string) => void;
}

const SECTIONS: ReadonlyArray<{ key: keyof typeof featured; label: string }> = [
  { key: 'jpop', label: 'J-POP' },
  { key: 'vocaloid', label: 'Vocaloid' },
  { key: 'anime', label: 'Anime' },
];

/**
 * Default landing view shown on the Browse tab when `query` is empty.
 * The favorites preview previously rendered here lives on the Favorites tab
 * now (see TabBar + App.tsx). EmptyState is purely featured-artist content.
 */
export function EmptyState({ onPickArtist }: EmptyStateProps) {
  return (
    <div class="empty-state">
      {SECTIONS.map((section) => {
        const artists = featured[section.key];
        return (
          <section key={section.key} class="empty-section">
            <h2 class={`empty-section-title empty-section-title-${section.key}`}>
              {section.label}
            </h2>
            {artists.length === 0 ? (
              <p class="empty-section-placeholder">아직 없음 / Not yet</p>
            ) : (
              <div class="empty-section-chips">
                {artists.map((name) => (
                  <button
                    key={name}
                    type="button"
                    class="featured-chip"
                    onClick={() => onPickArtist(name)}
                  >
                    {name}
                  </button>
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
```

Diff highlights vs. HEAD:
- Drop the `import type { SongRecord } from '@karaoke/schema';` line.
- Drop the `import { ResultCard } from './ResultCard.js';` line.
- Drop `favoriteIds`, `byId`, `isFavorite`, `onToggleFavorite` from `EmptyStateProps`.
- Drop the `favoriteRecords` resolution block.
- Drop the `{favoriteRecords.length > 0 && ( ... )}` JSX block (the `empty-favorites-section`).

### Step 4: Edit `App.tsx` — add `activeTab` state, mount `<TabBar>`, expand `results` memo, add `<FavoritesEmpty>` branch

The full edited file should look like:

```tsx
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
const SONG_COUNT_DISPLAY = '26,401';

/** Case-insensitive substring match against the four MiniSearch fields. Used
 *  ONLY by the Favorites tab — Browse uses the real MiniSearch index. The
 *  favorites set is bounded by the user (in the dozens), so a linear pass is
 *  sub-millisecond and avoids building a second index. */
function matchesQuery(record: SongRecord, query: string): boolean {
  const q = query.toLowerCase();
  return (
    record.title_primary.toLowerCase().includes(q) ||
    (record.title_ko !== null && record.title_ko.toLowerCase().includes(q)) ||
    record.artist_primary.toLowerCase().includes(q) ||
    (record.artist_ko !== null && record.artist_ko.toLowerCase().includes(q))
  );
}

export function App() {
  const [bundle, setBundle] = useState<IndexBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState('');
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
        const b = await loadIndex();
        if (cancelled) return;
        setBundle(b);
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

  useEffect(() => {
    return () => {
      if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
    };
  }, []);

  const handleInputChange = (value: string) => {
    setInputValue(value);
    if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      setQuery(value);
    }, DEBOUNCE_MS);
  };

  const handlePickArtist = (name: string) => {
    if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
    setInputValue(name);
    setQuery(name);
  };

  /** Pick the candidate set, then run the existing chip + slice pipeline. */
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

  const resultCount = useMemo(() => results.length, [results]);

  // Render-branch selection follows spec §Body rendering rules. Order matters:
  //   1. ErrorState beats everything.
  //   2. Favorites + zero stars → FavoritesEmpty (regardless of query).
  //   3. Browse + empty query → EmptyState (+ optional loading line).
  //   4. Loading window without empty query → loading line.
  //   5. results.length === 0 → NoResults (covers Favorites+typed+no-match too).
  //   6. Otherwise → result list.
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
      ) : activeTab === 'favorites' && favoriteIds.length === 0 ? (
        <FavoritesEmpty />
      ) : activeTab === 'browse' && query === '' ? (
        <>
          <EmptyState onPickArtist={handlePickArtist} />
          {loading && (
            <p class="loading">
              {SONG_COUNT_DISPLAY}곡 검색 인덱스 빌드 중 / Building {SONG_COUNT_DISPLAY}-song index
              <span class="loading-dot" aria-hidden="true">.</span>
              <span class="loading-dot" aria-hidden="true">.</span>
              <span class="loading-dot" aria-hidden="true">.</span>
            </p>
          )}
        </>
      ) : loading ? (
        <p class="loading">
          {SONG_COUNT_DISPLAY}곡 검색 인덱스 빌드 중 / Building {SONG_COUNT_DISPLAY}-song index
          <span class="loading-dot" aria-hidden="true">.</span>
          <span class="loading-dot" aria-hidden="true">.</span>
          <span class="loading-dot" aria-hidden="true">.</span>
        </p>
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
```

Diff highlights vs. HEAD:
- New imports: `FavoritesEmpty`, `TabBar`, `type TabId`.
- New module-scope helper: `matchesQuery(record, query)`.
- New state: `const [activeTab, setActiveTab] = useState<TabId>('browse');`.
- `<EmptyState>` invocation drops four props (now only `onPickArtist`).
- `<TabBar>` mounted between `<SearchBox>` and `<CategoryChips>`.
- `results` memo: branch on `activeTab` to pick the candidate set; the chip+slice pipeline downstream is unchanged.
- Render block: new `activeTab === 'favorites' && favoriteIds.length === 0` arm rendering `<FavoritesEmpty>` BEFORE the `query === ''` check.

### Step 5: Verification (Phase 2)

```bash
corepack pnpm exec biome check apps/web/src/components/App.tsx apps/web/src/components/App.test.tsx apps/web/src/components/EmptyState.tsx apps/web/src/components/EmptyState.test.tsx
corepack pnpm --filter @karaoke/web test
corepack pnpm -r build
```

Expected:

- Biome: 0 errors.
- Vitest: previous baseline + 10 new App tests + 1 replacement EmptyState test (favorites surfacing block dropped) + 5 TabBar tests + 2 FavoritesEmpty tests. All green.
- Build: clean. Bundle gzipped ≤ 50 KB. Astro check (implicit during `corepack pnpm -r build`) passes — `EmptyState`'s prop surface change is statically typed, so any leftover caller passing `favoriteIds`/`byId`/etc. would fail type-check here.

### Step 6: Bilingual sweep

```bash
grep -rnE "[ぁ-んァ-ヶ]" apps/web/src/components apps/web/src/pages
```

Expected: zero hits.

### Risks & rollback (Phase 2)

- **Risk:** `App.test.tsx`'s `vi.mock` interacts badly with the existing `App loading state` and `App loading-state mitigation` describes (they test the loading branch and assume `loadIndex` resolves to a full real bundle).
  **Mitigation:** the new file-level mock returns a real-shaped bundle from a fixture map. The existing tests assert on `.loading` and `.empty-state` selectors — those branches still render off the fixture corpus, so they continue to pass. If a clash surfaces, scope the mock with `vi.mock(..., { ... })` inside specific `describe` blocks instead of file-level.
- **Risk:** the new `matchesQuery` helper is allocated per `results` re-run.
  **Mitigation:** it's a pure function; the cost is negligible at ≤ dozens of records. No memoization required.
- **Risk:** the render-branch order accidentally renders `FavoritesEmpty` instead of `NoResults` when the Favorites tab has favorites + a query that matches none.
  **Mitigation:** the order in the render block is locked: `FavoritesEmpty` only fires on `favoriteIds.length === 0`. Test 9 in App.test.tsx asserts the `NoResults` path explicitly. If this regresses, that test fails fast.
- **Rollback:** revert the four modified files. `TabBar` and `FavoritesEmpty` from Phase 1 stay on disk, unimported, harmless.

---

## Phase 3: CSS for the sticky tab bar in `index.astro`

**Goal:** Land the visual styling for `.tab-bar` and `.tab-button[-active]`. Make the tab bar sticky beneath the header. Verify keyboard + visual checks in the dev server. No JS or test changes.

**Files (modified):**
- `apps/web/src/pages/index.astro`

### Step 1: Declare the `--header-height` custom property on `:root`

CSS custom properties only inherit from ancestors. The tab bar is a child of `<main class="results">`, NOT of `<header>`, so the property must be declared somewhere both elements can see it. Declare it on `:root` so every element in the tree inherits it.

Find the existing `:root` block in `<style is:global>` (it holds the color tokens like `--bg`, `--accent`, etc., near the top of the style block). Append the new property at the end of that block:

```diff
       :root {
         /* existing color tokens... */
+        --header-height: 5.25rem;
       }
```

If the existing token block is named differently (e.g. `:where(html)` or `html`), add the property there instead — anywhere global. The property does NOT also need to be declared on `header.site-header`; the tab bar reads it via `var(--header-height, 5.25rem)` and the `5.25rem` fallback is defense-in-depth.

`5.25rem` is a measured fit: 1rem top padding + 1.4rem h1 font + 0.75rem h1 margin-bottom + 0.7rem×2 input padding + 1.05rem input font + 1rem bottom padding ≈ 5.25rem at 16 px root. The exact value doesn't have to be sub-pixel-perfect; the tab bar's `top:` only needs to sit below the header's resolved bottom edge.

### Step 2: Add the tab-bar CSS block

Insert this block immediately after the existing `header.site-header h1` rule (around line 62, before `.search-input-wrap`):

```css
      .tab-bar {
        position: sticky;
        top: var(--header-height, 5.25rem);
        z-index: 9;
        display: flex;
        margin: 0 0 0.75rem;
        background: var(--bg-elev);
        border: 1px solid var(--border);
        border-radius: 8px;
        overflow: hidden;
      }

      .tab-button {
        flex: 1;
        font: inherit;
        padding: 0.6rem 0.9rem;
        min-height: 44px;
        background: transparent;
        color: var(--fg-muted);
        border: 0;
        border-radius: 0;
        cursor: pointer;
      }

      .tab-button:hover:not(:disabled):not(.tab-button-active) {
        color: var(--fg);
      }

      .tab-button-active {
        background: var(--accent);
        color: var(--accent-fg);
        font-weight: 650;
      }

      .tab-button:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }

      @media (max-width: 719px) {
        .tab-bar {
          margin-left: -1.25rem;
          margin-right: -1.25rem;
          border-radius: 0;
          border-left: 0;
          border-right: 0;
        }
      }
```

Notes:

- `z-index: 9` sits one below the header (`z-index: 10`) so the header always covers a tab bar that scrolls under it.
- The mobile rule offsets the `1.25rem` `main.results` horizontal padding so the bar reaches the viewport edges. `border-radius: 0` and stripped side borders match the spec's "flush edges" call-out.
- Each `.tab-button` is 44 px tall (matching the existing `Task 8` mobile audit) — already meets the spec's mobile tap-target requirement on every viewport.
- `.tab-button-active` stays accent-on-accent-fg (matching `.chip-selected`), so dark/light theme swaps don't need new tokens.

### Step 3: Manual visual verification

```bash
corepack pnpm --filter @karaoke/web dev
```

Open `http://localhost:4321/karaoke-search/`. Verify:

1. The tab bar sits flush beneath the search header, segmented-control look, full width within the `main.results` content column.
2. Scrolling the result list keeps the tab bar pinned beneath the header.
3. Click `즐겨찾기` — body switches; click `검색` — body switches back.
4. Press Tab from the search box: focus lands on the active tab button. Press ArrowRight: focus moves to the inactive tab button (no body change yet — focus only). Press ArrowLeft: focus returns. Press Enter while focused on the inactive tab: body switches.
5. Resize to mobile width (<720 px in DevTools Device Mode). Confirm the tab bar reaches both viewport edges, both tabs are ≥ 44 px tall, no horizontal overflow.
6. While the corpus is still loading (use DevTools Network throttling to "Slow 3G" + reload), confirm both tab buttons appear at reduced opacity and clicking them does nothing — the body stays on the empty-state view.

Stop the dev server with Ctrl-C.

### Step 4: Verification

```bash
corepack pnpm exec biome check apps/web/src/pages/index.astro
corepack pnpm -r build
```

Expected: 0 errors. Bundle size guard passes.

### Risks & rollback (Phase 3)

- **Risk:** future edits move the custom property off `:root`, breaking inheritance to the tab bar.
  **Mitigation:** the property is declared on `:root` per Step 1, and `.tab-bar`'s `top:` uses `var(--header-height, 5.25rem)` so a missing or unreachable property still produces a sane offset.
- **Risk:** the sticky offset drifts if a future change alters the header's resolved height.
  **Mitigation:** the spec acknowledges this risk and accepts the `--header-height` single-source-of-truth approach. Future header tweaks update the one custom property.
- **Risk:** sticky-on-sticky with the search header creates z-index layering bugs.
  **Mitigation:** explicit `z-index: 9` on `.tab-bar` is one below the header's `z-index: 10`. If a third sticky element appears later (e.g. a category-chip drawer), the convention extends downward (`z-index: 8`).
- **Rollback:** revert `apps/web/src/pages/index.astro`. The component-level changes from Phase 2 still work — they just render unstyled (browser-default button look in a flex row).

---

## Phase 4: Final verification

**Goal:** Run the spec's full acceptance suite end-to-end. No code changes; only verification commands. If anything fails, return to the relevant earlier phase, fix, re-verify here.

### Step 1: Full web test suite green

```bash
corepack pnpm --filter @karaoke/web test
```

Expected: previous baseline (35 from the frontend-polish plan's final state) + 5 TabBar + 2 FavoritesEmpty + 10 new App-tab tests − 3 dropped EmptyState favorites tests + 1 replacement EmptyState test = roughly 50 tests passing. Recount once you arrive — the literal totals depend on which sub-tests vitest discovers. **All tests green is the gate.**

### Step 2: Schema and crawler tests still pass (untouched)

```bash
corepack pnpm --filter @karaoke/schema test
corepack pnpm --filter @karaoke/crawler test
```

Expected: schema and crawler counts unchanged from baseline. This phase touched zero files in those packages — any drift is a real regression and blocks merge.

### Step 3: Biome lint

```bash
corepack pnpm exec biome check .
```

Expected: 0 errors across the full repo.

### Step 4: Type and bundle build

```bash
corepack pnpm -r build
```

Expected:

- `@karaoke/schema` builds.
- `@karaoke/crawler` builds.
- `@karaoke/web` builds. Astro `tsc`-equivalent check passes (any leftover caller of the old `EmptyState` props would fail here).
- `scripts/check-bundle-size.mjs` postbuild guard exits 0 — gzipped island ≤ 50 KB. Two new components are small (~40 LOC TabBar + ~10 LOC FavoritesEmpty) and a few CSS rules; the diff is well within the headroom.

### Step 5: Bilingual sweep

```bash
grep -rnE "[ぁ-んァ-ヶ]" apps/web/src/components apps/web/src/pages
```

Expected: zero hits. New strings are Korean + English only.

### Step 6: Manual dev-server smoke check

```bash
corepack pnpm --filter @karaoke/web dev
```

At `http://localhost:4321/karaoke-search/`, verify each item in the spec's "Manual verification before declaring done" list:

- [ ] Tab strip is sticky under the search header.
- [ ] Both tabs reachable by mouse (click) and keyboard (Tab into the strip, ArrowLeft/ArrowRight cycle focus, Enter activates).
- [ ] Mobile viewport (DevTools Device Mode at, e.g., iPhone 12) keeps tap targets ≥ 44 px tall on both tab buttons. Tab bar reaches viewport edges with `border-radius: 0`.
- [ ] Star a result on Browse → switch to Favorites → the starred record appears.
- [ ] On Favorites tab, unstar the same record → record disappears; if it was the last one, `<FavoritesEmpty>` placeholder appears, tab stays on Favorites.
- [ ] On Favorites tab with ≥ 1 favorite, type a query that matches a favorite → the matching favorite renders; type a query that matches none → `<NoResults>` renders.
- [ ] Switch Favorites → Browse with a query in the box → query persists, Browse re-runs full-corpus search.
- [ ] Reload the page (Ctrl-R) → Browse is the active tab again (no persistence).
- [ ] During the loading window (throttle network to "Slow 3G" and reload), both tab buttons are visually disabled and do not switch the body.

Stop the dev server with Ctrl-C.

### Risks & rollback (Phase 4)

- **Risk:** an existing test from the prior frontend-polish work (e.g. `EmptyState.test.tsx`'s favorites cases) still exists in the repo and Phase 2 forgot to drop it.
  **Mitigation:** Step 1's vitest run surfaces the failure with the exact file/line. Drop the offender in a tiny follow-up edit; don't claim done until all green.
- **Risk:** the sticky-tab CSS snags on a Safari quirk (sticky inside a flex container).
  **Mitigation:** the tab bar is a direct child of `<main class="results">`, which uses a plain block layout, not flex. No conflict.
- **Rollback:** the entire feature is opt-in via the `activeTab` state; reverting Phases 1–3 (or any subset that breaks) restores the prior browse-only behavior.

---

## Done when

The plan is complete when **all** the following are true:

- [ ] `corepack pnpm --filter @karaoke/web test` runs all unit + behavior tests green (TabBar 5, FavoritesEmpty 2, App tab behavior 10, EmptyState replacement 1, plus existing baseline).
- [ ] `corepack pnpm exec biome check .` is clean across the repo.
- [ ] `corepack pnpm -r build` completes; bundle gzipped ≤ 50 KB (postbuild guard exits 0).
- [ ] Dev-server eyeball check at `http://localhost:4321/karaoke-search/` confirms:
  - Tab strip is sticky under the search header.
  - Both tabs reachable by mouse + keyboard (arrow keys cycle focus).
  - Mobile viewport keeps tap targets ≥ 44 px.
  - Starring/unstarring cards updates the Favorites body correctly when on the Favorites tab.
  - Reload restores Browse as the active tab.
- [ ] `grep -rnE "[ぁ-んァ-ヶ]" apps/web/src/components apps/web/src/pages` returns zero hits (no Japanese strings introduced).
- [ ] No new dependencies added to any `package.json`.
- [ ] No changes outside `apps/web/src/components/` and `apps/web/src/pages/index.astro`.
- [ ] Tab labels in the source are exactly `검색` and `즐겨찾기` — verified by reading `TabBar.tsx`'s `TABS` constant.

---

## Self-review

Spec coverage map:

- Components → New → `TabBar.tsx` → **Phase 1, Steps 2 + 4**.
- Components → New → `FavoritesEmpty.tsx` → **Phase 1, Steps 1 + 3**.
- Components → Modified → `App.tsx` (`activeTab` state, mount `<TabBar>`, candidate-set switch in `results` memo, render branch for `<FavoritesEmpty>`) → **Phase 2, Step 4**.
- Components → Modified → `EmptyState.tsx` (drop favorites preview block + four props) → **Phase 2, Step 3**.
- Components → Modified → `index.astro` (sticky `.tab-bar` CSS, mobile flush edges) → **Phase 3, Steps 1–2**.
- Testing → New unit tests → `TabBar.test.tsx` (5 cases) → **Phase 1, Step 2**.
- Testing → New unit tests → `FavoritesEmpty.test.tsx` (2 cases) → **Phase 1, Step 1**.
- Testing → New behavior tests on `App.test.tsx` (10 cases) → **Phase 2, Step 1**.
- Testing → Updated tests → `EmptyState.test.tsx` (drop favorites cases) → **Phase 2, Step 2**.
- Manual verification list → **Phase 4, Step 6** (every item replicated).

Test-case coverage check (spec lists 5 + 2 + 10 + 1 update = 18 test additions/edits):

- TabBar 1 (label literals regardless of count) → Phase 1 Step 2 case 1.
- TabBar 2 (aria-selected) → case 2.
- TabBar 3 (active-click no-op) → case 3.
- TabBar 4 (Arrow-Left/Right focus) → case 4.
- TabBar 5 (disabled inert) → case 5.
- FavoritesEmpty 1 (bilingual text) → Phase 1 Step 1 case 1.
- FavoritesEmpty 2 (★ glyph) → case 2.
- App 1 (default Browse) → Phase 2 Step 1 case 1.
- App 2 (Favorites with N stars) → case 2.
- App 3 (chip narrows favorites) → case 3.
- App 4 (typed query narrows favorites) → case 4.
- App 5 (zero favorites placeholder) → case 5.
- App 6 (last-unstar fall to placeholder) → case 6.
- App 7 (star on Browse no-switch) → case 7.
- App 8 (Fav→Browse query preserved) → case 8.
- App 9 (Favorites + no-match query → NoResults) → case 9.
- App 10 (loading window inert) → case 10.
- EmptyState updated → Phase 2 Step 2.

No gaps detected.

Decisions taken in plan (collected for audit):

1. `favoriteCount` stays on the `TabBarProps` surface but is unused in the render — keep forward compatibility for a future count badge without re-plumbing. (Phase 1 Step 4.)
2. `aria-controls` / `role="tabpanel"` wiring is **not** added in this round — spec only calls for `tablist`/`tab`/`aria-selected`. (Phase 1 Step 4.)
3. The substring matcher lives inline in `App.tsx` as `matchesQuery(record, query)` — single call site, no `lib/` extraction. (Phase 2 Step 4.)
4. `<NoResults>` is the fallback for "Favorites tab + typed query + zero matches"; `<FavoritesEmpty>` is **only** for `favoriteIds.length === 0`. Render-branch order is locked. (Phase 2 Step 4.)
5. Switching tabs preserves `inputValue` and `query` — no reset on tab switch. (Phase 2 Step 4.)
6. `--header-height` custom property is declared on `:root` (not `header.site-header`) so it inherits down to the tab bar; a `5.25rem` fallback on `.tab-bar`'s `top:` covers the inheritance edge case. (Phase 3 Step 1.)
7. Active-tab click in `TabBar.tsx` is a hard no-op (`if (id === activeTab) return;`) at the source — parents don't need to dedupe. (Phase 1 Step 4.)
8. `App.test.tsx` uses Option A (file-level `vi.mock` of `loadIndex` returning a fixture-shaped bundle) over Option B (real MiniSearch fixture corpus). (Phase 2 Step 1.)
9. `EmptyState.test.tsx` is fully replaced (existing file at HEAD only contains the favorites describe block being dropped) with one featured-artist smoke test. (Phase 2 Step 2.)

Ambiguity / open notes flagged for follow-up (none block this plan):

- Spec is silent on whether the loading line should still render on the **Favorites** tab during the loading window. The plan keeps the existing render-branch behavior: while `loading === true`, the loading line renders on Browse (with `EmptyState`) and on Favorites (without `EmptyState`, falling through to the third loading arm). On Favorites with zero favorites, `<FavoritesEmpty>` takes priority over the loading line — debatable; the spec's edge-case table says tab buttons are inert during loading but doesn't dictate the body content. **Resolution: keep `<FavoritesEmpty>` priority; the user has already opened the favorites view and the placeholder is more meaningful than a corpus-loading message in that context.** Logged here for executor awareness.
- Spec's `aria-label="결과 보기 모드"` (or equivalent) for the tab bar's `role="tablist"` is not specified. Plan picks `결과 보기 모드` ("result view mode") as a sensible default. If a copywriter wants a different label, change the literal in `TabBar.tsx`'s top-level `<div>` only — no test asserts on this string.

Placeholder scan: searched the plan for "TBD", "TODO", "fill in details", "similar to Phase" — zero matches. Recount comment in Phase 4 Step 1 is an operational hint (the literal vitest total depends on what the test file count resolves to at landing), not a placeholder for content.

Type consistency:

- `TabBar` exports `type TabId = 'browse' | 'favorites'` — consumed by `App.tsx`'s `useState<TabId>('browse')`.
- `TabBarProps`: `{ activeTab, onChange, favoriteCount, disabled }` — `App.tsx` passes all four.
- `EmptyStateProps` shrinks to `{ onPickArtist }` — `App.tsx`'s call site passes only this.
- `FavoritesEmpty` takes no props.
- `useFavorites()` is unchanged.

Command consistency vs CLAUDE.md Quick Commands: all verification commands use `corepack pnpm` exactly as listed (`corepack pnpm --filter @karaoke/web test`, `corepack pnpm --filter @karaoke/web dev`, `corepack pnpm exec biome check .`, `corepack pnpm -r build`, `corepack pnpm --filter @karaoke/schema test`, `corepack pnpm --filter @karaoke/crawler test`). No bare `pnpm`. No `npm`/`yarn`.
