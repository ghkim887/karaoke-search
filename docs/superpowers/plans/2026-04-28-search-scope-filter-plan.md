# Search Scope Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL — use `superpowers:executing-plans` (or `superpowers:subagent-driven-development`) to implement this plan phase-by-phase. Steps use checkbox (`- [ ]`) syntax for tracking. Each phase is independently verifiable: scope → tests → implementation → verification → single conventional commit. Author and review are separate passes per OMC orchestration rules — code-reviewer or verifier signs off between phases.

**Goal:** Add a three-way scope filter (`전체` / `곡명` / `가수`) below the tab bar that restricts which fields the search query is matched against. Default `전체` (current 4-field behavior). `곡명` restricts to `title_primary` + `title_ko`; `가수` restricts to `artist_primary` + `artist_ko`. Applies to **both** the Browse-tab MiniSearch query and the Favorites-tab `matchesQuery` substring narrowing. Ephemeral state (resets to `전체` on reload). Frontend-only, no schema or crawler change.

**Spec:** `docs/superpowers/specs/2026-04-28-search-scope-filter-design.md` (HEAD `26bc24c`, status: Approved for plan).

**Architecture:** Pure additive Astro+Preact changes inside `apps/web`. One new presentational component (`ScopeFilter.tsx`). One state field added to `App.tsx`. The `results` memo's Browse branch grows a per-call `fields` argument to MiniSearch; the Favorites branch's `matchesQuery` helper grows a third `scope` parameter. CSS for the segmented-control filter is added to `apps/web/src/pages/index.astro`. No new dependencies. No changes to `useFavorites`, the MiniSearch index build, schema, crawler, or `songs.json`.

**Tech stack:** Astro 4.x · Preact 10.x · MiniSearch · Vitest (jsdom opt-in) · TypeScript · Biome · vanilla CSS.

**Pre-flight environment notes:**

- Use `corepack pnpm` for every command — plain `pnpm` is not on PATH on the Windows host.
- The web workspace's `vitest.config.ts` uses `environment: 'node'`. Tests that render Preact components MUST opt into jsdom via the `// @vitest-environment jsdom` file-level pragma. `jsdom` is already a `@karaoke/web` devDependency. New `ScopeFilter.test.tsx` uses this pragma; existing `App.test.tsx` already does.
- Scope labels are the exact literal Korean strings `전체` / `곡명` / `가수` — no English half, no romaji, no slash format. Locked at the test level (ScopeFilter Test 1).
- **Decision taken in plan:** the scope-to-fields mapping lives as a module-scope const `SCOPE_FIELDS` in `App.tsx`, keyed by `'all' | 'title' | 'artist'`. `'all'` maps to `null` (so the call site can drop the `fields` option entirely on default — preserving the literal current MiniSearch call shape; passing `fields: undefined` would also work but a null sentinel is more explicit). The Browse branch checks `if (SCOPE_FIELDS[scope] !== null)` and conditionally adds `fields:` to the search options object. This keeps the default scope's call site byte-for-byte identical to today.
- **Decision taken in plan:** `matchesQuery` becomes a 3-argument function in `App.tsx`. Module-private (not exported). Single call site. The third argument has type `Scope = 'all' | 'title' | 'artist'`. The function dispatches with a `switch (scope)` block (not a lookup map) because the field accesses are typed and the branches stay short.
- **Decision taken in plan:** the `Scope` type is exported from `ScopeFilter.tsx` (mirrors the `TabId` export from `TabBar.tsx`). Single source of truth.
- **Decision taken in plan:** `<ScopeFilter>` uses the WAI-ARIA radio-group "manual activation" pattern: arrow keys move focus only; Enter/Space commits. This avoids spurious queries on every arrow press. The TabBar uses click-to-commit only (no manual activation pattern), but the scope filter is single-select (radio semantics) so the manual-activation pattern is the correct WAI-ARIA recommendation.
- **Decision taken in plan:** `tabIndex` per scope button follows the radio-group convention — `0` on the active button, `-1` on the others. This collapses the group to a single tab stop and makes Tab traversal predictable. The TabBar does NOT do this (both tabs are tab-stops there) — this is a deliberate divergence because tabs are a known-different ARIA pattern from radio groups.
- **Decision taken in plan:** the scope filter is **not sticky**. Adding a third sticky element on top of the existing header + tab bar would consume too much vertical space on mobile. Documented in the spec.
- **Decision taken in plan:** clicking the already-active scope button is a hard no-op at the source (`if (id === scope) return;`) — same convention as `TabBar.tsx`'s active-click handler.

---

## Phase 1: Scaffold `ScopeFilter.tsx` + extract `scope` state in `App.tsx` (no behavior change)

**Goal:** Land the new component with its unit tests, AND wire a `scope` state into `App.tsx` whose value does not yet affect `results`. The control renders, clicks update state, but the search still runs against all four fields. This isolates a) the component contract and b) the parent state plumbing from c) the actual search-behavior switch (which lands in Phase 2). After Phase 1, dev/build/tests still pass and the Browse / Favorites views still behave exactly as today.

**Files (new):**
- `apps/web/src/components/ScopeFilter.tsx`
- `apps/web/src/components/ScopeFilter.test.tsx`

**Files (modified):**
- `apps/web/src/components/App.tsx` (add `scope` state + mount `<ScopeFilter>`; do NOT thread `scope` into `results` yet).

**Files unchanged in this phase:** `App.test.tsx`, `index.astro` (CSS lands in Phase 3), every `lib/*` module, every other component.

### Step 1: Write `ScopeFilter.test.tsx` (TDD — tests first)

Create `apps/web/src/components/ScopeFilter.test.tsx`. Use the `// @vitest-environment jsdom` pragma at the top. Mirror the existing test harness in `TabBar.test.tsx` (`render` from `preact`, `host = document.createElement('div')` mount/teardown pattern, `vi.fn()` spies for `onChange`).

Cases:

1. **Renders three buttons with the literal Korean labels `전체` / `곡명` / `가수`.**
   - Mount with `scope='all'`, `onChange={vi.fn()}`, `disabled={false}`.
   - Query `host.querySelectorAll('[role="radio"]')`. Assert length 3.
   - Assert `buttons[0].textContent?.trim() === '전체'`, `buttons[1].textContent?.trim() === '곡명'`, `buttons[2].textContent?.trim() === '가수'`.
2. **Active scope has `aria-checked="true"`; the other two have `aria-checked="false"`.**
   - Render with `scope='all'` → assert `buttons[0].getAttribute('aria-checked') === 'true'` AND the others `=== 'false'`.
   - Re-render with `scope='title'` → second is true, others false.
   - Re-render with `scope='artist'` → third is true, others false.
3. **Clicking an inactive button fires `onChange` with the right scope; clicking the active button is a no-op.**
   - Render with `scope='all'` and a `vi.fn()` spy. Click button 1 (`곡명`) → spy called once with `'title'`. Click button 2 (`가수`) → spy called with `'artist'` (resets across calls; assert most-recent call args). Click button 0 (active `전체`) → call count unchanged.
4. **Arrow-Left / Arrow-Right cycle focus among the three buttons (wrapping).**
   - Mirror `CategoryChips`'s focus-cycling test. From button 0, press ArrowRight → `document.activeElement === buttons[1]`. ArrowRight → `buttons[2]`. ArrowRight → `buttons[0]` (wrap). ArrowLeft → `buttons[2]` (wrap).
5. **Arrow keys do NOT auto-activate.**
   - Render with `scope='all'` and a spy. Focus button 0, press ArrowRight (focus moves to button 1). Press ArrowRight again (focus moves to button 2). Assert spy was called 0 times.
6. **`tabIndex` is `0` on the active button and `-1` on the others.**
   - Render with `scope='all'`. Assert `buttons[0].tabIndex === 0` AND `buttons[1].tabIndex === -1` AND `buttons[2].tabIndex === -1`.
   - Re-render with `scope='title'`. Assert `buttons[1].tabIndex === 0` AND the others `-1`.
7. **While `disabled` (loading), buttons are inert and don't fire on click.**
   - Render with `disabled={true}` and a spy. Click each button → spy not called. Assert each button has the `disabled` attribute.

### Step 2: Implement `ScopeFilter.tsx`

Create `apps/web/src/components/ScopeFilter.tsx`:

```tsx
import { useRef } from 'preact/hooks';

export type Scope = 'all' | 'title' | 'artist';

interface ScopeFilterProps {
  scope: Scope;
  onChange: (scope: Scope) => void;
  disabled: boolean;
}

const SCOPES: ReadonlyArray<{ id: Scope; label: string }> = [
  { id: 'all', label: '전체' },
  { id: 'title', label: '곡명' },
  { id: 'artist', label: '가수' },
];

/**
 * Three-button segmented-control for restricting which fields the search query
 * is matched against. Single-select. Default `'all'` (= current 4-field
 * behavior). Mirrors `TabBar` for refs-array + arrow-key focus cycling, but
 * uses the WAI-ARIA radio-group pattern (single-select, manual activation):
 *
 *   - Container: `role="radiogroup" aria-label="검색 범위"`.
 *   - Each button: `role="radio"` + `aria-checked={isActive}`.
 *   - `tabIndex={0}` on the active button, `-1` on the others — the group is
 *     a single tab stop; arrow keys cycle within.
 *   - Arrow keys move focus only; Enter/Space (default button activation)
 *     commit the choice. No auto-activation on arrow.
 *   - Active-click is a hard no-op at the source.
 */
export function ScopeFilter({ scope, onChange, disabled }: ScopeFilterProps) {
  const buttonsRef = useRef<Array<HTMLButtonElement | null>>([]);

  const handleKeyDown = (e: KeyboardEvent, idx: number) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    const next = (idx + dir + SCOPES.length) % SCOPES.length;
    buttonsRef.current[next]?.focus();
  };

  const handleClick = (id: Scope) => {
    if (id === scope) return;
    onChange(id);
  };

  return (
    <div class="scope-filter" role="radiogroup" aria-label="검색 범위">
      {SCOPES.map((opt, idx) => {
        const isActive = scope === opt.id;
        return (
          <button
            key={opt.id}
            ref={(el) => {
              buttonsRef.current[idx] = el;
            }}
            type="button"
            role="radio"
            class={`scope-button ${isActive ? 'scope-button-active' : ''}`}
            aria-checked={isActive}
            tabIndex={isActive ? 0 : -1}
            disabled={disabled}
            onClick={() => handleClick(opt.id)}
            onKeyDown={(e) => handleKeyDown(e, idx)}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
```

Notes:

- `Scope` is exported (single source of truth for the type — `App.tsx` consumes it).
- The component is a strict mirror of `TabBar` plus two additions: `tabIndex` per button and `aria-checked`/`role="radio"` instead of `aria-selected`/`role="tab"`.
- No `favoriteCount`-equivalent forward-compat prop is needed; the spec does not anticipate a count badge for scope.

### Step 3: Wire `scope` state into `App.tsx` (mount the component, do NOT thread through `results` yet)

Edit `apps/web/src/components/App.tsx`. Add the import:

```tsx
import type { Scope } from './ScopeFilter.js';
import { ScopeFilter } from './ScopeFilter.js';
```

Add the state declaration alongside the other `useState` calls (place it next to `selectedVendors` to keep filter-state grouped):

```tsx
const [scope, setScope] = useState<Scope>('all');
```

Mount the component in the JSX, between `<TabBar>` and `<CategoryChips>`:

```tsx
<TabBar
  activeTab={activeTab}
  onChange={setActiveTab}
  favoriteCount={favoriteIds.length}
  disabled={loading}
/>
<ScopeFilter scope={scope} onChange={setScope} disabled={loading} />
<CategoryChips selected={selectedCategories} onToggle={toggleCategory} />
```

**Do not** modify the `results` memo, the `matchesQuery` helper, or the `index.search` call in this phase. The `scope` value is read by the component (controlled prop) but does not yet affect search outcomes. This is intentional — Phase 1 is component scaffold + state plumbing only.

> **Lint note:** Biome may flag `scope` as set-but-unused in the dependency-array sense once the rest of the file lands. To avoid a temporary noise warning, add a single line that "uses" `scope` trivially: in the existing `useMemo(() => { ... }, [bundle, query, activeTab, favoriteIds, selectedCategories, selectedVendors])`, append `scope` to the dependency array now. The memo body still does not reference it, so the compiler treats it as an unused dep — but Biome's React rules will be quieter, and Phase 2 fills in the body. **Decision taken in plan:** add `scope` to the deps array in Phase 1 even though Phase 2 is the consumer. This is a one-character forward-compat move; it does not change any behavior because the memo's body still does not branch on `scope`. If Biome's `react-hooks/exhaustive-deps`-equivalent flags `scope` as unused, suppress with a `// biome-ignore lint/correctness/useExhaustiveDependencies: scope is consumed in Phase 2` comment as a tight scoped exception, removed in Phase 2 once the body uses `scope`.

### Step 4: Verification (Phase 1)

```bash
corepack pnpm exec biome check apps/web/src/components/ScopeFilter.tsx apps/web/src/components/ScopeFilter.test.tsx apps/web/src/components/App.tsx
corepack pnpm --filter @karaoke/web test
corepack pnpm -r build
```

Expected:

- Biome: 0 errors. The temporary `biome-ignore` comment (if needed) is removed in Phase 2.
- Vitest: previous baseline + 7 new ScopeFilter tests. All green. The existing `App.test.tsx` cases pass unchanged — Phase 1 does not change any visible behavior.
- Build: clean. Bundle gzipped ≤ 50 KB. The new component adds ~40 LOC; well within headroom.
- Manual: `corepack pnpm --filter @karaoke/web dev` and visit `http://localhost:4321/karaoke-search/`. Confirm the three scope buttons render between the tab bar and the category chips. Click each — visual active-state changes (even though styling is browser-default until Phase 3). Search behavior is unchanged because `scope` is not yet threaded.

### Step 5: Bilingual sweep (sanity)

```bash
grep -rnE "[ぁ-んァ-ヶ]" apps/web/src/components apps/web/src/pages
```

Expected: zero hits. The new file contains no hiragana/katakana.

### Acceptance criteria (Phase 1)

- [ ] `ScopeFilter.tsx` exports `Scope` type + `ScopeFilter` component.
- [ ] All seven new ScopeFilter tests pass.
- [ ] `App.tsx` declares `scope` state, mounts `<ScopeFilter>` between `<TabBar>` and `<CategoryChips>`.
- [ ] Scope value is purely cosmetic in this phase — the `results` memo does not branch on it. All existing tests still pass.
- [ ] `corepack pnpm exec biome check .` is clean.
- [ ] `corepack pnpm -r build` succeeds; bundle size guard passes.
- [ ] No new strings outside Korean + English; no Japanese characters introduced.

### Verifier evidence to gather (Phase 1)

- Vitest output: full test count delta = `+7` (new ScopeFilter cases). All previously-green tests still green. Capture stdout from `corepack pnpm --filter @karaoke/web test`.
- Biome output: `0 errors, 0 warnings` in the touched-files scope. Capture stdout from the targeted-files biome run AND the full-repo `corepack pnpm exec biome check .`.
- Build output: capture the final lines of `corepack pnpm -r build` showing `@karaoke/web` build success and the `scripts/check-bundle-size.mjs` postbuild guard exit code 0.
- Manual browser-check checklist:
  - [ ] Three buttons render below the tab bar, above the category chips.
  - [ ] Default `전체` is visually active (browser-default focus / pressed state — final styling lands in Phase 3).
  - [ ] Clicking each button flips the active state.
  - [ ] No console errors.
  - [ ] Existing search/browse/favorites behavior is unchanged (typing returns the same results as before).

### Verifier checkpoint (between Phase 1 and Phase 2)

**Stop here. Run a separate verifier or code-reviewer agent pass before proceeding to Phase 2.** Per OMC orchestration rules and `CLAUDE.md`, author and review are always separate agent passes — never self-approve. The verifier's job at this checkpoint:

- Confirm the test suite is genuinely green (re-run, do not trust prior output).
- Confirm the dev-server eyeball check shows no regression in search/browse/favorites.
- Confirm the `scope` state is wired but does not yet affect `results` — read the diff and assert the memo body is byte-for-byte identical to HEAD.
- Approve the Phase 1 commit.

If the verifier flags a regression or contract violation, return to the appropriate step and re-verify. Do not advance.

### Single conventional commit (Phase 1)

After verifier sign-off, stage and commit with a single conventional commit:

```bash
git add apps/web/src/components/ScopeFilter.tsx apps/web/src/components/ScopeFilter.test.tsx apps/web/src/components/App.tsx
git commit -m "$(cat <<'EOF'
feat(web): scaffold ScopeFilter component (phase 1)

Scope filter is a follow-up tracked in CLAUDE.md (MEDIUM): three-way
segmented-control to restrict search matching to title-only or artist-only
fields. Phase 1 lands the presentational component, its 7 unit tests, and
the parent state plumbing. Behavior is unchanged — `scope` is held in
state and passed to ScopeFilter, but `results` does not yet branch on it.
Phase 2 threads the value through the MiniSearch call and the favorites
matchesQuery helper.

Spec: docs/superpowers/specs/2026-04-28-search-scope-filter-design.md
Plan: docs/superpowers/plans/2026-04-28-search-scope-filter-plan.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Risks & rollback (Phase 1)

- **Risk:** Biome's unused-deps lint trips on the temporary `scope`-in-deps-array workaround.
  **Mitigation:** the `biome-ignore` comment in Step 3's note covers this; removed in Phase 2 when the deps array is genuinely consumed.
- **Risk:** ArrowLeft/Right test flakes in jsdom.
  **Mitigation:** dispatch via `new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })`, matching the existing `TabBar.test.tsx` and `CategoryChips.test.tsx` pattern. Both have been green for weeks.
- **Rollback:** revert the three touched files. No other files affected.

---

## Phase 2: Thread `scope` into the MiniSearch call AND `matchesQuery`

**Goal:** Make the scope filter actually do something. The `results` memo's Browse branch passes `fields:` into `index.search` when `scope !== 'all'`. The `matchesQuery` helper grows a `scope` argument and dispatches over it. After this phase, the feature is functionally complete in dev — only CSS polish + final verification remain.

**Files (modified):**
- `apps/web/src/components/App.tsx`
- `apps/web/src/components/App.test.tsx`

**Files unchanged in this phase:** `ScopeFilter.tsx`, `ScopeFilter.test.tsx`, every other component, every `lib/*` module, `index.astro`, `EmptyState.tsx`, `EmptyState.test.tsx`, `useFavorites`.

### Step 1: Write the new `App.test.tsx` behavior tests (TDD — tests first)

Add a new sibling `describe('App scope filter', () => { ... })` block to `apps/web/src/components/App.test.tsx`. Use the same per-describe `vi.spyOn(searchModule, 'loadIndex').mockResolvedValue(fixtureBundle)` scoping pattern established in the favorites-tab plan. **Do not** introduce a file-level `vi.mock` — the existing `App loading state` and `App loading-state mitigation` tests rely on the real un-mocked `loadIndex`.

**Critical fixture extension:** the existing 3-record fixture (`r1` Idol/YOASOBI, `r2` KICK BACK/米津玄師, `r3` Senbonzakura/初音ミク) is reused. Add one more record designed to discriminate scopes:

```ts
const r4: SongRecord = {
  id: 'r4',
  title_primary: 'Hatsune',
  title_ko: '하츠네',
  artist_primary: 'IDOL Group',
  artist_ko: '아이돌 그룹',
  categories: ['jpop'],
  karaoke_numbers: { tj: '99999', ky: null, joysound: null },
  source_url: 'https://example.invalid/4',
};
```

Discrimination logic: the substring `idol` (case-insensitive) appears in `r4.artist_primary` but NOT in `r4.title_primary` (the title is `Hatsune`). Conversely, the substring `hatsune` appears in `r4.title_primary` but not in `r4.artist_primary` (the artist is `IDOL Group`). Combined with `r1` (`title_primary === 'Idol'`, artist `YOASOBI` — a title-`idol` hit), this gives a clean 2x2 for scope tests.

**Note on `r3`'s `artist_ko === '하츠네 미쿠'`:** the substring `하츠네` matches `r3.artist_ko` AND `r4.title_ko === '하츠네'`. Tests should assert the *negative* (which records are excluded) rather than locking exact counts, because the MiniSearch fuzzy + prefix options affect positive counts in ways unrelated to scope.

> **Important — fixture mutation safety:** the existing favorites-tab test fixture is module-scoped above the favorites describe block. Adding `r4` requires either (a) defining a new fixture array in the new `describe('App scope filter', ...)` block (preferred — keeps the favorites-tab fixture untouched) OR (b) extending the shared fixture and updating the favorites-tab test count assertions (rejected — too invasive). **Decision taken in plan: define a separate fixture inside the new describe block.** Naming: call the local fixture `scopeFixtureRecords` / `scopeFixtureBundle` to avoid shadowing.

#### Test cases (each its own `it(...)` block inside `describe('App scope filter', ...)`):

1. **Default scope on first render is `'all'` (the `전체` button is `aria-checked="true"`).**
   - Mount, await load. Query `host.querySelector('[role="radiogroup"]')`. Assert non-null. Query its `[role="radio"]` children — assert length 3. Assert `buttons[0].getAttribute('aria-checked') === 'true'` AND the others `=== 'false'`. Assert `buttons[0].textContent.trim() === '전체'`.

2. **Scope = `곡명` (`'title'`) hides artist-only matches on Browse.**
   - Mount, await load. Click the `곡명` button (find by text content). Type `idol` into the search input, advance fake timers by 150 ms (debounce). Assert the rendered `[data-testid="result-card"]` (or whatever the existing test selector is) DOES contain `Idol` (matches `r1.title_primary`) AND DOES NOT contain `IDOL Group` (`r4`'s artist-only match).
   - Reasoning: `r1` matches via title (`title_primary === 'Idol'`). `r4` matches via artist (`artist_primary === 'IDOL Group'`) which is now hidden by scope.

3. **Scope = `가수` (`'artist'`) hides title-only matches on Browse.**
   - Mount, await load. Click the `가수` button. Type `hatsune`, advance debounce. Assert the rendered cards DO NOT contain `Hatsune` as a title (`r4`'s title-only match must be excluded).
   - Positive assertion: at least one card renders, and it must be a record where `hatsune` matches an artist field. Given the fixture, no record has `hatsune` in an artist field (in either Latin or Korean). The expected outcome is therefore zero cards → `<NoResults>` renders.
   - **Decision taken in plan:** assert `host.querySelector('.no-results')` is non-null AND `host.querySelector('.result-list')` is null. This is the cleanest assertion — the scope hid the only fixture match.
   - **Alternative for stronger positive coverage:** add a record `r5` with `artist_primary: 'Hatsune Singer'` to ensure scope=`가수` returns at least one card on the same query. **Decision taken in plan:** add `r5` to keep both positive and negative assertions in the same test:
     ```ts
     const r5: SongRecord = {
       id: 'r5', title_primary: 'Different Title', title_ko: '다른 곡',
       artist_primary: 'Hatsune Singer', artist_ko: '하츠네 가수',
       categories: ['jpop'], karaoke_numbers: { tj: '88888', ky: null, joysound: null },
       source_url: 'https://example.invalid/5',
     };
     ```
     With `r5` in the fixture, the test asserts: rendered cards contain `Hatsune Singer` AND do NOT contain `Hatsune` as a title (`r4` excluded). The `<NoResults>` fallback path is not exercised here; the explicit empty-result case is covered by tests 5 and elsewhere.

4. **Scope = `'all'` (default) returns the union — regression-free default behavior.**
   - Mount, await load. Type `idol`, advance debounce. Assert rendered cards contain BOTH `Idol` (title hit on `r1`) AND `IDOL Group` (artist hit on `r4`). This locks the regression-free default — switching the scope plumbing must not silently change the all-fields behavior.

5. **Switching scope re-runs the search; query is preserved.**
   - Mount, await load. Type `idol`, advance debounce. Assert default scope returns `r1` + `r4` (two cards, presence-based assertion).
   - Click `곡명`. Assert the input's `.value` is still `idol`. Assert rendered cards drop to a set that contains `Idol` (`r1`) and excludes `IDOL Group` (`r4`).
   - Click `가수`. Assert rendered cards include `IDOL Group` (`r4`) and exclude `Idol` (`r1`).
   - Click `전체`. Assert rendered cards return to the union state.

6. **Scope applies to the Favorites-tab `matchesQuery` narrowing.**
   - Pre-seed `localStorage` with `karaoke-favorites:v1 = JSON.stringify(['r1', 'r4'])`. Mount, await load. Click the Favorites tab (find by text `즐겨찾기`). Type `idol`, advance debounce. Default scope (`전체`) — assert 2 cards rendered (both favorites match).
   - Click `곡명`. Assert 1 card rendered, containing `Idol` (`r1` only).
   - Click `가수`. Assert 1 card rendered, containing `IDOL Group` (`r4` only).
   - Click `전체`. Assert 2 cards rendered.

7. **Scope and category chips compose.**
   - Mount, await load. Click `곡명`. Click the `J-POP` category chip. Type `idol`, advance debounce. Assert rendered cards contain `Idol` (`r1`, jpop + title-`idol`) AND exclude `IDOL Group` (`r4`, jpop but artist-`idol` — hidden by scope).

8. **Scope reset on reload (no persistence).**
   - Mount, await load. Click `곡명`. Confirm `aria-checked="true"` on `곡명`. Unmount (`render(null, host)`). Remount with a fresh `<App />`. Await load. Assert `전체` is the active scope again (no `localStorage` consultation, no URL hash reading). Confirms ephemerality.

9. **Scope buttons inert during the loading window.**
   - Override `loadIndex` for this single test: `vi.spyOn(searchModule, 'loadIndex').mockReturnValueOnce(new Promise(() => {}))` (never resolves). Mount. Assert all three scope buttons have the `disabled` attribute. Click `곡명` → `aria-checked` does not move off `전체`.

#### Notes for the executor

- Tests 2, 3, 5, 6, 7 require fake timers for the 150 ms debounce. Use `vi.useFakeTimers()` per `it(...)` and `vi.useRealTimers()` in `afterEach`.
- Tests 6 requires `localStorage.setItem('karaoke-favorites:v1', ...)` BEFORE mount. Other tests should `localStorage.removeItem('karaoke-favorites:v1')` in `beforeEach` to keep test isolation.
- The fixture's `index.search` (the fake one) needs to honor the `fields` option. Update the fake to dispatch on `options?.fields`:
  ```ts
  const fakeIndex = {
    search: (q: string, options?: { fields?: readonly string[] }) => {
      const lower = q.toLowerCase();
      const fields = options?.fields ?? ['title_primary', 'title_ko', 'artist_primary', 'artist_ko'];
      return scopeFixtureRecords
        .filter((r) => fields.some((f) => {
          const v = (r as unknown as Record<string, unknown>)[f];
          return typeof v === 'string' && v.toLowerCase().includes(lower);
        }))
        .map((r) => ({ id: r.id }));
    },
  };
  ```
  This makes the test fixture honest about the contract being tested. Without this, scope tests would silently pass against a fake that ignores `fields` — a critical regression hole.

### Step 2: Edit `App.tsx` — thread `scope` into MiniSearch + `matchesQuery`

Edit `apps/web/src/components/App.tsx`. Three concrete diffs:

#### Diff 2a: `matchesQuery` signature + dispatch

Replace the existing `matchesQuery` function with:

```tsx
import type { Scope } from './ScopeFilter.js';

/** Scope → list of fields to test. `'all'` means all four fields. */
function matchesQuery(record: SongRecord, query: string, scope: Scope): boolean {
  const q = query.toLowerCase();
  switch (scope) {
    case 'title':
      return (
        record.title_primary.toLowerCase().includes(q) ||
        (record.title_ko !== null && record.title_ko.toLowerCase().includes(q))
      );
    case 'artist':
      return (
        record.artist_primary.toLowerCase().includes(q) ||
        (record.artist_ko !== null && record.artist_ko.toLowerCase().includes(q))
      );
    default:
      return (
        record.title_primary.toLowerCase().includes(q) ||
        (record.title_ko !== null && record.title_ko.toLowerCase().includes(q)) ||
        record.artist_primary.toLowerCase().includes(q) ||
        (record.artist_ko !== null && record.artist_ko.toLowerCase().includes(q))
      );
  }
}
```

Pure function. Module-private. Single call site (the `results` memo's Favorites branch).

#### Diff 2b: `SCOPE_FIELDS` constant for the Browse branch

Add a module-scope constant alongside `RESULT_LIMIT` / `DEBOUNCE_MS`:

```tsx
const SCOPE_FIELDS: Readonly<Record<Scope, readonly string[] | null>> = {
  all: null,
  title: ['title_primary', 'title_ko'],
  artist: ['artist_primary', 'artist_ko'],
};
```

`null` for `'all'` is the explicit sentinel — the call site below checks for `null` and conditionally adds `fields:` to the search options. This keeps the default-scope call shape literally identical to today (no `fields` option present at all), which matters for binary-comparing the runtime behavior of the default path against pre-Phase-2 HEAD.

#### Diff 2c: `results` memo — Browse branch passes `fields`; Favorites branch passes `scope`

Replace the body of the `results` `useMemo` with:

```tsx
const results: SongRecord[] = useMemo(() => {
  if (bundle === null) return [];
  let candidates: SongRecord[];
  if (activeTab === 'favorites') {
    const favRecords: SongRecord[] = [];
    for (const id of favoriteIds) {
      const rec = bundle.byId.get(id);
      if (rec !== undefined) favRecords.push(rec);
    }
    candidates =
      query === '' ? favRecords : favRecords.filter((r) => matchesQuery(r, query, scope));
  } else {
    if (query === '') return [];
    const scopeFields = SCOPE_FIELDS[scope];
    const hits =
      scopeFields === null
        ? bundle.index.search(query)
        : bundle.index.search(query, { fields: [...scopeFields] });
    const records: SongRecord[] = [];
    for (const hit of hits) {
      const rec = bundle.byId.get(String(hit.id));
      if (rec !== undefined) records.push(rec);
    }
    candidates = records;
  }
  const byCategory = filterByCategories(candidates, selectedCategories);
  return filterByVendors(byCategory, selectedVendors).slice(0, RESULT_LIMIT);
}, [bundle, query, activeTab, favoriteIds, selectedCategories, selectedVendors, scope]);
```

Diff highlights vs. Phase 1 HEAD:

- `matchesQuery` call site grows the third `scope` argument.
- The Browse branch reads `SCOPE_FIELDS[scope]`. When `null`, it calls `bundle.index.search(query)` with no second argument (literal current behavior). When non-null, it calls `bundle.index.search(query, { fields: [...scopeFields] })`. The spread is required because MiniSearch's `fields` option is typed as `string[]` (mutable) and the constant is `readonly string[]`; spreading produces a fresh mutable copy without mutating the constant.
- `scope` is added to the dependency array (the `biome-ignore` comment from Phase 1, if any, is removed now that `scope` is genuinely consumed in the memo body).

No other lines change. The render block is identical. The chip + slice pipeline is identical.

### Step 3: Update existing tests if they reference `matchesQuery` or the search-call shape

Grep the test directory for direct references:

```bash
grep -rn "matchesQuery\|index.search" apps/web/src/components apps/web/src/lib
```

Expected hits: only `App.tsx` (production) and the new fake-index in `App.test.tsx`. The existing `App.test.tsx` favorites-tab tests do NOT directly call `matchesQuery` — they assert via DOM presence. Therefore no existing test needs editing.

If any unexpected hit surfaces (e.g. a unit test for `matchesQuery` extracted as a pure function), update it to pass `'all'` as the third argument, preserving prior semantics.

### Step 4: Verification (Phase 2)

```bash
corepack pnpm exec biome check apps/web/src/components/App.tsx apps/web/src/components/App.test.tsx
corepack pnpm --filter @karaoke/web test
corepack pnpm -r build
```

Expected:

- Biome: 0 errors. The temporary `biome-ignore` from Phase 1 (if added) is removed.
- Vitest: previous baseline + 7 ScopeFilter tests (Phase 1) + 9 new App scope-filter behavior tests = `+16` total over pre-Phase-1 HEAD. All green.
- Build: clean. Bundle gzipped ≤ 50 KB.

### Step 5: Bilingual sweep

```bash
grep -rnE "[ぁ-んァ-ヶ]" apps/web/src/components apps/web/src/pages
```

Expected: zero hits.

### Acceptance criteria (Phase 2)

- [ ] All nine new App scope-filter behavior tests pass.
- [ ] Default scope (`'all'`) produces the same MiniSearch call as pre-Phase-1 HEAD (no `fields` argument). Verifiable by reading the diff at the call site.
- [ ] `matchesQuery` is a 3-argument function; the 3rd argument is `Scope`.
- [ ] `scope` is in the `results` memo dependency array.
- [ ] Browse-tab MiniSearch query honors scope (test 2/3/4/5 pass).
- [ ] Favorites-tab `matchesQuery` honors scope (test 6 passes).
- [ ] Scope and category chips compose (test 7 passes).
- [ ] Scope is ephemeral — resets to `'all'` on remount (test 8 passes).
- [ ] Scope buttons are inert during loading (test 9 passes).
- [ ] `corepack pnpm exec biome check .` is clean.
- [ ] `corepack pnpm -r build` succeeds; bundle size guard passes.
- [ ] No new strings outside Korean + English; no Japanese characters introduced.

### Verifier evidence to gather (Phase 2)

- Vitest output: full test count delta = `+9` from Phase 1 (the new `describe('App scope filter', ...)` cases). Capture stdout from `corepack pnpm --filter @karaoke/web test`.
- Biome output: `0 errors, 0 warnings`. Capture stdout from `corepack pnpm exec biome check .`.
- Build output: capture the final lines of `corepack pnpm -r build` showing `@karaoke/web` build success and the bundle-size guard exit code 0.
- Manual browser-check checklist:
  - [ ] Default `전체`: typing `idol` returns multiple cards (existing all-fields behavior).
  - [ ] Click `곡명`: typing `idol` returns title-only matches; the same query returns fewer cards than the default.
  - [ ] Click `가수`: typing `idol` returns artist-only matches.
  - [ ] Switch to Favorites tab with ≥1 favorite. Star a record from each scope to set up. Type a query that matches title-only on one favorite and artist-only on another. Toggle scope buttons; verify the favorites view updates correctly.
  - [ ] Apply J-POP chip on top of scope; verify intersection works.
  - [ ] Reload the page; scope returns to `전체`.
  - [ ] No console errors.

### Verifier checkpoint (between Phase 2 and Phase 3)

**Stop here.** Run a separate verifier or code-reviewer agent pass before proceeding to Phase 3. The verifier's job:

- Re-run the test suite from a clean state.
- Confirm the manual browser-check items above all pass.
- Read the diff and confirm the default-scope branch (`scope === 'all'`) produces a MiniSearch call shape literally identical to pre-Phase-1 HEAD. This is the regression-free guarantee for the default path.
- Confirm `matchesQuery`'s scope-dispatch covers all three branches with no fall-through.
- Confirm the fixture's fake `index.search` honors `options?.fields` — a fixture that ignores `fields` would silently pass these tests against a broken implementation, which is a critical hole.
- Approve the Phase 2 commit.

### Single conventional commit (Phase 2)

After verifier sign-off:

```bash
git add apps/web/src/components/App.tsx apps/web/src/components/App.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): wire scope filter into search + favorites narrowing (phase 2)

Browse-tab MiniSearch query now honors `scope`: `곡명` restricts to
title_primary + title_ko via per-call `fields:` option; `가수` restricts
to artist_primary + artist_ko; default `전체` calls index.search with no
`fields` argument, byte-for-byte identical to pre-Phase-1 behavior.

Favorites-tab matchesQuery helper grows a third `scope` argument and
dispatches over title/artist/all. Same field set as the Browse branch.

9 new behavior tests on App.test.tsx cover default-scope regression-free,
scope hides title-only/artist-only matches, scope+category chips compose,
favorites narrowing honors scope, scope resets on reload, scope buttons
inert during loading.

Spec: docs/superpowers/specs/2026-04-28-search-scope-filter-design.md
Plan: docs/superpowers/plans/2026-04-28-search-scope-filter-plan.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Risks & rollback (Phase 2)

- **Risk:** the test fixture's fake `index.search` does not honor `fields`, silently passing scope tests against a broken implementation.
  **Mitigation:** Step 1 explicitly extends the fake to dispatch on `options?.fields`. The verifier checkpoint above calls this out as a load-bearing detail.
- **Risk:** MiniSearch's per-call `fields` interacts badly with the index-level `fuzzy: 0.2` and `prefix: true` defaults.
  **Mitigation:** the spec discusses this. The behavior tests assert actual matching outcomes (positive AND negative) rather than internal MiniSearch state, so any silent regression in `fields`+`fuzzy`/`prefix` shows up as a failed test.
- **Risk:** `matchesQuery`'s scope dispatch falls through unexpectedly (e.g. an unhandled `Scope` value).
  **Mitigation:** the `default:` branch handles `'all'` explicitly. TypeScript exhaustiveness via the `Scope` literal union catches any future scope addition at compile time.
- **Risk:** the `results` memo dependency array drifts from the actual reads.
  **Mitigation:** Step 2c explicitly enumerates all reads. Biome's `react-hooks` (or equivalent) lint catches missing deps.
- **Risk:** the Favorites narrowing `matchesQuery` allocation is per-record per-render.
  **Mitigation:** the favorites set is bounded in the dozens. Sub-millisecond cost. No memoization needed (consistent with the favorites-tab spec).
- **Rollback:** revert the two touched files. Phase 1's `ScopeFilter.tsx` stays imported and mounted but inert (`scope` is set but does not affect search outcomes — no regression).

---

## Phase 3: CSS for the segmented-control filter

**Goal:** Land the visual styling for `.scope-filter` and `.scope-button[-active]`. Match the segmented-control look of the tab bar but stay non-sticky. Mobile flush-edges. Accessible focus ring. No JS or test changes.

**Files (modified):**
- `apps/web/src/pages/index.astro`

**Files unchanged in this phase:** every component, every `lib/*` module.

### Step 1: Add the scope-filter CSS block

Open `apps/web/src/pages/index.astro`. Find the existing `.tab-bar` block in `<style is:global>` (added by the favorites-tab plan, near the top of the post-`header.site-header h1` block). Append the new scope-filter rules immediately after the `.tab-bar` mobile media query block, BEFORE the `.search-input-wrap` rule. This keeps the segmented-control styles grouped together visually for future maintainers.

```css
      .scope-filter {
        display: flex;
        margin: 0 0 0.75rem;
        background: var(--bg-elev);
        border: 1px solid var(--border);
        border-radius: 8px;
        overflow: hidden;
      }

      .scope-button {
        flex: 1;
        font: inherit;
        padding: 0.55rem 0.75rem;
        min-height: 44px;
        background: transparent;
        color: var(--fg-muted);
        border: 0;
        border-radius: 0;
        cursor: pointer;
      }

      .scope-button:hover:not(:disabled):not(.scope-button-active) {
        color: var(--fg);
      }

      .scope-button:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: -2px;
      }

      .scope-button-active {
        background: var(--accent);
        color: var(--accent-fg);
        font-weight: 650;
      }

      .scope-button:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }

      @media (max-width: 719px) {
        .scope-filter {
          margin-left: -1.25rem;
          margin-right: -1.25rem;
          border-radius: 0;
          border-left: 0;
          border-right: 0;
        }
      }
```

Notes:

- **Not sticky.** Unlike `.tab-bar`, no `position: sticky;` and no `top:` offset. The scope filter scrolls with the chips.
- **No `z-index`.** Not sticky → no z-index needed. If a future change makes it sticky, the convention from the favorites-tab spec extends downward (`z-index: 8` would be the next slot after `tab-bar: 9` and `header: 10`).
- **`focus-visible` outline.** The radio-group manual-activation pattern relies on visible focus to communicate which button will activate on Enter/Space. Browser default focus rings are not always visible against the active `--accent` background, so an explicit `--accent` outline with `-2px` inset offset gives reliable contrast on both states.
- **`min-height: 44px`** matches the existing mobile tap-target audit baked into the tab bar and chips. Applied at every breakpoint, not just mobile, so the desktop UI is also generous.
- **No new color tokens.** Reuses `--bg-elev`, `--accent`, `--accent-fg`, `--border`, `--fg`, `--fg-muted` from the existing palette.
- **Mobile flush-edges:** `margin-left: -1.25rem; margin-right: -1.25rem; border-radius: 0; border-left: 0; border-right: 0` matches the `.tab-bar` mobile rule. The `1.25rem` offset is the existing `main.results` horizontal padding.

### Step 2: Manual visual verification

```bash
corepack pnpm --filter @karaoke/web dev
```

Open `http://localhost:4321/karaoke-search/`. Verify:

1. The scope filter renders directly below the tab bar and above the category chips. Three equal-width buttons in a single bordered container.
2. Default `전체` is highlighted with the accent color; the other two are muted.
3. Clicking each button flips the active state immediately, with the active accent color.
4. Hover on an inactive button lifts the text color from `--fg-muted` to `--fg`. Hover on the active button is unchanged (excluded by the `:not(.scope-button-active)` selector).
5. Tab from the search box / tab bar: focus lands on the active scope button. ArrowRight: focus moves to the next button (no body change yet — manual activation pattern). ArrowLeft: focus moves back. Enter or Space on the focused button activates it.
6. The `:focus-visible` outline is clearly visible on every button regardless of active state.
7. Resize to mobile width (<720 px in DevTools Device Mode). The filter spans the full viewport edges with `border-radius: 0`, no horizontal scroll, all three buttons ≥44 px tall.
8. While the corpus is still loading (DevTools throttle to "Slow 3G" + reload), all three buttons appear at reduced opacity (`0.55`), `cursor: not-allowed`, and clicking them does nothing.
9. The scope filter is NOT sticky — scroll the result list and confirm the filter scrolls out of view (only the header and tab bar stay pinned).

Stop the dev server with Ctrl-C.

### Step 3: Verification (Phase 3)

```bash
corepack pnpm exec biome check apps/web/src/pages/index.astro
corepack pnpm -r build
```

Expected: 0 errors. Bundle size guard passes.

### Acceptance criteria (Phase 3)

- [ ] `.scope-filter` and `.scope-button[-active|:hover|:disabled|:focus-visible]` rules added to `index.astro`.
- [ ] Mobile flush-edges rule at `(max-width: 719px)` matches the tab bar's pattern.
- [ ] No new color tokens introduced.
- [ ] Filter is NOT sticky.
- [ ] All manual visual verification items pass.
- [ ] `corepack pnpm exec biome check .` is clean.
- [ ] `corepack pnpm -r build` succeeds; bundle size guard passes.

### Verifier evidence to gather (Phase 3)

- Biome output: `0 errors, 0 warnings`. Capture stdout from `corepack pnpm exec biome check apps/web/src/pages/index.astro` AND the full-repo `corepack pnpm exec biome check .`.
- Build output: capture final lines of `corepack pnpm -r build` showing `@karaoke/web` build success and the bundle-size guard exit code 0. Note: the bundle delta should be near-zero (CSS additions are tiny).
- Manual browser-check checklist (each item gets a screenshot or a checkbox the verifier explicitly marks):
  - [ ] Scope filter renders below the tab bar, above the category chips.
  - [ ] Three buttons equal-width, segmented-control look, accent on active.
  - [ ] Click changes the active button; query results update accordingly (visual smoke check).
  - [ ] Tab+arrow keyboard navigation works; manual-activation (Enter/Space) commits.
  - [ ] `:focus-visible` outline is clearly visible on every button state.
  - [ ] Mobile (<720 px viewport): flush edges, ≥44 px buttons, no horizontal overflow.
  - [ ] Loading window: all three buttons disabled and opacity-reduced.
  - [ ] Filter is NOT sticky on scroll.
  - [ ] No console errors.

### Verifier checkpoint (between Phase 3 and Phase 4)

Run a separate verifier pass:

- Re-run `corepack pnpm exec biome check .`, `corepack pnpm -r build`, and the manual visual checklist.
- Confirm zero regression in any previously-shipped UI surface (search box, tab bar, category chips, vendor chips, result cards, footer, empty state, favorites empty).
- Confirm the bundle-size guard's headroom is intact (gzipped island still well below 50 KB).
- Approve the Phase 3 commit.

### Single conventional commit (Phase 3)

After verifier sign-off:

```bash
git add apps/web/src/pages/index.astro
git commit -m "$(cat <<'EOF'
ui(web): style sticky scope filter (phase 3)

Segmented-control look matching the tab bar: bordered container,
three equal-width buttons, active accent color, mobile flush-edges
at <720 px, ≥44 px tap targets at every breakpoint, focus-visible
outline for keyboard navigation.

Filter is intentionally NOT sticky — scrolls with the chips below the
sticky tab bar.

Spec: docs/superpowers/specs/2026-04-28-search-scope-filter-design.md
Plan: docs/superpowers/plans/2026-04-28-search-scope-filter-plan.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Risks & rollback (Phase 3)

- **Risk:** the `:focus-visible` outline collides with the active button's `--accent` background and becomes invisible.
  **Mitigation:** `outline-offset: -2px` insets the outline so it sits inside the button border, against the `--accent-fg` text rather than the same-color background. Manual visual check (Step 2 item 6) verifies.
- **Risk:** mobile flush-edges break on a viewport between 720 px (tab-bar mobile threshold) and the actual breakpoint.
  **Mitigation:** the media query uses the same `(max-width: 719px)` threshold as the tab bar. Symmetric. If the tab bar mobile rendering looks correct, so does this one.
- **Risk:** the bundle-size guard trips because the CSS additions push the gzipped island over 50 KB.
  **Mitigation:** the additions are ~25 lines of CSS (~600 bytes raw, ~200 bytes gzipped). Headroom is in the kilobytes, not bytes. Verified by Step 3 build output.
- **Rollback:** revert `apps/web/src/pages/index.astro`. Phase 2's behavior changes still work — the filter just renders unstyled (browser-default button look in a flex row).

---

## Phase 4: Final verification

**Goal:** Run the spec's full acceptance suite end-to-end. No code changes; only verification commands. If anything fails, return to the relevant earlier phase, fix, re-verify here.

### Step 1: Full web test suite green

```bash
corepack pnpm --filter @karaoke/web test
```

Expected: previous baseline (favorites-tab final state) + 7 ScopeFilter tests + 9 new App scope-filter tests = `+16` tests added by this work. All green. **All tests green is the gate.**

### Step 2: Schema and crawler tests still pass (untouched)

```bash
corepack pnpm --filter @karaoke/schema test
corepack pnpm --filter @karaoke/crawler test
```

Expected: schema and crawler counts unchanged from baseline. This work touched zero files in those packages — any drift is a real regression and blocks merge.

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
- `@karaoke/web` builds. Astro `tsc`-equivalent check passes.
- `scripts/check-bundle-size.mjs` postbuild guard exits 0 — gzipped island ≤ 50 KB. ScopeFilter is ~40 LOC, App.tsx grows ~20 LOC, plus ~25 lines of CSS. Comfortably within headroom.

### Step 5: Bilingual sweep

```bash
grep -rnE "[ぁ-んァ-ヶ]" apps/web/src/components apps/web/src/pages
```

Expected: zero hits. New strings are Korean only.

### Step 6: Manual dev-server smoke check

```bash
corepack pnpm --filter @karaoke/web dev
```

At `http://localhost:4321/karaoke-search/`, verify each item in the spec's "Manual verification before declaring done" list:

- [ ] Scope filter sits below the tab bar, above the category chips, three equal-width buttons.
- [ ] Default is `전체`; clicking `곡명` or `가수` flips the active state immediately.
- [ ] With a query in the box, switching scope re-runs the search visibly (cards add/drop).
- [ ] On the Favorites tab with ≥1 favorite + a query, switching scope narrows/widens the favorites view.
- [ ] Mobile viewport keeps tap targets ≥ 44 px on all three buttons.
- [ ] Tab into the scope filter, ArrowLeft/ArrowRight cycle focus, Enter/Space activate, focus does NOT auto-activate (the active state stays put while focus moves until Enter/Space is pressed).
- [ ] All three scope buttons appear at reduced opacity during the loading window.
- [ ] Reload — scope returns to `전체`.
- [ ] No console errors.
- [ ] Existing tab bar, category chips, vendor chips, result cards, favorites star toggle, footer, empty state, favorites empty placeholder all unchanged.

Stop the dev server with Ctrl-C.

### Acceptance criteria (Phase 4)

- [ ] `corepack pnpm --filter @karaoke/web test` runs all unit + behavior tests green.
- [ ] `corepack pnpm --filter @karaoke/schema test` unchanged from baseline.
- [ ] `corepack pnpm --filter @karaoke/crawler test` unchanged from baseline.
- [ ] `corepack pnpm exec biome check .` is clean across the repo.
- [ ] `corepack pnpm -r build` completes; bundle gzipped ≤ 50 KB (postbuild guard exits 0).
- [ ] `grep -rnE "[ぁ-んァ-ヶ]" apps/web/src/components apps/web/src/pages` returns zero hits.
- [ ] No new dependencies added to any `package.json`.
- [ ] No changes outside `apps/web/src/components/` and `apps/web/src/pages/index.astro`.
- [ ] Scope labels in the source are exactly `전체` / `곡명` / `가수` — verified by reading `ScopeFilter.tsx`'s `SCOPES` constant.
- [ ] CLAUDE.md's MEDIUM-priority follow-up "title-only/artist-only search scope filter" is satisfied. (CLAUDE.md update itself is a separate `docs:` commit if the user wants it — out of scope for this plan unless the user asks; CLAUDE.md updates are an orthogonal admin task per the existing convention of recording shipped status after the fact.)

### Verifier evidence to gather (Phase 4)

This phase is *the* verifier checkpoint for the entire feature. The verifier should:

- Capture stdout from each command in steps 1–5 and store in their report.
- Run the manual dev-server checklist (step 6) and check off each item explicitly.
- Confirm the three Phase commits each carry the spec/plan reference in the body and the `Co-Authored-By: Claude Opus 4.7 (1M context)` trailer.
- Confirm no `git add -A` or `git add .` was used (per `CLAUDE.md` git conventions). Each commit's `git show --stat` shows only the expected files.
- Approve the feature for merge to `main`.

### Risks & rollback (Phase 4)

- **Risk:** an existing test from prior frontend work fails unexpectedly because of a subtle scope-handling regression.
  **Mitigation:** Step 1's vitest run surfaces the failure with the exact file/line. Drop back to the relevant phase, fix, re-verify here.
- **Risk:** the bundle-size guard trips at the final build.
  **Mitigation:** the cumulative additions (component + state + CSS) are well within headroom; this is unlikely. If it trips, audit Phase 1's component for accidental verbosity.
- **Rollback:** revert all three Phase commits. The feature is opt-in via the `scope` state; reverting Phases 1–3 (or any subset that breaks) restores the prior browse-only-with-tabs-and-favorites behavior.

---

## Done when

The plan is complete when **all** the following are true:

- [ ] Phase 1 commit landed: `feat(web): scaffold ScopeFilter component (phase 1)`.
- [ ] Phase 2 commit landed: `feat(web): wire scope filter into search + favorites narrowing (phase 2)`.
- [ ] Phase 3 commit landed: `ui(web): style sticky scope filter (phase 3)`.
- [ ] Phase 4 verifier sign-off captured (full test suite green, biome clean, build clean, manual checklist all checked, schema + crawler untouched).
- [ ] All scope labels in the source are exactly `전체` / `곡명` / `가수`.
- [ ] No new dependencies in any `package.json`.
- [ ] No file changes outside `apps/web/src/components/` and `apps/web/src/pages/index.astro`.
- [ ] CLAUDE.md MEDIUM follow-up "title-only/artist-only search scope filter" is implemented (separate `docs:` commit to mark it shipped is the user's call).

---

## Self-review

Spec coverage map:

- Components → New → `ScopeFilter.tsx` → **Phase 1, Steps 1 + 2**.
- Components → Modified → `App.tsx` (scope state, ScopeFilter mount, matchesQuery 3-arg, MiniSearch fields, deps array) → **Phase 1 Step 3 (mount + state) + Phase 2 Step 2 (behavior wiring)**.
- Components → Modified → `index.astro` (scope-filter CSS) → **Phase 3, Step 1**.
- Testing → New unit tests → `ScopeFilter.test.tsx` (7 cases) → **Phase 1, Step 1**.
- Testing → New behavior tests on `App.test.tsx` (9 cases) → **Phase 2, Step 1**.
- Manual verification list → **Phase 4, Step 6** (every item replicated).

Test-case coverage check (spec lists 7 + 9 = 16 test additions):

- ScopeFilter 1 (literal labels) → Phase 1 Step 1 case 1.
- ScopeFilter 2 (aria-checked) → case 2.
- ScopeFilter 3 (active-click no-op) → case 3.
- ScopeFilter 4 (Arrow-Left/Right focus cycling, wrapping) → case 4.
- ScopeFilter 5 (no auto-activate on arrow) → case 5.
- ScopeFilter 6 (tabIndex per active button) → case 6.
- ScopeFilter 7 (disabled inert) → case 7.
- App scope 1 (default `'all'` aria-checked) → Phase 2 Step 1 case 1.
- App scope 2 (`곡명` hides artist-only on Browse) → case 2.
- App scope 3 (`가수` hides title-only on Browse) → case 3.
- App scope 4 (`'all'` returns union — regression-free default) → case 4.
- App scope 5 (switching scope re-runs search; query preserved) → case 5.
- App scope 6 (scope applies to Favorites narrowing) → case 6.
- App scope 7 (scope + category chips compose) → case 7.
- App scope 8 (scope reset on reload) → case 8.
- App scope 9 (scope buttons inert during loading) → case 9.

No gaps detected.

Decisions taken in plan (collected for audit):

1. `SCOPE_FIELDS['all']` is `null` (not `undefined` or `[]`) — explicit sentinel that drives the call site to drop the `fields` option entirely on default. (Phase 2 Step 2.)
2. `matchesQuery` becomes 3-argument with a `switch (scope)` block, not a lookup map. Single call site, module-private. (Phase 2 Step 2a.)
3. `Scope` type is exported from `ScopeFilter.tsx` (mirrors `TabId` from `TabBar.tsx`). (Phase 1 Step 2.)
4. ScopeFilter uses the WAI-ARIA radio-group manual-activation pattern: arrow keys move focus only; Enter/Space commits. Diverges from TabBar (which uses click-only) deliberately because radio-group semantics call for it. (Phase 1 Step 2.)
5. `tabIndex` on the active button is `0`, on the others `-1`. Diverges from TabBar deliberately for the radio-group convention. (Phase 1 Step 2.)
6. The scope filter is **not sticky**. (Phase 3 Step 1.)
7. Phase 1 adds `scope` to the `results` memo dependency array even though the body does not yet branch on it, with a `biome-ignore` comment if needed. The comment is removed in Phase 2 when the body genuinely consumes `scope`. (Phase 1 Step 3.)
8. `App.test.tsx` extends the per-describe fixture (does NOT mutate the favorites-tab fixture) — adds `r4` and `r5` with discriminating field values. The fake `index.search` honors `options?.fields` so scope tests don't silently pass against a broken implementation. (Phase 2 Step 1.)
9. Active-scope click is a hard no-op at the source. (Phase 1 Step 2.)
10. CSS additions land in Phase 3 only — Phases 1 and 2 deliver functional behavior with browser-default styling so the verifier checkpoints between phases do not conflate visual and behavioral changes.

Ambiguity / open notes flagged for follow-up (none block this plan):

- Spec's `aria-label="검색 범위"` for the radiogroup is sensible default. If a copywriter prefers a different label ("필드 선택" / "Match against"), change the literal in `ScopeFilter.tsx` only — no test asserts on this string.
- The fixture's discrimination strategy (the `idol` / `hatsune` substring split across `r1`/`r4`/`r5`) is delicate. Future fixture changes (e.g. someone adds `r6` with `title_primary === 'Idol Singer'`) could perturb the assertions. The tests should use presence-based assertions (does the rendered DOM contain text X?) rather than exact-count assertions wherever feasible to keep them robust.

Placeholder scan: searched the plan for "TBD", "TODO", "fill in details", "similar to Phase" — zero matches.

Type consistency:

- `ScopeFilter` exports `type Scope = 'all' | 'title' | 'artist'` — consumed by `App.tsx`'s `useState<Scope>('all')`.
- `ScopeFilterProps`: `{ scope, onChange, disabled }` — `App.tsx` passes all three.
- `matchesQuery` signature changes from `(record, query) => boolean` to `(record, query, scope) => boolean` — single call site updated.
- `SCOPE_FIELDS: Readonly<Record<Scope, readonly string[] | null>>` — exhaustive over `Scope`. TypeScript catches future scope additions at compile time.

Command consistency vs CLAUDE.md Quick Commands: all verification commands use `corepack pnpm` exactly as listed (`corepack pnpm --filter @karaoke/web test`, `corepack pnpm --filter @karaoke/web dev`, `corepack pnpm exec biome check .`, `corepack pnpm -r build`, `corepack pnpm --filter @karaoke/schema test`, `corepack pnpm --filter @karaoke/crawler test`). No bare `pnpm`. No `npm`/`yarn`.

Commit-trailer compliance vs CLAUDE.md Git Conventions: each phase commit uses HEREDOC, conventional-commit prefix (`feat(web):` for Phases 1–2, `ui(web):` for Phase 3), explicit file staging (no `git add -A`), and includes the `Co-Authored-By: Claude Opus 4.7 (1M context)` trailer.
