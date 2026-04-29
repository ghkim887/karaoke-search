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
// Aggregate failure types by message-prefix so triage shows category-level
// signal beyond just the first-5 sample IDs. Keyed by the first 80 chars of
// `err.message` to collapse near-identical errors that differ only in record-
// specific tail text (e.g. interpolated values).
const failureCategories = new Map();

for (const r of records) {
  try {
    validateSongRecord(r);
  } catch (err) {
    invalid += 1;
    if (invalid <= 5) {
      console.error(JSON.stringify({ id: r.id, error: err.message }));
    }
    const key = err.message.slice(0, 80);
    failureCategories.set(key, (failureCategories.get(key) ?? 0) + 1);
  }
}

if (invalid > 0) {
  console.error(`Validation failures: ${invalid} / ${records.length}`);
  // Sorted descending by count so the most common failure surfaces first.
  const sorted = Array.from(failureCategories.entries()).sort((a, b) => b[1] - a[1]);
  console.error(
    `\nFailure summary (${invalid} invalid records, ${sorted.length} distinct error categories):`,
  );
  const countWidth = String(sorted[0]?.[1] ?? 0).length;
  for (const [msg, count] of sorted) {
    console.error(`  ${String(count).padStart(countWidth)} × ${msg}`);
  }
  process.exit(1);
}

console.log(`Validated ${records.length} / ${records.length} records`);
