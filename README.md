# Karaoke Search 🎤

A bilingual web app for discovering Japanese and Vocaloid karaoke songs available on Korean karaoke systems.

## What is this?

Karaoke Search lets you find 21,000+ Japanese karaoke songs by title (Japanese or Korean), artist name, and karaoke system (TJ, 금영, JOYSOUND). Click any result to copy its karaoke number straight to your clipboard. Mobile-first, dark mode, no sign-up required.

**Live:** https://ghkim887.github.io/karaoke-search/

## Features

- **Bilingual search** — Korean and Japanese UI; search by Japanese title, Korean title, or artist name (Japanese/Korean/Latin romanization)
- **Multi-system support** — TJ Media (TJ), 금영 (KY), JOYSOUND karaoke numbers in one place
- **Click-to-copy** — Copy karaoke numbers with a single tap
- **Mobile-first dark mode** — Optimized for phone screens; works offline after first load
- **21,000+ songs** — 250+ artists indexed and cross-referenced
- **Attributions** — Every result links back to its source post

## Data Source & Attribution

This project crawls [j-pop-playlist.tistory.com](https://j-pop-playlist.tistory.com/), a Korean blog that meticulously catalogs Japanese karaoke songs and maps them to TJ, 금영, and JOYSOUND karaoke numbers. We surface only metadata (titles, artists, numbers)—no lyrics, no fan content. Each result links back to the original post, and all JSON records include `source_url` for full transparency. **A big thanks to the blog author for maintaining this invaluable resource.**

## Architecture

A pnpm TypeScript monorepo with three core packages:

- **`packages/schema`** — Universal `SongRecord` type + Ajv validator. Ensures consistent data across crawler and web app.
- **`packages/crawler`** — Pluggable adapter pattern. v1 source is j-pop-playlist.tistory.com. Crawls weekly via GitHub Actions.
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

- **v2** — TJ Media direct crawler for long-tail songs the blog misses
- **v3+** — Native crawlers for 금영 (KY) and JOYSOUND
- **Future** — Optional serverless live-fallback for queries that miss the static index (deferred indefinitely)

## License

MIT. See [LICENSE](LICENSE).

## Acknowledgments

Thanks to the [j-pop-playlist blog author](https://j-pop-playlist.tistory.com/) for the source data, to the project team for building this, and to Claude Code for pair-programming support.
