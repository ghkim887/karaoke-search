#!/usr/bin/env node
/**
 * Extract the WEB OFFLINE-BUNDLE subset from a full serving corpus.
 *
 * Background
 * ----------
 * The PWA / offline-fallback path ships a client bundle
 * (`apps/web/public/data/songs.json`) that the browser downloads once, builds a
 * MiniSearch index from, and searches locally when the worker API is
 * unreachable (see apps/web/src/lib/backend.ts `FallbackBackend`). Shipping the
 * whole ~312k-song serving corpus client-side fails on index build/memory (see
 * docs/ROADMAP.md R3), so the bundle is a SUBSET.
 *
 * Owner scope decision (2026-07-20): the offline bundle carries the TJ ∪ KY ∪
 * blog-* records — the two Korean-facing vendor catalogues (TJ, KY) plus the
 * curated blog-sourced J-pop/anime/Vocaloid list. This is the reproducible
 * replacement for the previous ad-hoc bundle.
 *
 * Membership predicate
 * --------------------
 * A record is a member iff ANY of:
 *   - `karaoke_numbers.tj` is present (non-null)
 *   - `karaoke_numbers.ky` is present (non-null)
 *   - `id` starts with `blog-`
 * These paths OVERLAP (a blog-sourced record can also carry a tj/ky number),
 * so the per-path counts printed below sum to MORE than the union total; the
 * union (kept) is what ships. Nothing else (title, artist, joysound number) is
 * inspected — a JOYSOUND-only record with no tj/ky number and a non-blog id is
 * dropped.
 *
 * Order + shape
 * -------------
 * Input order is preserved. The output is the canonical corpus byte-shape
 * (JSON.stringify indent=2 + trailing newline) written atomically via
 * writeCorpusAtomic, so re-running on the same input is byte-idempotent. No
 * record is modified — this is a pure row filter (a strict subset), so the
 * SongRecord schema is untouched and every serving surface reads it unchanged.
 *
 * Conservation
 * ------------
 * input count === kept + dropped (no row lost or duplicated). A mismatch is a
 * hard error (exit 3) — guards against a filter logic bug.
 *
 * Usage
 * -----
 *   node scripts/extract-offline-subset.mjs \
 *     --corpus <full-corpus.json> \
 *     --out apps/web/public/data/songs.json
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { isCliInvocation } from './lib/cli.mjs';
import { loadCorpus, writeCorpusAtomic } from './lib/corpus.mjs';

export const USAGE =
  'usage: node scripts/extract-offline-subset.mjs --corpus <full-corpus.json> --out <songs.json>';

/** Parse CLI args. Throws on unknown flags or missing required values. */
export function parseArgs(argv) {
  const parsed = { corpus: null, out: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--corpus') {
      parsed.corpus = argv[++i] ?? null;
      if (parsed.corpus === null) throw new Error('--corpus requires a path argument');
    } else if (arg === '--out') {
      parsed.out = argv[++i] ?? null;
      if (parsed.out === null) throw new Error('--out requires a path argument');
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!parsed.help) {
    for (const key of ['corpus', 'out']) {
      if (parsed[key] === null) throw new Error('missing required flag (--corpus, --out)');
    }
  }
  return parsed;
}

/** True when a record carries a TJ karaoke number. */
export function hasTj(rec) {
  return rec?.karaoke_numbers?.tj != null;
}

/** True when a record carries a KY karaoke number. */
export function hasKy(rec) {
  return rec?.karaoke_numbers?.ky != null;
}

/** True when a record's id is blog-sourced (`blog-` prefix). */
export function isBlog(rec) {
  return typeof rec?.id === 'string' && rec.id.startsWith('blog-');
}

/**
 * True when a record belongs in the offline bundle: it has a TJ number, OR a KY
 * number, OR a blog-* id. This is the ONLY membership condition.
 *
 * @param {{ id?: unknown, karaoke_numbers?: { tj?: unknown, ky?: unknown } }} rec
 */
export function isOfflineSubsetMember(rec) {
  return hasTj(rec) || hasKy(rec) || isBlog(rec);
}

/**
 * Partition `records` into kept (members) and dropped (non-members). Pure — no
 * I/O. Order-preserving within each partition.
 *
 * @param {unknown[]} records
 * @returns {{ kept: unknown[], dropped: unknown[] }}
 */
export function partitionOfflineSubset(records) {
  const kept = [];
  const dropped = [];
  for (const rec of records) {
    if (isOfflineSubsetMember(rec)) kept.push(rec);
    else dropped.push(rec);
  }
  return { kept, dropped };
}

/**
 * Per-path membership counts over `kept`. The three paths OVERLAP, so
 * tj + ky + blog does NOT equal `total` — they are diagnostic counts, not a
 * disjoint partition. `blogJoyOnly` is the blog-* subset that has NO tj/ky
 * number but DOES carry a joysound number (the JOYSOUND-only blog rows the
 * bundle would otherwise lack).
 *
 * @param {unknown[]} kept
 */
export function computeStats(kept) {
  let tj = 0;
  let ky = 0;
  let blog = 0;
  let blogJoyOnly = 0;
  for (const rec of kept) {
    const isTj = hasTj(rec);
    const isKy = hasKy(rec);
    if (isTj) tj += 1;
    if (isKy) ky += 1;
    if (isBlog(rec)) {
      blog += 1;
      if (!isTj && !isKy && rec?.karaoke_numbers?.joysound != null) blogJoyOnly += 1;
    }
  }
  return { total: kept.length, tj, ky, blog, blogJoyOnly };
}

/** input === kept + dropped (no row lost or duplicated). */
export function conservationHolds(inputLen, keptLen, droppedLen) {
  return inputLen === keptLen + droppedLen;
}

/**
 * Run one extraction pass over `corpusPath`, writing the offline subset to
 * `outPath`. Returns an exit code:
 *   0 — clean run
 *   2 — input corpus missing or not a JSON array
 *   3 — conservation violated (never expected; guards against a logic bug)
 */
export function runExtractOfflineSubset({ corpusPath, outPath, log = console }) {
  if (!existsSync(corpusPath)) {
    log.error(`ERROR: missing input corpus at ${corpusPath}`);
    return 2;
  }
  const corpus = loadCorpus(corpusPath);
  if (!Array.isArray(corpus)) {
    log.error(`ERROR: input corpus is not a JSON array: ${corpusPath}`);
    return 2;
  }
  const total = corpus.length;
  const { kept, dropped } = partitionOfflineSubset(corpus);

  if (!conservationHolds(total, kept.length, dropped.length)) {
    log.error(
      `ERROR: conservation failed — input ${total} != kept ${kept.length} + dropped ${dropped.length}`,
    );
    return 3;
  }

  writeCorpusAtomic(outPath, kept);

  const stats = computeStats(kept);
  log.log(`input corpus:      ${total}`);
  log.log(`offline subset:    ${stats.total}  (dropped ${dropped.length})`);
  log.log(`  tj-numbered:     ${stats.tj}`);
  log.log(`  ky-numbered:     ${stats.ky}`);
  log.log(`  blog-* id:       ${stats.blog}  (of which joysound-only: ${stats.blogJoyOnly})`);
  log.log(`  -> ${outPath}`);
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
  process.exitCode = runExtractOfflineSubset({
    corpusPath: resolve(args.corpus),
    outPath: resolve(args.out),
  });
}

if (isCliInvocation(import.meta.url)) {
  main();
}
