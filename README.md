# Karaoke Search 🎤

Karaoke Search is a bilingual static web app for finding Japanese, Vocaloid, and anime karaoke songs on Korean karaoke systems.

**Live site:** https://ghkim887.github.io/karaoke-search/

The app is optimized for quick phone use at karaoke: search a song, filter by karaoke brand, tap a number, and paste it into the machine.

## How to use the site

1. Open the [live site](https://ghkim887.github.io/karaoke-search/).
2. Search by Japanese title, Korean title, artist name, or romanized text.
3. Narrow results with category chips (`J-pop`, `Vocaloid`, `Anime`) or vendor chips (`TJ`, `KY`, `JOYSOUND`).
4. Tap a karaoke number badge to copy it to your clipboard.
5. Star songs to keep them in the device-local `즐겨찾기` tab.
6. Check the footer for the last committed DB update date, then verify on the actual karaoke machine if the number is critical.

No account is required. Favorites are stored only in your browser.

## Current data snapshot

The current checked-in corpus contains **25,902 songs** from two main sources:

| Source | Records | Notes |
| --- | ---: | --- |
| j-pop-playlist.tistory.com | 21,390 | Korean blog source with TJ/KY/JOYSOUND mappings and Korean title/artist metadata. |
| TJ Media catalog | 4,512 | TJ public catalog API records admitted through Japanese-relevance filters and cache-backed rescue rules. |

Category coverage:

| Category | Records |
| --- | ---: |
| J-pop | 20,263 |
| Vocaloid | 3,238 |
| Anime | 2,401 |

Vendor-number coverage, with overlap because one song can have multiple karaoke systems:

| Vendor | Records with number |
| --- | ---: |
| JOYSOUND | 20,897 |
| TJ | 6,160 |
| KY | 1,244 |

Korean metadata coverage:

- `title_ko`: 17,952 records
  - 15,390 from the blog source
  - 2,560 LLM-translated TJ-only titles
  - 2 manual fixes
- `media_context_ko`: 1,008 records with salvaged Korean anime/OST/OP/ED context
- `artist_aliases`: 1,893 records with normalized alias metadata

## Data sources and attribution

This project stores and serves metadata only: song titles, artists, karaoke numbers, categories, source URLs, and crawl timestamps. It does **not** host lyrics or fan content.

Primary sources:

- [j-pop-playlist.tistory.com](https://j-pop-playlist.tistory.com/) — the main Korean-language mapping source for Japanese karaoke songs across TJ, KY, and JOYSOUND.
- TJ Media's public catalog API — used for additional TJ-only catalog coverage.

The crawler also applies post-processing and quality gates, including:

- schema validation with `@karaoke/schema`
- category exclusivity rules (`jpop`, `vocaloid`, `anime`)
- TJ Japanese-relevance filters
- Korean/C-pop leak drop lists
- artist alias normalization
- anime songbook section-tag enrichment
- cached LLM Korean-title replay and manual title fixes
- stale TJ search-cache pruning

A big thanks to the j-pop-playlist blog author for maintaining the source resource this project builds on.

## Architecture

This is a pnpm + TypeScript monorepo.

| Path | Purpose |
| --- | --- |
| `apps/web` | Astro static site with a Preact search island and MiniSearch client-side index. |
| `packages/schema` | Shared `SongRecord` schema, category definitions, and Ajv validation. |
| `packages/category-rules` | Shared category priority/exclusivity rules used by crawler scripts. |
| `packages/crawler` | Adapter-based crawler pipeline and two-tier record merger. |
| `scripts/` | Data post-processing, validation, PDF ingest, translation-cache replay, and regression tests. |
| `.github/workflows/crawl.yml` | Weekly/dispatch data refresh workflow that opens crawl-output PRs. |
| `.github/workflows/deploy.yml` | GitHub Pages build/deploy workflow for `main`. |

Frontend stack: Astro, Preact, MiniSearch, self-hosted Geist/Inter/Pretendard fonts.

Crawler/tooling stack: TypeScript, undici, cheerio, robots-parser, Ajv, Python data scripts, Biome, Vitest, Playwright.

## Local development

Requirements:

- Node.js **24** (`.nvmrc` is `24`)
- Corepack-enabled pnpm (`pnpm@9.15.4`)

Install dependencies:

```bash
corepack enable
corepack pnpm install
```

Run the web app locally:

```bash
corepack pnpm --filter @karaoke/web dev
```

Then open http://localhost:4321.

Run checks:

```bash
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

Useful focused checks:

```bash
# Web unit tests
corepack pnpm --filter @karaoke/web test

# Web production build + bundle-size check
corepack pnpm --filter @karaoke/web build

# Crawler tests
corepack pnpm --filter @karaoke/crawler test

# Python regression tests for data scripts
python -m unittest discover scripts -p "test_*.py"

# Validate the committed corpus against the schema
node scripts/validate-songs-json.mjs apps/web/public/data/songs.json
```

## Working with crawler data

For small local smoke tests, write output to an ignored scratch path instead of overwriting the committed corpus:

```bash
node -e "require('node:fs').mkdirSync('.cache', { recursive: true })"
corepack pnpm --filter @karaoke/crawler start -- --source jpop-playlist-blog --limit 5 --out .cache/blog-smoke.json
```

Run `corepack pnpm --filter @karaoke/crawler start -- --help` for CLI options.

Important: the raw crawler output is **not** the final product data. The production corpus is produced by the full workflow in `.github/workflows/crawl.yml`, which runs the crawler and then replays the post-processing stack listed above. For real data updates, prefer GitHub Actions `workflow_dispatch` or the scheduled weekly crawl PR, review the diff, then merge.

If you intentionally update `apps/web/public/data/songs.json` locally, replay the same post-processing steps from `crawl.yml` before committing, then run schema validation.

## Deployment

Pushing to `main` triggers `.github/workflows/deploy.yml`:

1. install dependencies with pnpm
2. build all packages
3. build the Astro static site
4. upload `apps/web/dist` to GitHub Pages
5. run Playwright E2E against the built artifact in a parallel verification job

The weekly crawl workflow runs separately and opens a `crawl-output` pull request instead of pushing data directly to `main`.

### Cloudflare Worker/D1 import workflow

The D1-backed API lives in `apps/worker`. Local D1 state and generated SQL dumps are scratch artifacts under `apps/worker/.wrangler/` and must not be committed.

```bash
# Generate a D1 import dump from the committed product corpus. The dump omits schema;
# apply migrations first so Wrangler/D1 owns schema changes.
corepack pnpm --filter @karaoke/worker run d1:export-sql

# Local smoke database.
corepack pnpm --filter @karaoke/worker run d1:migrate:local
corepack pnpm --filter @karaoke/worker run d1:import:local
```

Remote D1 mutations are guarded. Before running the remote scripts, replace the placeholder `database_id` in `apps/worker/wrangler.toml`, verify the target Cloudflare account/database, then set `KARAOKE_D1_REMOTE_OK=1` for the command:

```bash
KARAOKE_D1_REMOTE_OK=1 corepack pnpm --filter @karaoke/worker run d1:migrate:remote
KARAOKE_D1_REMOTE_OK=1 corepack pnpm --filter @karaoke/worker run d1:import:remote
```

PowerShell equivalent:

```powershell
$env:KARAOKE_D1_REMOTE_OK = '1'
corepack pnpm --filter @karaoke/worker run d1:migrate:remote
corepack pnpm --filter @karaoke/worker run d1:import:remote
```

Do not use the remote D1 scripts from feature branches unless you intentionally want to mutate that D1 database; static GitHub Pages deployment still only happens from `main`.

## License

GNU Affero General Public License v3.0 or later (`AGPL-3.0-or-later`). See [LICENSE](LICENSE).

If you modify this project and let users interact with it over a network, the AGPL requires you to offer those users access to the corresponding source code.
