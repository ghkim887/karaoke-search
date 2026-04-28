# Frontend Polish + Favorites — Design Spec

**Date:** 2026-04-28
**HEAD:** `d01f569`
**Status:** Approved for plan
**Scope:** Single PR — visual polish, mobile-first tap-target audit, device-local favorites, footer, first-load mitigation, UI bilingual flip (Korean/Japanese → Korean/English).

---

## Context

The Astro + Preact frontend at `apps/web/` is functional but minimalist. User feedback after the v2 data merge: "current design is good but bit too simple." Primary use context is thumb-taps inside karaoke booths on phones, so mobile is the lead surface, not desktop.

This spec covers five concurrent improvements bundled into one polish pass:

1. **Visual polish** — category tinting, typography refinement, card hover, search-input affordance, loading-dots animation.
2. **Mobile-first** — every interactive element to ≥44 × 44 px; emphasize the catalog-number row as the primary action; no auto-focus.
3. **Favorites** — device-local star toggle on each result; favorites list surfaces at the top of the empty state.
4. **Footer** — single muted bar with project metadata and a build-time DB-update date.
5. **Loading mitigation** — render the empty state immediately on mount; only the result-list area shows the loading text while the index builds.

In parallel, every bilingual UI string flips from `Korean / Japanese` to `Korean / English`. Korean-only short labels (e.g. tab names, single-word buttons) stay Korean.

The `simplicity first` ethos in `CLAUDE.md` still binds: this is polish, not a redesign. No motion library, no skeleton shimmer, no light-mode toggle, no auth, no schema change.

---

## Goals

- Modernize visual presentation while preserving the simplicity ethos.
- Make every interactive element a comfortable thumb target (≥44 × 44 px) on mobile.
- Add a device-local favorites feature with no auth, no sync, no cap.
- Show useful chrome (featured chips, footer, favorites) within ~150 ms of HTML parse, even before the 11.6 MB `songs.json` finishes downloading.
- Add a footer with project metadata and a live DB-update timestamp.
- Flip the bilingual UI strings from Korean/Japanese to Korean/English.

## Non-goals

- No light-mode toggle. Single dark theme stays.
- No motion library, no advanced micro-interactions, no skeleton shimmer.
- No skeleton/placeholder loaders. The only loading-state animation is the CSS-only 3-dot opacity-cycle described under "Loading state" below.
- No auth, no cross-device sync of favorites.
- No schema change. `source_url` stays in `SongRecord` and `songs.json` — UI removal only.
- No new search behavior, no debounce change, no filter logic change.
- No new third-party fonts, no icon library (one inline SVG for the search glyph).
- No service worker. Deferred to a follow-up if real users report slow loads.

---

## Design — Visual polish

### Category badge tinting

All three categories currently share the same gray badge. Tint each one. Background stays unchanged; only text color and border color change.

| Category | Tint hex | Notes |
|----------|----------|-------|
| `jpop` | `#8ab4ff` | Current accent blue |
| `vocaloid` | `#c89bff` | Soft lavender |
| `anime` | `#ffb37a` | Warm peach |

Applied as:
- `color: <tint>`
- `border-color: color-mix(in srgb, <tint> 40%, var(--border))`
- `background: unchanged` (whatever the existing badge background is — no override)

The same three tints color the empty-state section titles plus a 3 px solid left border on each title.

### Typography refinements

Only the rules listed below change. All other typography is untouched. The system font stack is preserved.

| Selector | Property | From | To |
|----------|----------|------|----|
| `h1` (page title) | `font-size` | `1.25rem` | `1.4rem` |
| `h1` (page title) | `font-weight` | `600` | `650` |
| `h1` (page title) | `letter-spacing` | (default) | `-0.01em` |
| `.result-title` (h2 inside `ResultCard`) | `font-weight` | `600` | `650` |
| `.badge-number` (catalog number value) | `font-size` desktop | `0.82rem` | `0.86rem` |
| `.badge-number` (catalog number value) | `font-size` mobile | (no mobile rule today) | `0.95rem` (new rule inside `@media (max-width: 719px)`) |
| Empty-state section titles | `font-weight` | `600` | `650` |
| Empty-state section titles | `letter-spacing` | (default) | `-0.005em` |

### Result card

- Baseline shadow: `box-shadow: 0 1px 2px rgba(0, 0, 0, 0.35)`.
- Hover state:
  - `transform: translateY(-1px)`
  - `box-shadow: 0 4px 10px rgba(0, 0, 0, 0.45)`
  - `border-color: color-mix(in srgb, var(--accent) 25%, var(--border))`
- Transition on transform, box-shadow, and border-color: `120ms ease`.
- The source link is removed entirely from the UI:
  - Delete the `.result-source` and `.result-source:hover` CSS rules.
  - Delete the `<a class="result-source">…</a>` JSX from `ResultCard.tsx`.
  - The `source_url` field stays in `SongRecord` and in `songs.json` — schema and data are untouched.
- The freed top-right slot is taken by the new favorite-star button (see Favorites section).

### Search input

- Inline single-path SVG search-glass icon at `left: 0.9rem` inside the input wrapper. No icon library; the SVG is hand-written in the JSX as one `<svg>` with one `<path>`.
- `padding-left: 2.4rem` on the input to clear the icon.
- Font size `1rem → 1.05rem`.
- Padding `0.6rem 0.85rem → 0.7rem 1rem`.
- Focus state:
  - `border: 2px solid var(--accent)` (replaces whatever the current 1 px focus border is)
  - `box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 20%, transparent)`
- New attribute: `enterkeyhint="search"` (so the on-screen keyboard returns the magnifying-glass key).
- **No auto-focus on mount.** iOS keyboard would obscure the favorites + featured-artist sections.

### Empty-state section titles

- Font weight `600 → 650`, letter-spacing `-0.005em` (matches the typography table above).
- Each title gets a `3px` solid left border in its category tint, with `padding-left: 0.6rem`.
- Title text color matches the tint.

### Loading state

- Text content: `26,401곡 검색 인덱스 빌드 중 / Building 26,401-song index…`
- The count `26,401` is a hard-coded literal inserted at build time by the Astro frontmatter via `JSON.parse(readFileSync('apps/web/public/data/songs.json')).length`. It is not read at runtime.
- A CSS-only 3-dot opacity-cycle animation appears immediately after the English ellipsis. Implemented with three spans and `@keyframes` — no JavaScript, no setInterval. Each span animates `opacity: 0.2 → 1 → 0.2` on a 1.2 s cycle, staggered by 0.4 s.

---

## Design — Mobile first

### Tap-target audit

All interactive elements must be ≥44 × 44 px on mobile (Apple HIG / Material guideline). Audit table:

| Element | Rule |
|---------|------|
| Catalog number badges (`.badge-number`) | `min-height: 44px; padding: 0.6rem 0.8rem;` mobile font `0.95rem`. Desktop reverts to `0.86rem` via `@media (min-width: 720px)`. |
| Category chips and vendor chips | `min-height: 44px; padding: 0.55rem 1rem;` chip-row `gap: 0.6rem`. |
| Star button on result card | `min-width: 44px; min-height: 44px;` star glyph itself stays ~`1.2rem` (button is what enlarges, not the glyph). |
| Featured-artist chips | `min-height: 44px;` (same rule as category/vendor chips). |

### Catalog-number primary-action emphasis (mobile only)

The catalog number is the user's actual goal — they came here to read a number off the screen and punch it into the karaoke remote. Emphasize it on mobile, inside the existing `@media (max-width: 719px)` query.

- 1.5× vertical padding around the number row container.
- Number value font-weight `400 → 500`.
- Border on the number container: `1px → 1.5px` (use `border-width: 1.5px` directly).
- "복사됨 / Copied" toast: font size `0.72rem → 0.85rem` on mobile only.

### Search input on mobile

- 16 px font already prevents iOS pinch-zoom on focus — no change needed there.
- `enterkeyhint="search"` (already covered above).
- **No auto-focus on mount.** Reiterating: opening the iOS keyboard would obscure the favorites and featured-artist surfaces, defeating the loading-mitigation work.

---

## Design — Favorites feature

### Storage

- `localStorage` key: `karaoke-favorites:v1` (versioned for future migrations).
- Value: a JSON-encoded array of `id` strings, e.g. `["tj-28660", "blog-1596"]`.
- Order: newest-favorited first.
- Read on mount into the App's state. Write on every toggle. **No cap.**
- A small hook in `apps/web/src/lib/favorites.ts`:
  ```
  useFavorites(): {
    favorites: Set<string>;
    toggle: (id: string) => void;
    isFavorite: (id: string) => boolean;
  }
  ```
  Internally it owns both the `Set<string>` (for O(1) lookups) and the canonical newest-first array (for ordered display). Toggle on an existing id removes it; toggle on a new id prepends. Both representations are serialized to localStorage as the array form.

### Star button on `ResultCard`

- Position: top-right of the card, in the slot freed by removing the source link. `position: absolute; top: 0.75rem; right: 0.85rem;` (and the card itself stays `position: relative`).
- States: `☆` outline glyph (not favorited) → `★` filled glyph (favorited).
- Color:
  - Filled: `#ffc857` (gold).
  - Outline: `var(--fg-muted)`.
  - Hover while in the outline state: gold preview at 50 % opacity (`color: color-mix(in srgb, #ffc857 50%, transparent)` or equivalent).
- ARIA: `role="button"`, `aria-label="즐겨찾기 / Favorite"`, `aria-pressed={isFavorite(record.id)}`. Implemented as a real `<button type="button">` so keyboard activation works without extra handlers.
- Tap target: `min-width: 44px; min-height: 44px;` glyph centered.

### Empty-state surfacing

If `favorites.size > 0`, a new section appears **first** in the empty-state, before any featured-artist sections:

- Section title: `★ 즐겨찾기 (N) / Favorites` where N is `favorites.size`.
- Contents: full `ResultCard`s — the same component used for search results — for every favorited record. Star is filled; tapping it un-favorites and removes the card from the list on the next render.
- Order: newest-favorited first (matches the localStorage array order).
- No display cap; if a user favorites 200 records, all 200 render.
- If a favorited `id` no longer exists in the loaded corpus (rare; e.g. a record was removed in a future migration), it is silently skipped with no console noise.

If `favorites.size === 0`, the empty state is unchanged from today.

### No filter-by-favorites toggle during search

The empty state IS the favorites surface. To browse favorites, the user clears the search box. There is no "show only favorites" toggle wired into the live search flow. This keeps the search UI free of additional state.

---

## Design — Footer

A new `Footer.astro` component renders at the bottom of every page. Single row, bullet-separated, top-bordered, muted text.

```
─────────────────────────────────────────────  (1px solid var(--border))

  노래방 검색기 · DB 업데이트 2026-04-28 · MIT · GitHub ↗
```

Layout:

- Container: `padding: 1.5rem 1.25rem; max-width: 960px; margin: 0 auto;`
- Top border: `border-top: 1px solid var(--border);`
- Font: `0.8rem; color: var(--fg-muted); line-height: 1.6;`
- Layout: `display: flex; flex-wrap: wrap; align-items: center;`
- Separator: a literal `·` character with `padding: 0 0.5rem;` either side. Implemented as a `<span aria-hidden="true">` between tokens; `flex-wrap: wrap;` lets the row break naturally on narrow viewports.
- License token: literal `MIT` (no link).
- GitHub link: text `GitHub ↗`, color `var(--accent)`, underline on hover, `target="_blank" rel="noreferrer noopener"`, `href="https://github.com/ghkim887/karaoke-search"`. Only this token is a link; everything else is plain text.

DB-update date token (`DB 업데이트 2026-04-28` in the example):

- Read at build time inside Astro frontmatter via:
  ```
  git log -1 --format=%cs -- apps/web/public/data/songs.json
  ```
  (`%cs` produces a short ISO-8601 date `YYYY-MM-DD`.)
- Fallback 1: if `git log` fails or returns empty, format `process.env.SOURCE_DATE_EPOCH` (Unix seconds) as `YYYY-MM-DD` in UTC.
- Fallback 2: if both fail, return empty string. The component then omits both the date token AND the bullet separator on its leading side, so the footer reads cleanly: `노래방 검색기 · MIT · GitHub ↗`.

Mobile: bullet tokens wrap onto 2-3 lines automatically via `flex-wrap: wrap;`. No special mobile rules, no media query.

---

## Design — Loading mitigation

**Today.** `App.tsx` renders only the loading text until `loadIndex()` resolves. The user stares at one line of Korean for several seconds.

**Change.** On mount:

- The empty-state featured-artist chips, the favorites section (if any), and the footer all render immediately.
- The loading text appears **only inside the result-list area** while the index builds.
- The search input renders but is disabled (`disabled={loading}`). Its `placeholder` flips to `검색 인덱스 로딩 중… / Loading search index…` while loading.

Net effect: a user opening the page sees featured chips, favorites, and footer within ~150 ms of HTML parse, even on poor wifi. The 11.6 MB `songs.json` download proceeds in the background. Once `loadIndex()` resolves, the placeholder reverts and the input becomes interactive.

This is **option (a)** from the original brainstorm — chosen because it requires zero new abstractions, zero motion library, and zero shimmer.

---

## Components affected

| File | Change type | Notes |
|------|-------------|-------|
| `apps/web/src/components/App.tsx` | Modified | Wire up `useFavorites()`; render empty state during loading; pass `loading` to `SearchBox`; conditionally render favorites section in empty-state |
| `apps/web/src/components/ResultCard.tsx` | Modified | Add favorite-star button; remove source-link `<a>`; tinted category badges; add baseline + hover box-shadow CSS classes |
| `apps/web/src/components/EmptyState.tsx` | Modified | Render favorites section first if `favorites.size > 0`; tinted section titles with 3 px left border |
| `apps/web/src/components/SearchBox.tsx` | Modified | Inline SVG search icon; `enterkeyhint="search"`; `disabled` + dynamic placeholder while loading |
| `apps/web/src/lib/favorites.ts` | New | `useFavorites()` hook backed by `localStorage` key `karaoke-favorites:v1` |
| `apps/web/src/components/Footer.astro` | New | Static footer; build-time DB-date injection via `git log -1 --format=%cs -- apps/web/public/data/songs.json` |
| `apps/web/src/pages/index.astro` | Modified | Mount `<Footer />`; remove `.result-source` CSS; add new CSS for category tints, card hover, mobile media-query rules, footer styles, loading-dot `@keyframes`, search-input focus halo, empty-state section titles |
| `apps/web/src/data/featured.ts` | Unchanged | Already populated — no edits in this pass |

Bilingual UI string flip (Korean/Japanese → Korean/English) is a cross-cutting edit covered inside whichever component owns each string. No central i18n table is introduced; strings stay inlined.

---

## Acceptance criteria

- All interactive elements measure ≥44 × 44 px on mobile (verified with the audit checklist in the implementation plan).
- The Astro web build's gzipped `App.tsx` island bundle stays under the existing 50 KB postbuild guard.
- Test totals after the pass:
  - `@karaoke/schema`: 18/18 passing (unchanged).
  - `@karaoke/crawler`: 106/106 passing (unchanged).
  - `@karaoke/web`: 18 existing tests still pass + new tests for the favorites hook (toggle, persistence, ordering, missing-id skip), the footer build-time date (happy path + both fallbacks), and the loading-state behavior (empty state renders while `loading=true`).
- Favorites persist across page reloads on the same device (`localStorage` round-trip).
- The footer's DB-update date token updates on each new commit that touches `apps/web/public/data/songs.json` (verified by re-running the build after a synthetic data-only commit and confirming the rendered HTML changes).
- Every previously-Japanese second-half of a bilingual string is now English. Korean-only short labels are unchanged. Audit by grepping the components for hiragana/katakana ranges — should return zero hits in JSX text nodes.
- `source_url` is still present in the `SongRecord` TypeScript type, the JSON Schema, the Ajv-compiled validator output, and `apps/web/public/data/songs.json`. Verified by:
  - The existing schema validation test still passing.
  - `grep -c '"source_url"' apps/web/public/data/songs.json` returning > 0.
- iOS Safari behavior:
  - No zoom-on-focus on the search input.
  - The on-screen keyboard does not open on page load (no auto-focus).
- Lighthouse mobile a11y score does not regress. The implementation plan captures the pre-change baseline score on `main`; the post-change run on the PR preview must equal or exceed that baseline.

---

## Open questions / known constraints

- **Service Worker offline cache** is deferred to a follow-up commit. Triggered only if real users report slow first-loads after this pass ships.
- **Light mode** is explicitly out of scope. Single dark theme stays.
- **Build-time `git log` access on GitHub Pages deploy.** The footer's DB-date read assumes the deploy workflow checks out enough git history to see the most recent commit touching `apps/web/public/data/songs.json`. The current `actions/checkout` step in the Pages deploy workflow needs `fetch-depth: 0` (or, at minimum, `fetch-depth: 1` with the `songs.json` change in the latest commit). To verify on first deploy: confirm the rendered footer shows the expected date and not the empty-string fallback. If the date is empty, raise `fetch-depth` in the deploy workflow as a follow-up patch.

---
