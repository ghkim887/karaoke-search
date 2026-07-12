# TJ filter per-row admit/drop attribution (decision log) — design

Owner-approved 2026-07-12. Motivation (owner): "이거 필요해. 그래야 필터가
제대로 작동하는지 안 하는지 알지" — after a crawl there is currently NO way to
answer "why was TJ row X dropped / which step admitted it". The reject reason
is computed by every `FilterStep` and then destroyed at
`packages/crawler/src/adapters/tj-media-direct/parser.ts:190`
(`classifyRecord` collapses `{ decision:'reject', reason }` to bare `'drop'`);
admit attribution survives only as 5 aggregate stdout counters
(`crawler.ts:242`) that die with the Actions log. The JOYSOUND side already
has the model to mirror: a persisted per-row `DecisionRecord` JSONL
(`adapters/joysound-official/diagnostic.ts:13-29`) + aggregation tooling.

**Owner decisions (2026-07-12):**

- Scope = BOTH drop surfaces: the TJ `FILTER_STEPS` chain (crawl-time) and
  `scripts/drop-artist-leaks.mjs` (post-crawl drop-list re-application).
- Output = BOTH a per-row JSONL decision log (persisted as a workflow
  artifact) and an aggregate per-reason section in the crawl PR body
  (report-only, fail-soft).
- Sequencing = merge BEFORE the owner's upcoming verification crawl, so that
  crawl exercises this feature and its output is available while observing
  the gates. Report-only: zero behavior change to admit/drop results.

## 1. Record shape

```ts
/** One classified TJ catalog row. Mirrors the JOYSOUND DecisionRecord idea. */
interface TjFilterDecisionRecord {
  tj: string;              // TJ catalog number (stable key)
  title: string;           // raw indexTitle (trimmed)
  artist: string;          // raw indexSong (trimmed)
  decision: 'admit' | 'drop';
  step: string | null;     // FilterStep.name that fired; null for fall-through
  reason: string;          // admit: the via ('artist'|'pro'|'song-override'|'rescue')
                           // reject: the step's reason ('korean-drop-list'|'chinese-drop-list'|'pro-non-jpn'|'reviewed-song-drop'|…)
                           // fall-through (no step fired): 'no-admit-path'
}
```

The `no-admit-path` value is a NEW signal: it separates "explicitly rejected
by step X" from "no admit path claimed it" — today both are one `dropped`
counter. Rows skipped by the malformed-row guard (`parser.ts:127`, missing
tj/title/artist) are NOT decisions and are not recorded.

## 2. Crawler-side flow (packages/crawler)

1. `filterSteps.ts` — UNCHANGED. Verdicts already carry `via`/`reason`, and
   each step has a stable `name` + `phase`.
2. `parser.ts` — add `classifyRecordWithReason(tj, artist, cache, force)`
   returning `{ verdict: KeepVerdict; step: string | null; reason: string }`.
   The existing `classifyRecord` becomes a thin wrapper (existing callers and
   tests untouched). `parseCatalogResponse` collects one
   `TjFilterDecisionRecord` per classified row and returns it on `ParseResult`
   as a new `decisions` array (alongside `records` + `stats`).
3. Crawler/CLI — new optional `--decisions-out <path>` flag on the crawler
   start CLI (same pattern as `--conflicts-out`). When absent: exact current
   behavior, no file written. When present: after the crawl completes, write
   the decisions of the FINAL parse as JSONL (one compact object per line),
   overwrite semantics (each run's file is complete, NOT append).
   **Rescue-re-parse caveat (load-bearing):** `crawler.ts:207-212` re-runs
   `parseCatalogResponse` after the rescue pass; only the LAST parse's
   decisions may be written, otherwise rows are double-logged with
   contradictory verdicts. The exact plumbing from the adapter's generator to
   the CLI writer is the author's choice (e.g. expose the final ParseResult
   decisions via the crawl options/sink), under these constraints: written
   once, final-parse-only, no behavior change when the flag is absent.
4. Existing stdout counter lines stay byte-identical.

## 3. drop-artist-leaks.mjs (post-crawl surface)

- `isArtistDropped` currently returns a bare boolean; refactor so the caller
  learns WHICH check matched: reason ∈ `'korean-drop-list' |
  'chinese-drop-list' | 'catalog-anomaly-id'` (match the actual check set in
  the script; use these token spellings where they correspond).
- New optional `--decisions-out <path>` flag: writes JSONL of DROPPED rows
  only (admits are the surviving corpus; logging ~313k kept rows here is
  waste): `{ id, title, artist, decision:'drop', step:'drop-artist-leaks',
  reason }`. Stdout summary unchanged.
- The pipeline runs this script twice (kpop/cpop steps in
  `scripts/run-post-crawl-pipeline.mjs:92-97`); each invocation gets its own
  out path. Wiring: `run-post-crawl-pipeline.mjs` appends `--decisions-out
  "$FILTER_DECISIONS_DIR/<step-name>.jsonl"` to those two steps ONLY when the
  `FILTER_DECISIONS_DIR` env var is set; unset (local runs) = exact current
  behavior.

## 4. CI wiring (.github/workflows/crawl.yml)

- Crawler step: add `--decisions-out "${RUNNER_TEMP}/filter-decisions/tj-filter.jsonl"`.
- Post-crawl pipeline step: add `env: FILTER_DECISIONS_DIR: ${{ runner.temp }}/filter-decisions`.
- New artifact upload step immediately after the post-crawl pipeline, with
  `if: always()` (so a red leakage gate still ships the decisions — exactly
  when they are most needed): `actions/upload-artifact` pinned by full commit
  SHA like every other action in this workflow, name
  `filter-decisions-${{ github.run_id }}`, path
  `${{ runner.temp }}/filter-decisions/`. Default retention.
- RUNNER_TEMP is outside the repo tree → nothing can leak into the crawl PR
  (established convention in this workflow).

## 5. PR-body section (scripts/compose-crawl-pr-body.mjs)

- New 4th positional arg: the decisions DIR. Renders a trailing
  `### TJ filter attribution` section:
  - totals line (kept N / dropped M from `tj-filter.jsonl`),
  - one aggregate markdown table: reason → count, split into admits (by via)
    and drops (by reason, including `no-admit-path`), plus the two
    drop-artist-leaks files' drop counts by reason (labelled per step),
  - cap distinct-reason rows at 30 (defensive; the real set is ~10).
- Fail-soft contract IDENTICAL to the simplified-Chinese section: any missing
  file / unreadable file / malformed JSONL line renders a visible `[!NOTE]`
  instead of throwing — this section must NEVER red the crawl. Omitting the
  arg preserves the current body byte-for-byte.

## 6. Invariants + tests

Invariants (the review gate):

- Zero admit/drop behavior change: with or without the new flags, the
  produced corpus is identical; the only difference is new output files.
- `decisions[]` must be CONSISTENT with `KeepStats`: counts derived from the
  decisions array equal the existing counters (assert in tests).
- No new runtime dependencies (JSONL via node:fs). knip stays clean.

Tests (vitest, following each file's existing test conventions):

1. parser: representative rows per reason — a korean-drop-list reject, a
   chinese-drop-list reject, a pro admit, an artist admit, a song-override
   admit, a rescue admit (force set), a no-admit-path fall-through; plus the
   stats↔decisions consistency property on a mixed batch.
2. compose: section render (counts table), 0-row case, missing file note,
   malformed-line note, arg-omitted byte-parity — mirror the existing
   Chinese-audit test cases.
3. drop-artist-leaks: reason capture per list type; --decisions-out writes
   only dropped rows; flag-absent behavior unchanged.
4. Existing suites (leakage gate, classifier golden, parity golden) all stay
   green untouched.

Gates before PR: the CI mirror — biome, `-r typecheck`, `-r test`,
`-r build`, knip (fixed list; mirrors ci.yml).

## 7. Docs

- ARCHITECTURE.md: short paragraph documenting the TJ decision log next to
  the existing JOYSOUND decision-log description (observability asymmetry now
  closed at crawl time).
- This spec is committed with the branch (repo convention).

## 8. Out of scope (YAGNI, explicit)

- No threshold gating/alerting on reason counts (report-only).
- No JOYSOUND classifier changes (already has its log).
- No blog-id stable-identity work, no NAS retention automation.
- No change to the #97 leakage gate semantics.
