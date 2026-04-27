# Karaoke Search Web — v2 Design Spec

v2 expands the karaoke-search corpus with two new data sources (TJ Media direct and NamuWiki) and broadens category coverage to three populated categories: `jpop`, `vocaloid`, and `anime`. The frontend, schema validator, and core crawler pipeline remain in shape; the changes are additive adapters and a category-enum cleanup (drop the unused `proseka`).

## Status

- Date: 2026-04-26
- Version: v2 design
- Author: brainstorming session with user
- Inherits most conventions from v1 spec at `docs/superpowers/specs/2026-04-26-karaoke-search-design.md` (`SongRecord` shape, `normalize()` rules, operational discipline, UA / robots / atomic-write posture). The dedup/merge algorithm is REPLACED — see Section "Dedup & Merge Algorithm (v2 redesign)" below. Other deltas described in this document.

## Goals & Non-Goals

Goals:
- Add `tj-media-direct` adapter against TJ Media's official song search.
- Add `namuwiki` adapter covering NamuWiki's per-agency karaoke lists (Vocaloid + Hololive JP + Nijisanji JP, anime list page if maintained).
- Populate the previously-empty `anime` category from TJ's `애니메이션` genre filter.
- Replace v1's flat registration-order dedup with a two-tier match key + per-field ownership table (see Section "Dedup & Merge Algorithm (v2 redesign)" below). TJ-direct becomes the canonical "songs spine"; blog and namuwiki contribute enrichment metadata onto the spine plus standalone island records.

Non-Goals:
- Direct adapters against KY (금영) or JOYSOUND or DAM. Deferred.
- A standalone `vtuber` category. TJ Media files Hololive/Nijisanji songs under J-POP and v2 follows that vocabulary; vtuber-origin records simply emit `categories: ['jpop']`.
- Romaji indexing. Already removed from v1 (`title_romaji` does not exist).
- Live-fallback search via any serverless backend. Still deferred — v2 stays static.
- Server-side search. v2 stays static; if `songs.json` outgrows the client-side index budget, fix is captured as follow-up, not v2 scope.

## User-facing changes

UI mock (3 chips, deterministic order):

```
┌──────────────────────────────────────────────────┐
│            가라오케 / カラオケ Search            │
├──────────────────────────────────────────────────┤
│  [ search box: 노래/아티스트/曲名/imase ...   🔍 ] │
│  [ jpop ] [ vocaloid ] [ anime ]                 │
├──────────────────────────────────────────────────┤
│  ▸ 星街すいせい — Stellar Stellar       [2021]  │
│    호시마치 스이세이                             │
│    TJ 28311   KY —    JOY —                      │
│  ────────────────────────────────────────────    │
│  ▸ Ado — 阿修羅ちゃん                  [2020]   │
│    아도 — 아수라짱                               │
│    TJ 68425   KY 48374   JOY 631234              │
└──────────────────────────────────────────────────┘
```

Frontend deltas:
- `CategoryChips` renders three chips in this order: `jpop`, `vocaloid`, `anime`. Same AND-filter semantics (see v1 spec Section "Frontend").
- `proseka` chip never existed in the v1 UI; the data-side enum drops `proseka` outright (see Data Model deltas).
- Featured-artist landing grows from two populated categories to three. `apps/web/src/data/featured.ts` adds real entries for `anime` sourced from the v2 crawl.
- Result counts grow: blog ~21k → estimated v2 corpus 30k–100k+ depending on TJ scope. The result cap (top 50, no pagination) is unchanged.

The schema-driven UX (bilingual title/artist with em-dash for missing fields) handles TJ-direct's null-Korean records gracefully — no template changes required.

## Data Model deltas

`Category` union and the JSON Schema's `categories` enum both change:

```ts
// before (v1)
type Category = "jpop" | "vocaloid" | "anime" | "proseka";

// after (v2)
type Category = "jpop" | "vocaloid" | "anime";
```

The matching JSON Schema fragment in `packages/schema/src/index.ts`:

```jsonc
{
  "categories": {
    "type": "array",
    "minItems": 1,
    "uniqueItems": true,
    "items": { "enum": ["jpop", "vocaloid", "anime"] }
  }
}
```

Migration plan:
- Breaking schema change at the type level. Existing on-disk records are unaffected because none use `proseka` (verify with a one-line node check during the migration phase — see plan Phase 0).
- All other field shapes (`SongRecord`, `RawSongRecord`, `KaraokeNumbers`, `id` regex, `source_url`, `crawled_at`) are unchanged.
- Identity key and merge algorithm are REPLACED in v2 (the v1 single-key `normalize(title_primary) + "|" + normalize(artist_primary)` rule no longer applies). See Section "Dedup & Merge Algorithm (v2 redesign)" below.

## Dedup & Merge Algorithm (v2 redesign)

### Conceptual model

TJ-direct is the canonical **"songs spine"** — TJ catalog numbers are vendor-assigned IDs and the strongest identity signal v2 has. Blog and NamuWiki contribute **enrichment metadata** (Korean titles/artists, release year, additional vendor numbers, additional categories) onto the spine, plus standalone "island" records when their content has no TJ counterpart.

Mental model: SQL normalization. TJ-direct is the `songs` table; blog and namuwiki are `translations` / `metadata` tables that join on TJ# when available, or fall back to fuzzy `(title, artist)` match otherwise.

TJ-less songs (KY-only, JOY-only, blog-only, namuwiki-only) ARE retained in the output as standalone records with `karaoke_numbers.tj = null`. They remain searchable. The spine metaphor is conceptual — it describes priority/ownership, not eligibility.

### Two-tier match key

The v1 single-key identity (`normalize(title_primary) + "|" + normalize(artist_primary)`) is replaced by a two-tier scheme:

- **Tier A (hard match)**: two records cluster if they share a non-null value on the **same vendor field** (`karaoke_numbers.tj`, `karaoke_numbers.ky`, or `karaoke_numbers.joysound`). Per-vendor — TJ #100 and KY #100 are unrelated.
- **Tier B (soft match)**: among records NOT clustered by Tier A, fall back to normalized `(title_primary, artist_primary)` match.

The fuzzy normalizer for Tier B is **conservative**. The current `normalize()` (lowercase + collapse whitespace) is sufficient. It does NOT strip `feat. X`, `(movie ver.)`, `[Acoustic]`, etc. Songs with `feat.` variants either cluster via shared vendor numbers (Tier A, the realistic case where TJ assigns one TJ# to the canonical version), or remain separate records. This is intentional — aggressive suffix-stripping risks false-positive merging of remixes/covers/acoustic-versions as the same song.

Clustering algorithm (executed in `mergeRecords`):

1. Collect all `SongRecord[]` from all adapters (no per-adapter dedup beforehand).
2. Tier A pass: union-find over vendor numbers. For each non-null `karaoke_numbers.tj`, `karaoke_numbers.ky`, `karaoke_numbers.joysound`, union the records that share that value.
3. Tier B pass: among records still in singleton clusters after Tier A, group by normalized `(title_primary, artist_primary)` key. Merge same-key singletons into shared clusters.
4. Apply per-field ownership (table below) to each cluster to produce one output `SongRecord` per cluster.

### Per-field ownership table

The flat v1 priority `blog > namuwiki > tj` is replaced by a per-field table. Different fields have different "owners".

| Field | Owner (in fallback order) |
| --- | --- |
| `title_primary`, `artist_primary` | TJ-direct → blog → namuwiki |
| `title_ko`, `artist_ko` | blog → namuwiki |
| `release_year` | blog → namuwiki → TJ-direct |
| `karaoke_numbers.tj`, `.ky`, `.joysound` | union of all non-null values across the cluster; if multiple sources disagree on the SAME vendor's value, highest-priority source wins (priority order: blog > namuwiki > TJ-direct, kept from v1 for tiebreaking only) |
| `categories` | set-union of all contributing sources (sorted) |
| `id` | highest-priority contributing source's local ID (priority order: blog > namuwiki > TJ-direct), formed as `{source_slug}-{source_local_id}` |
| `source_url` | highest-priority contributing source's URL (priority order: blog > namuwiki > TJ-direct) |
| `crawled_at` | latest of contributing sources |

For TJ-less clusters the rule degrades gracefully: blog takes over `title_primary` when no TJ-direct record joined the cluster (next in fallback order); namuwiki takes over if blog is also absent.

The "highest priority for tiebreaking" priority order (`blog > namuwiki > TJ-direct`) is retained from v1 — but ONLY for tiebreaking on the same field, not as a global merge-precedence rule. Adapter registration order in `packages/crawler/src/adapters/index.ts` reflects this priority for tiebreak determinism.

### Crawl-time conflict logging

When records cluster via Tier B (fuzzy `title+artist` match) but disagree on a vendor number neither shares as the clustering key (e.g., blog says `tj=68923`, namuwiki says `tj=68924`, clustered by string match alone), the merger logs a warning. The merger does NOT abort — highest-priority source's value wins per the ownership table.

Warnings are returned as structured objects alongside the merged record array (not console output) so the crawl workflow can aggregate them into the PR body.

The warnings are aggregated into the crawl PR body (extending the existing PR-body summary in the crawl GitHub-Actions workflow) so the user can spot-check upstream errors over time. Quantity-only summary in the PR body — total count plus a sample of N=10 (NOT every conflict).

### Worked examples

| Scenario | Cluster path | Output |
| --- | --- | --- |
| Blog row + TJ row share `tj=28311` | Tier A (vendor union) | Single record. `title_primary` = TJ's, `title_ko` = blog's, `karaoke_numbers.tj=28311`. |
| Blog row + TJ row + Namu row all share `tj=68425`; Namu also has `ky=48374` | Tier A | Single record. `karaoke_numbers = {tj: 68425, ky: 48374, joysound: null}`. Categories set-unioned (e.g., `["anime", "jpop"]`). |
| Blog row has no TJ#, no KY#; matches a TJ row by normalized `(title, artist)` | Tier B | Single record. `title_primary` = TJ's. Conflict-log if blog's `karaoke_numbers.tj` were non-null and disagreed (here it's null, so no conflict). |
| Namu row only — no TJ row, no blog row | neither tier (singleton) | Standalone record. `title_primary` = namu's. `karaoke_numbers.tj=null`. |
| Blog row with no TJ#, no KY#, no JOY#; no other source matches | neither tier (singleton) | Standalone record. `title_primary` = blog's. `karaoke_numbers.tj=null`, `.ky=null`, `.joysound=null`. |
| Blog row says `tj=68923`, Namu row says `tj=68924`, neither shares with the other; both fuzzy-match `(title, artist)` | Tier B | Single record, `karaoke_numbers.tj=68923` (blog wins), warning logged. |
| Blog has `{tj, ky}`, Namu has `{ky, joysound}`, all three sources cluster via shared `ky` | Tier A | Single record. `karaoke_numbers` = union of all three vendor fields. |

### Cross-tagging policy

Each surfaced record carries the categories of its source page; the merger set-unions them (see per-field ownership table, `categories` row). So a Hololive cover that appears only on the Hololive list page gets `["jpop"]` (NamuWiki Hololive/Nijisanji pages emit `[jpop]` per Section "Source: NamuWiki" below); if the same song clusters (Tier A via shared TJ#, or Tier B via fuzzy title+artist) with a Vocaloid-list record, the union is `["jpop", "vocaloid"]`. Different-artist covers (Hololive talent covering a Vocaloid original) typically do NOT cluster — different artist breaks Tier B, and TJ usually issues distinct TJ#s for cover recordings, breaking Tier A — so they remain separate records. That is the intended behaviour.

## Source: TJ Media direct (`tj-media-direct`)

Crawls TJ Media's official accompaniment search and emits records with TJ numbers only.

Endpoint:
- Base: `https://www.tjmedia.com/song/accompaniment` (the live URL must be re-verified before Phase 2 — TJ has historically rotated paths) `[verify before Phase 2]`.
- Query parameters expected: a category code (`cate_cd` or similar) and a paging cursor. Exact param names captured in the parser-contract step of Phase 2.
- Japanese-language content lives under multiple genre codes; the crawler iterates genre codes mapped to our category union.

Genre → category mapping:

| TJ genre label | Our category | Notes |
| --- | --- | --- |
| `J-POP` / `J-pop` | `jpop` | Primary jpop volume |
| `애니메이션` | `anime` | Anime karaoke; includes anime OPs/EDs/inserts |
| `보컬로이드` | `vocaloid` | Some overlap with NamuWiki vocaloid set |

Available fields per row:
- TJ song number (digits, e.g. `28311`).
- Title (Japanese script).
- Artist (Japanese script).
- Occasionally lyricist / composer (ignored in v1 schema).
- NOT available: Korean title, Korean artist, KY/JOYSOUND numbers, release year (release year is sometimes shown but unreliable; record as `null` unless a `YYYY` is unambiguously present).

Pagination strategy:
- Iterate per genre code; for each, walk numeric pages (e.g. `?pageNo=1..N`) until an empty result set is returned twice in a row (the "two empties to be safe" guard handles transient blank pages).
- Adapter records the highest seen page per genre to `.cache/tj-direct-pages.json` and uses it as a starting offset on subsequent runs (skips already-fetched pages when ETag/Last-Modified is set; otherwise re-fetches from page 1).

Rate-limit and politeness:
- Default crawler rate (1 req/sec, ±0.5s jitter) is acceptable. TJ's history suggests we may safely crawl that fast.
- Per-host override is allowed via the http client's options struct: `{ minIntervalMs?: number; jitterMs?: number }`. Wire-up landed in v1's `http.ts` as part of Phase 2's surface area, OR added in v2 if missing.
- Honest UA preserved: `karaoke-search-crawler/0.1 (+https://github.com/ghkim887/karaoke-search)`.

Robots.txt:
- Must be re-verified live before the first Phase 2 crawl run. The `robots-parser` gate already runs per-request.

Adapter conformance:
- Implements the v1 `Crawler` interface: `name: "tj-media-direct"`, `crawl(opts?: CrawlOptions): AsyncIterable<SongRecord>` (see v1 spec Section "Crawler Architecture").
- Yields already-normalized `SongRecord` (matching the BlogCrawler's pattern). `karaoke_numbers.tj` populated; `karaoke_numbers.ky` and `karaoke_numbers.joysound` always `null`. `title_ko = null`, `artist_ko = null`. `release_year = null` unless extracted with high confidence.

Success-ratio gate: ≥90% of fetched listing pages must parse without throwing. Below 90%, the pipeline aborts with non-zero exit and no PR is opened (matches v1 budget).

## Source: NamuWiki (`namuwiki`)

Crawls per-page karaoke lists on NamuWiki and emits records with both Korean and Japanese titles plus TJ/KY numbers when listed.

Pages targeted (initial set; URLs verified before Phase 3):

| Page | Category | URL |
| --- | --- | --- |
| Vocaloid karaoke list | `vocaloid` | `https://namu.wiki/w/음성_합성_엔진_오리지널_곡/노래방_수록_목록` `[verify before Phase 3]` |
| Hololive JP karaoke list | `jpop` | `https://namu.wiki/w/홀로라이브_프로덕션/노래방_수록_목록` `[verify before Phase 3]` |
| Nijisanji JP karaoke list | `jpop` | `https://namu.wiki/w/니지산지/노래방_수록_목록` `[verify before Phase 3]` |
| Anime karaoke list | `anime` | exists only if a maintained list page is found `[verify before Phase 3]` — otherwise leave anime to TJ |

Hololive/Nijisanji songs are J-POP per TJ Media's own catalog vocabulary; v2 follows that convention rather than inventing a vtuber category that no upstream source naturally provides.

Page-shape contract (validated against fixtures during Phase 3):
- NamuWiki tables typically have columns like `[Korean title | Japanese title | Romaji | TJ# | KY# | Artist | Notes]`. Exact column count and order vary per page; the parser pins the contract per page (one parser variant per source page is acceptable — they share helpers but the table column map is page-specific).
- Korean is the page's document title; for individual song rows, the Korean title is the canonical Korean title (`title_ko`).
- Japanese (the original) appears in the body's "Japanese title" column; the parser extracts the first Japanese-script string (matching `/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u`) from that cell as `title_primary`.
- Romaji column is ignored (we dropped romaji indexing in v1).
- TJ# / KY# columns map directly to `karaoke_numbers.tj` / `karaoke_numbers.ky`. Empty / `-` / em-dash → `null` (same convention as the blog adapter).
- Artist column → `artist_primary` (Japanese script preferred). `artist_ko` is populated only if NamuWiki provides an explicit Korean artist field; otherwise `null`.

JS-rendering posture:
- NamuWiki is React-rendered; a basic `curl` returns minimal SSR HTML that may or may not contain the table. Phase 3 starts with an investigation step that captures one fixture each via three strategies and picks the simplest that yields a parseable table:
  1. Plain GET with our honest UA (preferred).
  2. NamuWiki's raw export endpoint, e.g. `https://namu.wiki/raw/<page>` or `?action=raw` if available.
  3. Headless-render via Playwright (already a project devDep).
- Whichever strategy is chosen is documented in the adapter README and pinned. Switching strategies later is a Phase-3-style change (parser + crawler + normalizer revisit).

403 / anti-bot handling:
- A basic-UA fetch may be blocked. UA strategy: keep our honest UA but do not pretend to be a browser. If 403 persists, document and degrade to the raw export strategy.
- Per-host rate limit: NamuWiki gets a 2 second min interval (vs the default 1s), set via the http client's per-host override.

Robots.txt: re-verified before crawl runs. The `robots-parser` gate is enforced per request.

Adapter conformance:
- Implements `Crawler`: `name: "namuwiki"`, yields `SongRecord` (already-normalized).
- For each record: `title_ko` populated from the page-level row; `title_primary` populated from the Japanese cell; `karaoke_numbers.tj` and `karaoke_numbers.ky` populated if listed; `karaoke_numbers.joysound` always `null` (NamuWiki rarely lists JOYSOUND).
- `categories`: assigned from the source page's pinned category (`vocaloid` for Vocaloid list, `jpop` for Hololive/Nijisanji list, `anime` for the anime list page if scraped). Multi-source overlap is handled by the merger's set-union — no special-case logic in this adapter.

Success-ratio gate: ≥85% of fetched pages must parse without throwing. The lower budget reflects the higher fragility of JS-rendered NamuWiki tables. Below 85%, the pipeline aborts with non-zero exit.

## Crawler architecture changes

Adapter registration order in `packages/crawler/src/adapters/index.ts`'s `adapters: Crawler[]` array:

```
[BlogCrawler, NamuWikiCrawler, TJDirectCrawler]
```

This order encodes the per-field tiebreak priority `blog > namuwiki > TJ-direct` from Section "Dedup & Merge Algorithm (v2 redesign)". The order is consulted ONLY when the per-field ownership table calls for a tiebreak on the same vendor field. It is NOT a global merge-precedence rule — see the per-field ownership table for which source actually wins on each field.

Resulting practical behaviour (from the per-field ownership table):
- TJ-direct provides canonical `title_primary` / `artist_primary` (the "spine"); blog and namuwiki contribute `title_ko` / `artist_ko` and additional vendor numbers and categories on top.
- NamuWiki adds the long-tail Vocaloid B-sides and Hololive/Nijisanji-only songs (standalone records when no TJ row joins the cluster).
- Blog wins on `release_year` and on vendor-number disagreement tiebreaks.

`mergeRecords` is **rewritten** for v2 — Phase 0.5 in the implementation plan implements the two-tier match key (Tier A vendor-number union-find, then Tier B fuzzy `(title, artist)` match) and the per-field ownership table. The v1 single-key + flat-priority algorithm is retired.

The pipeline still validates every record against `songRecordSchema` before writing. The schema's `Category` enum picks up the v2 union via Phase 0. The merger emits per-cluster conflict warnings (see Section "Crawl-time conflict logging") which Phase 0.5 wires into the crawl PR body summary.

## Frontend changes

- `apps/web/src/components/CategoryChips.tsx` — render three chips in the order `[ jpop ] [ vocaloid ] [ anime ]`. AND-filter semantics unchanged (`selectedCategories.every(c => record.categories.includes(c))`). The `proseka` chip is removed (was never rendered, but the chip-list constant referenced it).
- `apps/web/src/data/featured.ts` — type widens to `{ jpop: string[]; vocaloid: string[]; anime: string[] }`. Each list contains 6 artist names. Names MUST exist in `apps/web/public/data/songs.json` after the v2 crawl so clicking a featured chip yields hits — this is verified in Phase 4 by a sample-fixture cross-check.
- `apps/web/src/components/ResultCard.tsx` — no template change. The bilingual em-dash convention covers TJ-direct's null-Korean records as-is.
- `apps/web/src/lib/search.ts` — no boost change. The new sources contribute records, not a new search field; no MiniSearch reconfiguration.

## Operational discipline

Inherited verbatim from v1 (UA, ETag/Last-Modified cache, `robots-parser` gate, atomic write via `.tmp` rename). Per-host overrides allowed via the http client's options struct:

| Host | min interval | jitter | UA |
| --- | --- | --- | --- |
| `j-pop-playlist.tistory.com` | 1000 ms | ±500 ms | default |
| `namu.wiki` | 2000 ms | ±500 ms | default |
| `www.tjmedia.com` | 1000 ms | ±500 ms | default |

Per-adapter success-ratio gate:
- BlogCrawler: ≥90% (unchanged from v1).
- TJDirectCrawler: ≥90%.
- NamuWikiCrawler: ≥85% (relaxed for JS-render fragility).

Index-page failures (e.g., the per-genre TJ root page or the NamuWiki list page itself) remain critical: any failure aborts the crawl immediately with non-zero exit.

## Data scale and storage

Estimates:

| Source | Records (rough) |
| --- | --- |
| Blog (existing) | ~21k |
| NamuWiki (vocaloid + holo + niji + maybe anime) | ~5k–10k |
| TJ-direct (J-POP + 애니메이션 + 보컬로이드) | ~50k–100k |
| Total after dedup | ~80k–130k |

`apps/web/public/data/songs.json` could grow to ~30–60 MB.

If `songs.json` crosses 30 MB, MiniSearch's client-side index may become slow on first load (parse + index build on the main thread). v2 does NOT solve this; instead Phase 5 measures the post-crawl size and load time, and if either degrades noticeably, files a follow-up issue with one of these mitigations as the v3 candidate fix:
1. Lazy-load the index in a Web Worker.
2. Split `songs.json` by category and load on demand.
3. Move to a server-side search (vendor TBD) backed by a pre-built FlexSearch/MiniSearch shard.

For v2: just measure and document. Defer the actual fix.

## Open Questions

- NamuWiki's anti-bot posture is unknown until Phase 3's investigation step runs. If plain GET, raw-export, AND headless-render all fail under our honest UA, the namuwiki adapter is descoped to "blog + tj only" for v2 and Hololive/Nijisanji records populate from TJ-direct alone (still tagged `[jpop]` per TJ's genre, but without NamuWiki's Korean translations for those records).
- TJ's exact Japanese-only filter form (`cate_cd` value, additional language gating param if any) needs live capture in Phase 2's first step. The genre table above is provisional.

