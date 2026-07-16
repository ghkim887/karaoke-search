#!/usr/bin/env node
// Weekly post-crawl pipeline runner — extracted from `.github/workflows/crawl.yml`.
//
// Before this script existed, the order-load-bearing post-processing chain
// (atomic rename → splitter parity → tjpdf catalog ingest → Stage 1 title_ko
// strip → merger replay → KPOP drop → Cpop drop → Stage 2 LLM cache replay →
// manual title_ko fixes → cache prune → schema validation → blog↔KY parity
// report) lived ONLY as YAML step order in crawl.yml. It could not be run
// locally as one unit, and
// prose copies of the order kept drifting. This file is now the single source
// of truth for the chain; crawl.yml invokes it as one step.
//
// Usage:
//   node scripts/run-post-crawl-pipeline.mjs [--corpus <path>] [--skip <step-name>]... [--help]
//
//   --corpus  Corpus path (default: apps/web/public/data/songs.json, relative
//             to the repo root). When overridden, the resolved absolute path
//             is also exported to child steps as KARAOKE_SONGS_JSON so the
//             steps that read the default corpus path from the env
//             (tjpdf-catalog-ingest, replay-merger, drop-kpop-leaks,
//             drop-cpop-leaks, prune-artist-nationality-cache) operate on the
//             same file.
//             WARNING: the prune-artist-nationality-cache step ALWAYS mutates
//             the REAL apps/web/public/data/tj-search-cache.json — the cache
//             is not corpus-scoped, so --corpus does NOT redirect it. Restore
//             it via git after a throwaway run if you don't want the prune.
//   --skip    Skip a step by name (repeatable). Used e.g. locally where no
//             crawler tmp output exists: `--skip atomic-rename`.
//   --help    Print usage and exit 0.
//
// Behavior: steps run sequentially from the repo root, output streamed with
// banners. A non-zero exit stops the pipeline unless the step is marked
// `continueOnError` (logged loudly, pipeline continues — mirrors the YAML
// `continue-on-error: true` semantics). Exit code is non-zero iff any
// non-continueOnError step failed.

import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliInvocation } from './lib/cli.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, '..');

export const DEFAULT_CORPUS = 'apps/web/public/data/songs.json';

/**
 * Ordered step table. Mirrors the former crawl.yml steps EXACTLY: same
 * commands, same arguments, same order, same continue-on-error semantics.
 * `command` is an argv array spawned WITHOUT a shell (Windows/quoting safety).
 *
 * @param {string} corpus corpus path as passed on the CLI (kept verbatim in
 *   step argv so the default invocation is byte-identical to the old YAML).
 * @param {string} [filterDecisionsDir] when set (from the FILTER_DECISIONS_DIR
 *   env var in CI), the two drop-artist-leaks steps additionally emit a
 *   per-row drop decision log at `<dir>/<step-name>.jsonl` via --decisions-out.
 *   Unset (local runs) leaves every step's argv byte-identical to before.
 */
export function buildSteps(corpus = DEFAULT_CORPUS, filterDecisionsDir = undefined) {
  const node = process.execPath;
  // Append `--decisions-out <dir>/<step>.jsonl` ONLY when FILTER_DECISIONS_DIR
  // is set; otherwise an empty tail keeps the drop-step argv unchanged.
  const decisionsArgs = (stepName) =>
    filterDecisionsDir ? ['--decisions-out', join(filterDecisionsDir, `${stepName}.jsonl`)] : [];
  return [
    {
      // Preserves the YAML inline exactly:
      //   node -e "require('node:fs').renameSync('apps/web/public/data/songs.json.tmp','apps/web/public/data/songs.json')"
      name: 'atomic-rename',
      command: [
        node,
        '-e',
        `require('node:fs').renameSync(${JSON.stringify(`${corpus}.tmp`)},${JSON.stringify(corpus)})`,
      ],
    },
    {
      // Asserts clustering-rules.json splitterPattern matches the TS
      // SPLIT_RE_SOURCE byte-for-byte (TS ↔ Python parity).
      name: 'splitter-parity',
      command: ['python', '-m', 'unittest', 'scripts/test_splitter_parity.py'],
    },
    {
      // Coverage-only: inserts brand-new tjpdf-{code} records for TJ catalog
      // numbers absent from the corpus, from the committed TJ searchSong probe
      // catalog (scripts/data/tjpdf-catalog.jsonl). Offline + deterministic —
      // the network probe (scripts/probe-tjpdf-catalog.mjs) is run on-demand,
      // not here. Reads KARAOKE_SONGS_JSON for the corpus path.
      name: 'tjpdf-catalog-ingest',
      command: [node, 'scripts/ingest-tjpdf-catalog.mjs'],
    },
    {
      // Stage 1: strip transliteration title_ko from tj-/tjpdf- records.
      name: 'title-ko-stage1',
      command: ['python', 'scripts/normalize_tj_title_ko.py', corpus],
    },
    {
      name: 'replay-merger',
      command: [node, 'scripts/replay-merger.mjs'],
    },
    {
      name: 'drop-kpop-leaks',
      command: [
        node,
        'scripts/drop-artist-leaks.mjs',
        '--list',
        'korean',
        ...decisionsArgs('drop-kpop-leaks'),
      ],
    },
    {
      name: 'drop-cpop-leaks',
      command: [
        node,
        'scripts/drop-artist-leaks.mjs',
        '--list',
        'chinese',
        ...decisionsArgs('drop-cpop-leaks'),
      ],
    },
    {
      // Stage 2 LLM cache replay is a nice-to-have enhancement layer — if a
      // malformed cache file slips into a PR, we still want the weekly crawl
      // PR to open with the unsealed (un-translated) corpus. The next Stage 2
      // operator run fixes the cache.
      name: 'title-ko-stage2-replay',
      continueOnError: true,
      command: [node, 'scripts/translate_title_ko_via_agents.mjs', 'merge', corpus, 'scripts/data'],
    },
    {
      // Manual fixes are explicit user corrections — hard-fail.
      name: 'title-ko-manual-fixes',
      command: [
        node,
        'scripts/apply-manual-title-ko-fixes.mjs',
        corpus,
        'scripts/data/title-ko-manual-fixes.json',
      ],
    },
    {
      name: 'prune-artist-nationality-cache',
      command: [node, 'scripts/prune-artist-nationality-cache.mjs'],
    },
    {
      // Final gate: schema-validate every record.
      name: 'validate-songs-json',
      command: [node, 'scripts/validate-songs-json.mjs', corpus],
    },
    {
      // Report-only (R5 KY adapter, D7): blog↔KY parity over the FINAL corpus —
      // how many blog-claimed ky numbers the live KY crawl covers (residual
      // blog-* ky claims = delisted / typo / en-kr-tab-gap candidates). NEVER
      // gates: continueOnError so a parity-script hiccup cannot red the crawl,
      // and the script itself is read-only (no corpus mutation). First-soak
      // report-only; a ≥95% parity threshold is enforced later.
      name: 'blog-ky-parity',
      continueOnError: true,
      command: [node, 'scripts/audit-blog-ky-parity.mjs', corpus],
    },
  ];
}

export const USAGE =
  'usage: node scripts/run-post-crawl-pipeline.mjs [--corpus <path>] [--skip <step-name>]... [--help]';

/** Parse CLI args. Throws on unknown flags or missing values. */
export function parseArgs(argv) {
  const parsed = { corpus: DEFAULT_CORPUS, corpusOverridden: false, skip: [], help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--corpus') {
      const value = argv[i + 1];
      if (!value) throw new Error('--corpus requires a path argument');
      parsed.corpus = value;
      parsed.corpusOverridden = true;
      i += 1;
    } else if (arg === '--skip') {
      const value = argv[i + 1];
      if (!value) throw new Error('--skip requires a step name argument');
      parsed.skip.push(value);
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}

/**
 * Build the env for child steps. The runner OWNS the KARAOKE_SONGS_JSON
 * variable: it is set (resolved absolute) when --corpus is given, and
 * DELETED otherwise. Without the delete, a KARAOKE_SONGS_JSON preset in the
 * caller's shell would split-brain the pipeline — the five env-aware steps
 * would follow the preset corpus while the argv-threaded steps (stage1,
 * stage2 replay, manual fixes, validate) used the default, so the final
 * validate gate would check the wrong file.
 */
export function buildChildEnv(args, baseEnv = process.env) {
  // Rebuild the env WITHOUT the variable (no `delete`, per biome
  // lint/performance/noDelete) so it is truly absent unless set. The strip is
  // case-INsensitive: Windows env-var names are case-insensitive, so a preset
  // `karaoke_songs_json` would otherwise survive into the child env.
  const env = Object.fromEntries(
    Object.entries(baseEnv).filter(([k]) => k.toUpperCase() !== 'KARAOKE_SONGS_JSON'),
  );
  if (args.corpusOverridden) {
    env.KARAOKE_SONGS_JSON = isAbsolute(args.corpus)
      ? args.corpus
      : resolve(REPO_ROOT, args.corpus);
  }
  return env;
}

function banner(log, text) {
  log.error(`\n=== ${text} ===`);
}

/** Spawn one step command (no shell). Resolves to the exit code. */
function runCommand(command, { cwd, env }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env,
      stdio: ['ignore', 'inherit', 'inherit'],
      shell: false,
    });
    child.on('error', rejectPromise);
    child.on('close', (code, signal) => {
      resolvePromise(code ?? (signal ? 1 : 0));
    });
  });
}

/**
 * Run the step table sequentially.
 *
 * @returns {{ ok: boolean, results: Array<{ name: string, status: string }> }}
 *   statuses: ok | failed | failed-continued | skipped | not-run
 */
export async function runSteps(
  steps,
  { skip = [], cwd = REPO_ROOT, env = process.env, log = console } = {},
) {
  const skipSet = new Set(skip);
  const known = new Set(steps.map((s) => s.name));
  for (const name of skipSet) {
    if (!known.has(name)) {
      throw new Error(`--skip ${name}: no such step (steps: ${[...known].join(', ')})`);
    }
  }

  const results = [];
  let failedHard = false;
  for (const step of steps) {
    if (failedHard) {
      results.push({ name: step.name, status: 'not-run' });
      continue;
    }
    if (skipSet.has(step.name)) {
      banner(log, `SKIP ${step.name}`);
      results.push({ name: step.name, status: 'skipped' });
      continue;
    }
    banner(log, `RUN ${step.name}: ${step.command.join(' ')}`);
    let code;
    try {
      code = await runCommand(step.command, { cwd, env });
    } catch (err) {
      log.error(`step ${step.name}: failed to spawn: ${err.message}`);
      code = 1;
    }
    if (code === 0) {
      results.push({ name: step.name, status: 'ok' });
    } else if (step.continueOnError) {
      log.error(
        `\n!!! step ${step.name} FAILED (exit ${code}) but is continue-on-error — continuing !!!`,
      );
      // GitHub Actions workflow command: surfaces the soft failure as a
      // visible warning annotation (the old YAML continue-on-error step did
      // this for free). Parsed from stdout in CI; a harmless line locally.
      log.info(`::warning::${step.name} failed (continueOnError)`);
      results.push({ name: step.name, status: 'failed-continued' });
    } else {
      log.error(`\nstep ${step.name} FAILED (exit ${code}) — stopping pipeline`);
      results.push({ name: step.name, status: 'failed' });
      failedHard = true;
    }
  }
  return { ok: !failedHard, results };
}

function printSummary(log, results) {
  const width = Math.max(...results.map((r) => r.name.length));
  log.error('\n=== post-crawl pipeline summary ===');
  for (const r of results) {
    log.error(`  ${r.name.padEnd(width)}  ${r.status}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  // FILTER_DECISIONS_DIR (set by crawl.yml) opts the two drop-artist-leaks
  // steps into emitting a per-row drop decision log; unset locally = no-op.
  const steps = buildSteps(args.corpus, process.env.FILTER_DECISIONS_DIR || undefined);
  const { ok, results } = await runSteps(steps, { skip: args.skip, env: buildChildEnv(args) });
  printSummary(console, results);
  process.exitCode = ok ? 0 : 1;
}

if (isCliInvocation(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    console.error(USAGE);
    process.exitCode = 1;
  });
}
