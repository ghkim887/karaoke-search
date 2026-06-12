/**
 * Adjudication harness for the JOYSOUND full-catalog FP/FN review queues.
 *
 * The full-catalog JOYSOUND sweep (scripts/lib/corpus-audit-guardrails.mjs,
 * `writeJoysoundReviewQueues`) emits P0/P1 false-positive and false-negative
 * review queues as TSV. This harness chunks those queues for parallel agent
 * adjudication, then merges the agent verdicts into a machine-readable
 * `verdicts.json` (consumed by a LATER step that populates
 * `reviewedJoysoundOverrides.ts`).
 *
 * Two subcommands (mirrors scripts/translate_title_ko_via_agents.mjs):
 *
 *   prep <fp-queue.tsv> <fn-queue.tsv> <out-dir> [--chunk-size N]
 *     Parse both TSVs, dedup by normalized selSongNo across all buckets
 *     (union the bucket/reason/suggested_verdict info per song), split into an
 *     FP stream and an FN stream, chunk each (default 250 rows/chunk), and
 *     write adjudicate-{fp,fn}-chunk-NN-input.json + prep-manifest.json.
 *
 *   merge <out-dir> [--review-csv <path>]
 *     Read adjudicate-{fp,fn}-chunk-NN.json agent OUTPUT files, validate every
 *     input selSongNo has exactly one verdict in the enum, then emit
 *     verdicts.json (+ ready-to-paste override-arrays.txt, + optional review CSV
 *     with a UTF-8 BOM).
 *
 * The agent dispatch BETWEEN prep and merge is human-driven from a Claude Code
 * session — one Opus subagent per chunk. This harness builds ONLY the
 * prep/merge plumbing; it does not run any adjudication agent and does not
 * touch reviewedJoysoundOverrides.ts.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeJsonAtomic, writeTextAtomic } from './lib/atomic-write.mjs';
import { csvEscape } from './lib/csv.mjs';

/**
 * Canonical TSV column contract emitted by `writeJoysoundReviewQueues` /
 * `joysoundDecisionEvidenceRow` in scripts/lib/corpus-audit-guardrails.mjs.
 * Order is load-bearing for header validation.
 */
export const QUEUE_COLUMNS = [
  'bucket',
  'priority',
  'selSongNo',
  'title',
  'artist',
  'decision',
  'reason',
  'script_signal',
  'why_flagged',
  'suggested_verdict',
  'reviewer_verdict',
  'reviewer_note',
];

/** Adjudication verdict enum. ALLOW/DROP become override entries later;
 *  LEAVE_* record an explicit adjudication with no override. */
export const VALID_VERDICTS = new Set(['ALLOW', 'DROP', 'LEAVE_ADMITTED', 'LEAVE_DROPPED']);

/**
 * Canonical JOYSOUND override key: strip all hyphens (`190-001` -> `190001`)
 * and trim surrounding whitespace. Mirrors `normalizeJoysoundNumber` in
 * corpus-audit-guardrails.mjs (which the corpus + listing rows already share),
 * with an added trim for hand-edited TSV cells.
 *
 * @param {string|number|null|undefined} value
 * @returns {string}
 */
export function normalizeSelSongNo(value) {
  return String(value ?? '')
    .trim()
    .replace(/-/gu, '');
}

/**
 * Parse a JOYSOUND review-queue TSV string into an array of row objects keyed
 * by the canonical columns. Validates the header against QUEUE_COLUMNS so a
 * schema drift in the upstream writer fails loudly here. Blank trailing lines
 * are ignored.
 *
 * @param {string} text - raw TSV file contents
 * @returns {Array<Record<string,string>>}
 */
export function parseQueueTsv(text) {
  const lines = text.split(/\r?\n/u);
  // Drop trailing blank lines (the writer appends a final newline).
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) throw new Error('empty queue TSV');

  const header = lines[0].split('\t');
  if (header.length !== QUEUE_COLUMNS.length || header.some((c, i) => c !== QUEUE_COLUMNS[i])) {
    throw new Error(
      `queue TSV header mismatch:\n  expected: ${QUEUE_COLUMNS.join('\t')}\n  got:      ${lines[0]}`,
    );
  }

  return lines.slice(1).map((line) => {
    const cells = line.split('\t');
    const row = {};
    QUEUE_COLUMNS.forEach((col, i) => {
      row[col] = cells[i] ?? '';
    });
    return row;
  });
}

/**
 * Fold an array of raw queue rows into a Map keyed by normalized selSongNo,
 * unioning bucket/reason/suggested_verdict across rows that share a number.
 * The first-seen row supplies the canonical title/artist/priority; subsequent
 * rows only contribute to the union sets.
 *
 * @param {Array<Record<string,string>>} rows
 * @returns {Map<string, object>}
 */
function foldByNumber(rows) {
  const map = new Map();
  for (const row of rows) {
    const selSongNo = normalizeSelSongNo(row.selSongNo);
    if (selSongNo === '') continue;
    let rec = map.get(selSongNo);
    if (!rec) {
      rec = {
        selSongNo,
        title: row.title,
        artist: row.artist,
        priority: row.priority,
        decision: row.decision,
        buckets: new Set(),
        reasons: new Set(),
        suggested_verdicts: new Set(),
        why_flagged: new Set(),
        script_signals: new Set(),
      };
      map.set(selSongNo, rec);
    }
    if (row.bucket) rec.buckets.add(row.bucket);
    if (row.reason) rec.reasons.add(row.reason);
    if (row.suggested_verdict) rec.suggested_verdicts.add(row.suggested_verdict);
    if (row.why_flagged) rec.why_flagged.add(row.why_flagged);
    if (row.script_signal) rec.script_signals.add(row.script_signal);
  }
  return map;
}

/** Materialize a folded record into the byte-stable input shape an agent
 *  receives: arrays sorted, sets joined deterministically. */
function materializeInputRecord(rec) {
  const buckets = [...rec.buckets].sort();
  const reasons = [...rec.reasons].sort();
  const suggested = [...rec.suggested_verdicts].sort();
  return {
    selSongNo: rec.selSongNo,
    title: rec.title,
    artist: rec.artist,
    priority: rec.priority,
    decision: rec.decision,
    buckets,
    reasons,
    reason: reasons.join('; '),
    suggested_verdict: suggested.join('; '),
    why_flagged: [...rec.why_flagged].sort().join('; '),
    script_signal: [...rec.script_signals].sort().join('; '),
  };
}

/**
 * Dedup raw FP + FN queue rows into two deterministic, sorted streams of
 * adjudication input records. A song that appears in BOTH streams is routed to
 * the FP stream only (FP wins), carrying the UNION of buckets/reasons from both
 * streams so the agent never adjudicates the same number twice.
 *
 * @param {Array<Record<string,string>>} fpRows
 * @param {Array<Record<string,string>>} fnRows
 * @returns {{ fp: object[], fn: object[], collapsed: object }}
 */
export function dedupeQueueRecords(fpRows, fnRows) {
  const fpMap = foldByNumber(fpRows);
  const fnMap = foldByNumber(fnRows);

  // Cross-stream: a number in BOTH streams goes to FP, absorbing the FN unions.
  let crossStream = 0;
  for (const [selSongNo, fnRec] of fnMap) {
    const fpRec = fpMap.get(selSongNo);
    if (!fpRec) continue;
    crossStream += 1;
    for (const b of fnRec.buckets) fpRec.buckets.add(b);
    for (const r of fnRec.reasons) fpRec.reasons.add(r);
    for (const s of fnRec.suggested_verdicts) fpRec.suggested_verdicts.add(s);
    for (const w of fnRec.why_flagged) fpRec.why_flagged.add(w);
    for (const s of fnRec.script_signals) fpRec.script_signals.add(s);
    fnMap.delete(selSongNo);
  }

  const byNumber = (a, b) => (a.selSongNo < b.selSongNo ? -1 : a.selSongNo > b.selSongNo ? 1 : 0);
  const fp = [...fpMap.values()].map(materializeInputRecord).sort(byNumber);
  const fn = [...fnMap.values()].map(materializeInputRecord).sort(byNumber);

  return {
    fp,
    fn,
    collapsed: {
      fpRowsIn: fpRows.length,
      fpDistinct: fp.length,
      fnRowsIn: fnRows.length,
      fnDistinct: fn.length,
      crossStream,
    },
  };
}

/**
 * Deterministic split of `records` into consecutive chunks of `size`,
 * preserving order. Last chunk may be smaller. Mirrors the title_ko pipeline.
 */
export function chunkRecords(records, size) {
  if (records.length === 0) return [];
  const chunks = [];
  for (let i = 0; i < records.length; i += size) {
    chunks.push(records.slice(i, i + size));
  }
  return chunks;
}

/**
 * Write each chunk to <out-dir>/adjudicate-<stream>-chunk-NN-input.json
 * (zero-padded NN, two digits). Atomic per-file write via .tmp + rename.
 *
 * @param {string} outDir
 * @param {'fp'|'fn'} stream
 * @param {object[][]} chunks
 */
export function writeChunkInputs(outDir, stream, chunks) {
  chunks.forEach((chunk, idx) => {
    const nn = String(idx).padStart(2, '0');
    writeJsonAtomic(join(outDir, `adjudicate-${stream}-chunk-${nn}-input.json`), chunk);
  });
}

/**
 * `prep` subcommand: parse both queue TSVs, dedup across buckets/streams,
 * chunk each stream, write chunk-input files + a prep-manifest.json summary.
 *
 * @param {{ fpPath: string, fnPath: string, outDir: string, chunkSize?: number }} opts
 * @returns {object} manifest
 */
export function runPrep({ fpPath, fnPath, outDir, chunkSize = 250 }) {
  const fpRows = parseQueueTsv(readFileSync(fpPath, 'utf-8'));
  const fnRows = parseQueueTsv(readFileSync(fnPath, 'utf-8'));
  const { fp, fn, collapsed } = dedupeQueueRecords(fpRows, fnRows);

  const fpChunks = chunkRecords(fp, chunkSize);
  const fnChunks = chunkRecords(fn, chunkSize);
  writeChunkInputs(outDir, 'fp', fpChunks);
  writeChunkInputs(outDir, 'fn', fnChunks);

  const manifest = {
    generatedAt: new Date().toISOString(),
    chunkSize,
    distinctTotal: fp.length + fn.length,
    fp: {
      rowsIn: collapsed.fpRowsIn,
      distinct: fp.length,
      chunkCount: fpChunks.length,
      chunkSizes: fpChunks.map((c) => c.length),
    },
    fn: {
      rowsIn: collapsed.fnRowsIn,
      distinct: fn.length,
      chunkCount: fnChunks.length,
      chunkSizes: fnChunks.map((c) => c.length),
    },
    dedup: {
      fpCollapsed: collapsed.fpRowsIn - fp.length,
      fnCollapsed: collapsed.fnRowsIn - fn.length,
      crossStreamRoutedToFp: collapsed.crossStream,
    },
  };
  writeJsonAtomic(join(outDir, 'prep-manifest.json'), manifest);
  return manifest;
}

/**
 * Read every adjudicate-<stream>-chunk-NN-input.json under `outDir` and return
 * one combined array of input records. Matches the OUTPUT-pattern's
 * complement: input files end in `-input.json`.
 */
function loadChunkInputs(outDir) {
  const files = readdirSync(outDir)
    .filter((f) => /^adjudicate-(fp|fn)-chunk-\d+-input\.json$/u.test(f))
    .sort();
  const records = [];
  for (const f of files) {
    const arr = JSON.parse(readFileSync(join(outDir, f), 'utf-8'));
    if (!Array.isArray(arr)) throw new Error(`${f}: expected JSON array`);
    records.push(...arr);
  }
  return records;
}

/**
 * Read every adjudicate-<stream>-chunk-NN.json AGENT OUTPUT under `outDir`
 * (the `-input.json` files are excluded by the regex) and return one combined
 * array of `{selSongNo, verdict, reason, web_sources?}` entries.
 */
function loadChunkOutputs(outDir) {
  const files = readdirSync(outDir)
    .filter((f) => /^adjudicate-(fp|fn)-chunk-\d+\.json$/u.test(f))
    .sort();
  const outputs = [];
  for (const f of files) {
    const arr = JSON.parse(readFileSync(join(outDir, f), 'utf-8'));
    if (!Array.isArray(arr)) throw new Error(`${f}: expected JSON array`);
    outputs.push(...arr);
  }
  return outputs;
}

/**
 * Validate agent outputs against the prep inputs and return the joined verdict
 * records (carrying each input's union `buckets`). Throws on:
 *   - a verdict value outside VALID_VERDICTS
 *   - a duplicate selSongNo across outputs
 *   - an output selSongNo not present in the inputs (unknown)
 *   - an input selSongNo with no output verdict (missing)
 *
 * @param {object[]} inputs - prep input records
 * @param {object[]} outputs - agent output entries
 * @returns {Array<{selSongNo,verdict,reason,buckets,web_sources}>}
 */
export function validateChunkOutputs(inputs, outputs) {
  const inputByNo = new Map(inputs.map((r) => [normalizeSelSongNo(r.selSongNo), r]));

  const seen = new Set();
  const verdicts = [];
  const unknown = [];
  for (const out of outputs) {
    const selSongNo = normalizeSelSongNo(out.selSongNo);
    if (!VALID_VERDICTS.has(out.verdict)) {
      throw new Error(
        `selSongNo ${selSongNo}: invalid verdict "${out.verdict}" ` +
          `(expected one of ${[...VALID_VERDICTS].join(', ')})`,
      );
    }
    if (seen.has(selSongNo)) {
      throw new Error(`duplicate selSongNo ${selSongNo} in agent outputs`);
    }
    seen.add(selSongNo);
    const input = inputByNo.get(selSongNo);
    if (!input) {
      unknown.push(selSongNo);
      continue;
    }
    verdicts.push({
      selSongNo,
      verdict: out.verdict,
      reason: out.reason ?? '',
      buckets: input.buckets ?? [],
      title: input.title ?? '',
      artist: input.artist ?? '',
      web_sources: Array.isArray(out.web_sources) ? out.web_sources : [],
    });
  }
  if (unknown.length > 0) {
    throw new Error(`unknown selSongNo not in prep inputs: ${unknown.join(', ')}`);
  }

  const missing = [];
  for (const no of inputByNo.keys()) {
    if (!seen.has(no)) missing.push(no);
  }
  if (missing.length > 0) {
    throw new Error(`missing verdict for input selSongNo: ${missing.join(', ')}`);
  }

  return verdicts;
}

/**
 * Build the ready-to-paste TS array bodies for REVIEWED_JOYSOUND_ALLOW_NUMBERS
 * and REVIEWED_JOYSOUND_DROP_NUMBERS. Only ALLOW/DROP verdicts produce entries;
 * keys are hyphen-stripped, deduped, and sorted.
 *
 * @param {Array<{selSongNo,verdict}>} verdicts
 * @returns {{ allow: string[], drop: string[] }}
 */
export function buildOverrideArrays(verdicts) {
  const allow = new Set();
  const drop = new Set();
  for (const v of verdicts) {
    const key = normalizeSelSongNo(v.selSongNo);
    if (v.verdict === 'ALLOW') allow.add(key);
    else if (v.verdict === 'DROP') drop.add(key);
  }
  const sorted = (s) => [...s].sort();
  return { allow: sorted(allow), drop: sorted(drop) };
}

/** Render the override-arrays.txt convenience file (TS literal array bodies). */
function renderOverrideArrays({ allow, drop }) {
  const body = (nums) =>
    nums.length === 0 ? '' : `\n  ${nums.map((n) => `'${n}',`).join('\n  ')}\n`;
  return `// Generated by scripts/adjudicate_joysound_via_agents.mjs (merge).\n// Ready-to-paste array bodies for reviewedJoysoundOverrides.ts — do NOT\n// commit this file; copy the literals into the .ts source.\n\nconst REVIEWED_JOYSOUND_ALLOW_NUMBERS = [${body(allow)}];\n\nconst REVIEWED_JOYSOUND_DROP_NUMBERS = [${body(drop)}];\n`;
}

/** Join a string[] for a single CSV cell with a deterministic separator. */
function joinCell(values) {
  return Array.isArray(values) ? values.join('; ') : String(values ?? '');
}

/**
 * Write the convenience review CSV with a UTF-8 BOM (Korean Excel defaults to
 * CP949 and mojibakes UTF-8 without it). One row per verdict.
 *
 * @param {string} path
 * @param {Array<{selSongNo,title,artist,buckets,verdict,reason,web_sources}>} verdicts
 */
export function writeReviewCsv(path, verdicts) {
  const lines = ['selSongNo,title,artist,buckets,verdict,reason,web_sources'];
  for (const v of verdicts) {
    lines.push(
      [
        v.selSongNo,
        v.title ?? '',
        v.artist ?? '',
        joinCell(v.buckets),
        v.verdict,
        v.reason ?? '',
        joinCell(v.web_sources),
      ]
        .map(csvEscape)
        .join(','),
    );
  }
  writeTextAtomic(path, `﻿${lines.join('\n')}\n`);
}

/**
 * `merge` subcommand: load chunk inputs + agent outputs, validate, emit
 * verdicts.json + override-arrays.txt (+ optional review CSV).
 *
 * @param {{ outDir: string, reviewCsvPath?: string }} opts
 * @returns {object} stats
 */
export function runMerge({ outDir, reviewCsvPath }) {
  const inputs = loadChunkInputs(outDir);
  if (inputs.length === 0) {
    throw new Error(
      `no adjudicate-*-chunk-NN-input.json files found in ${outDir} (run prep first)`,
    );
  }
  const outputs = loadChunkOutputs(outDir);
  const verdicts = validateChunkOutputs(inputs, outputs);

  // Sort verdicts.json deterministically by normalized number.
  verdicts.sort((a, b) => (a.selSongNo < b.selSongNo ? -1 : a.selSongNo > b.selSongNo ? 1 : 0));
  writeJsonAtomic(join(outDir, 'verdicts.json'), verdicts);

  const arrays = buildOverrideArrays(verdicts);
  writeTextAtomic(join(outDir, 'override-arrays.txt'), renderOverrideArrays(arrays));

  if (reviewCsvPath) writeReviewCsv(reviewCsvPath, verdicts);

  const tally = { ALLOW: 0, DROP: 0, LEAVE_ADMITTED: 0, LEAVE_DROPPED: 0 };
  for (const v of verdicts) tally[v.verdict] += 1;

  return {
    verdictCount: verdicts.length,
    inputCount: inputs.length,
    allowCount: arrays.allow.length,
    dropCount: arrays.drop.length,
    tally,
  };
}

function parseFlag(argv, name) {
  const idx = argv.indexOf(name);
  return idx >= 0 ? argv[idx + 1] : undefined;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cmd = process.argv[2];
  if (cmd === 'prep') {
    const fpPath = process.argv[3];
    const fnPath = process.argv[4];
    const outDir = process.argv[5];
    if (!fpPath || !fnPath || !outDir) {
      console.error('usage: prep <fp-queue.tsv> <fn-queue.tsv> <out-dir> [--chunk-size N]');
      process.exit(2);
    }
    const chunkSizeRaw = parseFlag(process.argv, '--chunk-size');
    const chunkSize = chunkSizeRaw ? Number.parseInt(chunkSizeRaw, 10) : 250;
    const m = runPrep({ fpPath, fnPath, outDir, chunkSize });
    console.log(
      `prep: ${m.distinctTotal} distinct songs ` +
        `(FP ${m.fp.distinct} in ${m.fp.chunkCount} chunks, ` +
        `FN ${m.fn.distinct} in ${m.fn.chunkCount} chunks; ` +
        `dedup collapsed FP ${m.dedup.fpCollapsed} / FN ${m.dedup.fnCollapsed}, ` +
        `cross-stream→FP ${m.dedup.crossStreamRoutedToFp}) → ${outDir}`,
    );
  } else if (cmd === 'merge') {
    const outDir = process.argv[3];
    if (!outDir) {
      console.error('usage: merge <out-dir> [--review-csv <path>]');
      process.exit(2);
    }
    const reviewCsvPath = parseFlag(process.argv, '--review-csv');
    const s = runMerge({ outDir, reviewCsvPath });
    console.log(
      `merge: ${s.verdictCount} verdicts (ALLOW ${s.tally.ALLOW}, DROP ${s.tally.DROP}, ` +
        `LEAVE_ADMITTED ${s.tally.LEAVE_ADMITTED}, LEAVE_DROPPED ${s.tally.LEAVE_DROPPED}) ` +
        `→ verdicts.json + override-arrays.txt in ${outDir}`,
    );
  } else {
    console.error(`unknown subcommand: ${cmd ?? '(none)'} (expected prep | merge)`);
    process.exit(2);
  }
}
