# Open Questions

Live undecided items, with context and what unblocks each. Companion to
[ARCHITECTURE.md](ARCHITECTURE.md) and [PROJECT-KNOWLEDGE.md](PROJECT-KNOWLEDGE.md).
Items referencing the JOYSOUND feature branch
(`feat/joysound-full-catalog-sweep`) describe in-progress work that is NOT on
`main` yet.

## 1. Post-JOYSOUND data topology (DECIDED 2026-06-10)

**Decision (owner-approved, hybrid):** the tracked
`apps/web/public/data/songs.json` baseline (~25.8k) stays exactly as today
(offline bundle + weekly crawl PR diff); the post-JOYSOUND full corpus
(~221k, ~85 MB) lives OUTSIDE git as a GitHub Release asset, and git tracks
only a small manifest (`data/full-corpus.manifest.json`:
sha256/url/sizeBytes/record+vendor counts). D1 imports and the self-host
SQLite build consume the release asset via the manifest. Rationale: the
full corpus breaks both git limits (85 MB vs the 100 MB hard block) and
client-side index-build UX (~316 MB heap / ~5.7 s on desktop Node — worse
on phones), while a Release asset needs zero new secrets and the
store-agnostic manifest makes a later R2 swap a one-line `url` change.

Tooling landed (PR-1): `scripts/publish-full-corpus.mjs` (validate →
manifest [+ optional SQLite]) and `scripts/fetch-full-corpus.mjs`
(download → sha256+size verify → atomic write), shared logic in
`scripts/lib/manifest.mjs`. Remaining open sub-items:

- **PR-2 (workflow):** a `workflow_dispatch` full-corpus pipeline — compose
  → `gh release create` with the corpus asset → manifest-update PR. Weekly
  `crawl.yml` stays unchanged (baseline path preserved).
- **PR-3 (first publish/import):** publish the first release, manual D1
  import, `wrangler d1 info` 500 MB measurement (see item 4), then the
  worker/web deploy.

## 2. JOYSOUND runbook owner checkpoints

From the deploy runbook (on the feature branch:
`docs/superpowers/runbooks/2026-06-09-joysound-deploy.md`):

- **CHECKPOINT 1:** owner spot-check of the 175 ALLOW recoveries in
  `joysound-adjudication-review.csv`
  (`.tmp_review/joysound-sweep-2026-06-09/adjudication/`, untracked) before
  the `reviewedJoysoundOverrides` ALLOW list is committed.
- **Commit approval** for the reviewed in-flight branch work (explicit-path
  commits per runbook §2).
- Status note: the **full detail-fetching crawl STARTED 2026-06-10**
  (~33 h ETA, resumable via its append-only decision log). After it
  completes: candidate build → Layer-3 re-sampling (≥99 % precision gate) →
  the data-topology decision above gates the actual merge.

## 3. title_ko review CSV backlog

`scripts/data/llm-review.csv` carries ~255 medium/low-confidence LLM
translations pending human spot-check. Workflow: spot a wrong entry → append
a `{id, title_primary, title_ko}` row to
`scripts/data/title-ko-manual-fixes.json` → commit; the next post-crawl
pipeline run applies it. Unblocked by: owner review time (incremental — any
subset helps).

## 4. D1 free-tier 500 MB vs the JOYSOUND-scale corpus

The streamed D1 SQL export for the ~221k–236k candidate measured ~946 MB
during the 2026-06 JOYSOUND candidate dry-run — well past the 500 MB
Cloudflare D1 free-tier cap. Deploy-time check:
`wrangler d1 info --remote` after import. The planned escape hatch is the
**self-hosted search API** (`apps/worker/src/node-server.ts`,
`pnpm --filter @karaoke/worker serve:node`, landed in `008d453`) over the
same SQLite schema — the owner plans self-hosting as the expected path.
Unblocked by: the actual post-import measurement + hosting decision.

## 5. Post-JOYSOUND refactor backlog (deferred to avoid feature-branch conflicts)

Parked because the touched files are in flight on the feature branch:

- worker dedup: `splitSqlStatements` is duplicated between
  `apps/worker/scripts/import-d1-remote-chunked.mjs` and
  `report-d1-sql-metrics.mjs`, and the `StoredSongRow` row shape is declared
  in both `apps/worker/src/index.ts` and `@karaoke/data-store` — extract
  shared code;
- `apps/worker/scripts/export-d1-sql.mjs` dynamically imports the data-store
  via a hardcoded relative `dist/` path — switch to the `@karaoke/data-store`
  bare specifier so package resolution owns the path;
- `apps/web/src/components/App.tsx` hook extraction (the component
  accumulated search/API/favorites state machines);
- JOYSOUND classifier gate-array restructure — only with a
  diagnostic-replay proof of behavior identity;
- move the curated drop lists out of `adapters/tj-media-direct/` into a
  `src/curated/` home (keeping the sidecar export wiring intact);
- `.tmp_review/` audit artifacts: archive then delete (untracked, multi-GB
  over time);
- the agent-chunk prep/merge pattern (title_ko Stage 2, JOYSOUND
  adjudication) duplicates chunk-file plumbing — extract a shared lib.

## 6. Chinese-leak detection future work

The flat Chinese drop list + hardcoded catalog-anomaly IDs catch known leaks,
but TJ surfaces more non-Japanese rows over time. The right detector for
simplified-Chinese-only rows is a **simplified-Chinese character heuristic**
(characters that exist only in simplified script — a broad Han-without-kana
scan false-positives on ~2k kanji-titled Japanese songs and is the wrong
tool). Grow the catalog-anomaly ID list in `scripts/drop-artist-leaks.mjs` as
anomalies surface; revisit list structure if the Chinese list grows past ~20
entries (see PROJECT-KNOWLEDGE, drop lists).
