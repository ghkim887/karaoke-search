/**
 * Shared atomic-write helpers for scripts/*.mjs.
 *
 * Mirrors the Python `_atomic_write_corpus` convention: write to a `.tmp`
 * sibling file then rename into place so readers never see a partial write.
 * Both functions are byte-stable on identical input (idempotent across builds).
 *
 * Exports:
 *   writeJsonAtomic(path, value, opts?)
 *     Serialise `value` as JSON and write atomically.
 *     opts.indent          — JSON.stringify indent, default 2
 *     opts.trailingNewline — append a trailing newline, default true
 *
 *   writeTextAtomic(path, text)
 *     Write a raw string atomically (caller is responsible for encoding).
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * @param {string} path - absolute destination path
 * @param {unknown} value - JSON-serialisable value
 * @param {{ indent?: number, trailingNewline?: boolean }} [opts]
 */
export function writeJsonAtomic(path, value, opts = {}) {
  const indent = opts.indent ?? 2;
  const trailingNewline = opts.trailingNewline ?? true;

  const json = JSON.stringify(value, null, indent);
  const content = trailingNewline ? `${json}\n` : json;

  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, path);
}

/**
 * @param {string} path - absolute destination path
 * @param {string} text - raw text content
 */
export function writeTextAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, 'utf-8');
  renameSync(tmp, path);
}
