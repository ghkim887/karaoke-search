# Karaoke Search Web — Design Spec

A public, no-auth static web app for searching Japanese and Vocaloid songs available on Korean karaoke machines. Users query in Japanese, Korean, or Latin-script artist names and receive cross-system karaoke numbers (TJ Media, 금영, JOYSOUND) for each match. The system is built around a universal song-record schema, a pluggable adapter-based crawler pipeline, and a static Astro frontend with client-side full-text search.

## Status

- Date: 2026-04-26
- Version: v1 design
- Author: brainstorming session with user

## Goals & Non-Goals

Goals:
- Search-only public web app accessible without accounts.
- Multi-script search: Japanese title, official Korean translated title, Japanese artist name, Korean artist name, Latin-script artist name.
- Cross-source karaoke numbers (TJ Media / 금영 / JOYSOUND) shown together per song.
- Pluggable crawler architecture so additional sources (KY-direct, JOYSOUND-direct, DAM, etc.) drop in as new adapters without schema or frontend changes.
- Mobile-first UX optimized for use at a karaoke machine (click-to-copy numbers, dark mode).

Non-Goals:
- No auth, no user accounts, no favorites.
- No lyrics displayed.
- No fan nicknames or LLM-generated aliases. Official titles only.
- No live TJ scraping in v1. v1 source is the curated j-pop-playlist blog only.
- No pagination in v1. No router. No analytics in v1.

## User Experience

Single-page, search-only flow. Static Astro page with a sticky search bar, category filter chips, and a results list. Dark mode is the default to suit karaoke-room lighting.

UI mock:

```
┌──────────────────────────────────────────────────┐
│            가라오케 / カラオケ Search            │
├──────────────────────────────────────────────────┤
│  [ search box: 노래/아티스트/曲名/imase ...   🔍 ] │
│  [ jpop ] [ vocaloid ] [ anime ]                 │
├──────────────────────────────────────────────────┤
│  ▸ ヨルシカ — 거품 / あぶく           [2023]    │
│    요루시카                                      │
│    TJ —    KY —    JOY 647543                    │
│  ────────────────────────────────────────────    │
│  ▸ YOASOBI — 아이돌 / アイドル        [2023]    │
│    요아소비                                      │
│    TJ 68425   KY 48374   JOY 631234              │
└──────────────────────────────────────────────────┘
```

Search semantics:
- 150ms debounce on input.
- Prefix match enabled.
- Fuzzy distance 1.
- NFKC normalize plus casefold applied to both query and indexed fields.
- Category chips act as AND filters layered on the hit set.
- Top 50 results returned, no pagination.

Result card:
- Show Japanese and Korean titles together; if only one is known, show that one. Same convention for artist.
- Three monospace karaoke-number badges (TJ, KY, JOY); missing values render dimmed with an em-dash.
- Click-to-copy on each number badge — primary user action while standing at a karaoke machine.
- Year tag, category tag, and a "Source ↗" link pointing to `source_url` for attribution.

Empty and no-results states:
- Empty (no query): show a category landing with a curated set of featured artists per category, sourced from `apps/web/src/data/featured.ts`.
- No results: localized message ("검색 결과가 없습니다 / 該当なし") plus a hint that long-tail songs may need the planned v2 TJ-direct fallback.

Attribution:
- `source_url` is mandatory in the universal record and surfaces as a per-card "Source ↗" link.

## Data Model

All crawlers normalize into a single record shape. The frontend reads only this shape from `apps/web/public/data/songs.json`.

```jsonc
{
  "id": "blog-1596",                  // {source_slug}-{source_local_id}
  "source_url": "https://j-pop-playlist.tistory.com/1596",
  "title_primary": "あぶく",          // official primary title — any script (ja/en/mixed)
  "title_ko": "거품",                 // official Korean title (nullable)
  "artist_primary": "ヨルシカ",       // official primary artist — any script (e.g. "imase", "YOASOBI", "ヨルシカ", "米津玄師")
  "artist_ko": "요루시카",            // (nullable)
  "release_year": 2023,               // int, nullable
  "karaoke_numbers": {
    "tj": null,                       // string|null — TJ Media song #
    "ky": null,                       // string|null — 금영
    "joysound": "647543"              // string|null
  },
  "categories": ["jpop"],             // array of: "jpop"|"vocaloid"|"anime"|"proseka" — at least one
  "crawled_at": "2026-04-26T10:00:00Z"
}
```

Schema decisions:
- Cross-source identity key for dedup: `(normalize(title_primary), normalize(artist_primary))`. `normalize(s)` is defined as: (1) Unicode NFKC, (2) casefold via `String.prototype.toLowerCase()` with locale `'und'`, (3) strip every character outside the Unicode classes `\p{L}` (letters), `\p{N}` (numbers), and `\p{M}` (combining marks). All whitespace, ASCII punctuation, fullwidth punctuation, ideographic punctuation (`、`, `。`, `・`, `〜`), middle dots, asterisks, and parentheses are stripped.

  Worked examples:
  - `'DECO*27'` → `'deco27'`
  - `'ヨルシカ'` → `'ヨルシカ'` (NFKC leaves katakana unchanged; no punctuation to strip)
  - `'米津玄師'` → `'米津玄師'`
  - `'YOASOBI'` → `'yoasobi'`
  - `'imase'` → `'imase'`
  - `'花に亡霊 (movie ver.)'` → `'花に亡霊moviever'`
  - `'Mrs. GREEN APPLE'` → `'mrsgreenapple'`

  Note: this means `DECO*27` and `DECO27` collapse to the same identity key. That is intentional and acceptable for cross-source dedup.
- All Korean fields are nullable so the v2 TJ-direct crawler (which does not provide Korean translations) fits without a schema migration.
- `karaoke_numbers` is an object (not flat fields) so adding `dam`, `xing`, etc. later does not change record shape.
- `categories` is an array because some songs cross categories (e.g., a Vocaloid song that is also an anime opening).
- No lyrics, no fan nicknames, no LLM-generated content. Official titles only.
- `source_url` is the per-record attribution back-link; it is mandatory.

Worked examples:

```jsonc
// imase – NIGHT DANCER
{
  "title_primary": "NIGHT DANCER",
  "title_ko": null,
  "artist_primary": "imase",
  "artist_ko": "이마세"
}
```

```jsonc
// YOASOBI – アイドル
{
  "title_primary": "アイドル",
  "title_ko": "아이돌",
  "artist_primary": "YOASOBI",
  "artist_ko": "요아소비"
}
```

```jsonc
// 米津玄師 – Lemon
{
  "title_primary": "Lemon",
  "title_ko": null,
  "artist_primary": "米津玄師",
  "artist_ko": "요네즈 켄시"
}
```

Search index (client-side MiniSearch) field boosts:
- `title_primary` (3x)
- `title_ko` (3x)
- `artist_primary` (2x)
- `artist_ko` (2x)

## Crawler Architecture

Adapter pattern. Each source implements a common interface; downstream stages are source-agnostic.

```ts
interface Crawler {
  name: string;                              // "jpop-playlist-blog" | "tj-media-direct" | ...
  crawl(): AsyncIterable<RawSongRecord>;
}
```

Pipeline:

```
[Crawler A] ──┐
[Crawler B] ──┼─→ [Normalizer] → [Deduper / Merger] → apps/web/public/data/songs.json → static frontend
[Crawler C] ──┘
```

Stage roles:
1. Crawler — source-specific. Knows the source's HTML and URLs. Emits raw records.
2. Normalizer — source-specific. Maps raw records to the universal `SongRecord`.
3. Deduper / Merger — source-agnostic. Key = `normalize(title_primary) + "|" + normalize(artist_primary)`. On collision: merge `karaoke_numbers` (take non-null from each source) and accumulate `categories` as a set union. On collision, the **first record wins for `title_primary`, `title_ko`, `artist_primary`, `artist_ko`, and `source_url`**. "First" is determined by source adapter registration order in `packages/crawler/src/adapters/index.ts`. Ties within a single source (same source emits two records that collide on the identity key) are resolved by lower `crawled_at` timestamp.
4. Output — single `apps/web/public/data/songs.json`.

v1 crawler — `BlogCrawler` (`jpop-playlist-blog` source):
- 2-level walk verified against the live site:
  - Step 1: Fetch index pages `/98` (J-POP) and `/417` (Vocaloid). Extract per-artist summary post URLs of the form `/\d+`. Artist summary URLs are deduplicated before fetching. When the same URL appears under both `/98` and `/417` (e.g., a Vocaloid producer who also charts as J-POP), the URL is fetched once and the resulting records are tagged with the union of categories from all surfacing index pages.
  - Step 2: For each artist summary post, parse the song table (Japanese title | Korean title | TJ# | KY# | JOYSOUND#). Each row becomes one raw record.
- Categories inferred from which index page surfaced the artist. If the artist appears under both, accumulate.
- Subagent verification on 2026-04-26 confirmed each artist summary post (e.g., `/449` Ayase, `/215` RADWIMPS, `/418` DECO*27) contains a complete table with all songs and all three system numbers, eliminating the need to fetch individual song posts.

### Parser contract — j-pop-playlist blog

Verified against `/449` (Ayase) and `/215` (RADWIMPS) on 2026-04-26.

- Selector: `div.tt_article_useless_p_margin table` (the Tistory post body wraps article content in `div.tt_article_useless_p_margin`; the song listing is the first/only `<table>` inside it). The table has no class or id attribute. The parser locates it by scoping into the post body and taking the first `<table>` descendant.
- Row selector: `tbody > tr` (Tistory inserts an implicit `<tbody>`; cheerio normalizes this).
- Column count: each `<tr>` contains exactly **4 `<td>` cells**.
- Column order:
  - col 1 = title cell. Contains `Japanese title<br>Korean title`. The Korean title may be absent (no `<br>` and no second line) for songs without an official Korean translation. Inline `<strong>`, `<b>`, or `<span>` may wrap the Japanese title and must be unwrapped before reading text.
  - col 2 = TJ Media number (string of digits, e.g. `52919`).
  - col 3 = KY (금영) number (string of digits, e.g. `57802`).
  - col 4 = JOYSOUND number (string of digits, e.g. `624629`).
- Title-cell parsing: split on `<br>`. First segment trimmed = `title_primary` (Japanese). Second segment trimmed, if present and non-empty, = `title_ko`; otherwise `title_ko = null`.
- Missing-number encoding: a missing karaoke number is the literal text `-` (ASCII hyphen-minus, U+002D) inside the cell. The parser returns `null` when the cell text after trim matches `/^[-—–]$/` (covers ASCII hyphen, em dash, en dash defensively). Empty cells, `&nbsp;`-only cells, and whitespace-only cells also map to `null`.
- The blog has no `<thead>` / column-header row inside the table on these posts; the column meaning is positional and fixed by the contract above. The parser MUST NOT attempt to read header labels.
- Robustness: if a page's table structure deviates from this contract (no `<table>` found inside the post body, row has != 4 cells, or all rows are unparseable), the parser logs a warning with the URL and skips the page. The page counts as a parse failure for the purposes of the >=90% success budget (see operational discipline below).

v2 crawler — `TJDirectCrawler` (interface-locked, deferred):
- Crawls TJ Media's official song search/pagination.
- Emits `title_primary` (Japanese) + `artist_primary` (Japanese) + `karaoke_numbers.tj` only.
- Korean fields stay null. The merger adds new records when the Japanese identity key has not been seen, and no-ops when the record already exists from the blog source.

Operational discipline (every crawler):
- Honest User-Agent: `karaoke-search-crawler/0.1 (+https://github.com/<owner>/karaoke)`.
- 1 req/sec with ±0.5s jitter.
- Respect `robots.txt`.
- HTTP cache by ETag/Last-Modified, persisted to disk; re-runs only re-fetch changed pages.
- All errors logged with URL. Per-page errors do not abort the whole crawl. End-of-run summary lists failures.
- Index pages (`/98`, `/417`) are critical: any failure aborts the crawl immediately with non-zero exit. Artist summary pages have an error budget: at least 90% must parse successfully. Pages that fail parsing (HTTP error, missing table, malformed table) count as failures. Below 90%, the pipeline exits non-zero and no PR is opened.

## Frontend

Stack: Astro static site with small TSX islands and MiniSearch (~6 KB) for client-side full-text search. One page, no router.

Indexed fields and boosts:
- `title_primary` (3x)
- `title_ko` (3x)
- `artist_primary` (2x)
- `artist_ko` (2x)

Search settings:
- Debounce: 150ms.
- Prefix match: enabled.
- Fuzzy distance: 1.
- Normalization: NFKC + casefold applied identically to both query and indexed fields.
- Category chips: AND filter layered on the hit set.
- Category chips in v1 UI: `[ jpop ] [ vocaloid ] [ anime ]`. The `proseka` category is stored in the data but not exposed as a chip in v1. It becomes a chip when category coverage exceeds an arbitrary minimum (e.g., 20 songs).
- Result cap: top 50, no pagination in v1.

Romaji indexing is intentionally not provided in v1; mixed-script titles are searchable via title_primary normalization (NFKC + casefold).

UI affordances:
- Click-to-copy on each TJ/KY/JOY badge.
- Monospace badges; missing values dimmed with em-dash.
- Year and category tags on each card.
- "Source ↗" link to `source_url` for attribution.
- Dark mode default. Mobile-first layout: sticky search bar, single-column cards, tap-friendly badges.

## Repository Layout

```
karaoke/
├── package.json                      # workspaces root
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── biome.json
├── .github/workflows/
│   ├── crawl.yml
│   └── deploy.yml
├── apps/
│   └── web/
│       ├── astro.config.mjs
│       ├── src/
│       │   ├── pages/index.astro
│       │   ├── components/
│       │   │   ├── SearchBox.tsx
│       │   │   ├── ResultCard.tsx
│       │   │   └── CategoryChips.tsx
│       │   ├── data/featured.ts
│       │   └── lib/
│       │       ├── search.ts
│       │       └── normalize.ts
│       └── public/
│           └── data/
│               └── songs.json
└── packages/
    ├── schema/
    │   └── src/index.ts
    └── crawler/
        ├── src/
        │   ├── cli.ts
        │   ├── pipeline.ts
        │   ├── http.ts
        │   ├── merge.ts
        │   └── adapters/
        │       ├── index.ts
        │       └── jpop-playlist-blog/
        │           ├── crawler.ts
        │           ├── parser.ts
        │           └── normalizer.ts
        └── test/
            └── fixtures/
                └── songs.sample.json
```

## Tooling

- pnpm — monorepo workspaces.
- TypeScript (strict) — single toolchain across crawler and web.
- Biome — single config for lint and format across the repo.
- cheerio — HTML parsing in crawler adapters.
- undici — Node-native fetch in the crawler with ETag/Last-Modified caching.
- robots-parser — checks `robots.txt` rules per host before fetching. Used by `packages/crawler/src/http.ts` as a gate on every request. Cached per-host for the duration of the run.
- MiniSearch — ~6 KB client bundle, client-side full-text search.
- Astro static — static site output with small TSX islands.
- Vitest — unit tests for parser, normalizer, and merger.
- Playwright — one e2e smoke test against the deployed site.

Shared types live in `packages/schema`. Both `packages/crawler` and `apps/web` depend on it.

## Deployment & Data Refresh

Hosting: GitHub Pages (free, static, Astro `base: '/karaoke-search/'`). Original v1 design proposed Cloudflare Pages; switched to GitHub Pages during Phase 7 implementation — no functional change, simpler secrets surface.

`.github/workflows/crawl.yml`:
- Triggers: `schedule: cron '0 18 * * 0'` (Sunday 03:00 KST) and `workflow_dispatch`.
- Steps: checkout → pnpm install → `pnpm --filter crawler start` → check whether `songs.json` changed → open a PR with the diff if changed (auto-mergeable; user reviews and merges).
- Crawl atomicity: write to `songs.json.tmp` then rename on success. Partial failures never corrupt the live file.
- Error budget: per-page errors logged but not fatal. <90% success rate aborts the run with a non-zero exit and no PR is opened.
- HTTP cache persisted via Actions cache between runs.
- Concurrency: before opening a new PR, the workflow lists open PRs labeled `crawl-output` and closes them. This guarantees at most one open crawl PR exists at a time. The new PR is created with the `crawl-output` label.

`.github/workflows/deploy.yml`:
- Trigger: `push` to `main`.
- Steps: checkout → pnpm install → `pnpm -r build` → upload `apps/web/dist/` via `actions/upload-pages-artifact@v3` → `actions/deploy-pages@v4`.

Local dev:

```bash
pnpm install
pnpm --filter crawler start -- --limit 5      # crawl 5 artists for dev iteration
pnpm --filter web dev                         # http://localhost:4321 with hot reload
```

Test fixture: `packages/crawler/test/fixtures/songs.sample.json` is committed and used by frontend dev when no live data is around, and by Vitest unit tests.

Domain: `https://ghkim887.github.io/karaoke-search/` (GitHub Pages default). Custom domain is optional later.

## Future Work (v2+)

- TJ-direct crawler as a long-tail fallback. Emits official Japanese title + artist only; no Korean translation attempt.
- KY (금영) direct crawler.
- JOYSOUND direct crawler.
- Possible serverless live-fallback function (vendor TBD) for queries that miss the static index — deferred indefinitely; v2 redesign does not need it.
- Optional custom domain.

## Open Questions

None at spec-write time.
