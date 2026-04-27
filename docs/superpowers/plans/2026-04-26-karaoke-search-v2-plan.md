# Karaoke Search — v2 Implementation Plan

Source spec: `docs/superpowers/specs/2026-04-26-karaoke-search-v2-design.md` (locked).
v1 spec referenced: `docs/superpowers/specs/2026-04-26-karaoke-search-design.md` (shared conventions: `Crawler` interface, `normalize()`, operational discipline). v1's merge algorithm is REPLACED in v2 — see Phase 0.5 below and spec Section "Dedup & Merge Algorithm (v2 redesign)".
Repo: pnpm + TypeScript monorepo on `main` at HEAD `3b5a735`. v1 ships ~21,259 records across `jpop` + `vocaloid` from the j-pop-playlist Tistory blog.

## Required GitHub repository secrets

Same as v1 — `GITHUB_TOKEN` (provided by Actions) only. No new secrets in v2.

## Phase 0 — Schema migration: drop `proseka`

- **Goal**: Update the `Category` union and JSON Schema enum to the v2 set (drop unused `proseka`) without breaking any existing record on disk.
- **History**: Phase 0 originally also added `vtuber` to the union. That addition was reverted in the same commit set after the v2 design simplified — Hololive/Nijisanji records now emit `[jpop]` per TJ Media's catalog vocabulary, so no `vtuber` category is needed. The pre-migration check now also asserts that no live record uses `vtuber` (none do — the addition never reached production data).
- **Deliverables**:
  - `packages/schema/src/index.ts` — `Category` union changes from `"jpop" | "vocaloid" | "anime" | "proseka"` to `"jpop" | "vocaloid" | "anime"`.
  - `packages/schema/src/index.ts` — JSON Schema `categories.items.enum` changes to `["jpop", "vocaloid", "anime"]`.
  - `packages/schema/src/index.test.ts` — update enum-coverage tests to reference the v2 three-value union; assert that BOTH `proseka` AND `vtuber` are rejected, and that all three live values (`jpop`, `vocaloid`, `anime`) are accepted.
  - Pre-migration data check: a one-off `node -e` invocation, run before edits, that asserts no live record uses `proseka` or `vtuber`. If any do, abort the phase and escalate.
- **Implementation notes**:
  - Run the pre-migration check first:
    ```bash
    node -e "const r=require('./apps/web/public/data/songs.json'); const bad=r.filter(x=>x.categories.includes('proseka')||x.categories.includes('vtuber')); console.log('proseka+vtuber records:', bad.length); process.exit(bad.length===0?0:1)"
    ```
    Exit 0 confirms migration is safe. Exit 1 means a record needs hand-fixing — escalate.
  - The schema's `id` regex, `karaoke_numbers` shape, and `release_year` bounds are unchanged.
  - Confirm `apps/web/src/components/CategoryChips.tsx` did not hardcode `proseka` anywhere; if it did, that fix lands in Phase 4, not here.
- **Verification**:
  - `pnpm --filter @karaoke/schema test` exits 0 with the updated enum tests passing.
  - `pnpm --filter @karaoke/schema exec tsc --noEmit` exits 0.
  - Repo-wide grep: `grep -rn 'proseka\|vtuber' packages/ apps/ --include='*.ts' --include='*.tsx' --include='*.json'` returns zero hits except in commit message scaffolding or this plan file.
  - `node -e "const {validateSongRecord}=require('./packages/schema/dist/index.js'); ..."` succeeds against every record in the existing `apps/web/public/data/songs.json`.
- **Review pass** (`code-reviewer`):
  - Confirm both the TS union AND the JSON Schema enum changed in lockstep.
  - Confirm the pre-migration check command and its output were captured in the commit body.
  - Confirm no test still references `proseka` or `vtuber` as accepted values.
  - Confirm the negative tests for `proseka` and `vtuber` are real Ajv rejections (not just TS compile-error checks).
- **Commit message**:
  ```
  feat(schema): drop proseka from Category union

  Trim the unused proseka value from the v1 union; v2 keeps the three
  populated categories (jpop, vocaloid, anime). Verified zero live
  records use proseka before the swap. JSON Schema enum updated in
  lockstep.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- **Estimated agent time**: 25 min.

## Phase 0.5 — Merger rewrite (two-tier match key + per-field ownership)

- **Goal**: Replace v1's flat registration-order dedup with v2's two-tier match key (Tier A vendor-number union-find + Tier B fuzzy title+artist fallback) and per-field ownership table. See spec Section "Dedup & Merge Algorithm (v2 redesign)" for the locked design.
- **Deliverables**:
  - Rewrite `packages/crawler/src/merge.ts` (`mergeRecords`):
    - Step 1: collect all `SongRecord[]` from all adapters (no per-adapter dedup beforehand).
    - Step 2: cluster — Tier A first (union-find over non-null `karaoke_numbers.tj` / `.ky` / `.joysound`, per-vendor), Tier B for unclustered residuals (group by normalized `(title_primary, artist_primary)` key using the existing `normalize()` from `packages/crawler/src/normalize.ts` — do NOT introduce a more aggressive normalizer).
    - Step 3: per-cluster apply the per-field ownership table from the spec. Emit one `SongRecord` per cluster.
    - Conflict logging: when records cluster via Tier B but disagree on a vendor field that wasn't the clustering key, log a warning (structured object: `{ cluster_key, field, values, winner }`). Return aggregate counts + a sample of N=10 alongside the merged records (extends `mergeRecords`'s return shape, OR exposes a sibling getter — pick one and document).
  - Wire the conflict aggregate into the crawl GitHub-Actions workflow's PR-body summary (extend the existing summary block in `.github/workflows/` — quantity-only summary plus the N=10 sample, NOT every conflict).
  - Hand-crafted fixture test at `packages/crawler/test/merge.test.ts` (or extend existing) covering all of:
    1. Two-source merge by shared TJ# (TJ-direct + blog).
    2. Three-source merge by shared TJ# (TJ-direct + blog + namuwiki).
    3. Blog-only island (no vendor number on the row → no cluster, stands alone with `karaoke_numbers.tj=null`).
    4. Blog→TJ fuzzy match (Tier B; blog row has no TJ# but matches a TJ row by normalized `(title, artist)`).
    5. Vendor-number conflict (Tier B cluster, sources disagree on a vendor field, highest-priority source wins, warning logged — assert the warning was emitted).
    6. Multi-vendor merge (blog has `tj+ky`, namuwiki has `ky+joysound`; all three records vendor-number-overlap → one merged record with all three vendor fields populated).
    7. TJ-less Vocaloid (only namuwiki contributes, becomes a standalone record with `title_primary` from namuwiki — verifies graceful degradation of the per-field ownership table when TJ-direct and blog are absent).
- **Implementation notes**:
  - `feat.` / `(movie ver.)` / `[Acoustic]` are NOT stripped by the Tier B normalizer. The current `normalize()` (lowercase + collapse whitespace) is the spec'd Tier B key. Do not extend it.
  - Tier A is per-vendor: TJ #100 and KY #100 are unrelated and must NOT cluster. Implement as three separate index maps keyed by vendor.
  - Per-field ownership uses fallback chains, not a flat priority. `release_year` chain is `blog → namuwiki → TJ-direct`; `title_primary` chain is `TJ-direct → blog → namuwiki`; etc. — see spec table.
  - The flat priority `blog > namuwiki > TJ-direct` is retained ONLY for tiebreaking on the same vendor's number. Encode it as a single source-rank constant in the merger; do NOT scatter the order across files.
  - Merge determinism: re-running the merger on the same input record array twice MUST produce byte-identical output. Sort cluster outputs deterministically (by `id` after assignment, or by `karaoke_numbers.tj ?? '￿'` then normalized title — pick one and document). Phase 5's smoke test will verify this end-to-end.
- **Verification**:
  - `pnpm --filter @karaoke/crawler test test/merge.test.ts` exits 0; all 7 fixture cases pass.
  - The conflict-logging assertion in case 5 confirms a warning was emitted (count exactly 1 for that scenario).
  - `pnpm --filter @karaoke/crawler exec tsc --noEmit` exits 0.
  - Determinism micro-check inside the test file: build a fixed input array, call `mergeRecords` twice, deep-equal the two outputs (asserts cluster ordering is stable).
  - Backward-compat check: re-run the existing v1 crawl pipeline against the live blog adapter only (`pnpm --filter @karaoke/crawler start --source jpop-playlist-blog --limit 5 --out /tmp/v2-merge-smoke.json`) and confirm output record count and field shapes match a baseline snapshot — single-source pipeline must still work end-to-end with the rewritten merger.
- **Review pass** (`code-reviewer`):
  - Confirm the merger implements Tier A as **per-vendor** union-find (not a single combined map). Cite line numbers.
  - Confirm Tier B uses the existing `normalize()` and does NOT strip `feat.` / `(...)` / `[...]` suffixes. Read the diff against `packages/crawler/src/normalize.ts` and verify no new normalizer was added.
  - Confirm the per-field ownership table is implemented as fallback chains per field, not a single flat priority order.
  - Confirm conflict warnings are emitted for the vendor-number-disagreement-on-Tier-B case AND the aggregate is exposed for the PR-body summary wire-up.
  - Confirm cluster output ordering is deterministic — explain how (which key, ascending or descending).
  - Confirm all 7 fixture cases listed in the deliverables exist in `merge.test.ts` and each is named after the scenario.
- **Commit message**:
  ```
  feat(crawler): rewrite mergeRecords with two-tier match key

  Replace v1's flat registration-order dedup with v2's tiered scheme:
  Tier A unions records sharing a vendor number (per-vendor: tj/ky/joy);
  Tier B falls back to normalized (title, artist) for residuals.
  Per-field ownership table replaces the flat blog>namu>tj precedence.
  Tier B cross-source conflicts on a vendor field are logged and
  aggregated for the crawl PR body. 7 fixture tests cover the locked
  design's worked examples.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- **Estimated agent time**: 120 min.

## Phase 2 — `tj-media-direct` adapter

- **Goal**: Implement the TJ Media direct adapter (parser + crawler + normalizer) against committed HTML fixtures, then wire it into the registry as the lowest-priority source.
- **Deliverables**:
  - Pre-implementation investigation step:
    - Capture two live HTML pages per Japanese-language genre (J-POP, 애니메이션, 보컬로이드) using `curl -A "karaoke-search-crawler/0.1 (+https://github.com/ghkim887-karaoke-search)" "<url>" > fixture.html`.
    - Document in `packages/crawler/src/adapters/tj-media-direct/PARSER_CONTRACT.md` (a sibling spec, NOT a top-level docs file): the URL pattern, the form/query param names, the table selector, the per-row column order and count, and the missing-number convention.
  - `packages/crawler/src/adapters/tj-media-direct/parser.ts` — `parseListingPage(html: string, sourceUrl: string, genre: TJGenre): RawSongRecord[]`. Uses cheerio per the pinned selectors.
  - `packages/crawler/src/adapters/tj-media-direct/crawler.ts` — paginates per genre, calls parser, threads results through normalizer. Handles pagination cursor and "two empties to be safe" terminator.
  - `packages/crawler/src/adapters/tj-media-direct/normalizer.ts` — maps `RawSongRecord` → `SongRecord`. Genre → category mapping per spec Section "Source: TJ Media direct" — TJ's `J-POP` → `[jpop]`, `애니메이션` → `[anime]`, `보컬로이드` → `[vocaloid]`. No per-record artist roster lookup.
  - `packages/crawler/src/adapters/index.ts` — append `TJDirectCrawler` instance to the `adapters` array (lowest priority, after `BlogCrawler` and `NamuWikiCrawler` once the latter lands in Phase 3 — for now append it last; Phase 3 inserts `NamuWikiCrawler` between blog and tj).
  - `packages/crawler/test/fixtures/tj-media-direct/jpop-page-1.html`, `anime-page-1.html`, `vocaloid-page-1.html` — committed snapshots, with sibling `.sha256` files.
  - `packages/crawler/test/adapters/tj-media-direct/parser.test.ts` — fixture-based parser tests.
  - `packages/crawler/test/adapters/tj-media-direct/normalizer.test.ts` — `RawSongRecord` → `SongRecord` mapping tests covering all three genre→category mappings.
- **Implementation notes**:
  - URL and param shape MUST be re-confirmed from a live fetch in the investigation step before any code is written. Do NOT invent URLs from prior knowledge.
  - The `TJGenre` type is a local string union (e.g., `"jpop" | "anime" | "vocaloid"`) used only as a parser argument; it is NOT exported from `@karaoke/schema`.
  - Per-host rate override: TJ uses the default 1s/±0.5s. If the http client lacks a per-host override, add it as a small surface-area patch in this phase (`http.ts` accepts `{ minIntervalMs?: number }` per host).
  - `id` assignment: `tj-${tj_song_number}` (e.g., `tj-28311`). The schema's `id` regex `^[a-z0-9-]+-\d+$` allows this.
  - `release_year` extraction: only set when a 4-digit year unambiguously appears in a dedicated column. Otherwise `null`.
  - Robots.txt re-verification: log the resolved `robots-parser` decision once per host on first request to make the run-log auditable.
- **Verification**:
  - `pnpm --filter @karaoke/crawler test test/adapters/tj-media-direct/parser.test.ts` passes with ≥10 records extracted from each genre fixture; every record has `karaoke_numbers.tj` non-null and digit-only.
  - `pnpm --filter @karaoke/crawler test test/adapters/tj-media-direct/normalizer.test.ts` passes; assertions:
    - `id` matches `^tj-\d+$`.
    - Records from `J-POP` fixture have `categories: ["jpop"]`.
    - Records from `애니메이션` fixture have `["anime"]`.
    - Records from `보컬로이드` fixture have `["vocaloid"]`.
    - All records have `title_ko === null && artist_ko === null`.
  - `pnpm --filter @karaoke/crawler exec tsc --noEmit` exits 0.
- **Review pass** (`code-reviewer`):
  - Confirm `PARSER_CONTRACT.md` documents the live URL pattern and param names captured during the investigation step (no invented URLs).
  - Confirm the parser uses cheerio (not regex) and pins the table selector.
  - Confirm pagination terminator is "two consecutive empty pages", not "first empty page".
  - Confirm the genre→category mapping is exactly `J-POP → [jpop]`, `애니메이션 → [anime]`, `보컬로이드 → [vocaloid]` with no roster-based post-processing.
  - Confirm the per-host rate-limit override is wired through `http.ts` if it was missing in v1.
  - Confirm robots.txt is honored before the first request to `www.tjmedia.com` (capture in commit body whether the live `robots.txt` permits the path).
- **Commit message**:
  ```
  feat(crawler): add tj-media-direct adapter

  Implement parser, crawler, and normalizer for TJ Media's live song
  search. Cover J-POP / 애니메이션 / 보컬로이드 genres with committed
  HTML fixtures. Categories follow TJ's own genre vocabulary; Korean
  fields stay null per spec.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- **Estimated agent time**: 130 min.

## Phase 3 — `namuwiki` adapter

- **Goal**: Implement the NamuWiki adapter (parser + crawler + normalizer) against committed HTML fixtures for the Vocaloid + Hololive + Nijisanji list pages, then wire it between blog and tj in registration order.
- **Deliverables**:
  - Pre-implementation investigation step (`packages/crawler/src/adapters/namuwiki/RENDER_STRATEGY.md`):
    - Try strategy 1 (plain GET with honest UA) for each target page; capture status code and whether the table HTML is present in the response body.
    - If 1 fails, try strategy 2 (raw-export endpoint, e.g., `https://namu.wiki/raw/<page>` or `?action=raw`); capture result.
    - If 2 fails, try strategy 3 (Playwright headless render); capture result.
    - Pick the simplest strategy that yields a parseable table for ALL three pages, document the choice and rationale, and pin it in the adapter.
  - `packages/crawler/src/adapters/namuwiki/parser.ts` — exports `parseVocaloidList(html, sourceUrl): RawSongRecord[]`, `parseHololiveList(...)`, `parseNijisanjiList(...)`. Each variant pins the column order/count for that page.
  - `packages/crawler/src/adapters/namuwiki/crawler.ts` — fetches the three target URLs (using the chosen render strategy), threads each through its parser + normalizer.
  - `packages/crawler/src/adapters/namuwiki/normalizer.ts` — maps `RawSongRecord` → `SongRecord`. Categories assigned per source page (`vocaloid` for the Vocaloid list, `jpop` for the Hololive JP list, `jpop` for the Nijisanji JP list — Hololive/Nijisanji songs are J-POP per TJ Media's catalog vocabulary). `id` assigned as `namu-<slugified-page-anchor>-<row-index>`.
  - `packages/crawler/src/adapters/index.ts` — insert `NamuWikiCrawler` between `BlogCrawler` and `TJDirectCrawler` so the final registration order is `[BlogCrawler, NamuWikiCrawler, TJDirectCrawler]`.
  - `packages/crawler/test/fixtures/namuwiki/vocaloid.html`, `hololive.html`, `nijisanji.html` — committed snapshots with `.sha256` siblings.
  - `packages/crawler/test/adapters/namuwiki/parser.test.ts` — fixture-based parser tests, one block per page.
  - `packages/crawler/test/adapters/namuwiki/normalizer.test.ts` — `RawSongRecord` → `SongRecord` mapping tests.
- **Implementation notes**:
  - URLs MUST be live-verified during the investigation step before any code is written. Spec marks them `[verify before Phase 3]`.
  - Anime list page: only included if the investigation finds a maintained list page. Otherwise descope and document — `anime` category populates from TJ-direct alone.
  - Per-host rate override: `namu.wiki` gets `{ minIntervalMs: 2000, jitterMs: 500 }` in `http.ts`'s host config table.
  - `title_primary` extraction: from the Japanese-title column, take the first contiguous run of characters matching `/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u` (and adjacent ASCII letters/digits if part of a mixed-script title like `Stellar Stellar`). Trim and strip surrounding parens/notes.
  - `title_ko` extraction: from the Korean-title column, take the trimmed text content. Empty cells → `null` (not the empty string).
  - `karaoke_numbers.tj` / `.ky` extraction: same hyphen/em-dash → `null` convention as the blog adapter (covers `-`, `—`, `–`, `&nbsp;`-only, whitespace-only).
  - `karaoke_numbers.joysound`: always `null`. NamuWiki rarely lists JOYSOUND.
  - JS-rendering note: if Playwright is the chosen strategy, the adapter dynamically imports `playwright` so users who only run the crawler with non-namuwiki sources don't need browsers installed. Wrap the import in a try/catch with a clear "install playwright with `pnpm exec playwright install chromium`" error.
  - Success-ratio gate per spec: ≥85% of fetched pages parse successfully.
- **Verification**:
  - `pnpm --filter @karaoke/crawler test test/adapters/namuwiki/parser.test.ts` passes; per-page assertions:
    - Vocaloid fixture yields ≥30 records; ≥80% have non-null `title_primary` AND non-null `title_ko`.
    - Hololive fixture yields ≥20 records; every record has `categories.includes("jpop")` after normalization.
    - Nijisanji fixture yields ≥20 records; same `jpop` assertion.
  - `pnpm --filter @karaoke/crawler test test/adapters/namuwiki/normalizer.test.ts` passes; assertions:
    - `id` matches `^namu-[a-z0-9-]+-\d+$`.
    - Hololive/Nijisanji records have `categories: ["jpop"]` exactly (before merger union with other sources).
    - Vocaloid records have `categories: ["vocaloid"]` exactly.
    - At least one record has both `karaoke_numbers.tj` and `karaoke_numbers.ky` non-null.
    - All records have `karaoke_numbers.joysound === null`.
  - `pnpm --filter @karaoke/crawler exec tsc --noEmit` exits 0.
  - Final registry order check: `node -e "const {adapters}=require('./packages/crawler/dist/adapters/index.js'); console.log(adapters.map(a=>a.name))"` prints `["jpop-playlist-blog", "namuwiki", "tj-media-direct"]`.
- **Review pass** (`code-reviewer`):
  - Confirm `RENDER_STRATEGY.md` documents the live investigation results and the chosen strategy for each page.
  - Confirm Playwright (if used) is dynamically imported, not a top-level import.
  - Confirm `namu.wiki` per-host rate override is wired and observed (log-line proves it).
  - Confirm registry order is exactly `[blog, namuwiki, tj]` after this phase.
  - Confirm if anime list page was descoped, the descope decision is captured in the commit body and `anime` continues to populate from TJ-direct.
  - Confirm the parser does NOT include the romaji column anywhere in its output.
- **Commit message**:
  ```
  feat(crawler): add namuwiki adapter for vocaloid + holo/niji lists

  Implement parser, crawler, and normalizer for NamuWiki's per-agency
  karaoke list pages. Cover Vocaloid, Hololive JP, Nijisanji JP with
  committed HTML fixtures. Hololive/Nijisanji records emit [jpop] per
  TJ Media's catalog vocabulary. Per-host 2s rate cap. Inserted between
  blog and tj-media-direct in registration order.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- **Estimated agent time**: 150 min.

## Phase 4 — Frontend featured-artist update

- **Goal**: Seed `featured.ts` with real anime artists from the v2 corpus. Chip set stays at three (`J-POP / Vocaloid / Anime`) — no UI surface change.
- **Deliverables**:
  - `apps/web/src/components/CategoryChips.tsx` — confirm chip-list constant is `["jpop", "vocaloid", "anime"]` (already correct in v1). Remove any lingering `proseka` reference if present.
  - `apps/web/src/data/featured.ts` — type stays at `{ jpop: string[]; vocaloid: string[]; anime: string[] }`. Each list contains exactly 6 artist names that exist in the v2 `apps/web/public/data/songs.json`. v1 left `anime` empty; v2 fills it from the new TJ-direct corpus.
  - `apps/web/src/lib/search.test.ts` — extend existing AND-filter coverage for the now-populated `anime` category: a record with `categories: ["jpop"]` does NOT match an `anime`-selected query; a record with `["anime", "jpop"]` matches both an `anime`-only and an `anime+jpop` selection.
  - Optional: `apps/web/test/featured.test.ts` — Vitest test that loads `featured.ts` and `apps/web/public/data/songs.json` (or the sample fixture) and asserts every featured artist name appears as `artist_primary` in at least one record.
- **Implementation notes**:
  - The chip-list constant lives in a single source file. Do NOT duplicate it across components.
  - Featured-artist names: pick from real v2 records (selection happens AFTER Phase 5's live crawl — sequence Phase 5 first if needed; for this phase, use the sample-fixture artists that will be expanded in Phase 5).
  - Result-cap and 150ms debounce are unchanged from v1.
  - Bundle-size guard: featured.ts gains six string entries (anime); the existing 50 KB gzipped guard from v1 Phase 9 remains the gate.
- **Verification**:
  - `pnpm --filter @karaoke/web test` exits 0; the extended AND-filter test passes the new `anime` branches.
  - `pnpm --filter @karaoke/web build` exits 0.
  - Manual: `pnpm --filter @karaoke/web dev`, click the `anime` chip; results filter to anime-tagged records only (now non-empty in v2).
  - If `featured.test.ts` is included, it exits 0 with all 18 featured names matching at least one record.
- **Review pass** (`code-reviewer`):
  - Confirm `CategoryChips.tsx` renders three chips in the order `[jpop, vocaloid, anime]`.
  - Confirm AND-filter logic still uses `selectedCategories.every(c => record.categories.includes(c))`.
  - Confirm `featured.ts`'s `anime` list contains 6 real artists found in `songs.json`.
  - Confirm no `proseka` or `vtuber` reference remains anywhere in `apps/web/src`.
  - Confirm the `featured.test.ts` (if added) reads from a stable path and would catch a typo'd artist name.
- **Commit message**:
  ```
  feat(web): seed anime featured artists from v2 corpus

  featured.ts gains 6 anime artists pulled from the v2 crawl. Chip set
  stays at [jpop, vocaloid, anime]. AND-filter test extended to cover
  the now-populated anime category.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- **Estimated agent time**: 35 min.

## Phase 5 — Combined live crawl + sample fixture refresh

- **Goal**: Run the full v2 pipeline (blog + namuwiki + tj-media-direct), measure the resulting `songs.json`, and refresh the sample fixture to span all three categories.
- **Deliverables**:
  - Updated `apps/web/public/data/songs.json` from a real v2 crawl (re-tracked or gitignored per size — see notes).
  - Updated `packages/crawler/test/fixtures/songs.sample.json` — 12–16 anonymized records covering ≥1 `jpop`, ≥1 `vocaloid`, ≥1 `anime`, ≥1 multi-category (e.g., `["anime", "jpop"]` or `["jpop", "vocaloid"]`). "Anonymized" same as v1: real records with `id` rewritten to `sample-N` and `source_url` rewritten to a stable spec-example URL.
  - `packages/crawler/test/fixtures/sample.test.ts` — extend to assert at least one record per v2 category and at least one multi-category record.
  - Run-log capture (in commit body): per-adapter record counts, success ratios, total runtime, final `songs.json` size in bytes and after gzip.
  - If `songs.json` exceeds 30 MB or page load degrades noticeably (>2s on 4G simulation), file a follow-up issue titled `data: songs.json size mitigation (v3)` listing the three mitigation candidates from spec Section "Data scale and storage". Proceed.
- **Implementation notes**:
  - Run command: `pnpm --filter @karaoke/crawler start -- --out apps/web/public/data/songs.json` (no `--source` flag → all registered adapters; no `--limit` → full crawl).
  - Pipeline still validates every record against `songRecordSchema` before writing; failures abort the run.
  - Sample fixture is hand-curated from the live output, NOT auto-generated. Pick records that exercise edge cases (multi-category, null Korean fields, full TJ/KY/JOY trio).
  - Post-crawl size check: `wc -c apps/web/public/data/songs.json` and `gzip -c apps/web/public/data/songs.json | wc -c`; record both in the commit body.
  - If the file crosses 30 MB raw, the follow-up issue is filed but `songs.json` is committed regardless (size-mitigation is v3 work, not v2 scope).
- **Verification**:
  - Post-crawl record count: `node -e "console.log(require('./apps/web/public/data/songs.json').length)"` prints a number ≥30000.
  - Per-category counts: a small node one-liner prints non-zero counts for each of `jpop`, `vocaloid`, `anime`.
  - Sample fixture: `pnpm --filter @karaoke/crawler test test/fixtures/sample.test.ts` exits 0; record count ∈ [12, 16].
  - End-to-end: `pnpm --filter @karaoke/web build` exits 0 and the existing 50 KB gzipped JS bundle guard still passes.
  - Manual: `pnpm --filter @karaoke/web dev`, type a Hololive talent name (e.g., `星街すいせい`); ≥1 result with `categories.includes("jpop")`.
  - Per-adapter success ratios captured in run log: BlogCrawler ≥90%, TJDirectCrawler ≥90%, NamuWikiCrawler ≥85%.
  - Merge-determinism smoke test: stash the unmerged per-adapter record arrays from this run (or re-load them from the cached HTTP responses), then call the rewritten `mergeRecords` (from Phase 0.5) on the same input record set TWICE in the same process. The two output arrays must be byte-identical (deep-equal AND `JSON.stringify`-equal). Capture the assertion result in the commit body. Failure aborts the phase — escalate, do NOT relax the assertion.
- **Review pass** (`code-reviewer`):
  - Confirm the live `songs.json` was actually produced by the crawler (not hand-edited): re-running with cached pages should produce identical output bar `crawled_at`.
  - Confirm the sample fixture covers all three v2 categories AND a multi-category record.
  - Confirm per-adapter success ratios meet their gates (cite the run-log lines in the review comment).
  - Confirm the size mitigation follow-up issue is filed when applicable, and the commit body includes the size measurements regardless.
- **Commit message**:
  ```
  feat(crawler): produce v2 songs.json and refresh sample fixture

  Run blog + namuwiki + tj-media-direct end-to-end. Update songs.json
  with the v2 corpus (records, size, per-category counts in body).
  Sample fixture grows to 12-16 records spanning jpop/vocaloid/anime
  plus a multi-category record. Schema validation passes for every
  record.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- **Estimated agent time**: 75 min (mostly waiting on crawler).

## Phase 6 — Spec / plan / CLAUDE.md / README sync

- **Goal**: Make the v1 docs forward-compatible with v2's reality and surface the v2 changes in CLAUDE.md and README.
- **Deliverables**:
  - `docs/superpowers/specs/2026-04-26-karaoke-search-design.md` — append a top-of-file note: `> v2 supersedes the Category union (`proseka` removed; final set is `jpop | vocaloid | anime`), adds tj-media-direct + namuwiki adapters, and replaces the dedup/merge algorithm with a two-tier match key + per-field ownership table. See \`...-v2-design.md\` for v2 deltas.` Do NOT rewrite v1 prose.
  - `docs/superpowers/plans/2026-04-26-karaoke-search-plan.md` — same kind of forward-pointer note (mention the merger rewrite alongside the new adapters).
  - `CLAUDE.md` — Module Map updates (if present): list the two new adapter directories under `packages/crawler/src/adapters/`. Gotchas: NamuWiki's render strategy + per-host 2s rate cap; NamuWiki Hololive/Nijisanji pages emit `[jpop]` (TJ Media's catalog files them under J-POP); TJ-direct null-Korean records; merger's two-tier match key (Tier A vendor-number, Tier B fuzzy title+artist) — note that `feat.` / `(...)` / `[...]` suffixes are NOT stripped by Tier B by design.
  - `README.md` — feature list reflects 3-category coverage (`jpop`, `vocaloid`, `anime`). Source list reflects three adapters.
- **Implementation notes**:
  - The forward-pointer notes are minimal; they exist so a reader who lands on the v1 doc finds v2.
  - Do not edit the body of the v1 spec or v1 plan. Only the top-of-file note.
  - CLAUDE.md edits: only the Module Map and Gotchas sections. Keep edits surgical.
  - README edits: feature bullets only. Don't restructure.
- **Verification**:
  - `grep -n 'v2 supersedes' docs/superpowers/specs/2026-04-26-karaoke-search-design.md` finds the forward-pointer.
  - `grep -n 'v2 supersedes' docs/superpowers/plans/2026-04-26-karaoke-search-plan.md` finds the forward-pointer.
  - `grep -n 'anime' README.md` finds the v2 feature mention (`anime` is now populated).
  - No source code touched in this phase: `git diff --stat` shows only `*.md` files.
- **Review pass** (`code-reviewer`):
  - Confirm the forward-pointer notes are top-of-file and do NOT alter v1 prose.
  - Confirm CLAUDE.md edits are scoped to Module Map + Gotchas.
  - Confirm README's category list mentions all three populated v2 categories.
- **Commit message**:
  ```
  docs: forward-point v1 docs at v2 and refresh CLAUDE.md + README

  Append v2-supersedes notes to v1 spec and plan. Update CLAUDE.md
  Module Map / Gotchas with namuwiki + tj-media-direct details. Update
  README's feature list to reflect 3-category coverage with anime now
  populated.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- **Estimated agent time**: 25 min.

## Open Questions

- Should the namuwiki adapter ship a fourth page parser for `애니메이션_노래방_수록_목록` (or similar) if the investigation finds a maintained anime list? Spec defaults to "no — leave anime to TJ" if the page is missing or stale; user decision needed if a maintained page exists but is sparse (e.g., <500 records).
- Should `featured.ts` move from a hand-maintained file to an auto-generated picked-from-data file? v2 keeps it hand-maintained (matches v1); raise as a v3 candidate if maintenance burden grows.
- If `songs.json` exceeds 30 MB, which mitigation does the user want for v3 (Web Worker, category sharding, server-side search)? Capture the choice when the follow-up issue is filed in Phase 5.
