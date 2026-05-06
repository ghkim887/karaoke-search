/**
 * Stage 2 orchestrator for the title_ko backfill pipeline.
 *
 * Two subcommands:
 *   prep <corpus.json> <out_dir>   — chunk translatable records into
 *                                    <out_dir>/llm-translations-chunk-NN-input.json
 *   merge <corpus.json> <chunks_dir> [--review-csv <path>]
 *                                  — merge per-chunk agent outputs back
 *                                    into the corpus (atomic write) and
 *                                    write low-confidence review CSV.
 *
 * Spec: docs/superpowers/specs/2026-05-06-title-ko-backfill-design.md.
 *
 * The agent dispatch BETWEEN prep and merge is human-driven from a
 * Claude Code session — see scripts/title_ko_stage2_howto.md.
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CJK_RE = /[぀-ゟ゠-ヿ一-鿿]/;

/**
 * Records eligible for Stage 2 translation: title_ko is currently null,
 * title_primary contains kana or kanji, and the record has no
 * title_ko_source tag yet (so re-runs only pick up new records).
 */
export function filterTranslatableRecords(records) {
  return records.filter((r) => {
    if (r.title_ko != null) return false;
    if (r.title_ko_source != null) return false;
    if (!CJK_RE.test(r.title_primary || '')) return false;
    return true;
  });
}

/**
 * Deterministic split of `records` into consecutive chunks of `size`,
 * preserving order. Last chunk may be smaller than `size`.
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
 * Write each chunk to <out_dir>/llm-translations-chunk-NN-input.json
 * (zero-padded NN, two digits). Atomic per-file write via .tmp + rename.
 */
export function writeChunkInputs(outDir, chunks) {
  mkdirSync(outDir, { recursive: true });
  chunks.forEach((chunk, idx) => {
    const nn = String(idx).padStart(2, '0');
    const finalPath = join(outDir, `llm-translations-chunk-${nn}-input.json`);
    const tmpPath = `${finalPath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(chunk, null, 2), 'utf-8');
    renameSync(tmpPath, finalPath);
  });
}

/**
 * `prep` subcommand: load corpus, filter, chunk, write chunk inputs.
 */
export function runPrep({ corpusPath, outDir, chunkSize = 500 }) {
  const records = JSON.parse(readFileSync(corpusPath, 'utf-8'));
  const eligible = filterTranslatableRecords(records);
  const chunks = chunkRecords(eligible, chunkSize);
  writeChunkInputs(outDir, chunks);
  return {
    totalRecords: records.length,
    eligibleRecords: eligible.length,
    chunkCount: chunks.length,
  };
}

const REQUIRED_FIELDS = [
  'id',
  'title_primary',
  'title_ko',
  'media_context_ko',
  'confidence',
  'reasoning',
  'web_sources',
];
const VALID_CONFIDENCE = new Set(['high', 'medium', 'low']);

/**
 * Load every llm-translations-chunk-NN.json under `chunksDir`, validate
 * each entry's shape, and merge into a Map<id, decision>.
 *
 * Filename pattern matches OUTPUT files only (`llm-translations-chunk-NN.json`),
 * NOT the prep-stage INPUT files (`...-NN-input.json`). Throws on
 * missing required fields, invalid confidence enum, or duplicate ids.
 */
export function loadAndValidateChunkOutputs(chunksDir) {
  const map = new Map();
  const files = readdirSync(chunksDir)
    .filter((f) => /^llm-translations-chunk-\d+\.json$/.test(f))
    .sort();
  for (const f of files) {
    const path = join(chunksDir, f);
    const arr = JSON.parse(readFileSync(path, 'utf-8'));
    if (!Array.isArray(arr)) {
      throw new Error(`${f}: expected JSON array, got ${typeof arr}`);
    }
    for (const entry of arr) {
      for (const k of REQUIRED_FIELDS) {
        if (!(k in entry)) {
          throw new Error(`${f}: entry id=${entry.id ?? '?'} missing field ${k}`);
        }
      }
      if (!VALID_CONFIDENCE.has(entry.confidence)) {
        throw new Error(`${f}: entry id=${entry.id} unknown confidence "${entry.confidence}"`);
      }
      if (map.has(entry.id)) {
        throw new Error(`duplicate id ${entry.id} across chunk outputs`);
      }
      map.set(entry.id, entry);
    }
  }
  return map;
}

/**
 * Apply Map<id, decision> to records[]. Returns a NEW array (does not
 * mutate input). Records not covered by the decisions Map pass through
 * unchanged. Decisions with title_ko === null leave the record without
 * title_ko_source/title_ko_confidence (eligible for re-run); decisions
 * with non-null title_ko set source='llm-translated' and the confidence
 * tag.
 */
export function applyDecisionsToCorpus(records, decisions) {
  return records.map((rec) => {
    const d = decisions.get(rec.id);
    if (!d) return rec;
    const next = { ...rec };
    if (d.title_ko != null) {
      next.title_ko = d.title_ko;
      next.title_ko_source = 'llm-translated';
      next.title_ko_confidence = d.confidence;
    } else {
      next.title_ko = null;
    }
    if (d.media_context_ko != null) {
      next.media_context_ko = d.media_context_ko;
    }
    return next;
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cmd = process.argv[2];
  if (cmd === 'prep') {
    const corpusPath = process.argv[3];
    const outDir = process.argv[4];
    if (!corpusPath || !outDir) {
      console.error('usage: prep <corpus.json> <out_dir>');
      process.exit(2);
    }
    const stats = runPrep({ corpusPath, outDir });
    console.log(
      `prep: ${stats.eligibleRecords}/${stats.totalRecords} eligible, ` +
        `${stats.chunkCount} chunks written to ${outDir}`,
    );
  } else {
    console.error(`unknown subcommand: ${cmd}`);
    process.exit(2);
  }
}
