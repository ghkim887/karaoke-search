# JOYSOUND Full-Catalog Sweep + FP/FN Verification — Design

**Date:** 2026-06-09
**Status:** approved (brainstorming) → implementation
**Owner:** Gyunho
**Scope:** Bring the JOYSOUND-official **full catalog** (~291k rows) to a state where it can be merged into the production corpus, gated by an explicit **false-positive / false-negative (FP/FN) inspection** before any production merge. **This design does NOT merge** — it produces the verified delta + a briefing.

---

## 1. Goal & non-goals

**Goal.** Run a full-catalog sweep, classify every catalog row (admit/drop) using the **TJ methodology** (precision-first + curated number-level overrides + hard negative signals), inspect both FP (wrongly-admitted) and FN (wrongly-dropped) before production, apply the appropriate fixes, and brief the full delta + fix process.

**Non-goals (this iteration).**
- No production-DB merge (report only).
- No fresh ~291k per-song **detail** crawl (infeasible in-session; see §3). Vocaloid/anime *category precision* that needs detail is a bounded follow-up, not a blocker for admit-vs-drop FP/FN.

## 2. Methodology — adopt TJ's, adapted to a cleaner source

TJ's filter chain is **"admit on any of several positive signals, but strong negative signals + curated exact-number ALLOW/DROP override the admits"**, with a confidence vote. It is recall-conscious *because TJ's search-index source is leaky* (~33% miss).

JOYSOUND's source is the official catalog with per-song metadata, and its classifier is already **precision-leaning** (kana-required for jpop, foreign-act drop, Han-only rejected as Chinese-ambiguous). So we inherit TJ's *philosophy* — precision protected by hard negatives + a curated number-level override layer — which on this cleaner source resolves to **precision-first: when in doubt, drop**. A dropped real song is recoverable later; a leaked foreign act erodes corpus trust.

Concretely transferred from TJ:
- **Hard negative signals** (already in the JOYSOUND classifier): Korean/Chinese/Western act drop.
- **Curated number-level override layer** (NEW): `reviewedJoysoundOverrides.ts`, mirroring `reviewedSongOverrides.ts` — ALLOW/DROP keyed by canonical (hyphen-stripped) JOYSOUND number, consulted first in the classifier (ALLOW before the foreign-act gate; DROP first), so adjudicated edge cases (K-pop Japanese releases, specific FPs) are pinned by exact number, never artist-wide.

## 3. Sweep data source & feasibility

**Reuse the existing full-catalog listing crawl** — `apps/worker/.wrangler/audit/joysound-full-listing-20260604T171343Z/listing-rows.jsonl` (~291k rows, 2026-06-04). A fresh full-catalog crawl fetches per-song detail for every row (~291k rate-limited GETs) and is infeasible in-session. The cached listing rows ARE the sweep.

**Listing-level classification is sufficient for the precision-critical FP/FN axis.** `classifyJoysoundRecord({ listItem })` (detail optional) runs the foreign-act drop and kana-jpop admit gates on listing fields (`songName`, `artistName`, `tieupInfo`). What is **detail-only** (and therefore lossy at listing level): vocaloid `genreNames` and anime `tieupNames`. Rows whose verdict *could flip with detail* (Han-only, ASCII-only, kana-jpop-that-might-be-vocaloid/anime) are flagged `detailFlipRisk` for a **bounded** detail follow-up (prior audit already produced detail samples: high-priority + n10000 stratified, same artifact dir).

## 4. Architecture

Single source of classification truth = the **TS classifier**. The audit script (mjs) only buckets decisions; it does not re-implement classification (avoids TS↔mjs drift).

```
listing-rows.jsonl (existing, ~291k)
        │
        ▼  [diagnostic step, TS] imports classifyJoysoundRecordWithReason + reviewedJoysoundOverrides
decision-log.jsonl  { selSongNo, naviGroupId, title, artist, decision: admit|drop,
                      category, reason, detailFlipRisk, evidence }
        │
        ▼  [analyzeJoysoundDatabase, mjs]  + current corpus (songs.json)
FP / FN bucket trees  +  --review-dir TSV/JSONL queues   (analyzeTjDatabase analog)
        │
        ▼  human / agent adjudication of P0/P1 queues
reviewedJoysoundOverrides.ts  (number-level ALLOW/DROP)  + systematic classifier fixes
        │
        ▼  re-run diagnostic → analyzeJoysoundDatabase  → success-criteria gates green
        ▼  compareCorpora merge-delta (dry-run)  → BRIEF delta + fix process   (NO MERGE)
```

### 4.1 Reason-rich classification
Add `classifyJoysoundRecordWithReason({ listItem, detail? }): { category: Category | null; reason: string }` (or extend the existing function) exposing which gate fired: `reviewed-allow` / `reviewed-drop` / `foreign-korean` / `foreign-western` / `admit-vocaloid` / `admit-anime` / `admit-jpop-kana` / `drop-han-only` / `drop-ascii-only` / `drop-no-signal`. The existing `classifyJoysoundRecord` keeps its `Category | null` contract (delegates to the reason-rich one) so the crawler is unaffected.

### 4.2 Override hook
`reviewedJoysoundOverrides.ts` consulted at the top of the classifier: DROP override → drop first; ALLOW override → admit before the foreign-act gate (mirrors TJ's allow-precedes-droplist ordering). Key normalization = hyphen-strip (`190-001`→`190001`), matching `normalizeJoysoundNumber`.

### 4.3 FP/FN bucket taxonomy (analyzeJoysoundDatabase)
**FP — admitted but suspicious (should we have dropped?):**
- `existingNumberConflict` (P0/P1) — admitted joysound number already in corpus, mapped to a *different* title/artist.
- `foreignActAdmitted` (P0) — admitted, artist trips the audit's (superset) Korean/Chinese/Western patterns.
- `hanNoKanaAdmitted` (P2) — admitted with Han-but-no-kana (Mandopop risk).
- `asciiOnlyAdmitted` (P2) — admitted Latin-only, weak Japanese evidence.
- `categoryAmbiguous` (P2/P3) — admitted but category assignment weak / `detailFlipRisk`.

**FN — dropped but maybe Japanese (should we have admitted?):**
- `droppedHasKana` (P0/P1) — dropped though title/artist has kana.
- `droppedKnownJpArtist` (P1) — dropped but artist matches a known Japanese act in the corpus.
- `droppedForeignButJpRelease` (P1) — dropped as foreign but is a Japanese release/collab → ALLOW candidate.
- `droppedHanAmbiguous` (P2/P3) — dropped Han-only that may be Japanese kanji.
- `droppedAsciiOnly` (P3) — dropped Latin-only that may be a Latin-named Japanese act.

Each issue is a rich evidence row (`bucket, priority, why_flagged, suggested_verdict, script_signal, …`) mirroring `evidenceRow`; `--review-dir` writes `review-fp-high.tsv` (P0/P1), `review-fp-other.tsv`, `review-fn-high.tsv` (P0/P1), `review-fn-other.tsv`.

## 5. Success criteria = production-merge gate (3 layers)

**Layer 1 — automated hard gates (any failure blocks merge):**
- Final admitted set contains **0** foreign (Korean/Chinese/Western) acts (audit foreign buckets re-run on admitted output).
- merge-delta (`compareCorpora`, dry-run) shows **0** existing records removed, **0** rich-field mutation/loss, **0** duplicate IDs.
- **100%** of would-be-merged records pass schema validation (incl. the joysound digit `pattern`).
- Re-run is **byte-deterministic** (idempotent).

**Layer 2 — human/agent adjudication (the FP/FN inspection — owner requirement):**
- **All P0/P1 FP and FN rows adjudicated** → encoded into `reviewedJoysoundOverrides` (and/or systematic classifier fixes); **0 un-adjudicated P0/P1** in the merged delta.
- P2–P4 buckets sampled.

**Layer 3 — sampling confidence:**
- Random sample of admitted rows: category + Japanese-origin + title/artist/number integrity ≥ target (e.g. ≥99% Japanese).
- **Recall sanity:** a sample of known-Japanese songs that should be admitted are present (over-drop check).

## 6. Implementation units
1. `packages/crawler/src/adapters/tj-media-direct/…`? No — JOYSOUND: `packages/crawler/src/adapters/joysound-official/reviewedJoysoundOverrides.ts` (TS-only, ALLOW/DROP number sets + `isReviewedJoysoundAllow/Drop`, hyphen-strip key) + classifier hook.
2. Reason-rich classification in `classifier.ts` (`classifyJoysoundRecordWithReason`) + override consultation.
3. Diagnostic decision-log step (TS) over `listing-rows.jsonl` → `decision-log.jsonl`.
4. `analyzeJoysoundDatabase` + `collectJoysoundDatabaseIssueRows` + `writeJoysoundReviewQueues` in `scripts/lib/corpus-audit-guardrails.mjs` + a `joysound-db` CLI mode (mirror `tj-db`).
5. Tests for each (TDD), author→reviewer (both Claude) per project rule.

## 7. Verification & briefing
Re-run diagnostic + `analyzeJoysoundDatabase` after fixes → confirm Layer-1 gates green + Layer-2 queues cleared. Produce a `compareCorpora` dry-run of (corpus + admitted-after-overrides) vs current corpus. **Brief** the full delta (counts added/changed, category split, conflicts resolved, foreign dropped) + the fix process (overrides added, classifier fixes). **No merge.**
