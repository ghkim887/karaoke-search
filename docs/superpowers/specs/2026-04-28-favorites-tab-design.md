# Favorites Tab — Design Spec

**Date:** 2026-04-28
**HEAD:** `faec6a4`
**Status:** Shipped (HEAD 26bc24c)
**Scope:** Single PR — promote the favorites preview out of the empty-state into a top-level tab on the search page. Frontend-only; no schema, crawler, or storage changes.

---

## Context

Favorites shipped on 2026-04-28 as a starred-card toggle plus a "Favorites" section that surfaces above the featured-artist sections in the empty-state landing view. Tracked in `CLAUDE.md` as a HIGH-priority follow-up: **move favorites to a dedicated tab** so they're discoverable independently of an empty search.

The current empty-state mixes "what to do next" (featured artist sections) with "what you've kept" (favorites). Once a user has more than a handful of favorites, the landing view becomes long and the featured sections get pushed below the fold. A tab puts each context in its own home.

The favorites store itself (`useFavorites` hook, `localStorage` key `karaoke-favorites:v1`) does not change.

---

## Goals

- Give favorites a dedicated, discoverable home on the page.
- Keep the existing search box, category chips, and vendor chips usable inside the favorites view (filter and search work the same way they do on the browse view).
- Strip the favorites section out of the empty-state so the same content does not render in two places.
- Add a sensible empty-favorites placeholder for users who haven't starred anything.
- No regression to the existing search/browse experience.

## Non-goals

- No persistence of the active tab. Resets to **Browse** on every fresh page load — no URL hash, no localStorage tab key, no cookie.
- No new route, no second Astro page, no router. Single-page island as today.
- No change to how favorites are stored, ordered, or hydrated. The hook (`useFavorites`) is reused as-is.
- No change to MiniSearch index, schema, crawler, or `songs.json`.
- No drag-to-reorder, no manual sort, no folders/lists, no export/import, no sync.
- No new motion library, no skeleton loader, no service worker.
- No Playwright e2e in this round; covered by Vitest behavior tests on the App island.

---

## Architecture

### Visible layout, top to bottom

1. Page title (sticky header, unchanged).
2. Search box (sticky header, unchanged).
3. **NEW: Tab bar** — two buttons:
   - **검색** (default).
   - **즐겨찾기**.
4. Category filter chips (J-POP / Vocaloid / Anime) — unchanged; applies on both tabs.
5. Vendor filter chips (TJ / KY / JOY) — unchanged; applies on both tabs.
6. Body — driven by `(activeTab, query, favoriteIds)`; see "Body rendering rules" below.

The tab bar lives at the top of `<main class="results">`, immediately above the category chips. CSS makes it sticky beneath the existing sticky header.

### Body rendering rules

| Active tab | Search box | What renders |
|---|---|---|
| Browse | empty | Featured-artist landing view (`EmptyState`, with the favorites section removed). |
| Browse | typed | MiniSearch result cards filtered by category + vendor chips, capped at 50. |
| Favorites | empty, ≥1 favorites | All favorites resolved against the loaded corpus, newest-first, filtered by category + vendor chips, capped at 50. |
| Favorites | typed, ≥1 favorites | Favorites narrowed by case-insensitive substring match against `title_primary`, `title_ko`, `artist_primary`, `artist_ko`, then filtered by chips, capped at 50. |
| Favorites | any, 0 favorites | `FavoritesEmpty` placeholder ("No favorites yet — tap ★ on a result to add one"). |
| Either | corpus still loading | Existing loading message; tab bar buttons inert. |
| Either | corpus load error | Existing `ErrorState` (unchanged). |

> **Note on loading precedence**: when `activeTab === 'browse' && query === '' && loading === true`, both `<EmptyState>` and the loading message render together (the existing loading-mitigation behavior added in commit `cd54633` predates this design and is intentionally preserved). For all other loading-window cases (Favorites tab loading, Browse with a typed query loading), only the loading message renders. Tab buttons are inert during the loading window regardless.

### Why substring match (not MiniSearch) inside the Favorites tab

The favorites set is bounded by the user (in the dozens). Building a second MiniSearch index for tens of records is more code for no measurable speedup; a single linear pass with `String.toLowerCase().includes(...)` over four fields per record is sub-millisecond and uses the same fields the global search uses. No tokenization parity issues because Favorites is a strict subset of the corpus the user has already chosen.

### Active-tab state

A single string in component state, one of `'browse' | 'favorites'`. Default `'browse'`. Not persisted. Reset on every page load.

---

## Components

### New

- **`apps/web/src/components/TabBar.tsx`** — two-button tab strip. Mirrors `CategoryChips` / `VendorChips` patterns:
  - Wrapper element with `role="tablist"`.
  - Each button uses `role="tab"` + `aria-selected={isActive}` (instead of `aria-pressed`).
  - Arrow-Left / Arrow-Right cycle focus between the two buttons; Tab moves focus into and out of the group.
  - Browse label: `검색`. Favorites label: `즐겨찾기` — plain Korean only, no star prefix, no count badge, no English half. (Deliberate decision per user feedback: labels are Korean-only with no transliteration, no bilingual slash format, and no inline count in the tab strip itself.)
  - Both buttons disabled (`disabled` attribute and reduced visual contrast) while `loading === true`.
- **`apps/web/src/components/FavoritesEmpty.tsx`** — pure presentational placeholder. Bilingual text: `즐겨찾기가 아직 없어요 — 결과 카드의 ★ 버튼으로 추가하세요. / No favorites yet — tap ★ on a result to add one.` Single short paragraph; no buttons or actions.

### Modified

- **`apps/web/src/components/App.tsx`**
  - Add `activeTab` state (`'browse' | 'favorites'`, default `'browse'`).
  - Mount `<TabBar>` at the top of `<main class="results">`, above `<CategoryChips>`. Pass `activeTab`, `setActiveTab`, `favoriteCount = favoriteIds.length`, and `disabled={loading}`.
  - The `results` memo computes its candidate set per the rules in "Body rendering rules" above. The category + vendor filter pipeline downstream is unchanged.
  - The render block adds one new condition: when `activeTab === 'favorites' && favoriteIds.length === 0`, render `<FavoritesEmpty />` and skip the rest.
  - When `activeTab === 'browse' && query === ''`, render `<EmptyState>` with the same featured-artist behavior as today (favorites preview removed; see EmptyState below). The loading message keeps its existing placement.
- **`apps/web/src/components/EmptyState.tsx`**
  - Drop the favorites preview section entirely (the `favoriteRecords.length > 0` block).
  - Drop the props `favoriteIds`, `byId`, `isFavorite`, `onToggleFavorite` from the prop interface.
  - Featured-artist sections stay exactly as they are.
- **`apps/web/src/pages/index.astro`**
  - Add CSS for `.tab-bar` (segmented-control look using `--bg-elev`, `--accent`, `--border`) and the active-tab state. The bar is `position: sticky; top: <existing header height>` so it stays visible while the result list scrolls. Buttons are ≥44 px tall on mobile, matching the existing tap-target audit.

### Unchanged

- `useFavorites` hook in `apps/web/src/lib/favorites.ts` — reused as-is.
- `ResultCard.tsx`, `SearchBox.tsx`, `CategoryChips.tsx`, `VendorChips.tsx`, `NoResults.tsx`, `ErrorState.tsx`, `Footer.astro`.
- `lib/search.ts`, `lib/filter.ts`, `lib/normalize.ts`, `lib/retry.ts`.
- The `featured.ts` data file.
- All schema, crawler, and corpus-build pipelines.

---

## Data flow

The body is the output of a small pipeline:

```
candidate set
  → filterByCategories (existing)
  → filterByVendors (existing)
  → slice(0, 50)
  → render as result cards
```

The tab flag picks the candidate set:

| Tab | Query | Candidate set |
|---|---|---|
| Browse | empty | `[]` (skip pipeline; render `EmptyState`) |
| Browse | typed | `index.search(query)` mapped through `byId` |
| Favorites | empty | `favoriteIds.map(id => byId.get(id))` filtered to defined; preserves newest-first order from the hook |
| Favorites | typed | as above, then `.filter(record => matchesQuery(record, query))` where `matchesQuery` does case-insensitive substring match on the four MiniSearch fields |

Stale favorite IDs (favorited then later removed from the corpus) are silently dropped at the join step, same as the existing empty-state preview.

### Triggers that re-run the pipeline

| Event | Effect on state | Pipeline re-runs? |
|---|---|---|
| Keystroke in search box | debounced 150 ms → `query` updates | yes |
| Click a tab button | `activeTab` flips | yes |
| Click a category or vendor chip | selected set updates | yes |
| Click ★ on a card | favorites store updates (memory + disk) | yes if `activeTab === 'favorites'`; otherwise body unchanged |
| `loadIndex()` resolves | `loading` flips to false; `bundle` populated | yes |

Switching tabs **preserves** the search box value and the chip selections — they apply the same way against whichever candidate set the new tab provides.

---

## Edge cases

- **User unfavorites the last star while on the Favorites tab.** Pipeline returns 0 records; renderer falls back to `<FavoritesEmpty>`. Tab stays Favorites — no auto-bounce.
- **User stars a card while on Browse.** Tab does not switch. Body unchanged (Browse pipeline doesn't depend on favorites).
- **User types a query that matches no favorites.** Pipeline returns 0 records on the Favorites tab. Renderer falls back to `<NoResults>` (existing component) — *not* `<FavoritesEmpty>`. (Distinguishes "you have favorites, none match" from "you have no favorites at all".)
- **Mid-load click on Favorites tab.** Tab buttons are inert during loading; the click is ignored.
- **Stale favorite (id no longer in corpus).** Dropped at the `byId.get(id)` step. Hook value (`favoriteIds`) is *not* mutated by render — pruning is a manual concern out of scope here.

---

## Styling

- **Tab bar:** segmented-control look. Container is the existing `--bg-elev` color with `border: 1px solid var(--border)` and `border-radius: 8px`. Each button fills 50% width, has `padding: 0.6rem 0.9rem`, ≥44 px tall on mobile. Active button gets `background: var(--accent); color: var(--accent-fg); font-weight: 650`. Inactive button is `color: var(--fg-muted)` with hover lift via `color: var(--fg)`. Disabled state reduces opacity to `0.55` and removes hover.
- **Sticky placement:** the tab bar is `position: sticky; top: <header height>`. The existing header already uses `position: sticky; top: 0`, so the tab bar offset matches the header's resolved height. CSS uses a small calc against the header padding/font sizes (no JS measurement).
- **Mobile:** at `(max-width: 719px)`, the tab bar spans the full viewport width with `border-radius: 0` (flush edges).
- **No new color tokens.** Reuses the existing custom-property palette.

---

## Testing

### New unit tests

**`TabBar.test.tsx`**
1. Browse button label is exactly `검색`; Favorites button label is exactly `즐겨찾기` — no star, no count, regardless of favorites count.
2. Active tab has `aria-selected="true"`; inactive has `aria-selected="false"`.
3. Clicking the inactive tab fires the change handler with the right id; clicking the already-active tab is a no-op.
4. Arrow-Left / Arrow-Right move focus between the two buttons.
5. While `disabled` (loading), buttons are inert and don't fire on click.

**`FavoritesEmpty.test.tsx`**
1. Renders the bilingual placeholder text (Korean + English).
2. Mentions the ★ glyph in the instruction.

### New behavior tests on `App.test.tsx`

1. Default tab on first render is **Browse**.
2. Clicking **Favorites** with N starred records → body shows all N records, newest-first.
3. With Favorites active and an empty search box, applying a category chip narrows the body to favorites in that category.
4. With Favorites active, typing a query narrows the body to favorites whose title or artist contains the query (case-insensitive).
5. With Favorites active and zero favorites, the placeholder renders — not the search-results path.
6. Toggling off the last favorite while on the Favorites tab → placeholder appears; tab stays Favorites.
7. Toggling on a favorite while on **Browse** → tab does not switch; body unchanged.
8. Switching Favorites → Browse with a query in the box preserves the query; Browse re-runs full-corpus search.
9. With Favorites active, typing a query that matches no favorites → renders `NoResults` (not `FavoritesEmpty`).
10. Tab buttons inert during the loading window; clicks are ignored until the corpus resolves.

### Updated tests

- `EmptyState.test.tsx` — drop favorites-section cases. Featured-artist tests stay.

### Tests that pass unchanged

- `favorites.test.tsx`, `filter.test.ts`, `search.test.ts`, `normalize.test.ts`, `ResultCard.test.tsx`, `base-url.test.ts`, `footer-date.test.ts`.

### Manual verification before declaring done

- `corepack pnpm -r build` — types + bundle-size guard pass.
- `corepack pnpm exec biome check .` — lint clean.
- `corepack pnpm --filter @karaoke/web test` — all unit + behavior tests green.
- Dev-server eyeball check at `http://localhost:4321/karaoke-search/`:
  - Tab strip is sticky under the search header.
  - Both tabs reachable by mouse + keyboard (arrow keys cycle focus).
  - Mobile viewport keeps tap targets ≥44 px.
  - Starring/unstarring cards updates the Favorites body correctly when on the Favorites tab.
  - Reload restores Browse as the active tab.

---

## Risks & mitigations

- **Risk:** sticky offset for the tab bar drifts if the header padding/font changes later.
  **Mitigation:** declare a CSS custom property `--header-height` on `:root` (so it inherits to both `<header>` and `<main>`'s descendants), and consume it as the tab bar's `top:` value. Single source of truth. The header itself does not need to assert on this — it sets its own height via padding/typography rules — but the value must match. A small fallback like `top: var(--header-height, 5.25rem)` covers any inheritance edge case.
- **Risk:** the substring matcher inside Favorites diverges from MiniSearch behavior (Korean/Latin tokenization differences).
  **Mitigation:** explicit, documented behavior — Favorites uses substring, Browse uses MiniSearch. Documented in the table above and in inline comments at the call site. Kept simple precisely because the favorites set is small.
- **Risk:** the empty-state regression — favorites users land on Browse and don't see their starred items at all.
  **Mitigation:** the Favorites tab (`즐겨찾기`) is always visible in the tab strip regardless of which tab is active, so users can discover it easily. Browse remains the default (most common entry point is "I want to search").
- **Risk:** `App.tsx` LOC growth past readable.
  **Mitigation:** measured at ~220 LOC after this change vs. ~190 today. Acceptable. If a follow-up pushes it past ~280, revisit splitting into per-tab views.

---

## Open questions

None remaining. The Phase 2 review surfaced one previously-implicit precedence rule (Browse+empty+loading co-render) which is now documented inline in the body-rendering rules above.

All decisions taken during brainstorming:

- **Mode shape:** mode switch with search/filters preserved within Favorites (option B).
- **Persistence:** ephemeral, resets to Browse on reload (option A).
- **Empty-favorites behavior:** sticky placeholder, no auto-bounce (option B).
- **Tab placement:** in the App island, sticky beneath the existing search header.
- **Tab affordance:** segmented-control look, two buttons, Korean-only labels (`검색` / `즐겨찾기`), no count badge in tab strip.
- **Favorites preview in empty-state:** removed entirely.

---

## Out of scope (deferred)

- Title-only / artist-only search-scope filter — attempted and reverted (`a1ee604`); segmented-control UX rejected. Not an active follow-up.
- NamuWiki adapter — postponed by user.
- Drag-to-reorder favorites, manual sort, folders, export/import, cross-device sync — never in scope; no plan to add.
- Per-tab URL routing, deep-linking, back-button support — explicitly rejected (option A persistence).
