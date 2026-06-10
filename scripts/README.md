# `scripts/` — data-pipeline glue and ad-hoc tooling

This directory holds the project's non-package executables: build-chain
shims, weekly-crawl post-processing, schema validation gates, and ad-hoc
cleanup helpers used to reshape the corpus when policy changes. The mix of
Python and JavaScript is deliberate — the PDF ingest has historically lived
in Python (Windows-host `pdftotext -table` dependency, reused regex helpers),
while the merger replay and schema validation reuse the TypeScript build's
`dist/` artifacts directly. Python regression tests use stdlib `unittest`
and run via `python -m unittest discover -s scripts -p "test_*.py"`.

## Script catalog

| Script | Role | Frequency | Invocation context |
|---|---|---|---|
| `run-post-crawl-pipeline.mjs` | CI / post-crawl chain runner (atomic rename → … → schema validation) | Weekly | Single step in `crawl.yml`; runnable locally (`--corpus`, `--skip`) |
| `ingest_anisong_pdf.py` | CI / data ingest (coverage-only PDF records) | Weekly | After JS crawl, in `crawl.yml` |
| `normalize_tj_title_ko.py` | CI / title_ko Stage 1 (strip TJ transliterations, salvage `media_context_ko`) | Weekly | After PDF ingest, in `crawl.yml` |
| `replay-merger.mjs` | CI / merger replay | Weekly | After Stage 1, in `crawl.yml` |
| `drop-artist-leaks.mjs --list korean` | CI / Korean-artist leak cleanup | Weekly | After merger replay, in `crawl.yml` (also runnable manually after drop-list updates) |
| `drop-artist-leaks.mjs --list chinese` | CI / Chinese-artist (Cantopop/Mandopop) leak cleanup (+ catalog-anomaly IDs) | Weekly | After KPOP drop, in `crawl.yml` |
| `translate_title_ko_via_agents.mjs` | CI / title_ko Stage 2 (`merge` replays the cached LLM translations) + manual `prep` chunking for operator-dispatched agent runs | Weekly (`merge`) | `crawl.yml` Stage 2 replay; `prep` is manual |
| `apply-manual-title-ko-fixes.mjs` | CI / manual title_ko sidecar replay | Weekly | After Stage 2 replay, in `crawl.yml` |
| `prune-artist-nationality-cache.mjs` | CI / tj-search-cache pruning (drops unreachable `artistNationalityMap` keys) | Weekly | Before schema validation, in `crawl.yml` |
| `validate-songs-json.mjs` | CI / data quality gate | Weekly | Final gate, in `crawl.yml` |
| `compose-crawl-pr-body.mjs` | CI / crawl PR-body composer | Weekly | In `crawl.yml`, stdout redirected to `$RUNNER_TEMP/pr_body.md` |
| `export-drop-list.mjs` | Build chain (Korean drop-list JSON sidecar) | On every crawler `pnpm build` | Auto-invoked by `@karaoke/crawler` `build` script |
| `export-clustering-rules.mjs` | Build chain (`SPLIT_RE` splitter-pattern JSON sidecar) | On every crawler `pnpm build` | Auto-invoked by `@karaoke/crawler` `build` script |
| `audit-corpus-guardrails.mjs` | Ad-hoc corpus audit | As-needed | Manual |
| `audit-crawler-quality.mjs` | Ad-hoc crawler-quality report | As-needed | Manual |
| `manual-fix-title-ko.mjs` | Ad-hoc single-record title_ko fix | As-needed | Manual |
| `test_*.py` | Tests (Python) | CI / local | `python -m unittest discover -s scripts -p "test_*.py"` (CI runs `test_splitter_parity.py` in `crawl.yml`) |
| `*.test.mjs` | Tests (JS) | Local | `corepack pnpm exec vitest run scripts` |

## Operational notes

- **Atomic writes everywhere.** `ingest_anisong_pdf.py` and `replay-merger.mjs`
  both write to a `<file>.tmp` then `os.replace()` / `renameSync()` — partial
  writes never reach `apps/web/public/data/songs.json`.
- **`replay-merger.mjs` is gated by safety thresholds.** Refuses to write
  when the corpus shrinks by more than `MAX_DELTA_THRESHOLD` records
  (currently 1000) — see the constants block at the top of the file. A
  negative delta (more output than input) is treated as fatal and aborts.
- **`export-drop-list.mjs` runs as a post-build step.** Reads
  `packages/crawler/dist/.../koreanArtistDropList.js`, writes
  `packages/crawler/src/adapters/tj-media-direct/korean-artist-drop-list.json`.
  The sidecar JSON is **tracked in git** so a TS-edited-without-regen drift
  is visible at code-review time. CI also has a sidecar drift guard step
  (`Verify all sidecars are in sync`), which covers the Korean drop-list
  sidecar plus `clustering-rules.json`. (The Chinese drop list has no sidecar:
  its only consumer is `drop-artist-leaks.mjs`, which imports the TS-built
  dist directly.)
- **`replay-merger.mjs` honors the `CI` env var.** In CI mode it does NOT
  auto-rebuild the crawler; it trusts the previous `pnpm -r build` step and
  errors out if `dist/merge.js` is missing. Locally it auto-rebuilds when
  `dist/merge.js` is older than `src/merge.ts`.
