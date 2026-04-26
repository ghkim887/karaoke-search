# Karaoke Search Web — v2 Design Spec

v2 expands the karaoke-search corpus with two new data sources (TJ Media direct and NamuWiki) and broadens category coverage to four populated categories: `jpop`, `vocaloid`, `anime`, and `vtuber`. The frontend, schema validator, and core crawler pipeline remain in shape; the changes are additive adapters, a category-enum migration, and a static Vtuber roster.

## Status

- Date: 2026-04-26
- Version: v2 design
- Author: brainstorming session with user
- Inherits all conventions from v1 spec at `docs/superpowers/specs/2026-04-26-karaoke-search-design.md` (data model identity key, normalize() rules, dedup/merge algorithm, operational discipline). This document only describes deltas.

## Goals & Non-Goals

Goals:
- Add `tj-media-direct` adapter against TJ Media's official song search.
- Add `namuwiki` adapter covering NamuWiki's per-agency karaoke lists (Vocaloid + Hololive JP + Nijisanji JP, anime list page if maintained).
- Populate the previously-empty `anime` category from TJ's `애니메이션` genre filter.
- Introduce a new populated `vtuber` category covering Hololive JP + Nijisanji JP.
- Maintain a static Vtuber artist roster, used both for tagging TJ-direct records and targeting NamuWiki pages.
- Preserve registration-order dedup priority (`blog` > `namuwiki` > `tj-media-direct`).

Non-Goals:
- Direct adapters against KY (금영) or JOYSOUND or DAM. Deferred.
- Non-JP vtubers (Hololive EN/ID, VShojo, indies). Deferred.
- Romaji indexing. Already removed from v1 (`title_romaji` does not exist).
- Live-fallback search via Cloudflare Workers. Still deferred.
- Server-side search. v2 stays static; if `songs.json` outgrows the client-side index budget, fix is captured as follow-up, not v2 scope.

## User-facing changes

UI mock (4 chips, deterministic order):

```
┌──────────────────────────────────────────────────┐
│            가라오케 / カラオケ Search            │
├──────────────────────────────────────────────────┤
│  [ search box: 노래/아티스트/曲名/imase ...   🔍 ] │
│  [ jpop ] [ vocaloid ] [ anime ] [ vtuber ]      │
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
- `CategoryChips` renders four chips in this order: `jpop`, `vocaloid`, `anime`, `vtuber`. Same AND-filter semantics (see v1 spec Section "Frontend").
- `proseka` chip never existed in the v1 UI; the data-side enum drops `proseka` outright (see Data Model deltas).
- Featured-artist landing grows from two populated categories to four. `apps/web/src/data/featured.ts` adds real entries for `anime` and `vtuber` sourced from the v2 crawl.
- Result counts grow: blog ~21k → estimated v2 corpus 30k–100k+ depending on TJ scope. The result cap (top 50, no pagination) is unchanged.

The schema-driven UX (bilingual title/artist with em-dash for missing fields) handles TJ-direct's null-Korean records gracefully — no template changes required.

## Data Model deltas

`Category` union and the JSON Schema's `categories` enum both change:

```ts
// before (v1)
type Category = "jpop" | "vocaloid" | "anime" | "proseka";

// after (v2)
type Category = "jpop" | "vocaloid" | "anime" | "vtuber";
```

The matching JSON Schema fragment in `packages/schema/src/index.ts`:

```jsonc
{
  "categories": {
    "type": "array",
    "minItems": 1,
    "uniqueItems": true,
    "items": { "enum": ["jpop", "vocaloid", "anime", "vtuber"] }
  }
}
```

Migration plan:
- Breaking schema change at the type level. Existing on-disk records are unaffected because none use `proseka` (verify with a one-line node check during the migration phase — see plan Phase 0).
- All other field shapes (`SongRecord`, `RawSongRecord`, `KaraokeNumbers`, `id` regex, `source_url`, `crawled_at`) are unchanged.
- Identity key (`normalize(title_primary) + "|" + normalize(artist_primary)`) and merge algorithm are unchanged (see v1 spec Section "Crawler Architecture").

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

Vtuber tagging is layered on top of whatever genre TJ assigned: after a record is normalized, the normalizer consults the Vtuber roster (see "Vtuber roster" below). If `artist_primary` matches a roster entry, `vtuber` is added to `categories` (set-union, sorted).

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
| Hololive JP karaoke list | `vtuber` | `https://namu.wiki/w/홀로라이브_프로덕션/노래방_수록_목록` `[verify before Phase 3]` |
| Nijisanji JP karaoke list | `vtuber` | `https://namu.wiki/w/니지산지/노래방_수록_목록` `[verify before Phase 3]` |
| Anime karaoke list | `anime` | exists only if a maintained list page is found `[verify before Phase 3]` — otherwise leave anime to TJ |

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
- `categories`: assigned from the source page's pinned category (`vocaloid`, `vtuber`, or `anime`). Multi-source overlap (e.g., a song that's both vocaloid and vtuber) is handled by the merger's set-union — no special-case logic in this adapter.

Success-ratio gate: ≥85% of fetched pages must parse without throwing. The lower budget reflects the higher fragility of JS-rendered NamuWiki tables. Below 85%, the pipeline aborts with non-zero exit.

## Vtuber roster

Static file at `packages/crawler/src/adapters/namuwiki/vtuber-roster.ts` (the file lives under `namuwiki/` because the NamuWiki adapter owns the roster's source-of-truth pages, but the file's exports are imported by both the namuwiki and tj-media-direct normalizers).

Exports:
- `HOLOLIVE_JP: string[]` — Hololive JP talents, names exactly as they appear in our data (Japanese script preferred since both upstream sources are Japanese-first; common variants included where a talent uses both kanji and hiragana stage names).
- `NIJISANJI_JP: string[]` — Nijisanji JP talents, same convention.
- `isVtuber(artist: string): "hololive" | "nijisanji" | null` — helper that normalize()-compares the input artist against both lists and returns the matching agency tag, or `null` if no match.

Used at two points:
1. In `tj-media-direct`'s normalizer, to add the `vtuber` tag if `isVtuber(artist_primary) !== null`.
2. By NamuWiki's crawler, to know which subset of pages to fetch (the Hololive and Nijisanji list-pages cover the same talent set; the roster pins the canonical names).

Maintenance:
- v2 ships ~30–50 names per agency. Roster source: agency-side NamuWiki pages (`홀로라이브_프로덕션`, `니지산지`) cross-checked against Wikipedia's English-language pages for spelling variants.
- Updates land as ordinary commits to the roster file. No separate publish step.
- Roster is unit-tested: known names match (`星街すいせい`, `月ノ美兎`), known non-vtubers do not (`YOASOBI`, `米津玄師`).

## Crawler architecture changes

Adapter registration order = dedup priority (see v1 spec Section "Crawler Architecture", stage 3). Updated registration order in `packages/crawler/src/adapters/index.ts`'s `adapters: Crawler[]` array:

```
[BlogCrawler, NamuWikiCrawler, TJDirectCrawler]
```

Resulting precedence:
- Blog wins for `title_ko`, `title_primary`, `artist_primary`, `artist_ko`, `source_url` when the same identity key collides.
- NamuWiki fills records the blog does not have (e.g., long-tail Vocaloid B-sides; all Hololive/Nijisanji-only songs).
- TJ-direct fills any remaining TJ numbers and adds long-tail Japanese-language artists not on either Korean source.

The existing `mergeRecords` algorithm already implements registration-order priority + per-field non-null union for `karaoke_numbers` + set-union for `categories`. No algorithmic changes required for v2 — only the array order changes.

The pipeline still validates every record against `songRecordSchema` before writing. The schema's `Category` enum picks up the v2 union via Phase 0.

## Frontend changes

- `apps/web/src/components/CategoryChips.tsx` — render four chips in the order `[ jpop ] [ vocaloid ] [ anime ] [ vtuber ]`. AND-filter semantics unchanged (`selectedCategories.every(c => record.categories.includes(c))`). The `proseka` chip is removed (was never rendered, but the chip-list constant referenced it).
- `apps/web/src/data/featured.ts` — type widens to `{ jpop: string[]; vocaloid: string[]; anime: string[]; vtuber: string[] }`. Each list contains 6 artist names. Names MUST exist in `apps/web/public/data/songs.json` after the v2 crawl so clicking a featured chip yields hits — this is verified in Phase 4 by a sample-fixture cross-check.
- `apps/web/src/components/ResultCard.tsx` — no template change. The bilingual em-dash convention covers TJ-direct's null-Korean records as-is.
- `apps/web/src/lib/search.ts` — no boost change. The new `vtuber` category is a category, not a search field; no MiniSearch reconfiguration.

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
3. Move to a server-side search backed by Cloudflare Workers + a pre-built FlexSearch/MiniSearch shard.

For v2: just measure and document. Defer the actual fix.

## Open Questions

- NamuWiki's anti-bot posture is unknown until Phase 3's investigation step runs. If plain GET, raw-export, AND headless-render all fail under our honest UA, the namuwiki adapter is descoped to "blog + tj only" for v2 and the `vtuber` category populates from TJ-direct + the static roster alone (no Korean translations for vtuber records).
- TJ's exact Japanese-only filter form (`cate_cd` value, additional language gating param if any) needs live capture in Phase 2's first step. The genre table above is provisional.
- Cross-tagging policy: a song that is both a Vocaloid original AND covered by a Hololive talent — does the cover record get `["vocaloid", "vtuber"]` or just `["vtuber"]`? Spec answer: each surfaced record carries the categories of its source page; the merger set-unions them. So a cover that appears on the Hololive list page gets `["vtuber"]`; if the SAME identity key (same title + same artist) also appears on the Vocaloid list, it gets unioned to `["vocaloid", "vtuber"]`. Different-artist covers (Hololive talent covering a Vocaloid song) have a different identity key from the Vocaloid original and therefore stay separate records — that is the intended behaviour.
