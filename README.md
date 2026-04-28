# Karaoke Search 🎤

A bilingual web app for discovering Japanese and Vocaloid karaoke songs available on Korean karaoke systems.

## What is this?

Karaoke Search lets you find ~21,000 Japanese karaoke songs by title (Japanese or Korean), artist name, and karaoke system (TJ, 금영, JOYSOUND). Click any result to copy its karaoke number straight to your clipboard. Mobile-first, dark mode, no sign-up required. (v2 adds a TJ Media adapter; combined corpus of ~25,675 records ships in Phase 5.)

**Live:** https://ghkim887.github.io/karaoke-search/

## Features

- **Bilingual search** — Korean and Japanese UI; search by Japanese title, Korean title, or artist name (Japanese/Korean/Latin romanization)
- **Multi-system support** — TJ Media (TJ), 금영 (KY), JOYSOUND karaoke numbers in one place
- **Click-to-copy** — Copy karaoke numbers with a single tap
- **Mobile-first dark mode** — Optimized for phone screens; works offline after first load
- **~21,000 songs live** — 250+ artists indexed and cross-referenced (blog source); combined corpus ~25,675 records ships in Phase 5
- **Attributions** — Every result links back to its source post

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

## Deployment

The app auto-deploys to GitHub Pages whenever you push to `main`. Weekly GitHub Actions crawls fetch fresh data and open a pull request labeled `crawl-output` for review and merge.

## Roadmap

- **v2 in progress** — Schema migration to 3 categories ✓ • Two-tier merger ✓ • TJ Media direct adapter ✓ • NamuWiki adapter (Vocaloid + Hololive/Nijisanji) and frontend chip refinement remain
- **v3+** — Native crawlers for 금영 (KY) and JOYSOUND
- **Future** — Optional serverless live-fallback for queries that miss the static index (deferred indefinitely)

## License

MIT. See [LICENSE](LICENSE).

## Acknowledgments

Thanks to the [j-pop-playlist blog author](https://j-pop-playlist.tistory.com/) for the source data, to the project team for building this, and to Claude Code for pair-programming support.
