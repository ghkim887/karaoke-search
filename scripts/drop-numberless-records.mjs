#!/usr/bin/env node
/**
 * Drop records that carry NO karaoke number (tj, ky and joysound all null) from
 * a corpus JSON, preserving every dropped row to a JSONL sidecar for audit.
 *
 * Background
 * ----------
 * The frozen v22-lineage corpus still carries ~771 numberless `blog-*` rows:
 * blog entries whose vendor number could not be resolved at merge time. #152 D2
 * (drop numberless at parse) only takes effect on a fresh crawl reparse, so the
 * frozen lineage never had them removed. Per owner decision these are removed
 * pre-emptively in the v24 build chain.
 *
 * SCOPE: this script is for the FROZEN-LINEAGE corpus only. After the crawl
 * resumes, #152 D2 blocks numberless rows at the source (the parser never emits
 * them), so a freshly crawled corpus needs no post-hoc drop — running this on
 * one is a harmless no-op, but its reason for existing is the frozen lineage.
 *
 * Drop predicate
 * --------------
 * EXACTLY `karaoke_numbers.tj`, `.ky` and `.joysound` all null (or absent). No
 * other signal (id prefix, title, artist) participates.
 *
 * Conservation
 * ------------
 * input count === kept (written to --out) + dropped (written to --dropped-out).
 * A mismatch is a hard error (exit 3) — a filter must never lose or duplicate a
 * row.
 *
 * Behavior
 * --------
 * Always writes both outputs, even with zero drops (--out is a distinct path
 * from --in, so the filtered corpus is always materialised; --dropped-out is an
 * empty file). Atomic writes (`<file>.tmp` + rename), canonical corpus byte
 * shape (indent=2 + trailing newline). No data is regenerated.
 *
 * Usage
 * -----
 *   node scripts/drop-numberless-records.mjs \
 *     --in data/v24/pre-drop-corpus.json \
 *     --out data/v24/corpus.json \
 *     --dropped-out data/v24/numberless-dropped.jsonl
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { writeTextAtomic } from './lib/atomic-write.mjs';
import { isCliInvocation } from './lib/cli.mjs';
import { loadCorpus, writeCorpusAtomic } from './lib/corpus.mjs';

export const USAGE =
  'usage: node scripts/drop-numberless-records.mjs --in <corpus.json> --out <filtered.json> --dropped-out <dropped.jsonl>';

/** Parse CLI args. Throws on unknown flags or missing required values. */
export function parseArgs(argv) {
  const parsed = { in: null, out: null, droppedOut: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--in') {
      parsed.in = argv[++i] ?? null;
      if (parsed.in === null) throw new Error('--in requires a path argument');
    } else if (arg === '--out') {
      parsed.out = argv[++i] ?? null;
      if (parsed.out === null) throw new Error('--out requires a path argument');
    } else if (arg === '--dropped-out') {
      parsed.droppedOut = argv[++i] ?? null;
      if (parsed.droppedOut === null) throw new Error('--dropped-out requires a path argument');
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!parsed.help) {
    for (const key of ['in', 'out', 'droppedOut']) {
      if (parsed[key] === null)
        throw new Error('missing required flag (--in, --out, --dropped-out)');
    }
  }
  return parsed;
}

/**
 * True when a record carries NO karaoke number — tj, ky and joysound all null
 * (or absent). This is the ONLY drop condition; nothing else is inspected.
 *
 * @param {{ karaoke_numbers?: { tj?: unknown, ky?: unknown, joysound?: unknown } }} rec
 */
export function isNumberless(rec) {
  const kn = rec?.karaoke_numbers ?? {};
  return kn.tj == null && kn.ky == null && kn.joysound == null;
}

/**
 * Partition `records` into kept (has ≥1 number) and dropped (numberless). Pure —
 * no I/O. Order-preserving within each partition.
 *
 * @param {unknown[]} records
 * @returns {{ kept: unknown[], dropped: unknown[] }}
 */
export function partitionByNumbers(records) {
  const kept = [];
  const dropped = [];
  for (const rec of records) {
    if (isNumberless(rec)) dropped.push(rec);
    else kept.push(rec);
  }
  return { kept, dropped };
}

/** input === kept + dropped (no row lost or duplicated). */
export function conservationHolds(inputLen, keptLen, droppedLen) {
  return inputLen === keptLen + droppedLen;
}

/** Serialise dropped rows as JSONL (empty string when none). */
export function droppedToJsonl(dropped) {
  if (dropped.length === 0) return '';
  return `${dropped.map((d) => JSON.stringify(d)).join('\n')}\n`;
}

/**
 * Run one drop pass over `inPath`, writing the filtered corpus to `outPath` and
 * the dropped rows (JSONL) to `droppedOutPath`. Returns an exit code:
 *   0 — clean run (including zero drops)
 *   2 — input corpus missing
 *   3 — conservation violated (never expected; guards against a logic bug)
 */
export function runDropNumberless({ inPath, outPath, droppedOutPath, log = console }) {
  if (!existsSync(inPath)) {
    log.error(`ERROR: missing input corpus at ${inPath}`);
    return 2;
  }
  const corpus = loadCorpus(inPath);
  if (!Array.isArray(corpus)) {
    log.error(`ERROR: input corpus is not a JSON array: ${inPath}`);
    return 2;
  }
  const total = corpus.length;
  const { kept, dropped } = partitionByNumbers(corpus);

  if (!conservationHolds(total, kept.length, dropped.length)) {
    log.error(
      `ERROR: conservation failed — input ${total} != kept ${kept.length} + dropped ${dropped.length}`,
    );
    return 3;
  }

  writeCorpusAtomic(outPath, kept);
  writeTextAtomic(droppedOutPath, droppedToJsonl(dropped));

  log.log(`input:        ${total}`);
  log.log(`kept (out):   ${kept.length}`);
  log.log(`dropped:      ${dropped.length}`);
  log.log(`  -> ${outPath}`);
  log.log(`  -> ${droppedOutPath} (dropped rows, JSONL)`);
  return 0;
}

function main() {
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
  process.exitCode = runDropNumberless({
    inPath: resolve(args.in),
    outPath: resolve(args.out),
    droppedOutPath: resolve(args.droppedOut),
  });
}

if (isCliInvocation(import.meta.url)) {
  main();
}
