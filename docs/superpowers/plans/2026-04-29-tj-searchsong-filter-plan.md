# Plan — TJ-direct: replace JP-regex + Chinese denylist with `searchSong`-backed filter

**Date:** 2026-04-29
**Owner:** TJ-direct adapter (`packages/crawler/src/adapters/tj-media-direct/`)
**Depends on:** `docs/research/2026-04-29-tj-media-api-surface.md`

## Status

- **PR-1 (translit-only enrichment) — SHIPPED 2026-04-29.** Commits: `4b3ad55` (research + plan), `23f1a95` (code), `12bf4fc` (4,011-record cache pre-seed).
- **PR-2 (Option D + Option C bootstrap — full filter replacement) — SHIPPED 2026-04-29.** Commits TBD by orchestrator post-merge. Code-level changes:
  - `searchSong.ts`: added `searchSongByArtist(http, searchTxt, nationType='')` for `strType=2` artist queries; centralized `sanitizeSearchTxt` apostrophe-strip across both helpers.
  - `cache.ts`: lifted `artistNationalityMap` out of the forward-compat `extras` bag into a typed top-level field with `ArtistNationalityEntry`; added `isArtistNationalityFresh` (90-day TTL) and `isBootstrapFresh` (7-day TTL) helpers.
  - `bootstrapCharts.ts` (new): Option-C `topAndHot100?strType=3` sweep over rolling 2-year weekly windows, deduped by `pro`, ≥3-distinct-pro confidence threshold for JPN tagging. Idempotent: existing mixed-vote (`searchSong`-derived) entries are not overwritten by chart evidence.
  - `enrichArtistMap.ts` (new): per-distinct-artist `searchSong?strType=2` scan with exact-`indexSong`-match vote tally; classifies as `JPN`/`KOR`/`ENG`/`AMBIGUOUS`/`UNKNOWN`. Cache-hit short-circuit; transport errors leave the cache untouched so the next crawl retries.
  - `parser.ts`: replaced JP-regex + `CHINESE_ARTIST_DENYLIST` (gone) + rescue with the 3-path `shouldKeep` chain — per-record JPN OR per-artist JPN OR blog-whitelist rescue. `ParseOptions.cache` now required.
  - `crawler.ts`: orchestrates bulk fetch → cache load → bootstrap (if stale) → per-artist scan → parse/filter → translit pass → save. `disableEnrichment: true` skips enrichment passes for tests; the parser still consumes the on-disk cache.
  - `normalize.ts` (new shared): `normalizeForMatch` (whitespace-collapse + lowercase + NFKC, single source of truth for cache keys) + `sanitizeSearchTxt` (apostrophe-strip).
- **Pre-seed (artist scan + chart bootstrap + per-record fallback) — PENDING.** Run live with the new code, commit the resulting cache + crawl output for CI smoke.

## Post-mortem (PR-1 lessons that informed PR-2)

- **Per-record title-search miss rate: 33%** (1,950 of 5,961 fetches found no `pro` match). Plan estimated ≤20%. Lesson: title-search alone is not reliable enough to be the sole confirmation path. PR-2 elevates the **per-artist** scan to primary; per-record translit is the fallback for translit-only enrichment, not the filter authority.
- **TJ server apostrophe bug.** ≥2 records observed during the PR-1 pre-seed (`pro=68988`, `pro=68992`, IDOLiSH7 OST) trigger `resultCode=04 / 알수 없는 에러` because their titles contain ASCII apostrophes. Mitigation: strip `'` from `searchTxt` before sending. PR-2 centralizes the strip into a single `sanitizeSearchTxt` helper applied to both title and artist queries.
- **Per-artist primacy lesson.** Latin-titled Japanese acts (e.g. GRANRODEO) that title-search would miss are now caught by the artist-scan vote tally — the false-negative recovery promise of the plan. The blog rescue stays as defense-in-depth, not a primary path.


---

## Goal

Replace the current JP-script-regex + 170-entry Chinese-artist denylist + blog-whitelist rescue triple-filter with an authoritative `nationalcode == "JPN"` filter sourced from `/legacy/api/searchSong`. Eliminate the long tail of dropped Latin-titled Japanese acts and the maintenance burden of the Chinese denylist.

Side benefit: populate `title_ko` and `artist_ko` (currently always `null` from this adapter) using `sortTitleKo` and `sortSongKo` returned by the same endpoint.

---

## Current state (as of HEAD `a0c5250`)

**Bulk fetch:** one POST to `/legacy/api/newSongOfMonth?searchYm=200001` returns **67,324** records. Response **does not include `nationalcode`**.

**Filter chain in `parser.ts` (`packages/crawler/src/adapters/tj-media-direct/parser.ts:67–86`):**
1. Skip if missing `pro` / `indexTitle` / `indexSong`.
2. **Rescue:** if `pro ∈ blog-whitelist` → bypass steps 3–4.
3. **Loose-JP regex:** title OR artist must contain hiragana, katakana, or Han-without-Hangul.
4. **Chinese-artist denylist:** ~170 hand-curated CN-artist names dropped post-regex.

**Failure modes today:**
- Latin-titled Japanese acts not in the blog corpus → silently dropped (e.g. an obscure visual-kei band whose TJ entry has no kana). False negative.
- Chinese artists not in the 170-entry list → leak through. False positive (small tail, capped at ≤4 records each).
- Maintenance: every audit pass appends new entries to the denylist (parser.ts:148–323 already has 3 audit additions).

**Output:** ~5,900 J-pop records, all `categories: ['jpop']`, `title_ko: null`, `artist_ko: null`.

---

## Proposed algorithm — Option D (hybrid per-artist + per-record fallback)

### Phase 0 — bulk fetch (unchanged)

`POST /legacy/api/newSongOfMonth` body `searchYm=200001` → 67,324 records.

### Phase 1 — per-artist nationality scan (cheap, broad)

Goal: build `artistNationalityMap` so most records can be classified without a per-record API call.

```
unique_artists = set of trimmed `indexSong` values from the 67,324 records
                 ≈ 10,000–15,000 entries
```

For each unique artist `A`:

```
POST /legacy/api/searchSong
body: searchTxt=A & strType=2 (artist) & nationType= (blank)
```

Process the response (returns up to ~40 results across the 6-bucket array structure). For each returned item:

- Compute `normalizedItemArtist = normalize(item.indexSong)` and `normalizedQuery = normalize(A)`.
- If exact match — count one **vote** for `item.nationalcode`.

After all responses processed:

- If artist has **votes ≥ 1** AND **all votes agree** → assign `artist → nationalcode` confident tag.
- If votes are **mixed** (e.g. JPN + KOR) — leave artist as `AMBIGUOUS`, defer to Phase 2.
- If artist has **zero exact-match votes** (TJ search didn't return them) — leave as `UNKNOWN`, defer to Phase 2.

Persist `artistNationalityMap` to disk for reuse across crawls.

**Cost:** 10–15k calls × 500 ms (TJ host rate-limit per `HOST_CONFIG`) = **1.4–2 hours first run**, **minutes on subsequent runs** (only NEW artists scan).

### Phase 2 — per-record fallback for AMBIGUOUS / UNKNOWN artists

For each catalog record whose artist is not confidently classified by Phase 1:

```
POST /legacy/api/searchSong
body: searchTxt=<title> & strType=1 (title) & nationType= (blank)
```

Find the result whose `pro` exactly matches our record's `pro`. Use its `nationalcode` directly.

If `pro` not found among results (TJ search index miss): mark record as `UNKNOWN_NAT` and **drop** (conservative — current pipeline already drops these via the JP regex).

Persist `proEnrichmentMap[pro]` for reuse.

**Cost:** depends on Phase 1 hit-rate. Empirically expect ≤20% of records to fall through (~13k calls = ~2 hours first run, much smaller on incremental).

### Phase 3 — emission

A record is **kept** if `nationalcode === "JPN"` (whether from Phase 1 artist tag or Phase 2 per-record).

For kept records, populate the `RawSongRecord`:

| Field | Source |
|---|---|
| `title_primary` | catalog `indexTitle` (unchanged) |
| `title_ko` | `proEnrichmentMap[pro].sortTitleKo` (or `null`) |
| `artist_primary` | catalog `indexSong` (unchanged) |
| `artist_ko` | `proEnrichmentMap[pro].sortSongKo` (or `null`) |
| `karaoke_numbers.tj` | `String(pro)` |
| `categories` | `['jpop']` (unchanged at this layer; PDF ingest still adds anime/vocaloid) |

Phase 2 **already fetches** the per-record translit fields. For records confirmed JPN purely from Phase 1 (artist-level), do an enrichment pass: query `searchSong?searchTxt=<title>&strType=1&nationType=JPN`, match by `pro`, pull translit. This is the **per-record translit pass**.

**Cost of translit pass:** ~5,900 calls = ~50 min first run. Cached `proEnrichmentMap` makes incremental crawls cheap.

---

## Total runtime budget

| Phase | First run | Incremental (weekly) |
|---|---|---|
| Phase 0 (bulk) | 1 call, ~5 s | 1 call |
| Phase 1 (per-artist) | 1.4–2 h | < 5 min (only new artists) |
| Phase 2 (per-record fallback) | ~2 h | < 5 min |
| Phase 3 translit enrichment | 50 min | < 5 min |
| **Total** | **~4–5 h** | **~15 min** |

Fits the weekly cron schedule (current crawl already runs unattended in CI). First-run can be pre-seeded by running locally + committing the cache file.

---

## Caching

New file: `packages/crawler/cache/tj-search-cache.json` (gitignored) and a versioned snapshot at `apps/web/public/data/tj-search-cache.json` (tracked, like `songs.json`).

Schema:

```jsonc
{
  "version": 1,
  "generatedAt": "2026-04-29T10:00:00Z",
  "artistNationalityMap": {
    "<normalized-artist>": {
      "code": "JPN" | "KOR" | "ENG" | "AMBIGUOUS" | "UNKNOWN",
      "votes": { "JPN": 12, "KOR": 0, "ENG": 0 },
      "lastSeen": "2026-04-29T10:00:00Z"
    }
  },
  "proEnrichmentMap": {
    "68781": {
      "nationalcode": "JPN",
      "sortTitleKo": "아이도루(최애의 아이 OP)",
      "sortSongKo": "",
      "subTitle": "",
      "publishdate": "2023-05-24",
      "lastSeen": "2026-04-29T10:00:00Z"
    }
  }
}
```

**Cache invalidation:** entries older than **90 days** are re-verified on next crawl. Catalog-mutation rate is low; a hard re-verify every 90 days catches metadata drift without ballooning costs.

**Atomic writes:** mirror `scripts/ingest-anisong-pdf.py`'s pattern — write to `<file>.tmp` then `os.replace()`.

---

## Schema / merger touch points

**`@karaoke/schema`** — no changes. `title_ko` and `artist_ko` are already optional `string | null` slots.

**Merger (`packages/crawler/src/merge.ts`)** — per-field ownership:

| Field | Current | After this change |
|---|---|---|
| `title_ko` | blog wins | **blog wins if non-null, else TJ-search-translit** |
| `artist_ko` | blog wins | **blog wins if non-null, else TJ-search-translit** |

Conflict aggregate already surfaces disagreements; new `tjpdf-` ↔ `tj-` Korean-field divergences will appear in `/tmp/conflicts.json` and the crawl PR body — useful audit signal.

**Validate-songs-json gate** (`scripts/validate-songs-json.mjs`) — no changes; `title_ko`/`artist_ko` remain optional.

---

## Implementation steps

> Each step is a separate commit. Ship in this order so the test suite stays green at every step.

1. **Add `searchSong` HTTP helper** to `packages/crawler/src/adapters/tj-media-direct/searchSong.ts`. Pure function that takes `(http, searchTxt, strType, nationType)` and returns parsed result items. Unit tests: shape contract (`nationalcode`, `sortTitleKo`, `sortSongKo`); empty `searchTxt` rejection; mixed-bucket `strType=0` parsing.

2. **Add cache loader/writer** in `packages/crawler/src/adapters/tj-media-direct/cache.ts`. Pure load + atomic save. Unit tests: round-trip; corrupt-file recovery; version mismatch.

3. **Add Phase 1 (per-artist scanner)** as `enrichArtistMap()` in a new module. Takes the catalog items + existing cache + http client; returns updated `artistNationalityMap`. Logs progress every 500 artists.

4. **Add Phase 2 (per-record fallback)** as `enrichByPro()`. Takes ambiguous-artist records + cache + http; returns updated `proEnrichmentMap`.

5. **Add Phase 3 (translit pass)** as `enrichTranslit()`. Same shape; only runs on records confirmed JPN by Phase 1.

6. **Wire into `TJDirectCrawler.crawl()`**. Replace the parser's filter chain with cache lookups. Drop the rescue path's reliance on the blog corpus (the rescue was a workaround for the regex's false-negatives — no longer needed).

7. **Update `parser.ts`**: remove `isJapaneseRelevant`, `isChineseDeniedArtist`, `CHINESE_ARTIST_DENYLIST`, the `forceIncludeTjNumbers` rescue path. The parser becomes a thin "JSON → RawSongRecord" mapper.

8. **Update `normalizer.ts`**: thread the cache-derived `title_ko` / `artist_ko` through to `SongRecord`.

9. **Update merger ownership table** for `title_ko` / `artist_ko` (blog wins if non-null, else TJ-search).

10. **Update `CLAUDE.md`**: drop "Chinese-artist denylist (~170 entries)" from the Gotchas. Add the searchSong-backed flow.

11. **Update `docs/superpowers/specs/2026-04-26-karaoke-search-v2-design.md`** to reflect that NamuWiki Phase 3 is **deprecated in favor of TJ-searchSong enrichment**.

12. **Pre-seed the cache** by running locally with the full first-run pass; commit the resulting `apps/web/public/data/tj-search-cache.json` so CI never has to do a 4-hour first-run.

13. **Add CI rate-limit telemetry** — log `[tj-search] 5,234 calls, 95% cache hit, 3.2 min total` so we can spot drift.

---

## Test plan

- **Unit (vitest)**: each phase tested in isolation with fixture HTTP clients. Cover: confident-JPN artist, AMBIGUOUS artist, UNKNOWN artist, all 6 buckets in `strType=0` response, empty cache cold start, partial cache warm start, malformed cache file recovery.
- **Integration**: end-to-end run against a small slice (`searchYm=200001` with `--limit 100`) using the live API. Assert no Chinese artists in output; assert ≥80% records have non-null `title_ko`.
- **Regression**: pin 5 known-tricky artists in test fixtures (GRANRODEO, halyosy, DREAMS COME TRUE, Official髭男dism, 鈴木このみ) and assert they survive the new pipeline.
- **Conflict-aggregate spot-check**: after first crawl, audit `/tmp/conflicts.json` for unexpected `title_ko` / `artist_ko` divergences with the blog corpus.

---

## Risk and rollback

**Risks:**
- TJ search index has gaps (an obscure record's `pro` not findable by exact-title search) → record dropped. **Mitigation:** keep the blog-whitelist rescue as a final safety net (records in blog corpus auto-tagged JPN even if searchSong misses them).
- TJ revs `searchSong` shape or names → adapter throws. **Mitigation:** parser fails closed (throws), pipeline aborts, no silent data loss; alert via the existing schema-validate gate.
- Rate-limit creep — 4-hour first run on CI is risky. **Mitigation:** pre-commit the cache; CI runs ≤15 min/week.
- False positives from `nationType` blank scan — what if TJ tags some Korean songs as `JPN` (e.g. a Korean cover album)? **Mitigation:** in audit-mode, run a 1% sample comparison against the blog corpus and flag disagreements.

**Rollback:** the entire change lives behind one commit boundary. Revert to HEAD `a0c5250` restores the regex + denylist filter; the cache file is non-destructive (gitignored locally; `songs.json` regenerates from the next crawl).

---

## Better options considered

### A. Drop only the Chinese denylist; keep the JP regex (conservative)

Run the JP regex first as a fast pre-filter, then run searchSong only on records that pass. This skips the per-artist scan entirely (the regex already covers most JPN records), so total cost drops to ~5,900 calls = 50 min first run.

**Cost vs benefit:** keeps the false-negative bug (Latin-titled Japanese acts not in blog corpus still dropped). But it's the **lowest-risk** change. If you want a 1-week ship target, this is the better option.

**Recommendation:** pick this if reduced API cost or shorter ship window matters; pick the full Option D if completeness matters.

### B. Decompile the TJ Android app (`kr.tj.tjsmartplay_U`)

The consumer-facing Android app likely uses internal endpoints beyond the 3 we found — particularly a per-`pro` detail endpoint that would replace the per-record title-search with a direct lookup. Discovery cost: ~half-day APK reverse. ROI: potentially 10× speedup on Phase 2 + may surface a JPN-bulk endpoint that obviates Phase 1 entirely.

**Recommendation:** orthogonal exploration. Start Option D in parallel; if APK reverse uncovers a bulk endpoint, swap Phase 1 for it before shipping.

### C. Use `topAndHot100` strType=3 over rolling 2-year windows to bootstrap the JPN artist set

`topAndHot100` is rate-limit-light (100 records/call) and **already includes implicit JPN tagging** when filtered by `strType=3`. Iterate weekly windows backward; accumulate top-100 J-pop charts for the past 2 years (~104 weeks) = ~10,400 records WITH `nationalcode`. Use this as a free seed for the artist-nationality map.

**Cost vs benefit:** very cheap (104 calls × 500 ms = 52 seconds), but coverage is biased — only "popular" J-pop. Long-tail / catalog acts won't appear.

**Recommendation:** **layer this on top of Option D** as a free pre-warming pass. Run it first to seed `artistNationalityMap` with the most-played J-pop artists; Phase 1 only queries artists not already seeded.

### D. Probe the Philippines API surface

`newsong.tjmedia.com.ph/function/down_index.asp` is on a separate stack and may expose nationality tagging directly. 5-minute reconnaissance.

**Recommendation:** worth a probe before committing to Option D's design. If PH API has a per-record nationality endpoint with bulk semantics, it may simplify everything. **Suggested next step:** spend 30 min on PH-side reconnaissance before implementation.

### E. Keep the existing pipeline; layer `searchSong` translit-only

Don't touch the filter at all. Use `searchSong` purely to populate `title_ko`/`artist_ko` for the 5,900 records the existing filter accepts. This is the **smallest possible change** with high user-visible win (Korean transliterations show up in search).

**Recommendation:** if you want to ship a UX win **this week** without restructuring the filter, do this first; do Option D as a follow-up. The two changes are orthogonal — neither blocks the other.

---

## Recommendation

**Phase the work into two PRs:**

1. **PR-1 (this week):** Option E — translit-only enrichment. Ship `sortTitleKo` / `sortSongKo` to the frontend. ~50 minutes of API calls per crawl, no filter changes. Visible UX win, low risk.

2. **PR-2 (next 2 weeks):** Option D — full filter replacement. Pre-warm with Option C's chart bootstrap. Drop the Chinese denylist + JP regex. Replace with cache-backed searchSong filter.

If only one PR fits your appetite, ship **Option D + C bootstrap** combined. Skip Option A — it leaves the false-negative bug unaddressed and the user explicitly flagged "potential dropped Japanese songs" as a concern.

---

## Open questions

1. **Should the rescue path stay as a final fallback?** The blog corpus has been hand-validated for 21k+ J-pop records over time — even if TJ search index has a gap, the blog rescue catches it. **Recommendation:** keep the rescue. It's defense-in-depth, costs nothing, and covers the residual TJ index miss case.

2. **What happens when TJ revs `searchYm=200001` to a different "all-time" sentinel?** Detection: catalog count drops abruptly. **Recommendation:** add a guardrail in `crawler.ts` — if the catalog returns < 50,000 records, abort with a loud error (the current pipeline silently accepts whatever it gets).

3. **Should we investigate the 90-day cache TTL?** A more aggressive TTL (30 days) catches metadata drift faster but doubles API cost. Empirical answer requires a few weeks of operational data — start with 90 days, tighten if drift observed.

4. **Frontend behavior change** — populated `title_ko` and `artist_ko` will start matching searches in the existing 4-field MiniSearch index (`title_primary`, `title_ko`, `artist_primary`, `artist_ko`). Currently `title_ko` is mostly blog-corpus-sourced (~21k records). After this change, ~5,900 TJ-only records gain `title_ko`. Net effect: more matches, broader hit rate. No code change needed in the web layer.
