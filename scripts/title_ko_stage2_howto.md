# title_ko backfill — Stage 2 operator howto

Stage 2 has three phases: **prep** (deterministic Node script), **agent
dispatch** (Claude Code session, parallel subagents), **merge**
(deterministic Node script).

## Step 1 — Prep

```
node scripts/translate_title_ko_via_agents.mjs prep \
  apps/web/public/data/songs.json \
  scripts/data
```

Writes `scripts/data/llm-translations-chunk-NN-input.json` for each
chunk.

## Step 2 — Dispatch agents (Claude Code session)

In a Claude Code session, ask: "Run Stage 2 of the title_ko backfill."
Claude will:
1. List the chunk-input files.
2. Dispatch one Opus subagent per chunk in parallel via the Task tool.
3. Each subagent reads its chunk-input file, runs the worker prompt
   from `scripts/title_ko_stage2_worker_prompt.md`, and writes its
   chunk-output file at the matching
   `llm-translations-chunk-NN.json` path.
4. Wait for all subagents to return.

Wall-clock: ~5-15 min depending on web-search rate.

## Step 3 — Merge

```
node scripts/translate_title_ko_via_agents.mjs merge \
  apps/web/public/data/songs.json \
  scripts/data
```

Reads all `llm-translations-chunk-*.json`, applies decisions to the
corpus (atomic write), writes `scripts/data/llm-review.csv` with the
low-confidence subset for human spot-check.

## Verifying

After merge:
```
node scripts/validate-songs-json.mjs apps/web/public/data/songs.json
corepack pnpm --filter @karaoke/web build
```

Both should be clean. Inspect `scripts/data/llm-review.csv` for any
medium/low-confidence records you want to override manually before
committing.

## Running the orchestrator's tests

The repo doesn't have a root-level vitest config — vitest is hoisted into per-package `node_modules` only. To run the orchestrator's tests, invoke vitest from one of the workspace packages with `--root` pointing at the repo root.

PowerShell (this host's default):

```powershell
Set-Location packages/crawler
corepack pnpm exec vitest run `
  --root=(Resolve-Path ..\..).Path `
  scripts/translate_title_ko_via_agents.test.mjs
```

bash / WSL / macOS / Linux:

```bash
cd packages/crawler
corepack pnpm exec vitest run \
  --root="$(realpath ../..)" \
  scripts/translate_title_ko_via_agents.test.mjs
```

Note the path math: starting from `packages/crawler`, the repo root is two parents up (`../..`), not one. Vitest resolves the positional path argument relative to `--root`, so `scripts/translate_title_ko_via_agents.test.mjs` ends up correctly pointing at `<repo-root>/scripts/translate_title_ko_via_agents.test.mjs`.
