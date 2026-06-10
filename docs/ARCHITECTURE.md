# Architecture

Current-state structural map of the karaoke-search monorepo. For durable
invariants, gotchas, and policy decisions see
[PROJECT-KNOWLEDGE.md](PROJECT-KNOWLEDGE.md); for live undecided items see
[OPEN-QUESTIONS.md](OPEN-QUESTIONS.md).

- Live site: <https://ghkim887.github.io/karaoke-search/> (GitHub Pages, Astro
  `base: '/karaoke-search/'`).
- License: AGPL-3.0-or-later.
- Toolchain: pnpm workspaces (always invoke as `corepack pnpm` — plain `pnpm`
  is not guaranteed on PATH, especially on Windows hosts), TypeScript,
  Biome, Vitest, Playwright, plus Python 3.11 for some data scripts.

## Workspace map

| Workspace | Package | Purpose |
| --- | --- | --- |
| `apps/web` | `@karaoke/web` | Astro static site with one Preact island (`src/components/App.tsx`). Client-side MiniSearch index over the bundled corpus, plus an API-first search path (see below). Device-local favorites via `localStorage`. |
| `apps/worker` | `@karaoke/worker` | Cloudflare Worker search API (`GET /api/search`) backed by D1, plus a self-hostable Node server (`serve:node`, `src/node-server.ts`) over the same SQLite schema. `scripts/` holds the D1 export/import/verify tooling. |
| `packages/schema` | `@karaoke/schema` | Universal `SongRecord` type + Ajv validator. Both crawler and web depend on the compiled `dist/` output (build before runtime imports). |
| `packages/search` | `@karaoke/search` | Shared search-text primitives: normalization, tokenization, character n-grams, Hangul-initials expansion, karaoke-number query parsing. Consumed by the worker and the data store so index-time and query-time text processing cannot drift. |
| `packages/crawler` | `@karaoke/crawler` | Pluggable adapter pipeline (`Crawler` interface yields `SongRecord`), per-host rate-limited/cached HTTP client, artist-alias resolution, and the three-tier record merger. CLI at `dist/cli.js` after build. |
| `packages/data-store` | `@karaoke/data-store` | SQLite/D1 store: builds the search-index tables from a corpus JSON and streams D1-compatible SQL (streaming writer proven at ~236k records / ~946 MB SQL, measured during the 2026-06 JOYSOUND candidate dry-run). |
| `scripts/` | `@karaoke/scripts` | Post-crawl data pipeline, validation, PDF ingest, title_ko backfill tooling, and their Vitest + Python unittest suites. `corepack pnpm --filter @karaoke/scripts test` runs the JS tests. |

## Data flow (end to end)

Sources (each an adapter in `packages/crawler/src/adapters/`):

1. **`jpop-playlist-blog`** — Tistory blog crawl (~21k records). The main
   source of Korean titles/artists and of KY + JOYSOUND vendor numbers.
2. **`tj-media-direct`** — TJ Media public catalog API (~3.8k admitted
   records). Every candidate runs through the 7-step Japanese-relevance
   filter chain (`adapters/tj-media-direct/filterSteps.ts`; order is
   load-bearing — see PROJECT-KNOWLEDGE).
3. **`tjpdf-*` PDF post-step** — `scripts/ingest_anisong_pdf.py` inserts
   PDF-only records (~600) for anime-songbook coverage. Coverage-only: no
   tagging.

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
  `--skip-download-if-valid`. Shared consumer for local dev, D1 import, and
  the self-host SQLite build.

The release-publishing workflow and the first publish/import land in
follow-up PRs (see [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) item 1).

## Two search paths

1. **Offline / bundled (MiniSearch)** — `apps/web/src/lib/search.ts` builds a
   MiniSearch index over 5 fields (`title_primary`, `title_ko`,
   `artist_primary`, `artist_ko`, `artist_aliases`) from the bundled
   `songs.json`. Always available; the fallback path.
2. **API-first (Worker + D1)** — when `PUBLIC_KARAOKE_API_BASE_URL` is set at
   build time, Browse searches call the Worker `GET /api/search` (D1-backed
   custom index: token/prefix/n-gram/Hangul-initials tables built by
   `@karaoke/data-store`). The Worker currently accepts **one** vendor filter
   per request; the web app falls back to the bundled MiniSearch index when
   the API is absent/unreachable or multiple vendor chips are selected, and
   the favorites tab is always served locally.

A self-hosted Node variant of the same API exists
(`apps/worker/src/node-server.ts`, `pnpm --filter @karaoke/worker serve:node`)
as the escape hatch if D1 free-tier limits bind (see OPEN-QUESTIONS).

## CI workflows (`.github/workflows/`)

All third-party actions are pinned by 40-char SHA with the tag in a trailing
comment; upgrades must update both. Every job bootstraps through the shared
composite action `.github/actions/setup` (pnpm + Node from `.nvmrc` + frozen
lockfile install).

- **`ci.yml`** (every PR + main push): `pnpm lint` / `typecheck` / `test` /
  `build`; sidecar-drift gate (auto-generated JSON sidecars must be
  byte-identical to their committed versions after the build); Python
  unittest suites (`python -m unittest discover -s scripts -p "test_*.py"`);
  `d1:verify-sql` (exports D1 SQL from the committed corpus — this
  **schema-validates every committed record on every PR** — then checks SQL
  statement-size metrics); Worker deploy dry-run.
- **`crawl.yml`** (weekly cron + dispatch): build, sidecar-drift gate, full
  crawl into `songs.json.tmp`, then `run-post-crawl-pipeline.mjs`, then opens
  a PR labeled `crawl-output` (requires the repo setting "Allow Actions to
  create and approve pull requests"). Data lands on `main` by PR review,
  never by direct push.
- **`deploy.yml`** (main push + dispatch): `build` job (API-first env var set)
  → `e2e` job (Playwright against `astro preview` serving the exact build
  artifact) → `deploy` job with `needs: [build, e2e]`. **e2e is a required
  gate** — a red e2e blocks the Pages deploy.

## JOYSOUND status (one-liner)

A `joysound-official` adapter + full-catalog sweep exists on a feature branch
(spec: `docs/superpowers/specs/2026-06-09-joysound-full-catalog-sweep-design.md`
on that branch) but **no `joysound-*` records are in the corpus yet** — the
existing JOYSOUND vendor numbers are blog-sourced. The ~291k-row full-catalog
merge is blocked on the data-topology decision and owner checkpoints tracked
in [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md).
