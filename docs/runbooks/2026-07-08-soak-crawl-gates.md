# Runbook — Soak the crawl backlog gates (merge-pairs / ruby / classifier)

- **Date:** 2026-07-08
- **Why:** The three "crawl-soaking gates" in HANDOFF (reviewedMergePairs E191/F161 applied, crawler ruby persistence, classifier Phase-1 golden first-soak) all require **JOYSOUND full-catalog data**. The weekly `crawl.yml` (blog+TJ only) cannot soak them. They soak only during a **JOYSOUND full-catalog sweep → `build-joysound-candidate` recompose (v22)**.
- **Blocker that forced this runbook (2026-07-08):** the only decision-log on the NAS (`runs/data-2026-06-14-artist-ko-ruby-full-sweep/joysound-detail-decision-log.jsonl`, 146 MB) is a *different* sweep — it fails `build-joysound-candidate`'s checkpoint-1 guard (missing suspect selSongNo `148140/153397/735357`). The correct June-10 raw sweep log was local `.tmp_review` scratch and is gone. So a soak needs a **fresh sweep** (below) to regenerate a valid decision-log.

## ⚠️ 2026-07-09 CORRECTION — the LISTING must be a fresh full-catalog API crawl (this supersedes Step 1's listing sourcing)

**Root cause of the v22 coverage regression (2026-07-08→09):** the recompose used the stale `runs/data-2026-06-14-artist-ko-ruby-full-sweep/joysound-listing-from-corpus.jsonl` (236,434 rows) as the sweep listing. That file is a *from-corpus subset* (derived from the June corpus's existing joysound numbers), ~1 month older than the live v21 source. Result:

| | live v21 | v22 candidate | Δ |
|---|---|---|---|
| total | 307,961 | 262,221 | −45,740 |
| joysound | **306,822** | **257,139** | **−49,683** |

A **detail sweep only re-fetches details for songs already IN the listing — it never DISCOVERS new songs.** So sweeping a stale listing faithfully reproduces the *old* catalog scale. (The ruby "77%→90%" was an artifact: absolute ruby count was ~identical, the % rose only because ~50k non-ruby joysound songs were dropped.)

**The fix — enumerate the full CURRENT catalog via the JOYSOUND API; do NOT reuse a from-corpus listing:**
- `JoysoundOfficialCrawler` supports **`listingScope: 'fullCatalog'`** (`packages/crawler/src/adapters/joysound-official/crawler.ts:121,250-256`), which walks the **kana-indexed catalog** `https://www.joysound.com/web/search/songlist/{kana}?page=N` (`FULL_SONGLIST_BASE`, crawler.ts:29) across every kana index — i.e. it enumerates the ENTIRE current catalog. The default scope is `newReleases` (new songs only) — insufficient for a full recompose.
- **Correct listing step (replaces "reuse an old listing"):** run the joysound-official crawl in **`fullCatalog`** scope → a current, complete listing (~307k+) → then `joysound-detail-sweep.mjs <that-current-listing> <out-decision-log> <corpus>` → then `build-joysound-candidate`.
- ⚠️ **CLI-wiring TODO:** `fullCatalog` is an adapter option; `crawler start --source joysound-official` currently defaults to `newReleases`. Add/confirm a CLI flag (e.g. `--joysound-scope fullCatalog`) to select it before a full run. Until then it must be invoked via the adapter option directly.
- **Never** reuse `joysound-listing-from-corpus.jsonl` for a coverage-complete recompose — it is inherently a subset of whatever corpus produced it, and goes stale.

**Coverage gate before ANY promotion:** compare candidate vs live —
`ssh ubuntu@oci sqlite3 -readonly /srv/nas/karaoke/db/current/songs.sqlite "SELECT count(DISTINCT song_id) FROM karaoke_numbers WHERE provider='joysound' AND number IS NOT NULL"` (v21 = 306,822).
Candidate joysound count MUST be ≥ live, else it is a coverage regression — **do NOT promote.** (Host note: the serving box is the Tailscale node **`oci`** — the old `hermes-host` alias is retired.)

## Prereqs
- Clone at merged main (≥ `d9c30f0`, which shipped the dead-schema/hint-channel change). `corepack pnpm install --force`; `pnpm -r build` (dist required by the composer).
- Node with `--max-old-space-size=8192`.
- The `joysound-official` adapter is on main (`packages/crawler/src/adapters/joysound-official/`).

## Step 1 — Fresh JOYSOUND full-catalog sweep (soaks classifier gate c)
Run the opt-in JOYSOUND sweep to (re)generate a decision-log with the CURRENT classifier:
```
pnpm --filter @karaoke/crawler start --source joysound-official --limit 0 \
  --out <scratch>/songs.json.tmp --conflicts-out <scratch>/merge-conflicts.json
```
(⚠️ heavy: ~291k JOYSOUND pages, hours–days, hits JOYSOUND. Produces the detail decision-log the composer needs.)
- **Gate (c) classifier Phase-1 first-soak PASS:** golden test green (`pnpm -r test` → `classifierGolden.test.ts`) AND the fresh sweep's admit/drop distribution (decision-log `reason` counts) shows no unexpected regression vs the prior sweep (compare reason histograms). Phase-2 kana unification stays deferred until this passes.

## Step 2 — Recompose the full corpus
Stage the fresh decision-log at the composer's hardcoded path, then run:
```
# copy the fresh sweep's decision-log to:
#   .tmp_review/joysound-detail-sweep-<date>/decision-log.jsonl   (the composer's hardcoded dir; update the constant if the date differs)
node --max-old-space-size=8192 scripts/build-joysound-candidate.mjs
# → writes .tmp_review/.../songs-candidate.json (+ candidate-delta.json)
```
Checkpoint-1 guard will pass because a fresh 175-override sweep records the 3 suspect rows (the composer then scrubs them).

## Step 3 — Build the served DB WITH the curated hints
```
node apps/worker/scripts/build-sqlite-db.mjs \
  --input .tmp_review/.../songs-candidate.json \
  --output <scratch>/v22-candidate.sqlite \
  --search-hints data/search-hints.jsonl
```
(Or via the release path: `publish-full-corpus.mjs --input <candidate> --sqlite-out <db> --search-hints data/search-hints.jsonl` — wiring shipped in #93.)

## Step 4 — Verify the gates (read-only, on `<scratch>/v22-candidate.sqlite`)
Use `scratchpad/verify-drop.mjs` (schema/hint checks) plus:
- **Drop change (regression):** `search_hints` table absent, `search_texts` has no `text_norm`, `artist_hint` tokens present. (verify-drop.mjs)
- **Gate (a) merge-pairs applied:** for sampled Tier-E pairs `[tj, joy]` (e.g. `['6284','1755']` from `reviewedMergePairs.ts`), the tj record must carry BOTH numbers on ONE row:
  ```
  SELECT provider, number FROM karaoke_numbers WHERE song_id=(SELECT song_id FROM karaoke_numbers WHERE provider='tj' AND number='6284');
  -- PASS: rows include tj=6284 AND joysound=1755 for the same song_id
  ```
  Cross-check `candidate-delta.json` / `replay-merger.mjs` Before/After/Delta (each fired pair collapses 2→1).
- **Gate (b) ruby coverage:** `SELECT count(*) FILTER (WHERE title_ruby IS NOT NULL) have, count(*) total FROM songs;` → PASS: `have/total ≥ 236,224/307,961 (77%)` and ideally higher (crawler now persists ruby at sweep time).

## Step 5 — (separate, gated) promote to prod
Only on explicit owner go: `fetch-full-corpus` → build → oci `db/releases/data-<date>-v22` + `db/current` symlink (keep current+1). NOT part of this soak.

## Notes
- Recall behavior of the shipped change is a no-op (search-parity golden unchanged); the served DB just loses the dead `search_hints`/`text_norm` and stops fetching `title_ruby` in the serve projection.
- If you only need to re-verify the DROP (not the crawl gates), Step 3–4 against the committed `apps/web/public/data/songs.json` suffice (done 2026-07-08: 16/16 hints → 779 artist_hint tokens, no dead schema).
