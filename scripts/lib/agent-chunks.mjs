/**
 * Shared LLM-agent chunk plumbing for the two "prep/merge" harnesses
 * (scripts/adjudicate_joysound_via_agents.mjs and
 * scripts/translate_title_ko_via_agents.mjs).
 *
 * Both harnesses chunk records into per-agent input files, later read the agent
 * output files back, and emit a UTF-8-BOM review CSV. The DOMAIN logic (TSV
 * parse/dedup, CJK filter, NFKC title matching, verdict/confidence validation)
 * stays in each harness — only this transport-level boilerplate is shared.
 */

import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic, writeTextAtomic } from './atomic-write.mjs';
import { csvEscape } from './csv.mjs';

/**
 * Deterministic split of `records` into consecutive chunks of `size`,
 * preserving order. Last chunk may be smaller. Returns `[]` for empty input.
 *
 * @template T
 * @param {T[]} records
 * @param {number} size
 * @returns {T[][]}
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
 * Write each chunk to `<outDir>/<fileNameFor(NN)>` (zero-padded two-digit NN),
 * one atomic `.tmp`+rename JSON write per chunk.
 *
 * @param {string} outDir
 * @param {object[][]} chunks
 * @param {(nn: string) => string} fileNameFor
 * @param {{ ensureDir?: boolean }} [opts] - mkdir the outDir first (recursive)
 */
export function writeChunkInputs(outDir, chunks, fileNameFor, { ensureDir = false } = {}) {
  if (ensureDir) mkdirSync(outDir, { recursive: true });
  chunks.forEach((chunk, idx) => {
    const nn = String(idx).padStart(2, '0');
    writeJsonAtomic(join(outDir, fileNameFor(nn)), chunk);
  });
}

/**
 * List the files in `dir` whose name matches `pattern`, sorted lexically.
 *
 * @param {string} dir
 * @param {RegExp} pattern
 * @returns {string[]}
 */
export function listChunkFiles(dir, pattern) {
  return readdirSync(dir)
    .filter((f) => pattern.test(f))
    .sort();
}

/**
 * Read every `dir` file matching `pattern`, JSON-parse each (must be an array),
 * and return one concatenated array. Throws `${file}: expected JSON array` on a
 * non-array file.
 *
 * @param {string} dir
 * @param {RegExp} pattern
 * @returns {unknown[]}
 */
export function readJsonChunks(dir, pattern) {
  const records = [];
  for (const f of listChunkFiles(dir, pattern)) {
    const arr = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
    if (!Array.isArray(arr)) throw new Error(`${f}: expected JSON array`);
    records.push(...arr);
  }
  return records;
}

/**
 * Write a CSV with a leading UTF-8 BOM (U+FEFF) so Korean Excel (default CP949
 * codepage) opens it as UTF-8 rather than mojibake. Every cell is CSV-escaped;
 * pass the header as `rows[0]`.
 *
 * @param {string} path
 * @param {Array<Array<string|number|null|undefined>>} rows
 */
export function writeCsvWithBom(path, rows) {
  const body = rows.map((row) => row.map(csvEscape).join(',')).join('\n');
  writeTextAtomic(path, `﻿${body}\n`);
}

/**
 * Return the value following `name` in `argv`, or `undefined` if absent.
 *
 * @param {string[]} argv
 * @param {string} name
 * @returns {string|undefined}
 */
export function parseFlag(argv, name) {
  const idx = argv.indexOf(name);
  return idx >= 0 ? argv[idx + 1] : undefined;
}
