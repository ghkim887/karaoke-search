# title_ko backfill — Stage 2 operator howto

Stage 2 has three phases: **prep** (deterministic Node script), **agent
dispatch** (Claude Code session, parallel subagents), **merge**
(deterministic Node script).

## Step 1 — Prep

> **Note:** Stage 1 (`scripts/normalize_tj_title_ko.py`) MUST have been applied to the corpus before Stage 2 runs. Stage 2 only processes records where `title_ko === null`; if Stage 1 hasn't run, TJ records still carry phonetic transliterations and Stage 2 will silently skip them (the `prep` stats will show `0/N eligible`).

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
  scripts/data \
  --review-csv scripts/data/llm-review.csv
```

Reads all `llm-translations-chunk-NN.json` (output files only — the
`-input` files are ignored), applies decisions to the corpus (atomic
write), and — when `--review-csv` is passed — writes the review CSV
with the medium/low-confidence subset for human spot-check. The CI
cache-replay invocation (`scripts/run-post-crawl-pipeline.mjs`, step
`title-ko-stage2-replay`) runs `merge` without `--review-csv`.

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

`scripts/` is the `@karaoke/scripts` workspace package with its own vitest
config; its test script also builds the crawler first (some script tests
import the crawler dist):

```bash
corepack pnpm --filter @karaoke/scripts test
```

To run only this orchestrator's suite:

```bash
corepack pnpm --filter @karaoke/scripts exec vitest run translate_title_ko_via_agents.test.mjs
```
