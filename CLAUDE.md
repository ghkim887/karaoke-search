## Core Principles

- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **Minimal Impact**: Changes should only touch what's necessary. Avoid introducing bugs.

## Project Facts

- Repo: https://github.com/ghkim887/karaoke-search (public, MIT, default branch `main`).
- Live site: https://ghkim887.github.io/karaoke-search/ (GitHub Pages, Astro `base: '/karaoke-search/'`).
- Stack: pnpm + TypeScript + Astro + MiniSearch (frontend); cheerio + undici + robots-parser (crawler); Biome, Vitest, Playwright.
- v1 primary data source: https://j-pop-playlist.tistory.com — artist summary posts. Parser contract in design spec.
- v2 status: schema simplified to 3 categories (`jpop`/`vocaloid`/`anime`) with mutual-exclusivity rule (records tagged `anime` or `vocaloid` cannot also be `jpop`); `release_year` field dropped; merger rewritten with two-tier match key + per-field ownership; TJ-direct adapter shipped (catalog JSON API); frontend polish + favorites + footer + mobile-first pass shipped; favorites-tab follow-up DONE (commits `ccbfae2`, `b99999d`, `26bc24c`) — favorites now live on a dedicated `즐겨찾기` tab; TJ anisong PDF parser bug fixed in `cd3288d` (full rewrite: `-table` mode + column-aligned translit + Latin-only-field guard + validation gate) and re-ingested in `c427fe8` — 726 anime records now clean; HEAD at `c427fe8`. NamuWiki adapter still pending. Title/artist scope filter was attempted (commits `c244803`→`17cacf4`) then reverted in `a1ee604` after the user rejected the segmented-control UI — it is **not** an active follow-up; any future revisit must use a different UX direction (e.g. search-bar prefix syntax) and get visual sign-off before implementation. See `docs/superpowers/specs/2026-04-26-karaoke-search-v2-design.md`, `docs/superpowers/specs/2026-04-28-frontend-polish-design.md`, and `docs/superpowers/specs/2026-04-28-favorites-tab-design.md`.
- Spec & plan: `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`, `docs/superpowers/plans/YYYY-MM-DD-<topic>-plan.md`.

## Module Map

- `apps/web/` — Astro static site with one Preact island (`App.tsx`). Search via MiniSearch (4-field index — `title_primary`, `title_ko`, `artist_primary`, `artist_ko`; no romaji). Reads `apps/web/public/data/songs.json`. Device-local favorites via localStorage key `karaoke-favorites:v1` (`useFavorites()` hook in `lib/favorites.ts`). Footer with build-time DB-update date pulled via `git log -1 --format=%cs`. KR/EN bilingual UI strings (Japanese halves removed from chrome — artist content in `data/featured.ts` keeps kana). `App.tsx` also imports `VendorChips` (filters records by `karaoke_numbers.{tj,ky,joysound}` non-null). Featured-artist strip: jpop 6 + vocaloid 5 + anime 6 (LISA, Linked Horizon, 鈴木このみ, fripSide, EGOIST, ClariS). `<TabBar>` (Korean-only labels `검색` / `즐겨찾기` — no count badge) sits at the top of `<main class="results">`, sticky beneath the header. `App.tsx` holds an `activeTab` state of `'browse' | 'favorites'` (default `'browse'`, ephemeral — resets on reload, no URL hash, no localStorage tab key). `<FavoritesEmpty>` placeholder renders when on Favorites tab with zero favorites. `EmptyState` is now featured-artist-only — the favorites preview block was stripped. `matchesQuery` helper inside `App.tsx` does case-insensitive substring narrowing of favorites by query (over the same 4 search fields). Render-branch order in `App.tsx`: error → loading → favorites-empty → favorites-pipeline → browse-empty → browse-pipeline. On Browse+empty during loading, `<EmptyState>` co-renders alongside the loading message to preserve the existing `cd54633` loading-mitigation behavior.
- `packages/schema/` — universal `SongRecord` type + Ajv validator. `Category = 'jpop' | 'vocaloid' | 'anime'` (3 values; the JSON Schema enum is derived from `CATEGORY_VALUES`). Compiled artifact at `packages/schema/dist/`. Both crawler and web depend on it.
- `packages/crawler/` — pluggable adapter pipeline. `Crawler` interface yields `SongRecord` directly (each adapter does its own normalize). Two adapters: `jpop-playlist-blog` (Tistory blog, ~21k records) and `tj-media-direct` (TJ catalog API, ~5.9k records). `mergeRecords` returns `MergeResult { records, conflicts }` — destructure at every call site. `http.ts` exposes `postForm(url, body)` (cache-bypass POST + form-encoded) and a `HostConfig` map keyed by hostname for per-host UA + rate-limit overrides. CLI at `packages/crawler/dist/cli.js` after build.

## Known Issues

_(no current issues — TJ PDF parser bug fixed in `cd3288d`, re-ingested in `c427fe8`)_

## Quick Commands

Use `corepack pnpm` — plain `pnpm` is not always on PATH on this Windows host.

```bash
corepack pnpm install
corepack pnpm -r build                              # builds schema, crawler, web (with bundle-size guard)
corepack pnpm --filter @karaoke/web dev             # http://localhost:4321/karaoke-search/
corepack pnpm --filter @karaoke/web test            # vitest
corepack pnpm --filter @karaoke/crawler test
corepack pnpm --filter @karaoke/crawler start --source jpop-playlist-blog --limit 5 --out apps/web/public/data/songs.json
corepack pnpm --filter @karaoke/crawler start --source tj-media-direct --limit 0 --out /tmp/tj-full.json   # TJ catalog smoke (1 POST, ~5.9k records)
corepack pnpm --filter @karaoke/crawler start --out apps/web/public/data/songs.json --conflicts-out /tmp/conflicts.json   # all adapters + conflict aggregate
corepack pnpm exec biome check .
```

E2E (manual, after `playwright install chromium`):

```bash
E2E_BASE_URL=https://ghkim887.github.io/karaoke-search/ corepack pnpm --filter @karaoke/web test:e2e
```

## Gotchas

- `--limit N` on the crawler caps **artist pages per adapter**, not output records. `BlogCrawler` round-robins jpop+vocaloid artists then appends mixed.
- `apps/web/public/data/songs.json` (~9 MB, 21k+ records) is **tracked on `main`**. The deploy needs it baked into the build. Do NOT re-add it to `.gitignore`.
- Playwright e2e tests must use `await page.goto('')` (relative empty). `goto('/')` resolves the absolute path against the base, sending Playwright to the bare `github.io` domain (404).
- Schema runtime imports require `pnpm -r build` first — `@karaoke/schema` exports `dist/index.js`, not `src/index.ts`. CI builds with `pnpm -r build` before `pnpm start`.
- The blog adapter pulls artist names from the first `<blockquote>` in the post body. Posts without one (ranking lists, info posts) fall through; the index-parser filters known non-artist patterns (`랭킹|순위|차트|월간|연간|...`).
- Crawl workflow opens a PR labeled `crawl-output`; the GitHub repo setting **"Allow Actions to create and approve pull requests"** must be on, else the PR-create step fails.
- HTTP rate limit in `packages/crawler/src/http.ts` is 200ms base + ±50ms jitter (~4–6 req/sec) by default. Per-host overrides live in `HOST_CONFIG`: `www.tjmedia.com` is 500ms base + ±100ms jitter (no UA override — the catalog API is open). Adding hosts: extend the map; defaults apply otherwise.
- TJ-direct adapter (`packages/crawler/src/adapters/tj-media-direct/`) pulls the full catalog via one POST to `/legacy/api/newSongOfMonth` (`searchYm=200001`). Filters output via loose-JP regex (hiragana/katakana/Han-without-Hangul) + a ~170-entry Chinese-artist denylist (`CHINESE_ARTIST_DENYLIST` in parser). Rows whose `pro` is already in the blog corpus bypass BOTH filters (rescue path catches Japanese rock acts with all-Latin titles like GRANRODEO). The adapter reads `apps/web/public/data/songs.json` at construction time to build the rescue set; missing file degrades silently to an empty set with one `console.warn`.
- `mergeRecords` returns `{ records, conflicts }` — destructure at every call site. Two-tier match key: Tier A clusters by shared non-null `karaoke_numbers.{tj,ky,joysound}` (per-vendor union-find); Tier B falls back to normalized `(title_primary, artist_primary)` for residuals. Per-field ownership table picks the winner (TJ wins title/artist; blog wins Korean fields; vendor numbers union with `blog > namu > tj` tiebreak; categories set-union followed by `applyCategoryExclusivity` — defense-in-depth: the JSON Schema also rejects `jpop` paired with `anime`/`vocaloid`, and the blog adapter applies the exclusivity rule at the call site so the normalizer's pre-merger output is schema-conformant). The conflict aggregate is consumed by the crawl PR-body composition step in `.github/workflows/crawl.yml` when `total > 0`.
- Blog parser (`extractNumberCell`) returns `null` + warns on `<br>`-separated multi-code TJ/KY/JOY cells (instead of concatenating). Length-cap defensive guard: TJ/KY ≤6 digits, JOY ≤7. The merger's per-field ownership picks up the right value at merge time via Tier A on title+artist.
- Frontend favorites: backed by `localStorage` key `karaoke-favorites:v1` (versioned). The `useFavorites()` hook returns `{ favorites: Set, toggle, isFavorite, orderedIds }`. Stale ids (favorited then removed from corpus) are silently skipped at render. The Footer's git-log invocation has `cwd: repoRoot` set via `fileURLToPath(new URL('../../../..', import.meta.url))` because Astro's default cwd is `apps/web/` and the relative path would otherwise return empty without throwing.
- Favorites tab is mode-switch UI, not a filter chip. Active tab is in-memory only (resets on reload). Search box and category/vendor chips apply on both tabs. The render-branch order in `App.tsx` is: error → loading → favorites-empty → favorites → browse-empty → browse — `loading` takes precedence over `FavoritesEmpty`, EXCEPT that on Browse+empty+loading the existing loading-mitigation co-renders `<EmptyState>` alongside the loading message (preserves commit `cd54633`'s behavior).
- `scripts/ingest-anisong-pdf.py` requires xpdf's `pdftotext -table` (Git-for-Windows ships it; Linux poppler-utils does NOT support `-table`). The cached text file is at `.omc/anisong_utf8.txt` — regenerate out-of-band with `pdftotext -table -enc UTF-8 <pdf> .omc/anisong_utf8.txt` if the source PDF changes. Idempotent: re-running the script with an existing `.omc/anisong_utf8.txt` is safe.

## Git Conventions

- Conventional-commit prefixes: `docs:`, `chore:`, `feat:`, `fix:`, `refactor:`, `test:`, `ci:`, `ui:`.
- Commit body via HEREDOC; include `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` trailer.
- Stage paths explicitly. Never `git add -A` or `git add .`.
- Default branch `main`. Push to `origin`.

## Orchestration (Project Rule)

- Main thread is orchestrator only. Delegate every work item to a specialized agent: `executor` (code), `code-reviewer` (review), `planner` (plans/specs), `document-specialist` (external docs), `verifier` (verification evidence), `explore` (codebase search), `git-master` (git ops).
- Never self-approve. Author and review are always separate agent passes.
- Trivial single-tool calls in service of orchestration (a single Read to route work, a Write of a memory entry) are OK from the main thread; everything else delegates.
