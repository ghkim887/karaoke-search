#!/usr/bin/env node
/**
 * Apply the KY tie-up-suffix strip to an already-crawled KY smoke output
 * (audit follow-up A, Phase 3) — so the orchestrator can measure the merge
 * effect (tier-A `ky-*` reduction) WITHOUT re-crawling kysing.kr.
 *
 * The R5 KY adapter now strips trailing role/tie-up parentheticals from titles
 * in its normalizer (`normalizeKyTitle`) so a KY row clusters with its clean-
 * titled JOYSOUND twin. The existing `songs-ky.json` (4,691 records) was crawled
 * BEFORE that change, so its titles still carry the suffix. This transform
 * re-applies the SAME `normalizeKyTitle` to every `ky-*` record's title_primary,
 * producing an equivalent post-fix KY corpus. Feed the output to
 * `scripts/merge-ky-into-corpus.mjs` and re-run the audit to measure the drop.
 *
 * Reuses the compiled adapter helper (no drift): imports `normalizeKyTitle`
 * from `packages/crawler/dist`. Build first (`corepack pnpm --filter
 * @karaoke/crawler build`).
 *
 * Usage:
 *   node scripts/apply-ky-tieup-strip.mjs --in songs-ky.json --out songs-ky-stripped.json
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isCliInvocation } from './lib/cli.mjs';
import { writeCorpusAtomic } from './lib/corpus.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const NORMALIZER_JS = resolve(REPO_ROOT, 'packages/crawler/dist/adapters/ky-kysing/normalizer.js');

export const USAGE =
  'usage: node scripts/apply-ky-tieup-strip.mjs --in <songs-ky.json> --out <out.json>';

export function parseArgs(argv) {
  const parsed = { in: null, out: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--in' || arg === '--out') {
      const v = argv[i + 1];
      if (!v) throw new Error(`${arg} requires a path value`);
      parsed[arg.slice(2)] = v;
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}

/**
 * Apply `stripTitle` to every `ky-*` record's `title_primary`. Pure. Returns
 * `{ records, changed }` where `changed` is the count of rows whose title moved.
 * Non-`ky-*` records (should be none in a KY smoke file) pass through untouched.
 */
export function applyStrip(records, stripTitle) {
  let changed = 0;
  const out = records.map((r) => {
    if (typeof r?.id !== 'string' || !r.id.startsWith('ky-')) return r;
    const stripped = stripTitle(r.title_primary);
    if (stripped === r.title_primary) return r;
    changed += 1;
    return { ...r, title_primary: stripped };
  });
  return { records: out, changed };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (!args.in || !args.out) {
    console.error('ERROR: --in and --out are required');
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const inPath = resolve(args.in);
  if (!existsSync(inPath)) {
    console.error(`ERROR: input not found: ${inPath}`);
    process.exitCode = 2;
    return;
  }
  if (!existsSync(NORMALIZER_JS)) {
    console.error(
      `ERROR: ${NORMALIZER_JS} missing — run \`corepack pnpm --filter @karaoke/crawler build\` first.`,
    );
    process.exitCode = 2;
    return;
  }
  const { normalizeKyTitle } = await import(pathToFileURL(NORMALIZER_JS).href);
  const records = JSON.parse(readFileSync(inPath, 'utf8'));
  if (!Array.isArray(records)) {
    console.error('ERROR: --in must be a JSON array');
    process.exitCode = 2;
    return;
  }
  const { records: out, changed } = applyStrip(records, normalizeKyTitle);
  writeCorpusAtomic(resolve(args.out), out);
  console.log(
    `[apply-ky-tieup-strip] ${changed}/${records.length} ky titles stripped → ${args.out}`,
  );
}

if (isCliInvocation(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
