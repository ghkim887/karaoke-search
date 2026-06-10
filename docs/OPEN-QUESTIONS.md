# Open Questions

Live undecided items, with context and what unblocks each. Companion to
[ARCHITECTURE.md](ARCHITECTURE.md) and [PROJECT-KNOWLEDGE.md](PROJECT-KNOWLEDGE.md).
Items referencing the JOYSOUND feature branch
(`feat/joysound-full-catalog-sweep`) describe in-progress work that is NOT on
`main` yet.

## 1. Post-JOYSOUND data topology (decision REQUIRED before the ~291k merge)

The JOYSOUND full-catalog merge would grow the corpus far past what the
current "tracked `songs.json` baked into the static build" model supports
(GitHub Pages / Cloudflare Pages enforce a 25 MB per-file cap, and a ~291k
corpus also breaks the PR-CI schema-validation economics). Options on the
table:

- move the corpus out of git — R2 bucket vs GitHub Release asset as the
  artifact store;
- D1-only search (drop the bundled MiniSearch corpus entirely or keep a
  small bundled subset for offline fallback).

Unblocked by: an owner decision on artifact storage + offline-fallback
posture. Until then the committed corpus stays at its current baseline.

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

`scripts/data/llm-review.csv` carries ~241 medium/low-confidence LLM
translations pending human spot-check. Workflow: spot a wrong entry → append
a `{id, title_primary, title_ko}` row to
`scripts/data/title-ko-manual-fixes.json` → commit; the next post-crawl
pipeline run applies it. Unblocked by: owner review time (incremental — any
subset helps).

## 4. `deploy.yml` e2e must build in FALLBACK mode before/with the API-first deploy

The e2e job currently tests the API-first build (built with
`PUBLIC_KARAOKE_API_BASE_URL` set). Once full API-first removes the bundled
runtime fallback (feature-branch work), e2e needs a FALLBACK-mode build (no
`PUBLIC_KARAOKE_API_BASE_URL`) so it exercises the offline MiniSearch path
without depending on a live Worker. This is NOT deferred polish: e2e is a
**required deploy gate** since `f260f53` (`deploy` job
`needs: [build, e2e]`), so a red e2e blocks every Pages deploy. Must land
BEFORE or WITH the API-first deploy.

## 5. PR CI runs no Playwright e2e

`ci.yml` has no e2e job — Playwright runs only in `deploy.yml` (post-merge).
A PR that breaks the UI can merge green and then block all deploys (see
item 4: e2e is required). Options: add a (slower) e2e job to PR CI, a
label-gated e2e job, or accept the post-merge detection latency. Unblocked
by: owner appetite for PR-CI wall-time.

## 6. D1 free-tier 500 MB vs the JOYSOUND-scale corpus

The streamed D1 SQL export for the ~221k–236k candidate measured ~946 MB —
well past the 500 MB Cloudflare D1 free-tier cap. Deploy-time check:
`wrangler d1 info --remote` after import. The planned escape hatch is the
**self-hosted search API** (`apps/worker/src/node-server.ts`,
`pnpm --filter @karaoke/worker serve:node`, landed in `008d453`) over the
same SQLite schema — the owner plans self-hosting as the expected path.
Unblocked by: the actual post-import measurement + hosting decision.

## 7. Post-JOYSOUND refactor backlog (deferred to avoid feature-branch conflicts)

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

## 8. Chinese-leak detection future work

The flat Chinese drop list + hardcoded catalog-anomaly IDs catch known leaks,
but TJ surfaces more non-Japanese rows over time. The right detector for
simplified-Chinese-only rows is a **simplified-Chinese character heuristic**
(characters that exist only in simplified script — a broad Han-without-kana
scan false-positives on ~2k kanji-titled Japanese songs and is the wrong
tool). Grow the catalog-anomaly ID list in `scripts/drop-artist-leaks.mjs` as
anomalies surface; revisit list structure if the Chinese list grows past ~20
entries (see PROJECT-KNOWLEDGE, drop lists).
