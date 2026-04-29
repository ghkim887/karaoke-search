#!/usr/bin/env node
// Validates apps/web/public/data/songs.json against @karaoke/schema's
// validateSongRecord asserts function. Exits non-zero on the first 5+ failures.
// Used by .github/workflows/crawl.yml after the Python PDF ingest writes the JSON.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const target = process.argv[2] ?? 'apps/web/public/data/songs.json';
const { validateSongRecord } = await import('../packages/schema/dist/index.js');

const records = JSON.parse(readFileSync(resolve(target), 'utf8'));
let invalid = 0;

for (const r of records) {
  try {
    validateSongRecord(r);
  } catch (err) {
    if (++invalid <= 5) {
      console.error(JSON.stringify({ id: r.id, error: err.message }));
    }
  }
}

if (invalid > 0) {
  console.error(`Validation failures: ${invalid} / ${records.length}`);
  process.exit(1);
}

console.log(`Validated ${records.length} / ${records.length} records`);
