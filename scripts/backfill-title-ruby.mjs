#!/usr/bin/env node
// Backfills the additive `title_ruby` (katakana reading of title_primary) into
// a song corpus from the JOYSOUND detail-sweep decision logs.
//
// Usage:
//   node scripts/backfill-title-ruby.mjs <corpus.json> <ruby-slim.jsonl> \
//        --out <dir> [--baseline <songs.json>]
//
// Writes to <dir>:
//   - <corpus-basename>.title-ruby.json  — the enriched corpus
//   - backfill-title-ruby.report.json    — match/skip counts
// When --baseline is given, the SAME ruby map is applied to that file and
// written back IN PLACE (the committed apps/web/public/data/songs.json), so the
// tracked offline baseline gains the field via identical logic.
//
// Matching policy (conservative — never rewrite a title, only add a reading):
//   join key   song.karaoke_numbers.joysound === record.selSongNo (trimmed
//              string compare; both are stored dashless bare digits).
//   guard      record.songName must equal song.title_primary — exact first,
//              then NFKC-normalized fallback (counted separately). A mismatch
//              means the catalog entry changed since the sweep → SKIP.
//   empties    record.songNameRuby empty/null → SKIP.
//   collisions song already carrying title_ruby → keep if identical, else SKIP.
// Every song lands in exactly one disjoint outcome bucket; the buckets sum to
// the corpus size (asserted below and in the unit tests).

import { basename, join } from 'node:path';
import { writeJsonAtomic } from './lib/atomic-write.mjs';
import { isCliInvocation } from './lib/cli.mjs';
import { loadCorpus, writeCorpusAtomic } from './lib/corpus.mjs';
import { streamJsonl } from './lib/jsonl.mjs';

/** Trim a possibly-null/undefined string; '' and whitespace-only → ''. */
function trimmed(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Build the selSongNo → { songName, ruby } lookup from parsed decision-log
 * rows. Keyed by the trimmed selSongNo. Rows with an empty ruby are still
 * indexed (so the corpus pass can bucket them as `empty-ruby` vs a genuinely
 * absent record); duplicate selSongNo keys keep the FIRST occurrence and count
 * a conflict only when a later row disagrees on the ruby.
 *
 * @param {Iterable<{selSongNo?: unknown, songName?: unknown, songNameRuby?: unknown}>} rows
 * @returns {{ map: Map<string, {songName: string, ruby: string}>, duplicateRows: number, duplicateConflicts: number }}
 */
export function buildRubyMap(rows) {
  const map = new Map();
  let duplicateRows = 0;
  let duplicateConflicts = 0;
  for (const row of rows) {
    const key = trimmed(row.selSongNo);
    if (key === '') continue;
    const entry = { songName: trimmed(row.songName), ruby: trimmed(row.songNameRuby) };
    const prev = map.get(key);
    if (prev === undefined) {
      map.set(key, entry);
      continue;
    }
    duplicateRows += 1;
    if (prev.ruby !== entry.ruby) duplicateConflicts += 1;
  }
  return { map, duplicateRows, duplicateConflicts };
}

/**
 * Apply the ruby map to a corpus array. Pure: returns a NEW array (matched
 * records are shallow-cloned with `title_ruby` appended last; every other
 * record is returned by reference unchanged) plus a disjoint-bucket report.
 *
 * @param {Array<object>} records
 * @param {Map<string, {songName: string, ruby: string}>} rubyByNumber
 * @returns {{ records: Array<object>, report: object }}
 */
export function backfillCorpus(records, rubyByNumber) {
  const buckets = {
    applied_exact: 0,
    applied_nfkc: 0,
    noop_already_present_identical: 0,
    skip_no_joysound_number: 0,
    skip_no_ruby_record: 0,
    skip_empty_ruby: 0,
    skip_title_mismatch: 0,
    skip_already_present_conflict: 0,
  };

  const out = records.map((rec) => {
    const joysound = trimmed(rec.karaoke_numbers?.joysound);
    if (joysound === '') {
      buckets.skip_no_joysound_number += 1;
      return rec;
    }
    const entry = rubyByNumber.get(joysound);
    if (entry === undefined) {
      buckets.skip_no_ruby_record += 1;
      return rec;
    }
    if (entry.ruby === '') {
      buckets.skip_empty_ruby += 1;
      return rec;
    }
    const title = typeof rec.title_primary === 'string' ? rec.title_primary : '';
    let matchKind;
    if (entry.songName === title) {
      matchKind = 'exact';
    } else if (entry.songName.normalize('NFKC') === title.normalize('NFKC')) {
      matchKind = 'nfkc';
    } else {
      buckets.skip_title_mismatch += 1;
      return rec;
    }

    const existing = rec.title_ruby;
    if (existing !== undefined && existing !== null) {
      if (existing === entry.ruby) {
        buckets.noop_already_present_identical += 1;
      } else {
        buckets.skip_already_present_conflict += 1;
      }
      return rec;
    }

    buckets[matchKind === 'exact' ? 'applied_exact' : 'applied_nfkc'] += 1;
    // Append title_ruby LAST — leaves every pre-existing key in place so the
    // only field-level diff is the added key (verified by the baseline diff).
    return { ...rec, title_ruby: entry.ruby };
  });

  const appliedTotal = buckets.applied_exact + buckets.applied_nfkc;
  const report = {
    totalSongs: records.length,
    joysoundNumberedSongs: records.length - buckets.skip_no_joysound_number,
    appliedTotal,
    buckets,
  };

  // Invariant: buckets partition the corpus.
  const bucketSum = Object.values(buckets).reduce((a, b) => a + b, 0);
  if (bucketSum !== records.length) {
    throw new Error(`backfillCorpus: bucket sum ${bucketSum} !== corpus size ${records.length}`);
  }

  return { records: out, report };
}

/** Parse argv into { corpusPath, rubyPath, outDir, baselinePath }. */
function parseArgs(argv) {
  const positionals = [];
  let outDir;
  let baselinePath;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') {
      outDir = argv[++i];
    } else if (arg === '--baseline') {
      baselinePath = argv[++i];
    } else {
      positionals.push(arg);
    }
  }
  const [corpusPath, rubyPath] = positionals;
  return { corpusPath, rubyPath, outDir, baselinePath };
}

async function main() {
  const { corpusPath, rubyPath, outDir, baselinePath } = parseArgs(process.argv.slice(2));
  if (!corpusPath || !rubyPath || !outDir) {
    process.stderr.write(
      'Usage: node scripts/backfill-title-ruby.mjs <corpus.json> <ruby-slim.jsonl> ' +
        '--out <dir> [--baseline <songs.json>]\n',
    );
    process.exit(1);
  }

  const rows = [];
  for await (const row of streamJsonl(rubyPath)) rows.push(row);
  const { map, duplicateRows, duplicateConflicts } = buildRubyMap(rows);

  const corpus = loadCorpus(corpusPath);
  const corpusResult = backfillCorpus(corpus, map);
  const enrichedPath = join(outDir, `${basename(corpusPath, '.json')}.title-ruby.json`);
  writeCorpusAtomic(enrichedPath, corpusResult.records);

  const report = {
    logRecords: rows.length,
    rubyMapSize: map.size,
    duplicateRows,
    duplicateConflicts,
    corpus: { input: corpusPath, output: enrichedPath, ...corpusResult.report },
  };

  if (baselinePath) {
    const baseline = loadCorpus(baselinePath);
    const baselineResult = backfillCorpus(baseline, map);
    writeCorpusAtomic(baselinePath, baselineResult.records);
    report.baseline = { input: baselinePath, output: baselinePath, ...baselineResult.report };
  }

  const reportPath = join(outDir, 'backfill-title-ruby.report.json');
  writeJsonAtomic(reportPath, report);

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (isCliInvocation(import.meta.url)) {
  main();
}
