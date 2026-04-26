#!/usr/bin/env node
// Phase 9 bundle-size guard. Walk apps/web/dist/_astro/*.js, gzip each chunk
// in-memory, and fail the build if any chunk's gzipped size exceeds 50 KB.
// The 50 KB ceiling is the v1 spec budget — do NOT lower it without a spec
// update.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const LIMIT_BYTES = 50 * 1024;

const __dirname = dirname(fileURLToPath(import.meta.url));
const astroDir = resolve(__dirname, '..', 'dist', '_astro');

if (!existsSync(astroDir)) {
  console.error(`ERROR: ${astroDir} does not exist. Run \`astro build\` first.`);
  process.exit(1);
}

const jsFiles = readdirSync(astroDir).filter((name) => name.endsWith('.js'));

if (jsFiles.length === 0) {
  console.error(`ERROR: no .js chunks found in ${astroDir}.`);
  process.exit(1);
}

const sizes = [];
let largest = { name: '', bytes: 0 };
let violation = null;

for (const name of jsFiles) {
  const buf = readFileSync(join(astroDir, name));
  const gz = gzipSync(buf);
  const kb = (gz.length / 1024).toFixed(2);
  console.log(`${name}: ${kb} KB gzipped`);
  sizes.push({ name, bytes: gz.length });
  if (gz.length > largest.bytes) largest = { name, bytes: gz.length };
  if (gz.length > LIMIT_BYTES && violation === null) {
    violation = { name, bytes: gz.length };
  }
}

if (violation !== null) {
  const kb = (violation.bytes / 1024).toFixed(2);
  console.error(`ERROR: ${violation.name} exceeds 50 KB gzipped (${kb} KB)`);
  process.exit(1);
}

const largestKb = (largest.bytes / 1024).toFixed(2);
console.log(`OK: largest chunk ${largest.name} at ${largestKb} KB gzipped (limit 50 KB)`);
process.exit(0);
