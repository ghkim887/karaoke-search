# `scripts/` — pipeline tools and data diagnostics

This directory contains build helpers, post-crawl processing, audits, and
one-off repair tools. Python handles Stage-1 Korean-title normalization and
splitter parity; JavaScript tools reuse the crawler's compiled TypeScript
modules. The scheduled crawl workflow was still disabled at the September 17,
2026 check. The table describes where tools are wired, not a currently
running weekly schedule.

## Script catalog

| Script | Role | Invocation context |
|---|---|---|
| `run-post-crawl-pipeline.mjs` | Twelve-step post-crawl chain, ending in a report-only blog/KY audit | `crawl.yml`; local `--corpus` and `--skip` options |
| `probe-tjpdf-catalog.mjs` | Network TJ `searchSong` number probe | On demand; `--fresh`, `--range A..B` |
| `ingest-tjpdf-catalog.mjs` | Offline, coverage-only `tjpdf-*` additions from `scripts/data/tjpdf-catalog.jsonl` | Pipeline, after splitter parity |
| `normalize_tj_title_ko.py` | Stage 1: strip TJ transliterations and salvage Korean media context | Pipeline, before merger replay |
| `replay-merger.mjs` | Reapply current merge rules | Pipeline, after Stage 1 |
| `drop-artist-leaks.mjs` | Korean and Chinese artist leak cleanup, with row exemptions and anomaly IDs | Two pipeline passes: `--list korean`, then `--list chinese` |
| `translate_title_ko_via_agents.mjs` | Stage 2: prepare decision chunks or replay cached translations | Pipeline uses `merge`; `prep` prepares files separately |
| `apply-manual-title-ko-fixes.mjs` | Replay explicit Korean-title corrections | Pipeline, after Stage 2 |
| `prune-artist-nationality-cache.mjs` | Remove unreachable nationality-cache keys | Pipeline, before schema validation |
| `validate-songs-json.mjs` | Validate every corpus record | Final blocking pipeline step |
| `audit-blog-ky-parity.mjs` | Report unresolved blog KY claims | Last pipeline step; report-only |
| `compare-parity-baselines.mjs` | Compare old and regenerated search baselines | Crawl PR reporting; also accepts two local paths |
| `compose-crawl-pr-body.mjs` | Compose crawl summaries, parity deltas, and filter reports | `crawl.yml` writes its stdout to a temporary PR body file |
| `export-drop-list.mjs` | Export the tracked Korean drop-list JSON sidecar | Crawler build |
| `export-clustering-rules.mjs` | Export the tracked splitter-pattern sidecar | Crawler build |
| `audit-corpus-guardrails.mjs` | Corpus guardrail diagnostics | On demand |
| `audit-crawler-quality.mjs` | Crawler-quality diagnostics | On demand |
| `manual-fix-title-ko.mjs` | Single-record Korean-title correction | On demand |
| `extract-offline-subset.mjs` | Extract TJ-numbered, KY-numbered, or `blog-*` records from a full corpus | `--corpus <full-corpus.json> --out apps/web/public/data/songs.json` |
| `test_*.py` | Python regression tests | `python -m unittest discover -s scripts -p "test_*.py"` |
| `*.test.mjs` | JavaScript regression tests | `corepack pnpm --filter @karaoke/scripts test` |

Full pipeline order and source-adapter behavior are documented in
[ARCHITECTURE.md](../docs/ARCHITECTURE.md). Translation and review contracts
are documented below.

## Operational pitfalls

- Corpus-writing tools such as catalog ingest and merger replay use temporary
  files followed by rename. This protects each write, not the whole multi-step
  pipeline as a transaction. Diagnostic logs and one-off tools have their own
  write semantics.
- Merger replay refuses a shrink exceeding `MAX_DELTA_THRESHOLD` (1,000 at
  the checked revision) and also rejects output growth. A threshold check
  limits size change; it does not prove the intended songs survived.
- Stage-2 cache replay and the final blog/KY parity report are fail-soft.
  Manual fixes and schema validation fail the pipeline. Successful completion
  alone does not establish successful translation or complete KY coverage.
- The Korean drop-list and splitter JSON sidecars are tracked and checked for
  drift after builds. The old Python PDF-ingest consumer was retired. The
  Chinese predicates have no JSON sidecar; TypeScript callers and JavaScript
  tools use the canonical code or compiled crawler modules.
- In CI, merger replay uses the previously built crawler and fails if
  `dist/merge.js` is absent. Locally it can rebuild when that file is older
  than `src/merge.ts`; this narrow timestamp check does not detect every
  changed imported dependency.
- Many tools default to the web corpus path; `KARAOKE_SONGS_JSON` and explicit
  corpus options distinguish a temporary full-corpus input from the tracked
  offline subset. Those two populations have different search scores and
  coverage.
- Some one-off scripts retain historical NAS paths. Their existence does not
  establish that their original inputs still exist. The June uncompressed
  JOYSOUND detail evidence, for example, was archived in July.
- Filter JSONL files distinguish actual drops from JOYSOUND-anchored rows
  spared by cleanup. Their line counts are not drop counts. See
  [filter attribution](../docs/PROJECT-KNOWLEDGE.md#filter-decision-logs)
  for the current PR-summary labeling limitation.


## Title KO Stage 2

Stage 1 (`normalize_tj_title_ko.py`) clears TJ phonetic sort-title values before
preparation; otherwise Stage 2 may report zero eligible records. Preparation
and replay are deterministic file operations:

```sh
node scripts/translate_title_ko_via_agents.mjs prep \
  apps/web/public/data/songs.json scripts/data

node scripts/translate_title_ko_via_agents.mjs merge \
  apps/web/public/data/songs.json scripts/data \
  --review-csv scripts/data/llm-review.csv
```

Preparation writes `llm-translations-chunk-NN-input.json`. Each matching
`llm-translations-chunk-NN.json` is a JSON array with one decision per input
record, in input order. The title remains verbatim as an identity guard:

```json
{
  "id": "tj-12345",
  "title_primary": "<verbatim input title>",
  "title_ko": null,
  "media_context_ko": null,
  "confidence": "low",
  "reasoning": "<translation or uncertainty evidence>",
  "web_sources": []
}
```

- `title_ko` is a Korean title or null; confidence is `high`, `medium`, or
  `low`. Established Korean forms need supporting evidence. Converging
  independent sources support high confidence; a lone uncertain fan title or
  a best-effort literal translation does not. Unresolved meaning stays null/low.
- Pure-Latin core titles can remain null/high. Kana punctuation is not
  Japanese script, and nested trailing tie-up parentheses are separate from
  the core title. Phonetic katakana-to-Hangul copying is not a translation.
- `media_context_ko` can preserve a known Korean anime/OST/OP/ED name even
  when the song title stays null. Artist context distinguishes versions and
  canonically named works.
- Useful evidence queries combine original title, artist, and `한국어`, or
  Korean artist text with `가사`/`제목`. Official releases, Korean references,
  and fan-subtitle sources have different confidence. `web_sources` records
  only consulted URLs; no source is invented to justify a decision.

Merge ignores `-input` files and writes the corpus atomically. Its optional
review CSV includes medium/low decisions with a UTF-8 BOM for Korean Excel.
The pipeline replays outputs without CSV and treats Stage 2 as fail-soft;
manual fixes run afterward as a separate hard-fail step. ID/title guards avoid
attaching old decisions to another song. Editing source titles can invalidate
both manual and cached translations.

Schema checking uses `node scripts/validate-songs-json.mjs <corpus.json>`.
The targeted regression file is `translate_title_ko_via_agents.test.mjs` in
the scripts workspace. Schema validity alone does not prove translation quality.

## JOYSOUND review decisions

Review input is an array containing `selSongNo`, title, artist, classifier
decision (`admit`/`drop`), and audit buckets. Output contains exactly one
verdict per selection number, preserving input order:

```json
[
  {
    "selSongNo": "430643",
    "verdict": "LEAVE_ADMITTED",
    "reason": "<song-specific release evidence>",
    "web_sources": []
  }
]
```

`ALLOW`/`DROP` introduce a number-level override; `LEAVE_ADMITTED` and
`LEAVE_DROPPED` confirm the existing decision. An `existingNumberConflict`
bucket can mean that the older blog corpus assigned the wrong JOYSOUND number;
it does not by itself make the official record a false positive. Old
`suggested_verdict` fields can predate that conflict handling.

The relevant distinction is the actual release: a foreign act's Japanese
release differs from a Japanese transliteration of a Korean title. Latin
titles alone do not disqualify a Japanese act; Japanese artists' instrumental,
cover, and anime recordings remain in scope. Evidence URLs establish song
identity and language. After inconclusive research, a questionable dropped
row stays `LEAVE_DROPPED`, while an admitted row is not dropped without
positive exclusion evidence. Selection numbers are not public page IDs.

[Historical exclusions](../docs/PROJECT-KNOWLEDGE.md#joysound-screening-and-stale-decision-logs)
explain the three exact-number composer guards. The July cleanup verdict
format is separately documented with its retained
[evidence data](data/leak-review-verdicts/README.md).
