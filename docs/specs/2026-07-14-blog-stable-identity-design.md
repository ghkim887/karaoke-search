# Blog record stable identity — design

**Date:** 2026-07-14 · **Status:** owner-approved (this session) · **Scope owner decision:** ROADMAP item "blog-* record ids are positional and reshuffle each crawl" (HELD 2026-07-10, reopened 2026-07-14). Backward compatibility with existing `blog-*` ids is **waived** by the owner ("기존과 호환성은 생각 안 해도 돼").

## Problem

`blog-{artistIdNumber}-{rowIndex}` ids are positional (`packages/crawler/src/adapters/jpop-playlist-blog/normalizer.ts:27`): `rowIndex` is the row's position on the artist page, so any row insert/removal/reorder on the blog reassigns the whole page's id→song mapping (crawl #95 moved 137/149 ids on the Utada page). Every id-keyed consumer silently re-targets: device favorites (localStorage `karaoke-favorites:v1`), the Stage-2 title_ko cache (134 blog entries, currently defended by an id+title double-check in `rekey-llm-translation-titles.mjs`), one search hint, and the parity baseline. blog ids dominate the corpus because blog is the highest-priority merge source — 21,695 of 26,462 tracked records (82%) carry `blog-*` ids today.

## Owner decisions (2026-07-14)

| # | Decision |
|---|---|
| D1 | **Demote blog to the lowest source rank.** New `SOURCE_RANK`: `tj(1) > tjpdf(2) > joysound(3) > blog(4)`. Merged clusters take the stable vendor id; blog contributes only its fields. |
| D2 | **Drop numberless blog rows** (tj+ky+joysound all null after parsing) at normalize time. 483 rows in the current tracked corpus. Live-verified: the blog itself prints `-` in all three columns for these (song not registered in any karaoke system); they are not parser damage. |
| D3 | **Reverse lookup for claimed-but-unmatched vendor numbers.** blog rows whose claimed number has no matching vendor record feed the vendor probes (TJ) or the crawl report (JOYSOUND). |
| D4 | **Residual stable minting.** Standalone blog records (claimed numbers that resolve nowhere) get `blog-{artistIdNumber}-{vendor}-{number}` ids instead of positional ids. |
| D5 | **Favorites unchanged.** Favorites keep storing record ids; no migration for existing localStorage (compat waived — stale favorites silently dangle). Number-keyed favorites noted as a possible future hardening, out of scope. |

## Design

### 1. Merge: source-rank demotion (D1)

`packages/crawler/src/merge.ts:26-31` — reorder `SOURCE_RANK` to `tj:1, tjpdf:2, joysound:3, blog:4`. joysound stays below tj/tjpdf (preserving the existing "JOYSOUND must not displace TJ" intent, merge.ts:21-24); only blog moves, to last.

**What flips (intended):**
- `id` (`pickByPriority`, merge.ts:1552) — a blog+vendor cluster now survives under the vendor id (`tj-{n}`, `tjpdf-{n}`, `joysound-{naviGroupId}`).
- `source_url` (merge.ts:1553) — vendor page URL. Not user-visible.
- `karaoke_numbers` conflict tiebreak (`mergeKaraokeNumbers`) — on a disputed cell the vendor's own number now beats the blog's claim (vendor is authoritative for its own number space).

**What must NOT flip (invariant, replay-asserted):** every chain-driven field. `title_primary`/`artist_primary` (TITLE_ARTIST_CHAIN, tj-first, unchanged), `title_ko`/`artist_ko`/`media_context_ko`/`title_ko_source`/`title_ko_confidence` (KO_CHAIN, **blog-first**, unchanged — this is the "blog contributes its unique fields" guarantee), `title_ruby` donor pairing, `artist_aliases` union, `crawled_at` latest-wins.

Expected scale (from tracked-corpus counts): 21,199/21,695 blog rows carry a joysound number and 1,686 a TJ number, so at full-catalog recompose the vast majority of merged records flip to `joysound-*`/`tj-*` ids. Exact flip/residual counts come from the replay gate (§6).

### 2. Crawler: numberless drop + residual minting (D2, D4)

In `normalizeRawRecords` (`jpop-playlist-blog/normalizer.ts`):

1. **Drop rule:** if `karaoke_numbers` has all three of tj/ky/joysound null after cell parsing, emit no record. Count and list dropped rows in the crawl report (same observability channel as the TJ filter-decisions artifact, #134). Known caveat, accepted: a row whose ONLY number cell is dropped by the parser's multi-value/junk rules (parser.ts:80-96) falls out entirely — the report makes this visible; cell semantics stay as-is.
2. **Minting:** `blog-{artistIdNumber}-{vendor}-{number}` where `{vendor}-{number}` comes from the first non-null of **tj → ky → joysound** (claimed numbers, straight from the row). Examples: `blog-416-tj-26723`, `blog-299-joysound-677515`. The id stays within the schema id pattern `^[a-z0-9-]+-\d+$` (no schema change) and keeps the `blog` first segment, so `sourceSlug()` (merge.ts:59-62) and every `startsWith('blog-')` classifier keep working.
3. **Collision guard:** duplicate minted id within one adapter run → throw (loud failure). Current data has zero same-page same-vendor-number duplicates, so this only fires on future blog data damage.
4. The derivation lives in ONE exported function (crawler package) so normalizer, re-key tooling, and tests share it.

`artistIdNumber` stays in the id: it preserves the "row on this artist's page" record semantics, prevents cross-page collisions (a duet listed on two artist pages stays two records that then merge by number — current behavior), and keeps ids traceable to their source page.

### 3. Reverse lookup (D3)

Computed at crawl time, after merge: collect claimed vendor numbers on still-standalone blog records.

- **TJ:** feed unmatched claimed TJ numbers into the tj-media-direct probe queue (the R7 searchSong number probe). A successful probe creates the TJ record; the next merge pass unions them and the record graduates to `tj-{n}`.
- **JOYSOUND:** fullCatalog enumeration is exhaustive by construction, so an unmatched claimed JOYSOUND number means a delisted song or a blog typo — report-only (crawl report section listing them); no probe.
- **KY:** no KY source exists until R5. Claimed KY numbers stay preserved in `karaoke_numbers` and in residual ids (`blog-{aid}-ky-{n}`). When R5 lands, those records merge into `ky-*` records — a known, one-time id flip for that tiny set (0 ky-only rows today).

### 4. Sidecar re-keying (one-time, this change)

- **Stage-2 title_ko cache** (`scripts/data/llm-translations-chunk-*.json`, 134 blog-keyed entries): re-key each entry's `id` via the old→new mapping produced by the replay (§6). Entries whose record is dropped by D2 (numberless) are pruned — their songs no longer exist in the corpus. The cache stays id-keyed with its existing title guard; ids are simply stable from now on.
- **`data/search-hints.jsonl`:** 1 blog-keyed hint (`blog-338-10`) — re-key via the same mapping (or prune if its record is dropped).
- **Merge unit tests** (`packages/crawler/test/merge.test.ts`, 43 hand-written blog ids): update inputs to the new minting shape and expected winners to the new rank order.
- **Parity baseline** (`apps/web/src/lib/__snapshots__/search-parity.baseline.json`, 342 blog ids): NOT regenerated in this change — the tracked corpus (a crawl artifact) is frozen while the crawl is disabled, so the baseline still matches it. It regenerates with the first resumed-crawl PR, per the existing baseline-regeneration policy.
- **Not affected (already number-keyed):** reviewedMergePairs, drop-lists, smoke fixture `search-parity-smoke.json`, title-ko-manual-fixes (0 blog entries).

### 5. Serving / web

No code changes. Worker SQL, Pages Functions proxy, MiniSearch, and favorites all treat `id` as opaque; SQLite PK uniqueness plus `validateSongCorpus` catch any collision loudly at build. Favorites become stable as a consequence of stable ids (D5).

## 6. Verification

- **CI mirror gates** (fixed set): biome / -r typecheck / -r test / -r build / knip.
- **Unit:** merge tests re-pinned to new rank + minting; drop-rule and minting-collision tests; derivation-function tests.
- **v22 full replay** (NAS decision-log + committed crawl outputs, same methodology as PR #142's 352,290-row replay), asserting:
  1. id flip census: merged clusters take vendor ids; report counts per family.
  2. residual standalone `blog-*` count (expected: small — claimed-but-unmatched only) with the list attached.
  3. numberless drop count matches the corpus census (483 on current data).
  4. zero id collisions corpus-wide.
  5. **field-flip zero check:** for every surviving record, all fields except `id`/`source_url`/disputed number cells are byte-identical to the current-code replay output.
  6. old→new id mapping emitted as the §4 re-key input.
- Replay outputs are verification artifacts (kept on NAS alongside the run), not committed corpus changes.

## Rollout

This change ships as code + tests + sidecar re-keys only. The tracked corpus and parity baseline regenerate at the first resumed crawl; serving (v22) is untouched until the owner's crawl-resume/1.0 declaration. Effect at resume: corpus loses numberless rows (−483 on current data), merged records surface under vendor ids, TJ reverse probes enrich coverage.

## Out of scope (recorded, not planned)

- **Numberless songs as a product question:** these are songs singable nowhere; they have been shown in search results until now. D2 removes them. If a "discography completeness" view is ever wanted, that's a separate product decision.
- **Title-based reverse probe** (search vendors by title+artist for numberless/delisted songs to catch late registrations): low value vs false-match risk; revisit only if requested.
- **Number-keyed favorites** (store `tj:26723`-style keys + load-time resolver): would decouple favorites from any future id decision; redundant while ids are number-derived. Independent follow-up if wanted.
- **Audit semantics note:** `scripts/audit-crawler-quality.mjs` classifies records by `startsWith('blog-')`; after resume, post-merge `blog-*` counts shrink to residual standalones only. Expected, no code change.
