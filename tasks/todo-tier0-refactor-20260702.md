# Tier 0 refactor — correctness fixes (2026-07-02)

Source: 5-agent full-repo refactoring review (arch / web / pipeline / scripts /
ops), 2026-07-02. This file tracks Tier 0 (immediate correctness) only; the
full tier backlog is summarized at the bottom. No git commits until owner
approves (Windows mount also hits dubious-ownership).

## Tier 0 items

- [x] **T0-0 Permissions decision documented, not fixed.** Owner: the
  permissive `ReadWritePaths=/srv/karaoke` + plaintext env/cert layout is
  intentional during active development. Recorded in
  `docs/PROJECT-KNOWLEDGE.md` ("Self-host service permissions"); no changes
  to the unit, env, cert, or backups.
- [x] **T0-1 `isCliInvocation` unification (scripts R1).** DONE 2026-07-02,
  review APPROVE (after one REVISE round). 19 scripts unified onto
  `lib/cli.mjs:isCliInvocation` (incl. `run-post-crawl-pipeline.mjs` and
  `lib/corpus-audit-guardrails.mjs` caught in review); replay-merger's local
  copy deleted; 6 guard-less scripts wrapped in guarded `main()`;
  `joysound-diagnostic-sweep` argv[1]-throw bug fixed as a side effect; new
  `lib-cli.test.mjs` symlink regression test. Verified via `node --check`
  (all files), import-side-effect checks (0), CLI smoke on non-destructive
  scripts. Full vitest run deferred to Linux CI (Z: CIFS mount blockers:
  cmd.exe UNC + rollup native dlopen + broken pnpm symlinks — pre-existing). Only 3 of ~22
  `.mjs` scripts use `lib/cli.mjs:isCliInvocation`. Weak inline guards
  (`import.meta.url === pathToFileURL(process.argv[1]).href`, no realpath)
  silently no-op under symlinked invocation; `replay-merger.mjs` keeps a
  local copy of the very function that was extracted from it; 6 scripts have
  no guard at all (run on import); `joysound-diagnostic-sweep.mjs` throws on
  import when `process.argv[1]` is unset.
- [x] **T0-2 Python splitter behavior-parity test (scripts R2).** DONE
  2026-07-02, review APPROVE. Added `scripts/fixtures/splitter_parity_cases.json`
  (27 cases), `scripts/splitter_parity_harness.mjs` (hard-fail on missing
  crawler dist, exit 2), `scripts/test_splitter_behavior_parity.py`
  (normalized-key-set comparison — both consumers reduce to drop-set
  membership), strengthened `test_splitter_parity.py` (flags + fallback
  assertions). Python suite: 124 tests OK. No TS↔Python behavioral mismatch
  found.
  `test_splitter_parity.py` only syncs the delimiter string. The feat/prod
  paren regex, ` of ` sub-split, and regex flags are hand-mirrored in
  `lib/artist_split.py` with no behavioral comparison against TS
  `splitArtistCollab` — TS changes can silently drift the KPOP/Cpop drop
  filter. Add a shared-fixture behavior parity test.
- [x] **T0-3 Remove D1 50-byte LIKE gate (arch P3 / pipeline P9).** DONE
  `MAX_D1_LIKE_PATTERN_BYTES=50` (`apps/worker/src/index.ts:44`),
  `makeD1NumericPrefixPattern` null-drop, and
  `sqlite-adapter.ts:enforceD1SuffixLikePatternLimit` carry a Cloudflare-D1
  constraint onto node:sqlite, silently skipping the numeric-prefix subquery
  for long patterns (recall loss). Behavior change — isolated commit + search
  regression tests. D1 *renames* stay out of scope (Tier 3).

## Verification gates

- `corepack pnpm --filter @karaoke/scripts test` (T0-1, T0-2 JS side)
- Python unittest suite as invoked by `ci.yml` (T0-2)
- `corepack pnpm --filter @karaoke/worker test` (T0-3)
- Each item authored and reviewed by separate agents (author-reviewer).

## Review

All three items authored and independently reviewed (separate agents),
final verdicts APPROVE. Uncommitted working-tree changes — owner to commit.

- **T0-1** — 19 scripts on `isCliInvocation` (one REVISE round caught 2
  stragglers: `run-post-crawl-pipeline.mjs`, `lib/corpus-audit-guardrails.mjs`);
  new `lib-cli.test.mjs`. Verified: `node --check` all, import side effects 0,
  non-destructive CLI smoke. Vitest deferred to Linux CI (mount blockers).
- **T0-2** — behavior parity via normalized-key-set comparison (reviewer
  verified both consumers reduce to drop-set membership, so set comparison is
  conservative-correct). 27 fixture cases; hard-fail (exit 2) on missing
  crawler dist; CI order compatible. Python suite 124 tests OK (author +
  reviewer both reproduced). No actual TS↔Python drift found.
- **T0-3** — gate removal traced safe (pattern input is digits-only by
  construction via `normalizeKaraokeNumber`; bound parameters); no dangling
  references; regression test fails if the gate is restored. typecheck exit 0;
  worker vitest 5 files / 53 tests pass (author + reviewer both reproduced,
  via scratchpad harness working around Z:-mount vitest blockers).

### Environment findings (pre-existing, not from these changes)

Running the JS toolchain directly on the Z: CIFS mount is broken on this
Windows host: cmd.exe rejects UNC cwd (breaks `corepack pnpm` nested script
invocations), Windows denies dlopen of native `.node` binaries on network
paths (rollup → vitest), and `scripts/node_modules` has broken pnpm symlinks.
Full-suite verification for JS changes should run in Linux CI (or on the
server) until then. Python suite runs fine on the mount.

---

## Tier 1 execution plan (started 2026-07-02)

Batch 1 (parallel, disjoint file sets):
- [x] **T1-1 Font subsetting** — DONE 2026-07-03, review APPROVE, deployed
  to `public/fonts` (SHA256-verified). 5 unicode-range subsets (latin 321KB /
  kana 86KB / hangul 213KB / kanji 1008KB / ext 3954KB safety net) replace
  the 5.2MB variable woff2; typical download 620KB (−88%). Coverage: union
  cmap == original (22,059 cp), 0 used-char loss, variable axes preserved.
  **Commit note:** originals kept as `fonts.css.old` and
  `pretendard-jp-variable.woff2.bak` — `git rm` the tracked originals and do
  NOT commit the `.old`/`.bak` files. Follow-up (pre-existing): CSS declares
  `font-weight: 45 920` but the axis max is 930.
- [x] **T1-2 Surface API errors** — DONE 2026-07-02, review APPROVE.
  RenderMode gains 'browse-error'/'favorites-error' (exhaustive never kept);
  stale-error leakage gated on apiBrowse.key match; new `apiFavoritesStatus`
  state; Retry button via retryNonce; `fetchWithTransientRetry` (network/5xx/
  429 only; searchApi 2 attempts, favorites hydration 3). aria-live error
  label. Verified: web tsc exit 0; vitest 12 files / 101 tests pass (author +
  reviewer reproduced via harness). Follow-up (optional): style
  `.error-state-retry` button in global.css.
- [x] **T1-4 Promote shared search constants** — DONE 2026-07-02, review
  APPROVE. `PROVIDER_MASKS` / `MAX_PREFIX_TOKEN_CHARS` / `SearchTokenKind`
  single-sourced in `@karaoke/search`; locals deleted, direct imports, token
  logic untouched. Verified: tsc exit 0 ×3; vitest search 22 / data-store 30
  / worker 53 (author + reviewer reproduced). dist is gitignored — live-tree
  dist/cli.js EPERM non-issue (cli doesn't use promoted symbols).

Batch 2 (after batch 1 reviews, parallel):
- [x] **T1-3 Normalize single-sourcing** — DONE 2026-07-02, review APPROVE.
  Part A: crawler `normalize` re-exports `compactSearchText`; web
  `lib/normalize.ts` + parity test deleted — byte-equal proven over all
  222,429 corpus string values (0 mismatches; old impl verified against git
  HEAD). Part B: shared `hasKana`/`isKanaOnly`/`hasHan`/`hasHangul`/
  `hasLatinLetter` predicates (union ranges) adopted by joysound normalizer,
  tj blogWhitelist, jpLikelyRescue; predicate-level diffs 16/103,666 strings,
  **0 admit/drop flips**. classifier.ts deliberately untouched (audited
  per-range semantics — future work needs its own audit). Tests: search 22 /
  crawler 709 / web 94 / Python 124, typecheck ×3 exit 0 (author + reviewer
  reproduced). Deploy prerequisite: server-side `pnpm install` (new
  crawler→search workspace link) + crawler rebuild.
- [x] **T1-5a Row-type/projection dedup** — DONE 2026-07-02, review APPROVE.
  `StoredSongRow`/`KaraokeNumberRow`/`AliasRow` owned+exported by data-store
  (worker `import type`); `SONG_COLUMNS` + `songColumnsProjection(alias?)`
  drives all 5 SELECT projections; `build-sqlite-db.mjs` on bare specifier
  `@karaoke/data-store`. Hardening: exportSongs sub-queries now SELECT
  `song_id` so row casts match runtime shape. Verified: tsc exit 0; vitest
  data-store 30 / worker 53 (author + reviewer reproduced); zero test edits
  needed. Note: local dist stale on the mount — server-side `pnpm install` +
  build regenerates.

Deferred:
- **T1-5b SongRecord TypeBox single-source** — requires adding a dependency;
  pnpm install is unreliable on the Z: CIFS mount (broken symlinks). Execute
  on the server or in CI-driven branch instead.

## Tier 2 execution plan (started 2026-07-03)

Wave 1 (parallel, disjoint file sets):
- [x] **T2-1 App.tsx decomposition + SearchBackend** — DONE 2026-07-03,
  review APPROVE. App.tsx 490→330 lines; new lib/backend.ts (mode decision in
  exactly one place; apiBaseUrl branches 9→1), lib/results.ts (pure candidate
  logic, equivalence proven against git HEAD), hooks useCorpus/useApiBrowse/
  useApiFavorites/useSearchResults; P5 fixed (favorites MiniSearch index memo
  depends only on records — regression-guarded by App.p5.test). All 94
  pre-existing tests pass unmodified (+16 new = 110/14 files), tsc 0. Known
  benign delta: API-mode loading flips false one microtask later (proven
  unobservable). Baseline note: pre-refactor web suite is 94, not 101 —
  T1-3 deleted normalize.test.ts (7).
- [x] **T2-2 merge.ts declarative tiers** — DONE 2026-07-03, review APPROVE.
  merge.ts 2010→1713 lines: `mergeCluster(cluster, tier, conflicts)` replaces
  11 positional params; `SOFT_KEY_ORDER` traversal replaces 6-deep ternary
  (null fall-through reproduced); `TIER_PIPELINE: TierDescriptor[]` + single
  driver replaces 6 unrolled tier blocks (Tier D blocked-conflict side effect
  preserved); reviewed-pair tables (byte-identical substrings of the
  original) moved to `reviewedMergePairs.ts`. Proof: 45 cases / ~11.5k
  records, before==after SHA `5e1ee92f…`, independently re-derived by the
  reviewer via a dual-import harness. crawler 709/709, tsc 0, tests
  unmodified. (`src/merge.ts.__old` leftover deleted after lock release.)
- [x] **T2-5 data-store module split** — DONE 2026-07-03, review APPROVE.
  index.ts 1791→35-line barrel over schema/hints/search-index/song-writer/
  import-export/delta-patch (one-way import graph, 0 cycles); importSongs now
  reuses the single song-writer write path (inline upsert SQL + duplicate
  token insertion deleted). Proof: 4 scenarios (full import 25,842 songs /
  +hints / delta affected / delta all) all-table sorted dumps byte-identical
  (author), independently re-captured by reviewer with a fresh harness and
  different separator — 4/4 identical. Exports 26/26 preserved; cli.ts SHA
  unchanged; vitest 30+53 unmodified; tsc 0. Merge prerequisite: rebuild
  data-store dist before worker typecheck (stale dist on the mount).
- [x] **T2-6 scripts lib extraction** — DONE 2026-07-03, review APPROVE.
  5 new libs (jsonl / stream / joysound-dist / joysound-jp-artist /
  agent-chunks, each with a vitest .test.mjs) absorb duplication across 9
  scripts; loadCorpus/writeTextAtomic adopted (R5); ingest_anisong_pdf.py
  dead code removed (R6 — note: 2 of the 4 "unused" imports flagged in the
  original analysis were live test references and were correctly kept).
  Verified: 15/15 output artifacts SHA-identical before/after (author +
  reviewer reproduced), Python 124 OK, node --check 19 files, export surface
  fully preserved, T0-1/T0-2 intact. New lib vitests run in Linux CI.

Wave 2:
- [x] **T2-3 filterSteps phase enforcement** — DONE 2026-07-03, review
  APPROVE. `FilterPhase`/`PHASE_ORDER` (7 phases, 1:1 with steps —
  admit-pro/admit-artist split because execution order fixes the observable
  `via` counter) + load-time `assertPhaseOrder(FILTER_STEPS)` throw; generic
  admit-blocklist check deduped via `leadKeyOf`/`isGenericAdmitBlocked`
  (equivalence proven incl. dead-branch analysis). Reorder-detection tests
  added (42+7 green); crawler 40 files / 726 tests; tsc 0; verdict logic
  unchanged vs git HEAD.
- [x] **T2-4 http.ts hardening** — DONE 2026-07-03, review APPROVE.
  Rate-limit reservation clock (synchronous slot booking — concurrent
  requests stagger correctly; sequential cadence proven equivalent, drift
  actually improved); `getWithRetry` for idempotent GETs only (429/5xx/
  transient network, equal-jitter backoff 500ms→30s cap, Retry-After
  honored, per-attempt slot re-booking, failed bodies never cached); unique
  cache tmp names; robots comment aligned to real behavior (no behavior
  change) + debug log. http tests 17→27 green, crawler 726 green (author;
  reviewer re-derived 27/27 + isolated strict tsc 0 via local harness).
  Follow-ups (non-blocking): tj cache.ts shares the fixed-tmp pattern;
  orphan unique-tmp accumulation on rename failure.
Wave 3:
- [x] **T2-7 build-chain dist-free typecheck/test** — DONE 2026-07-03,
  review APPROVE. Per-package `tsconfig.typecheck.json` (composite:false,
  paths→sibling src; build tsconfigs untouched) + vitest resolve.alias→src;
  manual `--filter X build &&` prepends deleted from root/crawler/data-store/
  worker scripts (build scripts now plain `tsc -b` — references own the
  graph); web gets tsconfig paths directly (astro check reads it). The one
  remaining prepend (scripts/ test) is a genuine runtime dist dependency and
  stays. Verified: 6/6 typechecks exit 0 dist-free (reviewer reproduced with
  traceResolution proving src resolution), suites 22/726/30/53/110 green
  (author). Reviewer risk ruling on astro build bundling search from src:
  low (import-type-only schema; isolatedModules-safe search; stale-dist
  footgun removed) — keep as-is, CI e2e (real astro build + Playwright)
  gates it. **Final gate: Linux CI** (pnpm orchestration + astro check/build
  not runnable on this mount).

## Full backlog summary (Tiers 1–3, from the 2026-07-02 review)

- **Tier 1 (high impact):** font subsetting (5.2MB woff2 → unicode-range
  split + font-display swap); surface API errors in UI (currently disguised
  as "no results"); single-source normalization in `@karaoke/search`
  (crawler/web hand-copies + 3 divergent script-detection regexes); promote
  shared search constants (provider masks / prefix len / SearchTokenKind
  duplicated across data-store↔worker); SongRecord single-source via TypeBox
  (+ StoredSongRow / 11-column projection dedup).
- **Tier 2 (structural):** App.tsx decomposition + SearchBackend abstraction
  (+ favorites index rebuild fix); merge.ts TierDescriptor declarative
  orchestration; filterSteps phase-tag order enforcement; tsconfig paths to
  kill manual build prepends; data-store split (duplicate upsert SQL paths);
  HTTP client (rate-limit reservation, retry/backoff, cache tmp clobber);
  scripts lib extraction (agent-protocol, joysound predicate/JSONL).
- **Tier 3 (hygiene):** D1/worker renames; root retention policies
  (runs/, db/releases 40GB+); funnel-web adoption + .bak removal + service
  unit env mismatch; stale worktree removal; knip in CI; e2e/axe gates
  actually running in CI; dead-script archiving; a11y/i18n items.
- All data-touching refactors require before/after artifact byte-diff gates.
