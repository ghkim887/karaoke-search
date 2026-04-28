# Search Scope Filter — Design Spec

**Date:** 2026-04-28
**HEAD:** `26bc24c`
**Status:** Approved for plan
**Scope:** Single PR — add a three-way segmented-control filter that restricts search matching to one of {all four fields, title fields only, artist fields only}. Frontend-only; no schema, crawler, MiniSearch index, or storage changes.

---

## Context

The search box currently runs every query against MiniSearch's full 4-field index (`title_primary`, `title_ko`, `artist_primary`, `artist_ko`). This is the right default — short queries like `idol` or `이마요` should still match either side. But there is a recurring failure mode where a user knows the artist exactly and wants to browse just that artist's titles, or they remember a fragment of a song title that is also a common substring in artist names. The full-field search surfaces noise.

`CLAUDE.md` tracks this as a MEDIUM-priority frontend follow-up: "add title-only/artist-only search scope filter". The favorites tab follow-up shipped with commits `ccbfae2`, `b99999d`, `26bc24c`; this spec picks up the next item on that list.

The favorites tab itself uses a separate code path (the `matchesQuery` helper in `App.tsx`) for narrowing, which does case-insensitive substring matching against the same four fields. The scope filter must apply equally to both code paths so that switching tabs does not silently change the meaning of the user's scope choice.

---

## Goals

- Let the user restrict matching to title fields, artist fields, or both — three mutually exclusive modes.
- Default mode is the current behavior (all four fields). No regression for existing users.
- Apply the same scope choice to both the Browse tab (MiniSearch) and the Favorites tab (`matchesQuery` substring narrowing).
- Keep the UI surface small: one segmented control, three buttons, Korean-only labels matching the recent Japanese-removal pass.
- Independent of the existing category and vendor chip filters — chips still apply on top of whichever scope is active.
- No regression to existing search, browse, favorites, chip-filter, or empty-state behavior.

## Non-goals

- No persistence of the scope across reloads. Mirrors the favorites-tab decision (ephemeral, default each load) — this is the simpler default and matches the no-persistence stance taken across the recent UI passes.
- No URL query parameter, no hash routing, no localStorage key.
- No new MiniSearch index. The 4-field index is reused; per-call `fields` option restricts the search at query time.
- No fourth scope ("Korean only" / "Japanese only" / per-field). Three modes only — title vs. artist is the established axis users ask for; sub-language splits are out of scope and would balloon the UI.
- No regex / boolean / phrase mode. Out of scope.
- No interaction with romaji search — romaji is intentionally excluded from the index per the v2 spec, and that decision is unaffected.
- No Playwright e2e in this round; covered by Vitest behavior tests on the App island.

---

## Architecture

### Visible layout, top to bottom

1. Page title (sticky header, unchanged).
2. Search box (sticky header, unchanged).
3. Tab bar (`검색` / `즐겨찾기`, sticky, unchanged).
4. **NEW: Scope filter** — three buttons in a segmented control:
   - **전체** (default).
   - **곡명**.
   - **가수**.
5. Category filter chips (J-POP / Vocaloid / Anime) — unchanged; applies on both tabs and on top of any scope.
6. Vendor filter chips (TJ / KY / JOY) — unchanged; applies on both tabs and on top of any scope.
7. Body — driven by `(activeTab, query, favoriteIds, scope, selectedCategories, selectedVendors)`.

The scope filter sits **below** the tab bar and **above** the category chips. Justification:

- Above the chips because scope changes the meaning of `query` directly (which fields the query is matched against), while category/vendor chips post-filter the result set. Reading top-to-bottom mirrors the data-flow order.
- Below the tab bar because the tab bar already establishes a strong horizontal boundary at the top of `<main>` and stays sticky beneath the header. The scope filter does **not** need to be sticky — it is a query-modifier, like the chips, and chips already scroll with the content.
- The scope filter is also placed below the tab bar because both tabs honor the scope; placing it above the tab bar would imply the scope is a global mode that supersedes the tab axis, which is misleading.

### Scope state

A single string in component state, one of `'all' | 'title' | 'artist'`. Default `'all'`. Not persisted. Reset on every page load. Carries over across tab switches (consistent with the spec's "switching tabs preserves search box value and chip selections" rule).

### Scope → field mapping

| Scope | MiniSearch `fields` option | `matchesQuery` checks |
|---|---|---|
| `all` (default) | `undefined` (uses all indexed fields — current behavior) | all four fields |
| `title` | `['title_primary', 'title_ko']` | `title_primary`, `title_ko` |
| `artist` | `['artist_primary', 'artist_ko']` | `artist_primary`, `artist_ko` |

The Browse path passes `fields` into `index.search(query, options)` as a per-call override. The MiniSearch instance itself stays configured with all four fields (the index is built once at load time and reused). MiniSearch's `searchOptions.fields` is a documented per-call override; passing it does not rebuild the index, does not allocate new term tries, and does not break boosts — boosts apply to whichever fields remain in scope.

The Favorites path's `matchesQuery` helper grows a third argument and switches over the scope at the call site. It stays a pure function, single call site, in `App.tsx`.

### Body rendering rules

Unchanged from the favorites-tab spec. Scope is a query-modifier; it does not introduce any new render branches. The render-branch order remains:

```
error → loading → favorites-empty → favorites-pipeline → browse-empty → browse-pipeline
```

The Browse+empty+loading co-render (commit `cd54633`'s mitigation) is preserved as-is.

The "empty query" semantics are unchanged: on Browse, `query === ''` skips the MiniSearch call entirely and renders `<EmptyState>`; on Favorites, `query === ''` shows all favorites. Scope only applies when `query !== ''`. (When `query === ''` the scope choice is a no-op — there is nothing to scope.)

### Why per-call `fields` (not a second index)

MiniSearch's API supports `fields` as a per-call search option. It restricts which inverted-index posting lists the query iterates over. Three options were considered:

1. **Build three indexes** (full / title-only / artist-only) at `loadIndex` time. Triple the memory footprint, triple the build time, all to handle a switch the user can flip at any moment. Rejected.
2. **Build one index, pass per-call `fields`.** Native MiniSearch feature. Zero extra build cost. Sub-millisecond switch — the call signature is the only thing that changes. **Selected.**
3. **Build one index, post-filter results by which field matched.** MiniSearch returns matched-field metadata via `match` on each hit, but the API is more brittle (the `match` shape depends on tokenization) and post-filtering still iterates the full result set before discarding. Rejected — option 2 is strictly cleaner.

### Why apply scope to favorites' substring matcher too

Failing to apply the same scope to `matchesQuery` would mean: the user picks "곡명", types `요아소비`, switches to Favorites tab, and sees their starred YOASOBI tracks anyway because the substring matcher checked artist fields. That's a silent contract violation — the scope chip says "only titles" but the favorites view is matching artists. Symmetric application is required; the cost is negligible (one switch statement in a function that runs once per favorite per render, with the favorites set bounded in the dozens).

### Triggers that re-run the pipeline

| Event | Effect on state | Pipeline re-runs? |
|---|---|---|
| Click a scope button | `scope` updates | yes |
| Keystroke in search box | debounced 150 ms → `query` updates | yes |
| Click a tab button | `activeTab` flips | yes |
| Click a category or vendor chip | selected set updates | yes |
| Click ★ on a card | favorites store updates (memory + disk) | yes if `activeTab === 'favorites'`; otherwise body unchanged |
| `loadIndex()` resolves | `loading` flips to false; `bundle` populated | yes |

Switching scope **preserves** the search box value, the chip selections, the active tab, and (on Favorites) the favorites set. Only the candidate-set membership changes.

---

## Components

### New

- **`apps/web/src/components/ScopeFilter.tsx`** — three-button segmented control. Mirrors `TabBar.tsx` for refs-array + arrow-key focus cycling, and uses `<div role="radiogroup">` instead of `<fieldset>`/`<legend>` (justification below).
  - Wrapper element with `role="radiogroup" aria-label="검색 범위"`.
  - Each button uses `role="radio"` + `aria-checked={isActive}` (segmented control = single-select, semantically a radio group).
  - Arrow-Left / Arrow-Right cycle focus among the three buttons; Tab moves focus into and out of the group.
  - Labels: `전체` / `곡명` / `가수` — Korean-only, no English half, no romaji, no slash format. Matches the recent Japanese-removal pass and the tab bar's Korean-only label decision.
  - All three buttons disabled (`disabled` attribute and reduced visual contrast) while `loading === true`. Consistent with chips and tab bar.

### Modified

- **`apps/web/src/components/App.tsx`**
  - Add `scope` state (`'all' | 'title' | 'artist'`, default `'all'`).
  - Mount `<ScopeFilter>` after `<TabBar>` and before `<CategoryChips>`. Pass `scope`, `setScope`, and `disabled={loading}`.
  - Extend `matchesQuery` signature: `matchesQuery(record, query, scope)`. The function dispatches over scope to pick which fields to test.
  - Extend the Browse branch of the `results` memo: when `scope !== 'all'`, pass `fields: SCOPE_FIELDS[scope]` into `index.search(query, options)`. When `scope === 'all'`, omit `fields` (preserving current behavior literally — same call shape as today).
  - Add `scope` to the `results` memo dependency array.
  - The chip + slice pipeline downstream is unchanged.
- **`apps/web/src/pages/index.astro`**
  - Add CSS for `.scope-filter` (segmented-control look, three equal-width buttons) and the active-button state. Reuses the existing `--bg-elev` / `--accent` / `--accent-fg` / `--border` / `--fg` / `--fg-muted` tokens. Buttons are ≥44 px tall on mobile, matching the existing tap-target audit. Not sticky — it scrolls with the chips.

### Unchanged

- `useFavorites` hook in `apps/web/src/lib/favorites.ts`.
- `lib/search.ts` (the MiniSearch index build), `lib/filter.ts`, `lib/normalize.ts`, `lib/retry.ts`.
- `ResultCard.tsx`, `SearchBox.tsx`, `CategoryChips.tsx`, `VendorChips.tsx`, `NoResults.tsx`, `ErrorState.tsx`, `EmptyState.tsx`, `FavoritesEmpty.tsx`, `TabBar.tsx`, `Footer.astro`.
- The `featured.ts` data file.
- All schema, crawler, and corpus-build pipelines.
- The MiniSearch field list and per-field boosts in `lib/search.ts` — the index keeps all four fields and their boosts; scope only restricts which subset is consulted at query time.

---

## Data flow

The body is the output of the same pipeline as before; the scope only changes the candidate-set step:

```
candidate set
  → filterByCategories (existing)
  → filterByVendors (existing)
  → slice(0, 50)
  → render as result cards
```

The `(activeTab, scope, query)` tuple now picks the candidate set:

| Tab | Query | Scope | Candidate set |
|---|---|---|---|
| Browse | empty | any | `[]` (skip pipeline; render `EmptyState`) |
| Browse | typed | `all` | `index.search(query)` (no `fields` — current behavior) |
| Browse | typed | `title` | `index.search(query, { fields: ['title_primary', 'title_ko'] })` |
| Browse | typed | `artist` | `index.search(query, { fields: ['artist_primary', 'artist_ko'] })` |
| Favorites | empty | any | `favoriteIds` resolved through `byId` (scope is a no-op when query is empty) |
| Favorites | typed | `all` | favorites filtered by `matchesQuery(r, query, 'all')` (4 fields) |
| Favorites | typed | `title` | favorites filtered by `matchesQuery(r, query, 'title')` (2 title fields) |
| Favorites | typed | `artist` | favorites filtered by `matchesQuery(r, query, 'artist')` (2 artist fields) |

Stale favorite IDs are still silently dropped at the join step.

---

## Edge cases

- **User picks `곡명`, then switches to Favorites tab.** Scope persists (it is component state, independent of `activeTab`). Favorites narrowing now only checks title fields. Same behavior as Browse.
- **User picks `가수`, types nothing, switches between tabs.** Scope is a no-op when `query === ''`. Browse renders `EmptyState`; Favorites renders all favorites or `<FavoritesEmpty>` per existing rules.
- **User picks `곡명`, types a query that only matches artist fields.** MiniSearch returns 0 results; renderer falls back to `<NoResults>` (existing component). On Favorites the same: substring matcher returns 0; `<NoResults>` renders (NOT `<FavoritesEmpty>` — favorites count is unchanged).
- **User picks `곡명`, applies the J-POP category chip, types a query.** Pipeline first runs MiniSearch with `fields: title-only`, then `filterByCategories` post-filters by jpop, then `filterByVendors` post-filters by selected vendors. All filters compose; nothing is silently overridden.
- **Mid-load click on a scope button.** Buttons are inert during loading (`disabled` attribute set); the click is ignored.
- **Reload while scope is `곡명`.** Scope resets to `전체`. Same model as the tab. Documented behavior.
- **`title_ko` is `null` for a record.** `matchesQuery` short-circuits the null check (existing behavior). MiniSearch tolerates null fields at index time and does not produce hits for null-keyed fields. No change in either path.

---

## Styling

- **Scope filter:** segmented-control look, three equal-width buttons. Container uses `--bg-elev` background with `border: 1px solid var(--border)` and `border-radius: 8px`. Each button takes `flex: 1`, has `padding: 0.55rem 0.75rem`, ≥44 px tall on mobile. Active button gets `background: var(--accent); color: var(--accent-fg); font-weight: 650`. Inactive buttons are `color: var(--fg-muted)` with hover lift via `color: var(--fg)`. Disabled state reduces opacity to `0.55` and removes hover.
- **Vertical rhythm:** `margin: 0 0 0.75rem;` matches the tab bar's bottom margin so the scope filter sits with the same spacing above the category chips that the tab bar maintains above itself.
- **Not sticky.** Unlike the tab bar, the scope filter scrolls with the chips. Sticking three controls in addition to the header + tab bar would eat too much vertical space on mobile, and the scope is set-and-forget for most queries (the user picks once and types).
- **Mobile (≤719 px):** the filter spans the full viewport content width with the same `margin-left: -1.25rem; margin-right: -1.25rem; border-radius: 0; border-left: 0; border-right: 0` flush-edges treatment used by the tab bar. Each button stays ≥44 px tall.
- **No new color tokens.** Reuses the existing custom-property palette.

---

## Accessibility

The container is `role="radiogroup"` with `aria-label="검색 범위"`. Each button is `role="radio"` with `aria-checked` reflecting active state.

Decision: `radiogroup` over `tablist` and over `<fieldset>`/`<legend>`.

- **Why not `tablist`?** Tabs imply distinct *panels* of content. The scope filter does not switch the body view (the same result list renders); it modifies the *meaning* of the existing query. Using `tablist` here would conflict with the actual tab bar above (which is correctly `role="tablist"` because it does swap panels) — a screen reader landing on two tablists in adjacent regions would be misleading.
- **Why not `<fieldset>` + `<legend>`?** That is the established pattern for `CategoryChips` and `VendorChips`, both of which are *multi-select* (chips toggle independently — `aria-pressed` per chip). The scope filter is *single-select* — picking one option deselects the others. Single-select is a radio-group, not a checkbox-group; using `<fieldset>` would imply multi-select to assistive tech.
- **Why not `<select>`?** A native dropdown is semantically valid but visually clashes with the existing chip/segmented styling and adds an extra interaction (open the menu, pick, close). Three options fit comfortably as a visible segmented control on every viewport.
- **`role="radiogroup"`** is the correct WAI-ARIA pattern for a single-select segmented control. `aria-checked="true"` on the active button matches the pattern's required state.

Keyboard model:

- Tab moves focus into the group (lands on the active button) and out (skips remaining buttons in the group). This is the WAI-ARIA radio-group convention: only the active radio is in the tab order; arrow keys cycle within the group. Implementation uses `tabIndex={isActive ? 0 : -1}` per button.
- Arrow-Left / Arrow-Right move focus among the three buttons (wrapping at the ends). On focus change via arrow, the focused button is **not** automatically activated — the user must press Enter or Space to commit. This matches the safer "manual activation" radio-group pattern; auto-activation can fire spurious queries on every arrow press.
- Enter or Space on a focused button activates it (fires `onChange`).
- Clicking the already-active button is a no-op (matches the tab-bar pattern).

Visual contrast: active button uses `--accent` background with `--accent-fg` text — same contrast as the active tab and the selected chips. No new contrast audit needed.

---

## Testing

### New unit tests

**`ScopeFilter.test.tsx`** (Vitest + jsdom; `// @vitest-environment jsdom` pragma)

1. **Renders all three buttons with the literal Korean labels.**
   - Assert button count is 3 AND `buttons[0].textContent.trim() === '전체'` AND `buttons[1].textContent.trim() === '곡명'` AND `buttons[2].textContent.trim() === '가수'`.
2. **Active scope has `aria-checked="true"`; inactive have `aria-checked="false"`.**
   - Render with `scope='all'` → first button checked. Re-render with `scope='title'` → second checked. Re-render with `scope='artist'` → third checked.
3. **Clicking an inactive button fires `onChange` with the right scope; clicking the already-active button is a no-op.**
   - `vi.fn()` spy. Click inactive → spy called once with the right id. Reset spy, click active → spy not called.
4. **Arrow-Left / Arrow-Right move focus among the three buttons (wrapping).**
   - Mirror `CategoryChips`'s focus-cycling test. From button 0, ArrowRight → button 1. ArrowRight → button 2. ArrowRight → button 0 (wrap). ArrowLeft → button 2 (wrap reverse). Per-key, assert `document.activeElement` matches.
5. **Arrow keys do NOT auto-activate** — the spy is not called when only focus moves.
   - From button 0 (active), press ArrowRight. Assert `onChange` spy was NOT called even though focus moved.
6. **`tabIndex` is `0` on the active button and `-1` on the others.**
   - Render with `scope='all'`. Assert `buttons[0].tabIndex === 0` AND `buttons[1].tabIndex === -1` AND `buttons[2].tabIndex === -1`.
7. **While `disabled` (loading), buttons are inert and don't fire on click.**
   - Render with `disabled={true}`. Click each button → spy not called. Assert each button has the `disabled` attribute.

### New / updated behavior tests on `App.test.tsx`

These build on the same `describe('App tab behavior', ...)` mock scoping pattern established in the favorites-tab plan (per-describe `vi.spyOn` of `loadIndex`, fixture bundle injected via `beforeEach`). Add a new sibling `describe('App scope filter', ...)` group with the same scaffolding.

Fixture extension: reuse the existing 3-record fixture (`r1` Idol/YOASOBI, `r2` KICK BACK/米津玄師, `r3` Senbonzakura/初音ミク), and add one more designed to exercise scope:

- `r4` — `title_primary: 'Hatsune'`, `title_ko: '하츠네'`, `artist_primary: 'IDOL Group'`, `artist_ko: '아이돌 그룹'`, `categories: ['jpop']`. The string `idol` appears as a substring of the **artist** field but NOT the title. Conversely, `hatsune` appears as a substring of the **title** field but `초음`/`초미꾸` etc. do not — and importantly, `r3.title_ko === '천본앵'` and `r3.artist_ko === '하츠네 미쿠'`, so the string `하츠네` matches `r3` via artist-Korean and `r4` via title-Korean. This single string discriminates artist-only vs. title-only scope.

Test cases (each its own `it(...)` block inside the new `describe('App scope filter', ...)`):

1. **Default scope on first render is `전체` (`'all'`).**
   - Mount, await load. Assert the `[role="radiogroup"]`'s first button has `aria-checked="true"` AND the other two have `aria-checked="false"`.
2. **Scope = `곡명` hides artist-only matches on Browse.**
   - Mount, await load. Click the `곡명` button. Type `idol`, advance debounce. Assert exactly 1 card renders AND its text contains `Idol` (matches `r1`'s `title_primary === 'Idol'`). Assert the rendered cards do NOT contain `IDOL Group` (`r4`'s artist-only match must be hidden).
3. **Scope = `가수` hides title-only matches on Browse.**
   - Mount, await load. Click the `가수` button. Type `hatsune`, advance debounce. Assert exactly 1 card renders AND its text contains `IDOL Group` or `하츠네 미쿠` (matches `r3`'s `artist_ko`). Assert the rendered cards do NOT contain a title-only `hatsune` hit (`r4`'s `title_primary === 'Hatsune'` must be hidden).
   - **Note:** the exact hit count may also include `r3` via `artist_ko === '하츠네 미쿠'` if the MiniSearch substring/prefix logic catches the romanized `hatsune` as a prefix. The assertion locks the *negative* (no `r4` title hit), which is the load-bearing claim; the positive count is informational.
4. **Scope = `전체` (default) returns the union — the legacy behavior.**
   - Mount, await load. Type `idol`, advance debounce. Assert cards include both `r1` (title hit) AND `r4` (artist hit). This locks the regression-free default.
5. **Switching scope re-runs the search; query is preserved.**
   - Mount, await load. Type `idol`, advance debounce. Assert default `전체` returns `r1` + `r4` (2 cards). Click `곡명` (without typing). Assert the input's `.value` is still `idol`. Assert the rendered cards drop to 1 (only `r1`). Click `가수`. Assert the rendered cards include `r4` and exclude `r1`.
6. **Scope applies to the Favorites-tab `matchesQuery` narrowing too.**
   - Pre-seed favorites = `['r1', 'r4']` (one title-`idol` hit, one artist-`idol` hit). Mount, await load. Click the Favorites tab. Type `idol`, advance debounce. Default `전체` → 2 cards visible. Click `곡명` → 1 card (`r1`). Click `가수` → 1 card (`r4`). Click `전체` → back to 2.
7. **Scope and category chips compose.**
   - Mount, await load. Click `곡명`. Click the J-POP category chip. Type `idol`, advance debounce. Assert exactly 1 card renders AND it is `r1` (jpop AND title-`idol`). Confirm `r4` is excluded (also jpop, but artist-`idol` is hidden by scope). Confirm `r2`/`r3` are excluded (wrong category).
8. **Scope reset on reload (no persistence).**
   - Mount, await load. Click `곡명`. Assert active. Unmount, remount. Assert default `전체` is active again. Confirms `localStorage` / sessionStorage is not consulted.
9. **Scope buttons inert during the loading window.**
   - Mock `loadIndex` to never resolve (one-off `mockReturnValueOnce(new Promise(() => {}))`). Mount. Assert all three scope buttons have the `disabled` attribute. Click `곡명` → `aria-checked` does not move off `전체`.

### Tests that pass unchanged

- `favorites.test.tsx`, `filter.test.ts`, `search.test.ts`, `normalize.test.ts`, `ResultCard.test.tsx`, `base-url.test.ts`, `footer-date.test.ts`, `TabBar.test.tsx`, `FavoritesEmpty.test.tsx`, `EmptyState.test.tsx`, the existing `App.test.tsx` `App loading state` / `App loading-state mitigation` / `App tab behavior` blocks. Scope is purely additive.

### Manual verification before declaring done

- `corepack pnpm -r build` — types + bundle-size guard pass.
- `corepack pnpm exec biome check .` — lint clean.
- `corepack pnpm --filter @karaoke/web test` — all unit + behavior tests green.
- Dev-server eyeball check at `http://localhost:4321/karaoke-search/`:
  - Scope filter sits below the tab bar, above the category chips, three equal-width buttons.
  - Default is `전체`; clicking `곡명` or `가수` flips the active state immediately.
  - With a query in the box, switching scope re-runs the search visibly (cards add/drop).
  - On the Favorites tab with ≥1 favorite + a query, switching scope narrows/widens the favorites view.
  - Mobile viewport keeps tap targets ≥ 44 px on all three buttons.
  - Tab into the scope filter, ArrowLeft/ArrowRight cycle focus, Enter/Space activate, focus does NOT auto-activate.
  - Both scope buttons appear at reduced opacity during the loading window.
  - Reload — scope returns to `전체`.

---

## Risks & mitigations

- **Risk:** MiniSearch's per-call `fields` option misbehaves when combined with the existing `fuzzy: 0.2` and `prefix: true` defaults baked into the index.
  **Mitigation:** these defaults are options on the index's `searchOptions`, which serve as fall-backs for any per-call options not overridden. Passing only `fields` keeps `fuzzy` and `prefix` intact. The behavior tests assert the actual matching outcome (test 2/3/4 above), so any silent regression in the `fields`+`fuzzy`/`prefix` combination shows up as a failed test.
- **Risk:** the `matchesQuery` signature change is a silent contract break for anything else that calls it.
  **Mitigation:** `matchesQuery` is module-private to `App.tsx` (not exported). Single call site. The TypeScript signature change is enforced at compile time.
- **Risk:** users mistake `곡명` and `가수` for chips that toggle independently and try to select two at once.
  **Mitigation:** the segmented-control visual treatment (three buttons sharing a single bordered container, only one with the active accent color) is the established affordance for single-select. The `aria-checked` semantics on each button confirm to assistive tech that this is single-select. If user research later shows confusion, revisit with copy or a tooltip.
- **Risk:** sticky-on-sticky layering — the scope filter is not sticky, but a future change might make it sticky and collide with the tab bar.
  **Mitigation:** explicit "not sticky" call-out in the spec. If a future change makes it sticky, that change has to follow the existing `z-index` convention (`header: 10`, `tab-bar: 9`, scope-filter: 8) documented in the favorites-tab spec.
- **Risk:** Browse's empty-query behavior accidentally short-circuits scope.
  **Mitigation:** scope is irrelevant when `query === ''` by design — there is nothing to scope. The Browse `query === ''` branch already returns early; the Favorites empty-query branch already returns the full favorites set unfiltered. No code change needed; this is documented in the data-flow table.
- **Risk:** scope state grows the `App.tsx` LOC past readable.
  **Mitigation:** measured impact is ~15–20 LOC (one `useState`, one mount in JSX, one branch in `matchesQuery`, one branch in the Browse `index.search` call, scope in the deps array). `App.tsx` was ~250 LOC after the favorites-tab follow-up; this lands it at ~270, still well under the ~280 threshold flagged for revisiting splits.

---

## Open questions

None remaining. All decisions resolved during spec drafting:

- **Placement:** below tab bar, above category chips. Justified by data-flow ordering and the tab-bar/scope-filter semantic distinction.
- **Persistence:** ephemeral, default `전체` each load. Mirrors the favorites-tab decision.
- **Mobile layout:** ≥44 pt tap targets. Flush-edges at ≤719 px.
- **Bilingual labels:** Korean-only (`전체` / `곡명` / `가수`). Matches the recent Japanese-removal pass.
- **Interaction with other filters:** independent. Scope modifies the search; chips post-filter the result set.
- **MiniSearch wiring:** per-call `fields` option. No second index.
- **Accessibility:** `role="radiogroup"` + `role="radio"` + `aria-checked`. Manual activation (Enter/Space, not auto-on-arrow). `tabIndex` honors the radio-group convention.
- **Test coverage:** at least one Vitest test per branch (scope = title hides artist-only, scope = artist hides title-only, default = all returns union, scope applies to favorites narrowing, scope persists across tab switches, scope resets on reload, buttons inert during load, scope + chips compose).

---

## Out of scope (deferred)

- TJ PDF parser fix — separate Known Issue tracked in `CLAUDE.md`.
- NamuWiki adapter — postponed by user.
- Per-language scope (Korean only / Japanese only / English only) — out of scope; would expand the segmented control past three options and is not user-requested.
- Phrase / boolean / regex search — out of scope.
- Scope persistence (URL hash, localStorage, query string) — explicitly rejected; matches the no-persistence stance for the tab axis.
- Scope-aware MiniSearch boost tuning (e.g. raising title boosts when scope is title) — premature; the existing 3:2 boost ratio is fine for scoped searches because the artist fields are simply absent from the index iteration.
