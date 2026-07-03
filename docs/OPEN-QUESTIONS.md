# Open Questions

Live undecided items, with context and what unblocks each. Companion to
[ARCHITECTURE.md](ARCHITECTURE.md), [PROJECT-KNOWLEDGE.md](PROJECT-KNOWLEDGE.md)
and [ROADMAP.md](ROADMAP.md) (decided-but-not-started future work).
Items referencing the JOYSOUND feature branch
(`feat/joysound-full-catalog-sweep`) describe in-progress work that is NOT on
`main` yet.

## 1. Post-JOYSOUND data topology (DECIDED 2026-06-10)

**Decision (owner-approved, hybrid):** the tracked
`apps/web/public/data/songs.json` baseline (~25.8k) stays exactly as today
(offline bundle + weekly crawl PR diff); the post-JOYSOUND full corpus
(~221k, ~85 MB) lives OUTSIDE git as a GitHub Release asset, and git tracks
only a small manifest (`data/full-corpus.manifest.json`:
sha256/url/sizeBytes/record+vendor counts). The self-host SQLite build
consumes the release asset via the manifest. Rationale: the
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
- **PR-3 (first publish/import):** publish the first release, build the
  self-host SQLite database from it, stand up the self-host API, then the
  web deploy flip (Cloudflare Pages root build with same-origin
  `PUBLIC_KARAOKE_API_BASE_URL=/` and Pages Functions proxying to the
  self-host API origin).

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

## 4. D1 free-tier 500 MB vs the JOYSOUND-scale corpus (RESOLVED 2026-06-13 — by removal)

Resolved by removing the Cloudflare deploy path entirely: the owner decided
self-hosting (`apps/worker/src/node-server.ts`,
`pnpm --filter @karaoke/worker serve:node` over the SQLite database from
`sqlite:build`) is the only serving path, so the D1 500 MB free-tier cap no
longer applies. Background: the streamed D1 SQL export for the ~221k–236k
candidate measured ~946 MB during the 2026-06 JOYSOUND candidate dry-run —
well past the cap — which motivated the decision. Workers + D1 + wrangler
tooling was deleted from the repo on 2026-06-13.

## 5. Post-JOYSOUND refactor backlog (deferred to avoid feature-branch conflicts)

Parked because the touched files are in flight on the feature branch:

- worker dedup: the `StoredSongRow` row shape is declared in both
  `apps/worker/src/index.ts` and `@karaoke/data-store` — extract shared code
  (the `splitSqlStatements` half of this item was resolved by deletion when
  the D1 import scripts were removed 2026-06-13);
- `apps/worker/scripts/build-sqlite-db.mjs` dynamically imports the
  data-store via a hardcoded relative `dist/` path — switch to the
  `@karaoke/data-store` bare specifier so package resolution owns the path;
- the worker's `D1*` interfaces (now `SearchDatabase`/`PreparedStatementLike`/
  `QueryResult`/`SqlValue`), the sqlite-adapter's `SqliteSearchDatabase`, and
  data-store's `SONG_SCHEMA_SQL` were renamed backend-neutral (T3-1). The
  `.wrangler/` scratch-dir convention in `apps/worker/scripts/build-sqlite-db.mjs`
  was neutralized to `apps/worker/.build/sqlite/` (T4-5) via a coordinated
  `.gitignore` + pin-test (`apps/worker/test/ci-pipeline-pins.test.ts`) change;
  `apps/worker/.wrangler/` stays gitignored for historical local scratch, and
  `apps/web/.wrangler/` is retained as live Cloudflare Pages local state
  (`apps/web/wrangler.toml`);
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

## 7. JOYSOUND classifier safe-predicate unification — Phase 2 (deferred)

The JOYSOUND classifier
(`packages/crawler/src/adapters/joysound-official/classifier.ts`) historically
carried its own script-detection regexes that drifted from the shared
`@karaoke/search` predicates. T5-D unified this in two phases, gated by a golden
regression harness
(`packages/crawler/test/adapters/joysound-official/classifierGolden.test.ts`).

**Phase 1 (DONE, T5-D):** the three *safe* predicates were swapped to the shared
`@karaoke/search` functions —
- `RE_ASCII_LETTER` → `hasLatinLetter` (byte-identical, zero behaviour change);
- `hasKanaScript` (admit path) → `hasKana`;
- `RE_KANA` (foreign-name echo path) → `hasKana`.

The only behavioural effect is a strict *widening* of kana recognition, verified
by the golden gate's Part B1 (change spec) and the always-on Part C differential:
Katakana Phonetic Extensions (U+31F0–31FF) now admit as `admit-jpop-kana`, and a
Han foreign-name whose only kana is half-width (U+FF66–FF9F) or phonetic-ext is
now recognised as a Japanese-title echo (suppressing `foreign-chinese`). Both
are DROP→ADMIT flips, so genuine-JP dropout is structurally impossible. A full
`songs.json` differential (98,772 distinct strings, current corpus) showed **0
flips** in either direction for all three predicates — the widening is latent
for today's catalog and only affects future rows carrying those code points.

**Phase 2 (deferred — proceed after the golden gate has soaked one crawl
cycle):** unify the remaining three predicates, which sit on ADMIT/DROP-critical
paths whose real JOYSOUND foreign-name distribution is not yet validated:
- `RE_HANGUL` → `hasHangul` (`\p{Script=Hangul}`): adds half-width Hangul and
  Jamo Extended-A/B → widens the `foreign-korean` DROP directly;
- `RE_HAN_FOREIGN` → `hasHan` (`\p{Script=Han}`): adds supplementary-plane Han →
  changes the `foreign-chinese` DROP directly;
- `RE_HAN` (drop-reason split) → `hasHan`: adds CJK-compat / supplementary-plane
  Han and drops the Yijing-hexagram block → shifts `drop-han-only` vs
  `drop-no-signal`.

Phase 2 is unblocked by: a fresh crawl cycle confirming the Phase-1 gate holds in
production, plus a real JOYSOUND foreign-name-field distribution sample for the
Hangul/Han code points above. The Phase-2 divergence points are already pinned at
their current behaviour in the golden gate's Part B2 — flipping those assertions
is the Phase-2 change spec.

## 8. Offsite full-corpus backup publication (HELD 2026-07-04, owner)

Local retention now keeps only current+previous release (README-ops on the
NAS root), which makes an offsite corpus copy the only protection against
NAS loss short of a re-crawl (hours). The pipeline is fully built: upload
`full-corpus.json` as a GitHub Release asset, then dispatch
`full-corpus.yml` (trust-no-one re-verification -> manifest PR). What is
held is the DECISION to publish the ~93 MB corpus as a public release
asset. Unblocked by: owner approval of public publication (the same
metadata is already publicly queryable through the live API), or choosing
a private storage target instead.

## 9. Watchdog alert channel (HELD 2026-07-04, owner)

`karaoke-healthz.timer` (1-min healthz watchdog with auto-restart and a
10-min restart-loop guard) is live on the host and logs to the journal
(tag `karaoke-healthz`). No alert channel is wired - a wedged service is
self-healed but a HUMAN is only informed via journal inspection. Unblocked
by: owner picking a channel (Telegram / Discord webhook / e-mail / none);
the hook point is the `logger` calls in
`/srv/nas/karaoke/healthz-watchdog.sh`.
