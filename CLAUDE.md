## Core Principles

- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **Minimal Impact**: Changes should only touch what's necessary. Avoid introducing bugs.

## Project Facts

- Repo: https://github.com/ghkim887/karaoke-search (public, MIT, default branch `main`).
- Live site: https://ghkim887.github.io/karaoke-search/ (GitHub Pages, Astro `base: '/karaoke-search/'`).
- Stack: pnpm + TypeScript + Astro + MiniSearch (frontend); cheerio + undici + robots-parser (crawler); Biome, Vitest, Playwright.
- v1 primary data source: https://j-pop-playlist.tistory.com — artist summary posts. Parser contract in design spec.
- Spec & plan: `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`, `docs/superpowers/plans/YYYY-MM-DD-<topic>-plan.md`.

## Module Map

- `apps/web/` — Astro static site with one Preact island (`App.tsx`). Search via MiniSearch (4-field index — `title_primary`, `title_ko`, `artist_primary`, `artist_ko`; no romaji). Reads `apps/web/public/data/songs.json`.
- `packages/schema/` — universal `SongRecord` type + Ajv validator. Compiled artifact at `packages/schema/dist/`. Both crawler and web depend on it.
- `packages/crawler/` — pluggable adapter pipeline. `Crawler` interface yields `SongRecord` directly (each adapter does its own normalize). v1 adapter is `jpop-playlist-blog`. CLI at `packages/crawler/dist/cli.js` after build.

## Quick Commands

Use `corepack pnpm` — plain `pnpm` is not always on PATH on this Windows host.

```bash
corepack pnpm install
corepack pnpm -r build                              # builds schema, crawler, web (with bundle-size guard)
corepack pnpm --filter @karaoke/web dev             # http://localhost:4321/karaoke-search/
corepack pnpm --filter @karaoke/web test            # vitest
corepack pnpm --filter @karaoke/crawler test
corepack pnpm --filter @karaoke/crawler start --source jpop-playlist-blog --limit 5 --out apps/web/public/data/songs.json
corepack pnpm exec biome check .
```

E2E (manual, after `playwright install chromium`):

```bash
E2E_BASE_URL=https://ghkim887.github.io/karaoke-search/ corepack pnpm --filter @karaoke/web test:e2e
```

## Gotchas

- `--limit N` on the crawler caps **artist pages per adapter**, not output records. `BlogCrawler` round-robins jpop+vocaloid artists then appends mixed.
- `apps/web/public/data/songs.json` (~9 MB, 21k+ records) is **tracked on `main`**. The deploy needs it baked into the build. Do NOT re-add it to `.gitignore`.
- Playwright e2e tests must use `await page.goto('')` (relative empty). `goto('/')` resolves the absolute path against the base, sending Playwright to the bare `github.io` domain (404).
- Schema runtime imports require `pnpm -r build` first — `@karaoke/schema` exports `dist/index.js`, not `src/index.ts`. CI builds with `pnpm -r build` before `pnpm start`.
- The blog adapter pulls artist names from the first `<blockquote>` in the post body. Posts without one (ranking lists, info posts) fall through; the index-parser filters known non-artist patterns (`랭킹|순위|차트|월간|연간|...`).
- Crawl workflow opens a PR labeled `crawl-output`; the GitHub repo setting **"Allow Actions to create and approve pull requests"** must be on, else the PR-create step fails.
- HTTP rate limit in `packages/crawler/src/http.ts` is 200ms base + ±50ms jitter (~4–6 req/sec). Tuned for tistory.com; revisit per host if adding adapters.

## Git Conventions

- Conventional-commit prefixes: `docs:`, `chore:`, `feat:`, `fix:`, `refactor:`, `test:`, `ci:`, `ui:`.
- Commit body via HEREDOC; include `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` trailer.
- Stage paths explicitly. Never `git add -A` or `git add .`.
- Default branch `main`. Push to `origin`.

## Orchestration (Project Rule)

- Main thread is orchestrator only. Delegate every work item to a specialized agent: `executor` (code), `code-reviewer` (review), `planner` (plans/specs), `document-specialist` (external docs), `verifier` (verification evidence), `explore` (codebase search), `git-master` (git ops).
- Never self-approve. Author and review are always separate agent passes.
- Trivial single-tool calls in service of orchestration (a single Read to route work, a Write of a memory entry) are OK from the main thread; everything else delegates.
