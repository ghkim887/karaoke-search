# Architecture

Current-state structural map of the karaoke-search monorepo. For durable
invariants, gotchas, and policy decisions see
[PROJECT-KNOWLEDGE.md](PROJECT-KNOWLEDGE.md); for live undecided items see the
[Open questions](ROADMAP.md#open-questions) section of ROADMAP.md.

- Live site: <https://karaokedb.pages.dev/> (Cloudflare Pages, Astro
  `base: '/'`). GitHub Pages is intentionally disabled.
- License: MIT.
- Toolchain: pnpm workspaces (always invoke as `corepack pnpm` — plain `pnpm`
  is not guaranteed on PATH, especially on Windows hosts), TypeScript,
  Biome, Vitest, Playwright, plus Python 3.11 for some data scripts.

## Workspace map

| Workspace | Package | Purpose |
| --- | --- | --- |
| `apps/web` | `@karaoke/web` | Astro static site with one Preact island (`src/components/App.tsx`). Client-side MiniSearch index over the bundled corpus, plus an API-first search path (see below). Device-local favorites via `localStorage`. |
| `apps/worker` | `@karaoke/worker` | Self-hostable Node search API (`GET /api/search`; `serve:node`, `src/node-server.ts`) over a SQLite search database built by `sqlite:build` (`scripts/build-sqlite-db.mjs`). The package name is historical — the Cloudflare Workers + D1 deploy path was removed 2026-06-13. |
| `packages/schema` | `@karaoke/schema` | Universal `SongRecord` type + Ajv validator. Both crawler and web depend on the compiled `dist/` output (build before runtime imports). |
| `packages/search` | `@karaoke/search` | Shared search-text primitives: normalization, tokenization, character n-grams, Hangul-initials expansion, karaoke-number query parsing. Consumed by the worker and the data store so index-time and query-time text processing cannot drift. |
| `packages/crawler` | `@karaoke/crawler` | Pluggable adapter pipeline (`Crawler` interface yields `SongRecord`), per-host rate-limited/cached HTTP client, artist-alias resolution, and the three-tier record merger. CLI at `dist/cli.js` after build. |
| `packages/data-store` | `@karaoke/data-store` | SQLite store: schema (`SONG_SCHEMA_SQL`), corpus import/export, and the derived search-index table builder. |
| `scripts/` | `@karaoke/scripts` | Post-crawl data pipeline, validation, PDF ingest, title_ko backfill tooling, and their Vitest + Python unittest suites. `corepack pnpm --filter @karaoke/scripts test` runs the JS tests. |

## Data flow (end to end)

Sources (each an adapter in `packages/crawler/src/adapters/`):

1. **`jpop-playlist-blog`** — Tistory blog crawl (~21k records). The main
   source of Korean titles/artists and of KY + JOYSOUND vendor numbers.
2. **`tj-media-direct`** — TJ Media public catalog API (~3.8k admitted
   records). Every candidate runs through the 7-step Japanese-relevance
   filter chain (`adapters/tj-media-direct/filterSteps.ts`; order is
   load-bearing — see PROJECT-KNOWLEDGE).
3. **`tjpdf-*` TJ-catalog post-step** — `scripts/ingest-tjpdf-catalog.mjs`
   inserts records (~635) for anime/vocaloid TJ numbers absent from the other
   adapters, from the committed TJ `searchSong` probe catalog
   (`scripts/data/tjpdf-catalog.jsonl`, refreshed on-demand by the network probe
   `scripts/probe-tjpdf-catalog.mjs`). Offline + coverage-only: no tagging.

Pipeline order per crawl:

```
adapters → TJ filter chain → alias resolution (aliases.ts, pre-merge)
  → three-tier merger (merge.ts) → apps/web/public/data/songs.json
  → weekly post-crawl pipeline → deploy
```

- The corpus `apps/web/public/data/songs.json` (~11 MB, ~25.8k records) is
  **tracked in git** — the static deploy bakes it into the build. The TJ
  enrichment cache `apps/web/public/data/tj-search-cache.json` is tracked too
  (cold-start enrichment would take hours).
- Current record/vendor counts: generate, don't trust prose —
  `node -e "console.log(JSON.parse(require('fs').readFileSync('apps/web/public/data/songs.json','utf8')).length)"`.
- The weekly post-crawl pipeline is `scripts/run-post-crawl-pipeline.mjs` —
  the single source of truth for the 11-step order-load-bearing chain
  (atomic rename → splitter parity → PDF ingest → title_ko Stage 1 → merger
  replay → KPOP drop → Cpop drop → title_ko Stage 2 cache replay
  (continue-on-error) → manual title_ko fixes → cache prune → schema
  validation). `crawl.yml` invokes it as one step; it also runs locally
  (`--corpus`, `--skip` supported).

### Filter decision logs (crawl-time attribution)

The TJ filter chain and the two `drop-artist-leaks` post-crawl passes emit a
per-row admit/drop **decision log** (JSONL), so after a crawl a maintainer can
answer "why was TJ row X dropped / which step admitted it" — not just the five
aggregate `KeepStats` stdout counters, which die with the Actions log. The
crawler writes `tj-filter.jsonl` via `--decisions-out` (one
`{ tj, title, artist, decision, step, reason }` per classified row; `reason` is
the admit via, the firing step's reject reason, or `no-admit-path` for a silent
fall-through); the drop passes write dropped-row-only logs when
`FILTER_DECISIONS_DIR` is set. `crawl.yml` uploads all three as the
`filter-decisions-<run_id>` artifact (`if: always()`, so a red leakage gate
still ships them) and `compose-crawl-pr-body.mjs` renders a report-only
`### TJ filter attribution` section (fail-soft; never reds the crawl). This
closes the crawl-time observability asymmetry with the `joysound-official`
full-catalog sweep, which already emits a per-row `DecisionRecord`
(`adapters/joysound-official/diagnostic.ts`). Report-only: zero effect on
admit/drop results — omit the flags and every output is byte-identical.

### Full-corpus distribution (decided)

The post-JOYSOUND **full** corpus (~221k records, ~85 MB) will NOT be
tracked in git — it ships as a GitHub Release asset, and git tracks only a
small manifest at `data/full-corpus.manifest.json`
(`{ version, url, sha256, sizeBytes, recordCount, vendorCounts,
generatedAt, baselineCommit, decisionLogSha? }` — store-agnostic, so a
later move to R2 is a one-line `url` change). The tracked baseline
`songs.json` above stays exactly as today.

- `scripts/publish-full-corpus.mjs` — schema-validates a composed corpus,
  computes sha256 + record/vendor counts, writes the manifest atomically
  (optionally also builds the self-host SQLite via the worker's
  `build-sqlite-db.mjs`).
- `scripts/fetch-full-corpus.mjs` — downloads `manifest.url` (http(s) or
  `file://`), verifies sha256 + size **before** an atomic rename (a failed
  or corrupt download never leaves a torn file), idempotent re-fetch via
  `--skip-download-if-valid`. Shared consumer for local dev and the
  self-host SQLite build.

Verification is CI's job, composition is not: the corpus's composition
inputs (the JOYSOUND decision log, the candidate builder) live on the
operator's machine / feature branch, and an ~85 MB file cannot be a
workflow input — so the operator composes and publishes locally, then
`.github/workflows/full-corpus.yml` re-downloads the asset and regenerates
the manifest from the actual bytes (trust-no-one: CI never accepts an
uploaded manifest). `ci.yml` additionally shape-validates the tracked
manifest on every PR via `scripts/verify-manifest.mjs` (no download; no-op
until the first manifest lands). The first actual publish/import is still
ahead (see the post-JOYSOUND data-topology item in the
[Open questions](ROADMAP.md#open-questions) section).

#### Publishing a full-corpus release (operator runbook)

Asset-naming convention: the corpus asset on the release must be named
exactly **`full-corpus.json`**; an optional decision-log asset named exactly
`decision-log.jsonl.gz` gets its sha256 recorded as the manifest's
`decisionLogSha`. Other assets (e.g. a prebuilt `.sqlite`) may coexist.

1. Compose the full corpus locally and note the commit it was composed
   against (`git rev-parse HEAD` in the composing checkout).
2. Dry-run sanity (schema-validates every record, ~221k):
   `node scripts/publish-full-corpus.mjs --input <full-corpus.json> --url PENDING`
   — do NOT commit the resulting PENDING manifest; the ci.yml gate rejects
   PENDING urls by design.
3. Create the release with the asset(s):
   `gh release create data/<date> full-corpus.json [decision-log.jsonl.gz] --notes "..."`.
4. Hand off to CI:
   `gh workflow run full-corpus.yml -f release_tag=data/<date> [-f baseline_commit=<sha>]`
   — `baseline_commit` is the composition commit from step 1 (provenance
   metadata in the manifest). It defaults to the sha the workflow runs on,
   which is only correct when `main` has not moved since composition — when
   in doubt, pass it explicitly.
5. Review and merge the PR the workflow opens (label `full-corpus`, branch
   `data/full-corpus-manifest-<tag-slug>`): it commits the regenerated
   `data/full-corpus.manifest.json` with CI-computed sha256 and
   record/vendor counts in the PR body. Re-dispatching the workflow for the
   same tag force-updates that existing branch/PR rather than opening a
   duplicate (deliberate — peter-evans/create-pull-request v8 behavior).

Consumers (`scripts/fetch-full-corpus.mjs` for local dev and the self-host
SQLite build) read the merged manifest and verify sha256 + size on
download.

## Two search paths

1. **Offline / bundled (MiniSearch)** — `apps/web/src/lib/search.ts` builds a
   MiniSearch index over 5 fields (`title_primary`, `title_ko`,
   `artist_primary`, `artist_ko`, `artist_aliases`) from the bundled
   `songs.json`. Always available; the fallback path.
2. **API-first (self-hosted Node + SQLite)** — when
   `PUBLIC_KARAOKE_API_BASE_URL` is set at build time, Browse searches call
   `GET /api/search` on the self-hosted API
   (`apps/worker/src/node-server.ts`, `pnpm --filter @karaoke/worker
   serve:node`, SQLite-backed custom index:
   token/prefix/n-gram/Hangul-initials tables built by
   `@karaoke/data-store`). The API currently accepts **one** vendor filter
   per request; the web app falls back to the bundled MiniSearch index when
   the API is absent/unreachable or multiple vendor chips are selected, and
   the favorites tab is always served locally.

The Cloudflare Workers + D1 variant of this API was removed 2026-06-13;
self-hosting is the only serving path. Cloudflare Pages serves the static app
and exposes same-origin `/api/*` via Pages Functions that proxy to the
configured self-hosted API origin.

## Search-only hint channel

The search-only hint channel carries alternate strings (e.g. character / CV
artist credits) that must improve recall WITHOUT appearing in display — unlike
`artist_aliases`, which renders in `ResultCard`. Source of truth: the committed
`data/search-hints.jsonl` sidecar. Each line (`{song_id, field, text, source,
confidence}`) is materialized into `search_tokens` (`title_hint` /
`artist_hint`) at build time and never into `search_texts` or the exported
`SongRecord`, so a hint only ever adds low-weight token recall. Wired into the
release build via `scripts/publish-full-corpus.mjs --search-hints`. To add a
hint: append a line to `data/search-hints.jsonl`.

## CI workflows (`.github/workflows/`)

All third-party actions are pinned by 40-char SHA with the tag in a trailing
comment; upgrades must update both. Every job bootstraps through the shared
composite action `.github/actions/setup` (pnpm + Node from `.nvmrc` + frozen
lockfile install).

- **`ci.yml`** (every PR + main push): `verify` job — `pnpm lint` /
  `typecheck` / `test` / `build`; sidecar-drift gate (auto-generated JSON
  sidecars must be byte-identical to their committed versions after the
  build); Python unittest suites
  (`python -m unittest discover -s scripts -p "test_*.py"`);
  `sqlite:build` (imports the committed corpus into the self-host SQLite
  database — this **schema-validates every committed record on every PR**,
  rejects duplicate ids, and proves the database builds). A parallel `e2e`
  job runs
  the Playwright suite against `astro preview` over a fallback-mode build
  (no `PUBLIC_KARAOKE_API_BASE_URL`), so UI breakage is caught at PR time
  instead of post-merge at the required deploy gate.
  The `verify` job also shape-validates `data/full-corpus.manifest.json`
  when it exists (`scripts/verify-manifest.mjs` — cheap, no asset download).
- **`full-corpus.yml`** (dispatch only): trust-no-one verification gate for
  an operator-published full-corpus release — downloads the
  `full-corpus.json` asset from the given `release_tag`, schema-validates
  every record, recomputes sha256/size/counts itself, and opens a PR
  (label `full-corpus`) committing the regenerated manifest. See the
  operator runbook above.
- **`crawl.yml`** (weekly cron + dispatch): build, sidecar-drift gate, full
  crawl into `songs.json.tmp`, then `run-post-crawl-pipeline.mjs`, then opens
  a PR labeled `crawl-output` (requires the repo setting "Allow Actions to
  create and approve pull requests"). Data lands on `main` by PR review,
  never by direct push.
- **Cloudflare Pages deploy**: GitHub Pages deployment was removed after the
  public URL moved to `https://karaokedb.pages.dev/`. Production deploys are
  direct Wrangler uploads of `apps/web/dist` using `apps/web/wrangler.toml`;
  CI still runs fallback-mode Playwright in `ci.yml` so UI breakage is caught
  before merge.

## JOYSOUND status (one-liner)

A `joysound-official` adapter + full-catalog sweep exists on a feature branch
(spec: `docs/superpowers/specs/2026-06-09-joysound-full-catalog-sweep-design.md`
on that branch) but **no `joysound-*` records are in the corpus yet** — the
existing JOYSOUND vendor numbers are blog-sourced. The ~291k-row full-catalog
merge is blocked on the data-topology decision and owner checkpoints tracked
in the [Open questions](ROADMAP.md#open-questions) section of ROADMAP.md.
