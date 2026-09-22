# Architecture

Current implementation checked at `4e37fa1` on 2026-09-17. Release measurements
are in [the README](../README.md#current-state); incident details are in
[PROJECT-KNOWLEDGE.md](PROJECT-KNOWLEDGE.md).

## Workspaces

| Workspace | Package | Responsibility |
| --- | --- | --- |
| `apps/web` | `@karaoke/web` | Astro + Preact UI, API backend, local MiniSearch, PWA |
| `apps/worker` | `@karaoke/worker` | Node HTTP API and SQLite release builder |
| `packages/schema` | `@karaoke/schema` | TypeBox SongRecord schema, derived types, Ajv validation |
| `packages/search` | `@karaoke/search` | Shared normalization, n-grams, initials, number parsing, kana transliteration |
| `packages/crawler` | `@karaoke/crawler` | Adapters, classification, aliases, multi-stage record merger |
| `packages/data-store` | `@karaoke/data-store` | SQLite schema, import/export, token index, delta updates |
| `scripts` | `@karaoke/scripts` | Corpus processing, diagnostics, evidence conversion, translation replay |

Toolchain: Node >=24, pnpm 9.15.4 workspaces, TypeScript, Biome, Vitest,
Playwright, and Python for selected data scripts. Runtime workspace imports
resolve compiled `dist/` output.

## Sources and corpus preparation

Default adapters (`packages/crawler/src/adapters/index.ts`):

- `jpop-playlist-blog`: Korean titles/artists and TJ/KY/JOYSOUND mappings.
- `tj-media-direct`: TJ catalog and exact-number enrichment, filtered for
  Japanese relevance. The ordered seven-step classifier includes explicit
  song overrides, nationality checks, artist checks, and blog rescue.
- `ky-kysing`: Japanese `karaoke-book` index walk over 107 reading/letter
  buckets. Deduplicates by KY number; a curated map recovers truncated titles.

`joysound-official` is opt-in. The standalone
`scripts/joysound-fullcatalog-listing.mjs` provides resumable complete listing
collection; detail sweeps enrich/classify those listings. A detail sweep
does not discover songs absent from its input listing. The regular crawl does
not refresh the full JOYSOUND catalog.

`tjpdf-*` is a retained ID convention. Its current coverage-only post-step is
`scripts/ingest-tjpdf-catalog.mjs`, fed by a committed TJ exact-number probe
catalog. PDF parsing is no longer part of the current pipeline.

Each adapter yields normalized SongRecords. The pipeline resolves artist
aliases before calling `mergeRecords`, validates the output, and writes the
corpus atomically. The ordered merger has tiers A–G plus reviewed three-way
attachment after F:

- A: shared vendor-number union.
- B: normalized title + artist.
- C: cross-source primary-token matching.
- D: guarded matching with title context suffixes removed.
- E/F: explicitly reviewed vendor-number pairs, including existing clusters.
- F attachment: reviewed TJ/KY addition to a JOYSOUND pair already owned by E/F.
- G: conservative automatic residual rules.

Reviewed cluster attachment checks the full union for vendor-number
collisions. The data model has one number per vendor per record, so genuine
double registrations can remain separate. ID/number priority
(`tj > tjpdf > joysound > ky > blog`) is independent of display-field
ownership (TJ-first primary text, blog-first Korean fields).

`scripts/run-post-crawl-pipeline.mjs` defines the twelve post-processing steps:
atomic rename, splitter parity, TJ catalog ingest, Korean-title Stage 1,
merger replay, Korean-artist leak cleanup, Chinese-artist leak cleanup,
translation-cache replay, manual Korean-title fixes, cache pruning, schema
validation, and blog/KY parity reporting. Translation-cache replay and the
blog/KY report are fail-soft; the other steps stop the chain on failure.

TJ/KY per-row classification logs and corpus cleanup decisions record the
reasons for admitted, dropped, or protected records. The crawl workflow
uploads these artifacts and includes attribution in its data PR.

## Data artifacts

- `apps/web/public/data/songs.json`: tracked offline subset and local development
  corpus; v26 has 26,660 rows (TJ number OR KY number OR `blog-*` ID).
- `apps/web/public/data/tj-search-cache.json`: tracked TJ enrichment cache.
- `data/search-hints.jsonl`: tracked search-only strings.
- `scripts/data/`: probe catalogs, reviewed decisions, translation caches,
  and manual corrections.
- NAS `db/releases/<release>/`: full corpus, derived SQLite, checksum manifest,
  and release evidence. NAS `db/current` is a symlink to one release.
- NAS `runs/`: crawl outputs, decision logs, comparisons, and audits.

The full serving corpus is not in Git. GitHub Release-asset distribution and
offsite backup plans were retired in July; the documented recovery path for
loss of every NAS release is rebuilding from retained inputs or re-crawling.

## Search and serving

Public request path:

```text
Browser -> Cloudflare Pages Function -> Tailscale Funnel -> OCI Node API -> SQLite
   |
   +-- API failure -> bundled songs.json -> browser MiniSearch
```

The Node server exposes `/healthz`; its handler exposes:

- `GET /api/search?q=...&vendor=tj,ky&limit=50`: OR-filtered vendor search,
  with `items` and `nextCursor` in the response.
- `GET /api/songs?ids=...`: record lookup for device-local favorite IDs;
  the web client batches at 100 IDs.
- `GET /api/meta`: `dbUpdatedAt`, derived from the latest source crawl timestamp.

The API adapter uses SQLite query-only mode. Search uses custom
`search_tokens`, `search_token_stats`, and `search_texts` tables, not FTS5.
Exact compact text ranks above weighted token matches. Number queries have
a dedicated path; selected vendors also constrain number matches. Shared
query expansion supports kana/romaji forms, while indexed ruby readings add
romaji and Hangul recall. Inputs longer than 256 code points are rejected at
the API edge.

`ApiBackend` handles both search and favorite-record lookup. `FallbackBackend`
tries the API first, then lazily loads the local corpus on failure. It tracks
fallback state separately for browse and favorites. Multiple vendor selection
does not trigger fallback. With no API configuration, `LocalBackend` loads the
bundle initially and all searches use MiniSearch.

The local index covers primary/Korean titles and artists, aliases, and three
ruby-derived fields, with auxiliary number/initials recall. API and local
ranking are different implementations. The golden parity test measures their
overlap and first-result behavior; it does not assert identical results.

Favorite IDs use `localStorage` key `karaoke-favorites:v1`. Search/filter
controls reset on tab changes; favorites persist. UI locale is separate from
the language and provenance of song metadata.

## PWA and offline limits

`apps/web/src/sw.ts` precaches the app shell and runtime-caches the corpus
(CacheFirst, seven-day expiry) and fonts (30-day expiry). The corpus is excluded
from shell precaching and is not fetched on a healthy API path. Without an
already cached corpus, a completely offline first fallback has no local data.
JOYSOUND-only rows outside the blog/TJ/KY subset are unavailable offline.

The former full offline SQLite/OPFS pack direction was retired in favor of the
subset. [Project knowledge](PROJECT-KNOWLEDGE.md#offline-size-and-parity)
records the measurements and search-parity limitations behind that choice.

Bundle extraction after a release uses `scripts/extract-offline-subset.mjs`.
The parity baseline pins the corpus hash; its regeneration command is:

```sh
UPDATE_PARITY_SNAPSHOT=1 corepack pnpm --filter @karaoke/web exec vitest run \
  src/lib/search-parity.golden.test.ts
```

This is POSIX-shell syntax. The resulting per-query changes need evaluation:
regenerating the file alone does not establish search quality.

## Search-only hints and release builds

The release entry point is:

```sh
node apps/worker/scripts/build-sqlite-db.mjs \
  --input <full-corpus.json> --output <candidate-release>/songs.sqlite \
  --search-hints data/search-hints.jsonl
```

Import validates every record and rejects duplicate IDs. Hint lines use
`{song_id, field, text, source, confidence}` and materialize low-weight
`title_hint`/`artist_hint` tokens. They do not change displayed artist aliases
or exported SongRecords. Omitting `--search-hints` from a full release rebuild
would lose their extra recall. `title_ruby` remains in corpus/export data and
index derivation; the API's serve projection does not return it.

## CI and deployment

- `ci.yml`: lint, typecheck, package tests, build, knip, generated-sidecar drift,
  Python tests, and SQLite build from the committed corpus. A separate job
  runs Playwright against a fallback-mode preview. The separate offline E2E
  script exists but is not invoked by this workflow.
- `crawl.yml`: weekly cron/dispatch definition, currently disabled at GitHub.
  When enabled, it generates a data PR with crawler regression and parity
  checks inside the generating job. JOYSOUND full-catalog collection remains
  separate.
- `liveness.yml`: public health/meta/search probes with retries. These check
  availability and response shape, not catalog freshness or completeness.

Production web uploads use Wrangler from `apps/web`, including `functions/`.
`wrangler.toml` points at `https://oci.tail04d970.ts.net`. GitHub Pages and the
former Cloudflare Workers/D1 deployment are retired. Promoting a self-host DB
changes the `db/current` symlink and restarts the API; a code merge alone does
not rebuild or promote that DB.
