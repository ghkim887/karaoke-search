# Karaoke Search 🎤

Karaoke Search finds Japanese, Vocaloid, and anime karaoke songs across TJ,
KY, and JOYSOUND. The public app is [karaokedb.pages.dev](https://karaokedb.pages.dev/).
It stores song metadata, source links, and catalog numbers, not lyrics or audio.

Search by title, artist, Korean text, romanized text, reading, initials, or
karaoke number. Vendor chips select an OR filter: TJ + KY means a song with
either number. Number badges copy to the clipboard. The interface supports
Korean, English, and Japanese; favorites are device-local, with no account.

## Current state

Verified 2026-09-23 against the v26 production SQLite database, the public
API, and the committed offline bundle. These are dated measurements.

| Artifact | Current contents |
| --- | --- |
| Serving release | v26, `data-2026-09-18-v26-tj-refresh` |
| Serving corpus | 312,701 songs |
| Vendor coverage | TJ 6,590; KY 4,787; JOYSOUND 312,147; counts overlap |
| Bundled offline corpus | 26,660 songs, 11,355,330 bytes |
| API `dbUpdatedAt` | `2026-09-18`, derived from source crawl timestamps |
| Scheduled crawl | `disabled_manually`; indefinite hold remains in effect |

The offline bundle contains every serving row with a TJ number, a KY number,
or a `blog-*` ID. It is a subset of the serving corpus, not the full catalog.
The committed bundle SHA-256 is
`4f17560f7bc97a0b62354e06b937e8914c640e6390930a8ab7856e6ecab1c105`.

v26 adds 479 TJ numbers from a September 18 TJ-only refresh to v25: 349
attach to existing rows and 130 are new `tj-*` rows. Seven TJ display
corrections are included. Every v25 ID and KY/JOYSOUND number is retained.

## Verification evidence

The September 23 promotion check passed SQLite `quick_check`, found no lost
v25 ID or vendor number, and served TJ 90146 / JOYSOUND 432954 and the
unchanged TJ 26145 / KY 40449 / JOYSOUND 1546 record through the public proxy.
All 26,660 bundled records validated against the schema.

- [Feature-commit CI](https://github.com/ghkim887/karaoke-search/actions/runs/29739957509):
  2,263 JS/TS tests, 76 Python tests, and two E2E tests passed on July 20.
  This is the historical feature-build result, not a new full-suite run.
- NAS `runs/tj-refresh-20260918-141901/` holds the v26 TJ collection, change
  report, and per-number attach decisions; the release directory holds
  `update-report.json` and `SHA256SUMS`.
- NAS `runs/ky-v23-20260716/` holds v23–v25 reconstruction and comparison
  reports; `audit-v25/unmerged-xref.json` records the 424 residual decisions.
- [Merge evidence](scripts/data/b-review-merge-verdicts/) and
  [leak-review evidence](scripts/data/leak-review-verdicts/README.md) retain
  the number-level decisions used by v25.

## Documentation

- [Architecture](docs/ARCHITECTURE.md): components, data flow, search, deployment.
- [Project knowledge](docs/PROJECT-KNOWLEDGE.md): failure cases and data invariants.
- [Roadmap](docs/ROADMAP.md): remaining work and completed scope decisions.
- [UI design](DESIGN.md): implemented tokens, typography, and layout constraints.
- [Script catalog](scripts/README.md): data preparation and audit tools.

The parent NAS directory has a separate `README-ops.md` describing live paths.
Only `app/` is a Git repository; its parent also holds production data.

## Architecture

| Workspace | Role |
| --- | --- |
| `apps/web` | Astro static pages, Preact search UI, MiniSearch fallback, PWA |
| `apps/worker` | Self-hosted Node HTTP API over a prebuilt SQLite database |
| `packages/schema` | TypeBox-derived SongRecord types and Ajv validation |
| `packages/search` | Shared normalization, number parsing, initials, transliteration |
| `packages/crawler` | Blog/TJ/KY/JOYSOUND adapters, classifiers, alias resolution, merger |
| `packages/data-store` | SQLite schema, import/export, derived search index, delta patching |
| `scripts` | Corpus cleanup, translation-cache replay, audits, bundle extraction |

The `worker` name is historical. Cloudflare Workers/D1 serving was removed;
the current API runs on OCI. Cloudflare Pages serves the web app and its
Functions proxy `/api/*` and `/healthz` through Tailscale Funnel to that API.

When `PUBLIC_KARAOKE_API_BASE_URL` is configured, searches and favorite-record
lookups use the API. Multiple vendor chips remain on the API path. Favorite
IDs live in `localStorage`; `/api/songs` retrieves their current metadata.

An API failure triggers a lazy load of `data/songs.json` and local MiniSearch.
The service worker caches the shell separately from the corpus. Normal API
use does not pre-download the corpus: a fully offline first fallback with no
cached corpus can still fail. Offline coverage is limited to the bundle above.

## Local development

Requirements: Node.js **24 or newer** (`.nvmrc`: 24), Corepack, and
`pnpm@9.15.4`. Some data tools also use Python.

```sh
corepack pnpm install
corepack pnpm build
corepack pnpm --filter @karaoke/web dev
```

The development site is at `http://localhost:4321`. Workspace runtime imports
use compiled `dist/` packages, so the initial build supplies those dependencies.

```sh
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm -r --no-bail test
corepack pnpm build
corepack pnpm knip
python -m unittest discover -s scripts -p 'test_*.py'
```

`--no-bail` lets each package finish even if an earlier package fails. A
successful build also runs the web bundle-size and API-base checks.

For a local API:

```sh
corepack pnpm --filter @karaoke/worker run sqlite:build
corepack pnpm --filter @karaoke/worker build
KARAOKE_SQLITE_DB_PATH="$(pwd)/apps/worker/.build/sqlite/songs.sqlite" \
  corepack pnpm --filter @karaoke/worker run serve:node
```

The environment assignment above is POSIX-shell syntax, run from the repo
root. In PowerShell, set `$env:KARAOKE_SQLITE_DB_PATH` to the absolute DB path
before running `serve:node`. pnpm runs the script in `apps/worker`, so a DB
path relative to the repo root would otherwise resolve incorrectly. The default build
uses the bundled corpus; it does not recreate the full production catalog.

Set `PUBLIC_KARAOKE_API_BASE_URL=http://127.0.0.1:8787` when starting the web
development server to use that API. Without the variable, the web app uses
the local bundle.

## Data updates

The default crawl registers the Tistory blog, TJ Media, and KY kysing adapters.
JOYSOUND full-catalog collection is a separate opt-in lane. The crawl workflow
is currently disabled even though its YAML retains a weekly cron and dispatch
entry. Source output needs the post-processing chain in
`scripts/run-post-crawl-pipeline.mjs`; raw crawl output is not a release.

When a new full serving corpus is available, the bundle is reproducible with:

```sh
node scripts/extract-offline-subset.mjs \
  --corpus <full-corpus.json> --out apps/web/public/data/songs.json
node scripts/validate-songs-json.mjs apps/web/public/data/songs.json
```

The search-parity snapshot records the corpus hash. A corpus update therefore
also needs a regenerated snapshot and an assessment of per-query ranking
changes; the relevant command and limitations are in the architecture guide.

The full corpus and serving SQLite live on the NAS, outside Git. Git retains
the offline bundle, translation caches, curated corrections, and audit evidence.
The former GitHub Release-asset distribution tooling was retired on 2026-07-13.

## Deployment

Cloudflare Pages project: `karaokedb`. GitHub Pages is intentionally disabled. Production
uploads use the `apps/web` directory so Wrangler includes its `functions/`:

```sh
PUBLIC_SITE_URL=https://karaokedb.pages.dev \
PUBLIC_BASE_PATH=/ PUBLIC_KARAOKE_API_BASE_URL=/ \
  corepack pnpm --filter @karaoke/web build

cd apps/web
corepack pnpm dlx wrangler@latest pages deploy dist \
  --project-name karaokedb --branch main
```

These are POSIX-shell examples. Uploading only static assets without Functions
can leave the page visible while search fails; `/healthz`, `/api/meta`, and
`/api/search` exercise the public proxy chain. The self-host release build is
`apps/worker/scripts/build-sqlite-db.mjs`, with explicit full-corpus input and
`--search-hints data/search-hints.jsonl` for the curated search-only hints.

Primary metadata sources are [j-pop-playlist.tistory.com](https://j-pop-playlist.tistory.com/),
TJ Media, KY kysing, and JOYSOUND. The blog supplies substantial Korean metadata
and cross-vendor mappings. Each SongRecord retains a source URL.

## License

[MIT](LICENSE).
