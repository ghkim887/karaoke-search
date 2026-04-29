# Karaoke Search Web — v2 Design Spec

v2 expands the karaoke-search corpus with two new data sources (TJ Media direct and NamuWiki) and broadens category coverage to three populated categories: `jpop`, `vocaloid`, and `anime`. The frontend, schema validator, and core crawler pipeline remain in shape; the changes are additive adapters and a category-enum cleanup (drop the unused `proseka`).

## Status

- Date: 2026-04-26
- Version: v2 design
- Author: brainstorming session with user
- Inherits most conventions from v1 spec at `docs/superpowers/specs/2026-04-26-karaoke-search-design.md` (`SongRecord` shape, `normalize()` rules, operational discipline, UA / robots / atomic-write posture). The dedup/merge algorithm is REPLACED — see Section "Dedup & Merge Algorithm (v2 redesign)" below. Other deltas described in this document.

## Implementation status

- Phase 0 (schema migration) ✓ — `e5c36dd`, walked back partially in `2904878` (vtuber dropped, final union `jpop|vocaloid|anime`).
- Phase 0.5 (merger rewrite — two-tier match key + per-field ownership + conflict aggregate) ✓ — `250d57f`.
- Phase 2 (TJ-direct adapter) ✓ — `4eec991` (initial artist-fanout, walked back), `28f187c` (catalog API pivot), `01c44f4` (Chinese-artist denylist + blog-whitelist rescue).
- Bug fixes ✓ — `5305cc4` (blog parser handles `<br>`-separated multi-code cells).
- Phase 3 (NamuWiki adapter) — pending.
- Phase 4 (frontend wire-up) — pending.
- Phase 5 (combined live crawl + sample fixture refresh) — pending.
- Phase 6 (CLAUDE.md / README sync) — partially landing in this commit.

## Goals & Non-Goals

Goals:
- Add `tj-media-direct` adapter against TJ Media's official song search.
- Add `namuwiki` adapter covering NamuWiki's per-agency karaoke lists (Vocaloid + Hololive JP + Nijisanji JP, anime list page if maintained).
- Populate the previously-empty `anime` category via NamuWiki Tier A merges onto the TJ-direct spine (TJ has no genre tag — every TJ record emits `[jpop]`; NamuWiki contributes the `[anime]` and `[vocaloid]` categories that ride along through the merger).
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
    "items": { "enum": ["jpop", "vocaloid", "anime"] },
    // Mutual-exclusivity: if `anime` or `vocaloid` is present, `jpop`
    // must NOT also be. Encoded directly in the schema (defense-in-depth
    // alongside the merger's `applyCategoryExclusivity` runtime safeguard).
    "if": {
      "anyOf": [
        { "contains": { "const": "anime" } },
        { "contains": { "const": "vocaloid" } }
      ]
    },
    "then": {
      "not": { "contains": { "const": "jpop" } }
    }
  }
}
```

Migration plan:
- Breaking schema change at the type level. Existing on-disk records are unaffected because none use `proseka` (verify with a one-line node check during the migration phase — see plan Phase 0).
- All other field shapes (`SongRecord`, `RawSongRecord`, `KaraokeNumbers`, `id` regex, `source_url`, `crawled_at`) are unchanged.
- Identity key and merge algorithm are REPLACED in v2 (the v1 single-key `normalize(title_primary) + "|" + normalize(artist_primary)` rule no longer applies). See Section "Dedup & Merge Algorithm (v2 redesign)" below.

## Dedup & Merge Algorithm (v2 redesign)

### Conceptual model

TJ-direct is the canonical **"songs spine"** — TJ catalog numbers are vendor-assigned IDs and the strongest identity signal v2 has. Blog and NamuWiki contribute **enrichment metadata** (Korean titles/artists, additional vendor numbers, additional categories) onto the spine, plus standalone "island" records when their content has no TJ counterpart.

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
| `karaoke_numbers.tj`, `.ky`, `.joysound` | union of all non-null values across the cluster; if multiple sources disagree on the SAME vendor's value, highest-priority source wins (priority order: blog > namuwiki > TJ-direct, kept from v1 for tiebreaking only) |
| `categories` | set-union of all contributing sources, then mutual-exclusivity rule applied: if the union contains `anime` or `vocaloid`, `jpop` is dropped (final array sorted). The same rule is also encoded directly in the JSON Schema (`if/then` with `contains`), so `validateSongRecord` rejects non-conformant records up front; the merger's `applyCategoryExclusivity` is defense-in-depth for cluster-time set-unions. |

> **v2.1 update (2026-04-29):** the rule was tightened to **3-way mutual exclusivity** with priority `vocaloid > anime > jpop`. The schema now enforces `maxItems: 1` on `categories`, and `applyCategoryExclusivity` (canonical helper exported from `@karaoke/schema`) drops the lower-priority tag when multiple are present. See CLAUDE.md gotcha for the current shape.

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
| Blog row + TJ row + Namu row all share `tj=68425`; Namu also has `ky=48374` | Tier A | Single record. `karaoke_numbers = {tj: 68425, ky: 48374, joysound: null}`. Categories set-unioned then exclusivity-reduced (e.g., blog `["jpop"]` + TJ `["jpop"]` + Namu `["anime"]` → `["jpop", "anime"]` → `["anime"]`). |
| Blog row has no TJ#, no KY#; matches a TJ row by normalized `(title, artist)` | Tier B | Single record. `title_primary` = TJ's. Conflict-log if blog's `karaoke_numbers.tj` were non-null and disagreed (here it's null, so no conflict). |
| Namu row only — no TJ row, no blog row | neither tier (singleton) | Standalone record. `title_primary` = namu's. `karaoke_numbers.tj=null`. |
| Blog row with no TJ#, no KY#, no JOY#; no other source matches | neither tier (singleton) | Standalone record. `title_primary` = blog's. `karaoke_numbers.tj=null`, `.ky=null`, `.joysound=null`. |
| Blog row says `tj=68923`, Namu row says `tj=68924`, neither shares with the other; both fuzzy-match `(title, artist)` | Tier B | Single record, `karaoke_numbers.tj=68923` (blog wins), warning logged. |
| Blog has `{tj, ky}`, Namu has `{ky, joysound}`, all three sources cluster via shared `ky` | Tier A | Single record. `karaoke_numbers` = union of all three vendor fields. |

### Cross-tagging policy

Each surfaced record carries the categories of its source page; the merger set-unions them (see per-field ownership table, `categories` row). So a Hololive cover that appears only on the Hololive list page gets `["jpop"]` (NamuWiki Hololive/Nijisanji pages emit `[jpop]` per Section "Source: NamuWiki" below); if the same song clusters (Tier A via shared TJ#, or Tier B via fuzzy title+artist) with a Vocaloid-list record, the union is `["jpop", "vocaloid"]`. Different-artist covers (Hololive talent covering a Vocaloid original) typically do NOT cluster — different artist breaks Tier B, and TJ usually issues distinct TJ#s for cover recordings, breaking Tier A — so they remain separate records. That is the intended behaviour.

## Source: TJ Media direct (`tj-media-direct`)

Crawls TJ Media's legacy catalog JSON API and emits records with TJ numbers. Categorization is uniform: every TJ-direct record emits `categories: ["jpop"]`. TJ does not expose a per-row anime/vocaloid tag, and v2 deliberately does not infer one at the TJ adapter — those tags arrive via NamuWiki Tier A merges (a NamuWiki record with `[anime]` or `[vocaloid]` sharing a TJ# with a TJ-direct record produces a merged record where the schema-encoded category-exclusivity rule (also enforced by the merger) strips `jpop` and keeps `[anime]` or `[vocaloid]`).

### Endpoint and request body

A single POST returns the catalog since the supplied month. Using `searchYm=200001` (Jan 2000) returns ~67k records covering the full historical TJ catalog as of the crawl date. The previously-spec'd artist-fanout enumeration is retired — one POST replaces it.

```
POST https://www.tjmedia.com/legacy/api/newSongOfMonth
Content-Type: application/x-www-form-urlencoded

searchYm=200001
```

No authentication, no CSRF token, no session cookies. Static JSON response (`Content-Type: application/json;charset=UTF-8`).

### Response shape

```json
{
  "resultCode": "99",
  "resultData": {
    "itemsTotalCount": 67296,
    "items": [
      {
        "rownumber": 1,
        "thumbnailImg": "https://www.tjmedia.com/SONG_ALBUMIMG/SONG_MATCH/074026_thumb.jpg",
        "pro": 74026,
        "indexTitle": "her",
        "indexSong": "JVKE",
        "word": "LAWSON JACOB DODGE,LAWSON ZACHARY JOHN",
        "com": "LAWSON JACOB DODGE,LAWSON ZACHARY JOHN",
        "icongubun": "",
        "mv_yn": "N",
        "publishdate": "2026-04-27"
      }
    ]
  },
  "GNB_MENU": [],
  "resultMsg": "성공"
}
```

Field map to `RawSongRecord`:

| Schema field | Source field | Notes |
| --- | --- | --- |
| `karaoke_numbers.tj` | `pro` (number) | cast to string |
| `title_primary` | `indexTitle` (string) | |
| `artist_primary` | `indexSong` (string) | despite the field name, this is the artist |

Other fields (`word`, `com`, `thumbnailImg`, `icongubun`, `mv_yn`, `rownumber`, `publishdate`) are ignored.

### Loose-JP filter

The catalog API returns the entire TJ catalog (~67k records, mostly Korean). The adapter applies a loose Japanese-relevance filter at the parser layer — a record is kept if its `indexTitle` or `indexSong` contains at least ONE of:

- a hiragana char (`/[぀-ゟ]/`),
- a katakana char (`/[゠-ヿ]/`), OR
- a CJK unified ideograph (`/[一-鿿]/`) AND the same string contains no Hangul (`/[가-힯]/`).

Strings containing Hangul or only Latin script are NOT Japanese-relevant unless they also contain hiragana or katakana. This loose filter yields ~7,100 JP-relevant records out of 67,296. The strict variant (hiragana/katakana only) would yield ~4,000 records but loses Han-only Japanese titles like `紅蓮華`.

#### Chinese-artist denylist (always-on, post-filter)

The Han-without-Hangul branch unavoidably leaks Cantopop / Mandopop catalog entries by well-known artists (`张学友`, `刘德华`, `邓丽君`, `王菲`, `蔡琴`, etc.). After the loose-JP filter passes, the artist name is normalized (whitespace-collapse + `toLowerCase()` + NFKC) and matched against a `~170`-entry seed denylist of recognized Chinese-music acts. Matches are dropped. Long-tail Chinese leak (≤4 records per artist not in the seed list) is accepted scope. Live impact at 2026-04-27: ~1,000 records dropped (the seed list covers heavy-catalog Chinese artists; the brief's 300-400 estimate undershot actual TJ representation).

#### Blog-whitelist rescue (override)

The loose-JP filter also drops Japanese acts whose names and titles are all-Latin (`GRANRODEO`, `halyosy`, `DREAMS COME TRUE`, `go!go!vanillas`, `Novelbright`, etc.) — the J-pop blog adapter already knows about these. To recover them, the parser accepts an optional `forceIncludeTjNumbers: ReadonlySet<string>`. When a TJ catalog row's `pro` is in the set, BOTH the loose-JP filter AND the Chinese denylist are bypassed for that record (rescue overrides denylist; the blog corpus is canonical). The crawler builds the set at construction time by reading `apps/web/public/data/songs.json` and extracting every record's `karaoke_numbers.tj`. If the file is missing, the rescue path silently degrades to an empty set with a single `console.warn`. This dependency on the on-disk blog corpus is a small architectural smell, parallel to `apps/web/src/lib/featured.ts`.

Net coverage at 2026-04-27 with both refinements: **~5,860 JP-relevant records** (delta -1,001 vs the pre-refinement 6,860). The lower count reflects the wider-than-estimated denylist impact; the rescue path adds back ~145 records the blog already curated.

### Sample record

From the live response (`pro=68781`, captured 2026-04-27):

```json
{
  "id": "tj-68781",
  "source_url": "https://www.tjmedia.com/legacy/api/newSongOfMonth",
  "title_primary": "アイドル(推しの子 OP)",
  "title_ko": null,
  "artist_primary": "YOASOBI",
  "artist_ko": null,
  "karaoke_numbers": { "tj": "68781", "ky": null, "joysound": null },
  "categories": ["jpop"],
  "crawled_at": "2026-04-27T00:46:00.000Z"
}
```

### Anti-bot signals and UA strategy

The legacy catalog API has **no UA gating** — confirmed live 2026-04-27 with default UA, bot UA, and Chrome UA all returning 200. This is in contrast to the public HTML site (`/song/accompaniment_search`), which gates bot UAs to a static "site under maintenance" IIS page. The legacy API is open even when the public HTML site requires a Chrome UA.

The adapter therefore uses the project's default crawler UA. No Chrome spoof is needed. (The previous spec required a Chrome UA spoof for the HTML-scraping path; that requirement is retired alongside that path.)

### Rate limit and politeness

The adapter issues one POST per crawl run, so per-host rate-limit is essentially academic. The `www.tjmedia.com` per-host config retains a conservative **500 ms base + ±100 ms jitter** as documentation of intent — if any future code path adds a second request to TJ, it will already be polite.

Wired through the http client's per-host options struct: `{ minIntervalMs: 500, jitterMs: 100 }` (no `userAgent` override).

### Adapter conformance

- Implements the v1 `Crawler` interface: `name: "tj-media-direct"`, `crawl(opts?: CrawlOptions): AsyncIterable<SongRecord>` (see v1 spec Section "Crawler Architecture").
- Yields already-normalized `SongRecord`.
- Every record: `categories: ["jpop"]` (uniform — no heuristic anime/vocaloid inference).
- `karaoke_numbers.tj` populated with the TJ catalog number; `karaoke_numbers.ky` and `karaoke_numbers.joysound` always `null`.
- `title_ko = null`, `artist_ko = null` (TJ does not expose Korean fields on the catalog API).
- `id` format: `tj-<num>` (e.g., `tj-68781`).
- `source_url` is the catalog endpoint URL itself (the API is the source; there is no per-record landing page).

### Failure semantics

Single POST per crawl. Either it works or it doesn't:

- HTTP error (non-2xx, network failure, robots-disallow) → throw and abort the pipeline.
- Malformed response shape → throw and abort.
- No success-ratio gate (single request) and no per-vendor dedup needed (the API returns each `pro` exactly once).

### Captured live evidence

`packages/crawler/test/fixtures/tj-media-direct/catalog-sample.json` — trimmed snapshot of the live response (51 representative records: 31 JP-relevant + 10 Korean + 10 Latin-only, preserving the full response wrapper). Sibling `.sha256` file pins the fixture content. The full live capture was ~19 MB and is intentionally NOT committed.

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
- Blog wins on vendor-number disagreement tiebreaks.

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
| `j-pop-playlist.tistory.com` | 200 ms | ±50 ms | default crawler UA |
| `namu.wiki` | 2000 ms | ±500 ms | default crawler UA |
| `www.tjmedia.com` | 500 ms | ±100 ms | default crawler UA (legacy catalog API has no UA gating — see Source: TJ Media direct) |

Per-adapter success-ratio gate:
- BlogCrawler: ≥90% (unchanged from v1).
- TJDirectCrawler: not applicable — single POST per run; either it returns a parseable response or the pipeline aborts.
- NamuWikiCrawler: ≥85% (relaxed for JS-render fragility).

Index-page failures (e.g., the per-artist TJ search index page returning a non-2xx for a seeded artist, or the NamuWiki list page itself failing to load) remain critical: any failure aborts the crawl immediately with non-zero exit.

## Data scale and storage

Estimates:

| Source | Records (rough) |
| --- | --- |
| Blog (existing) | ~21k |
| NamuWiki (vocaloid + holo + niji + maybe anime) | ~5k–10k |
| TJ-direct (catalog API + loose-JP filter) | ~4k–7k |
| Total after dedup | ~25k–35k |

TJ-direct's value in v2 is **the catalog-number spine for the merger** (Tier A vendor-number clustering anchors on `karaoke_numbers.tj`). With the legacy catalog API, every Japanese-relevant TJ entry (~7k records, live-verified count: 6,860 on 2026-04-27) is reachable in a single POST — the v1 artist-fanout cap is retired.

`apps/web/public/data/songs.json` could grow to ~15–25 MB.

If `songs.json` crosses 30 MB, MiniSearch's client-side index may become slow on first load (parse + index build on the main thread). With v2's revised coverage estimate (~25–40k total) this is unlikely to trigger, but Phase 5 still measures the post-crawl size and load time; if either degrades noticeably, files a follow-up issue with one of these mitigations as the v3 candidate fix:
1. Lazy-load the index in a Web Worker.
2. Split `songs.json` by category and load on demand.
3. Move to a server-side search (vendor TBD) backed by a pre-built FlexSearch/MiniSearch shard.

For v2: just measure and document. Defer the actual fix.

## Open Questions

- NamuWiki's anti-bot posture is unknown until Phase 3's investigation step runs. If plain GET, raw-export, AND headless-render all fail under our honest UA, the namuwiki adapter is descoped to "blog + tj only" for v2 and Hololive/Nijisanji records populate from TJ-direct alone (tagged `[jpop]`, but without NamuWiki's Korean translations for those records).

## Resolved (formerly open)

- **TJ's Japanese-only filter form** — RESOLVED 2026-04-27 (initial recon). The public HTML site segments only by nation (`nationType=JPN`); there is no genre filter. Subsequently retired in favor of the catalog API path below.
- **TJ anti-bot posture** — RESOLVED 2026-04-27 (initial recon). The public HTML site (`/song/accompaniment_search`) gates bot UAs to a static "site under maintenance" IIS page; a Chrome UA is required there. The legacy catalog API used by v2 has NO UA gating — see next entry.
- **TJ catalog API discovery** — RESOLVED 2026-04-27 (follow-up recon). `POST https://www.tjmedia.com/legacy/api/newSongOfMonth` with body `searchYm=200001` returns the entire historical TJ catalog (~67k records) in one JSON response. No UA gating, no auth, no CSRF. This replaces the artist-fanout HTML-scrape design from the initial recon: 5× the coverage (~7k JP-relevant records vs ~5–15k via fanout) with 30× fewer requests. The v2 adapter uses this path exclusively. See Section "Source: TJ Media direct".

## Accepted scope notes

- TJ-direct ships with **loose-JP filter coverage** (~7k JP-relevant records, ~5% Chinese leak accepted as the tradeoff for catching Han-only Japanese titles). The strict alternative (hiragana/katakana only) would yield ~4k records but lose titles like `紅蓮華`. User decision documented in the loose-JP filter section.

