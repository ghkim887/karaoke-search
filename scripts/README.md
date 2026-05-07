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
| `ingest_anisong_pdf.py` | CI / data ingest | Weekly | After JS crawl, in `crawl.yml` |
| `validate-songs-json.mjs` | CI / data quality gate | Per crawl | After ingest, in `crawl.yml` |
| `replay-merger.mjs` | CI / merger replay | Per crawl | After ingest, before validate |
| `export-drop-list.mjs` | Build chain | On every `pnpm build` | Auto-invoked by `package.json` `build` script |
| `drop_kpop_leaks.py` | Ad-hoc cleanup | As-needed | Manual, after drop-list updates |
| `test_ingest_anisong_pdf.py` | Tests | CI / local | `python -m unittest scripts/test_ingest_anisong_pdf.py` |
| `test_drop_kpop_leaks.py` | Tests | CI / local | `python -m unittest scripts/test_drop_kpop_leaks.py` |

## Operational notes

- **Atomic writes everywhere.** `ingest_anisong_pdf.py` and `replay-merger.mjs`
  both write to a `<file>.tmp` then `os.replace()` / `renameSync()` — partial
  writes never reach `apps/web/public/data/songs.json`.
- **`replay-merger.mjs` is gated by safety thresholds.** Refuses to write
  when the corpus shrinks by more than `MAX_DELTA_THRESHOLD` records
  (currently 30) — see the constants block at the top of the file. A
  negative delta (more output than input) is treated as fatal and aborts.
- **`export-drop-list.mjs` runs as a post-build step.** Reads
  `packages/crawler/dist/.../koreanArtistDropList.js`, writes
  `packages/crawler/src/adapters/tj-media-direct/korean-artist-drop-list.json`.
  The sidecar JSON is **tracked in git** so a TS-edited-without-regen drift
  is visible at code-review time. CI also has a sidecar drift guard step
  (`Verify drop-list sidecar is in sync`).
- **`replay-merger.mjs` honors the `CI` env var.** In CI mode it does NOT
  auto-rebuild the crawler; it trusts the previous `pnpm -r build` step and
  errors out if `dist/merge.js` is missing. Locally it auto-rebuilds when
  `dist/merge.js` is older than `src/merge.ts`.
