#!/usr/bin/env node
/**
 * READ-ONLY, REPORT-ONLY audit (Roadmap "Chinese-leak detection future work"):
 * surface corpus rows whose title/artist text contains a simplified-Chinese-only
 * Han character — a high-precision signal that the row is Mandopop/Cantopop that
 * leaked past the TJ filter, rather than a Japanese song.
 *
 * This is DELIBERATELY not wired into anything. It does NOT gate on findings
 * (always exits 0 when it can read the corpus), does NOT touch the crawl filter
 * chain / classifier / drop lists / crawl.yml, and does NOT mutate the corpus.
 * Its only outputs are a JSONL file of suspect rows and a stdout summary a
 * maintainer reviews by hand. Wiring the predicate into the crawl (or growing
 * `scripts/drop-artist-leaks.mjs` from confirmed hits) is separate future work.
 *
 * The detection is single-sourced from `@karaoke/search`
 * (`hasSimplifiedOnlyHan` + the curated `SIMPLIFIED_ONLY_HAN` set), the same
 * package that owns `hasHan` / `hasKana` / `hasHangul`. The curation rationale
 * (why a broad Han-without-kana scan is the WRONG tool, and how the shinjitai
 * trap is avoided) lives with the set there.
 *
 * BUILD PREREQUISITE: `@karaoke/search` must be built (`corepack pnpm --filter
 * @karaoke/search build`, or any `pnpm -r build`) so its `dist/` resolves. A
 * missing build surfaces as a module-resolution error, consistent with the
 * dist-import pattern the other data scripts use.
 *
 * Fields scanned per record: `title_primary`, `artist_primary`, and each
 * `artist_aliases` entry (cheap, already an array of strings). `title_ko` /
 * `artist_ko` are intentionally NOT scanned — those are Korean, a different
 * script, and not what this leak detector is about.
 *
 * Output
 * ------
 *   <out>/suspects.jsonl   one JSON object per suspect row:
 *                          { id, title_primary, artist_primary, matched_chars,
 *                            matched_fields }. Written even when empty (a
 *                            deterministic artifact path). Default dir is
 *                            gitignored so a bare run never stages output.
 *   stdout                 summary: rows scanned, suspect count, and a
 *                          per-character histogram (the calibration evidence).
 *
 * Usage
 * -----
 *   node scripts/audit-simplified-chinese.mjs                 # committed baseline
 *   node scripts/audit-simplified-chinese.mjs <corpus.json>   # candidate/full corpus
 *   node scripts/audit-simplified-chinese.mjs --out <dir>
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIMPLIFIED_ONLY_HAN, hasSimplifiedOnlyHan } from '@karaoke/search';
import { writeTextAtomic } from './lib/atomic-write.mjs';
import { isCliInvocation } from './lib/cli.mjs';
import { loadCorpus } from './lib/corpus.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const DEFAULT_CORPUS = resolve(REPO_ROOT, 'apps/web/public/data/songs.json');
// Default artifact dir: gitignored (see .gitignore) so a bare invocation never
// stages the generated JSONL.
const DEFAULT_OUT_DIR = resolve(REPO_ROOT, 'scripts/data/audit-simplified-chinese');
const JSONL_NAME = 'suspects.jsonl';

export const USAGE =
  'usage: node scripts/audit-simplified-chinese.mjs [<corpus.json>] [--out <dir>]';

/**
 * Default matcher, single-sourced from `@karaoke/search`. `test` is the exported
 * predicate (the decision); `chars` lists the DISTINCT matched characters in
 * first-appearance order for the human-facing report. A test seam: `runAudit`
 * accepts an injected matcher so the orchestration is unit-tested without the
 * built search dist.
 */
export const defaultMatcher = {
  test: hasSimplifiedOnlyHan,
  chars: (text) => {
    const out = [];
    const seen = new Set();
    for (const character of String(text ?? '')) {
      if (SIMPLIFIED_ONLY_HAN.has(character) && !seen.has(character)) {
        seen.add(character);
        out.push(character);
      }
    }
    return out;
  },
};

/** Parse CLI args. Throws on unknown flags, missing values, or extra args. */
export function parseArgs(argv) {
  const parsed = { corpusPath: null, outDir: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--out') {
      const value = argv[i + 1];
      if (!value) throw new Error('--out requires a directory value');
      parsed.outDir = value;
      i += 1;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown argument: ${arg}`);
    } else if (parsed.corpusPath === null) {
      parsed.corpusPath = arg;
    } else {
      throw new Error(`unexpected extra argument: ${arg}`);
    }
  }
  return parsed;
}

/** The string fields this audit scans, in a stable order. */
const SCAN_FIELDS = ['title_primary', 'artist_primary'];

/**
 * Scan one record. Returns a suspect descriptor `{ id, title_primary,
 * artist_primary, matched_chars, matched_fields }` when any scanned field
 * contains a simplified-Chinese-only character, else `null`.
 *
 * `matched_chars` is the union across fields (distinct, first-appearance order);
 * `matched_fields` names which surfaces fired (`title_primary`,
 * `artist_primary`, or `artist_aliases[i]`). Pure — the matcher is injected.
 */
export function scanRecord(record, matcher) {
  const surfaces = [];
  for (const field of SCAN_FIELDS) {
    if (typeof record?.[field] === 'string') surfaces.push([field, record[field]]);
  }
  if (Array.isArray(record?.artist_aliases)) {
    record.artist_aliases.forEach((alias, index) => {
      if (typeof alias === 'string') surfaces.push([`artist_aliases[${index}]`, alias]);
    });
  }

  const matchedFields = [];
  const matchedChars = [];
  const seenChars = new Set();
  for (const [field, value] of surfaces) {
    if (!matcher.test(value)) continue;
    matchedFields.push(field);
    for (const character of matcher.chars(value)) {
      if (!seenChars.has(character)) {
        seenChars.add(character);
        matchedChars.push(character);
      }
    }
  }

  if (matchedFields.length === 0) return null;
  return {
    id: record?.id == null ? '' : String(record.id),
    title_primary: typeof record?.title_primary === 'string' ? record.title_primary : '',
    artist_primary: typeof record?.artist_primary === 'string' ? record.artist_primary : '',
    matched_chars: matchedChars,
    matched_fields: matchedFields,
  };
}

/**
 * Scan a whole corpus. Returns `{ suspects, summary }`:
 *   suspects  in corpus order (stable)
 *   summary   { scanned, suspectCount, charHistogram } where charHistogram is a
 *             `[char, rowCount]` array sorted by descending count then code
 *             point — the per-character calibration signal.
 * Pure aside from the injected matcher.
 */
export function scanCorpus(records, matcher) {
  const suspects = [];
  const charCounts = new Map();
  for (const record of records) {
    const suspect = scanRecord(record, matcher);
    if (suspect === null) continue;
    suspects.push(suspect);
    for (const character of suspect.matched_chars) {
      charCounts.set(character, (charCounts.get(character) ?? 0) + 1);
    }
  }
  const charHistogram = [...charCounts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].codePointAt(0) - b[0].codePointAt(0),
  );
  return {
    suspects,
    summary: { scanned: records.length, suspectCount: suspects.length, charHistogram },
  };
}

/** Serialise suspects as JSONL (one compact JSON object per line). */
export function buildJsonl(suspects) {
  return suspects.map((suspect) => JSON.stringify(suspect)).join('\n');
}

/**
 * Orchestrate: load corpus, scan, write the JSONL, print the summary.
 * `matcher` defaults to the real `@karaoke/search` predicate; tests inject a
 * fake. Returns 0 on success (INCLUDING when suspects are found — report-only,
 * never gated), 2 on a missing corpus.
 */
export function runAudit({ corpusPath, outDir, matcher = defaultMatcher, log = console }) {
  const resolvedCorpus = resolve(corpusPath ?? DEFAULT_CORPUS);
  if (!existsSync(resolvedCorpus)) {
    log.error(`ERROR: missing corpus at ${resolvedCorpus}`);
    return 2;
  }
  const resolvedOut = resolve(outDir ?? DEFAULT_OUT_DIR);
  const jsonlPath = resolve(resolvedOut, JSONL_NAME);

  const corpus = loadCorpus(resolvedCorpus);
  const { suspects, summary } = scanCorpus(corpus, matcher);

  // Trailing newline only when non-empty, so an all-clear run leaves a 0-byte
  // file rather than a lone newline.
  const jsonl = buildJsonl(suspects);
  writeTextAtomic(jsonlPath, jsonl === '' ? '' : `${jsonl}\n`);

  log.log(`corpus: ${resolvedCorpus}`);
  log.log(`rows scanned: ${summary.scanned}`);
  log.log(`suspect rows: ${summary.suspectCount}`);
  if (summary.charHistogram.length > 0) {
    log.log('matched characters (char: rows):');
    for (const [character, count] of summary.charHistogram) {
      log.log(`  ${character}  ${count}`);
    }
  }
  log.log(`wrote ${jsonlPath}`);
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
  process.exitCode = runAudit({ corpusPath: args.corpusPath, outDir: args.outDir });
}

if (isCliInvocation(import.meta.url)) {
  main();
}
