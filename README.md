# Karaoke Search 🎤

A bilingual web app for discovering Japanese and Vocaloid karaoke songs available on Korean karaoke systems.

## What is this?

Karaoke Search lets you find ~26,400 Japanese karaoke songs by title (Japanese or Korean), artist name, and karaoke system (TJ, 금영, JOYSOUND). Click any result to copy its karaoke number straight to your clipboard. Mobile-first, light + dark themes (auto via OS preference), no sign-up required.

**Live:** https://ghkim887.github.io/karaoke-search/

## Features

- **Bilingual search** — Korean primary UI with English subtitles + a footer data-accuracy disclaimer; search by Japanese title, Korean title, or artist name (Japanese/Korean/Latin romanization)
- **Multi-system support** — TJ Media (TJ), 금영 (KY), JOYSOUND karaoke numbers in one place
- **Click-to-copy** — Copy karaoke numbers with a single tap
- **Mobile-first, light + dark themes** — Optimized for phone screens with single-line horizontal-scroll chip rows; auto-switches via OS preference (`prefers-color-scheme`); works offline after first load. Self-hosted Geist + Inter + Pretendard fonts.
- **~26,400 songs live** — blog + TJ Media + anime songbook combined corpus; 250+ artists indexed and cross-referenced
- **Device-local favorites** — star songs and find them instantly on a dedicated `즐겨찾기` tab (`검색` / `즐겨찾기`); stored in your browser, no account needed

## Data Sources & Attribution

This project pulls from two sources:

- **[j-pop-playlist.tistory.com](https://j-pop-playlist.tistory.com/)** (primary, ~21k records) — a Korean blog that meticulously catalogs Japanese karaoke songs and maps them to TJ, 금영, and JOYSOUND karaoke numbers. Provides Korean translations of every title and artist.
- **TJ Media catalog** (~5.9k additional records) — pulled directly via TJ Media's public-but-undocumented JSON API, anchored on TJ catalog numbers. Filtered to Japanese-relevance via a hiragana/katakana/Han heuristic plus a Chinese-artist denylist; titles already known to the blog are rescued back regardless.

We surface only metadata (titles, artists, numbers)—no lyrics, no fan content. Each result links back to its source, and all JSON records include `source_url` for full transparency. **A big thanks to the j-pop-playlist blog author for maintaining the original Korean-translation resource.**

## Architecture

A pnpm TypeScript monorepo with three core packages:

- **`packages/schema`** — Universal `SongRecord` type + Ajv validator (3 categories: `jpop` / `vocaloid` / `anime`). Ensures consistent data across crawler and web app.
- **`packages/crawler`** — Pluggable adapter pipeline with two registered adapters today (`jpop-playlist-blog`, `tj-media-direct`). A two-tier merger reconciles records by shared vendor numbers first, then fuzzy title/artist match. Crawls weekly via GitHub Actions.
- **`apps/web`** — Astro static site with a Preact search island and MiniSearch full-text indexing. Deployed to GitHub Pages.

Stack: pnpm + TypeScript + Astro + Preact + MiniSearch (frontend); cheerio + undici + wanakana + robots-parser (crawler); Biome + Vitest + Playwright (tooling).

## Local Development

### Setup

```bash
corepack enable
pnpm install
```

### Run the web app

```bash
pnpm --filter @karaoke/web dev
```

Open http://localhost:4321

### Test the crawler

```bash
pnpm --filter @karaoke/crawler start --source jpop-playlist-blog --limit 5
```

### Run all tests

```bash
pnpm test
```

Additional test suites:

```bash
# Python regression tests for the anisong PDF ingest (13 unittest cases)
python -m unittest scripts/test_ingest_anisong_pdf.py

# Validate the songs corpus against the @karaoke/schema type (CI gate)
node scripts/validate-songs-json.mjs apps/web/public/data/songs.json
```

## Deployment

The app auto-deploys to GitHub Pages whenever you push to `main`. Weekly GitHub Actions crawls fetch fresh data and open a pull request labeled `crawl-output` for review and merge. The deploy workflow also runs Playwright E2E tests as a parallel job against an in-CI `astro preview` server (using the build artifact) so regressions surface before the Pages deployment completes.

## Roadmap

- **v2 in progress** — Schema migration to 3 categories ✓ • Two-tier merger ✓ • TJ Media direct adapter ✓ • Frontend polish + favorites + mobile-first pass ✓ • Revolut-inspired UI refactor + auto light/dark theme ✓ • NamuWiki adapter (Vocaloid + Hololive/Nijisanji) remains
- **v3+** — Native crawlers for 금영 (KY) and JOYSOUND
- **Future** — Optional serverless live-fallback for queries that miss the static index (deferred indefinitely)

## License

MIT. See [LICENSE](LICENSE).

## Acknowledgments

Thanks to the [j-pop-playlist blog author](https://j-pop-playlist.tistory.com/) for the source data, to the project team for building this, and to Claude Code for pair-programming support.
