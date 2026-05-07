/**
 * Shared corpus helpers for scripts/*.mjs.
 *
 * Exports:
 *   loadValidator()
 *     Imports validateSongRecord from packages/schema/dist/index.js.
 *     Throws with a helpful message if the dist is missing (run build first).
 *     Returns the validateSongRecord function.
 *
 *   loadCorpus(path)
 *     Reads and JSON-parses a corpus file. Returns the parsed array.
 *     Throws on missing file or malformed JSON.
 *
 *   writeCorpusAtomic(path, records)
 *     Writes a corpus array with the canonical byte-shape used throughout
 *     the pipeline (indent=2, trailing newline). Thin wrapper around
 *     writeJsonAtomic — use this instead of inline atomic-write boilerplate
 *     whenever you're writing the main songs.json corpus.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeJsonAtomic } from './atomic-write.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SCHEMA_DIST = resolve(HERE, '../../packages/schema/dist/index.js');

/**
 * Load and return the `validateSongRecord` function from the built schema dist.
 *
 * @returns {Promise<Function>}
 */
export async function loadValidator() {
  try {
    const { validateSongRecord } = await import(pathToFileURL(SCHEMA_DIST).href);
    return validateSongRecord;
  } catch {
    process.stderr.write(
      'Cannot load @karaoke/schema. Run `corepack pnpm --filter @karaoke/schema build` first.\n',
    );
    process.exit(1);
  }
}

/**
 * Read and JSON-parse a corpus JSON file.
 *
 * @param {string} path - absolute or process.cwd()-relative path
 * @returns {unknown[]} parsed array
 */
export function loadCorpus(path) {
  const abs = resolve(path);
  return JSON.parse(readFileSync(abs, 'utf-8'));
}

/**
 * Write a corpus array atomically with the canonical pipeline byte-shape
 * (JSON.stringify indent=2, trailing newline, UTF-8).
 *
 * @param {string} path - destination path
 * @param {unknown[]} records
 */
export function writeCorpusAtomic(path, records) {
  writeJsonAtomic(path, records, { indent: 2, trailingNewline: true });
}
