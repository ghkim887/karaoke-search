#!/usr/bin/env node
// Applies a single manual title_ko fix to apps/web/public/data/songs.json.
//
// Usage:
//   node scripts/manual-fix-title-ko.mjs <record_id> <title_ko>
//   node scripts/manual-fix-title-ko.mjs <record_id> --null
//
// Sets title_ko_source = 'manual', deletes title_ko_confidence, validates
// the patched record against @karaoke/schema before writing. Atomic write
// via .tmp + rename.

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH =
  process.env.KARAOKE_CORPUS_PATH ?? resolve(__dirname, '../apps/web/public/data/songs.json');

function usage() {
  process.stderr.write(
    'Usage:\n' +
      '  node scripts/manual-fix-title-ko.mjs <record_id> <title_ko>\n' +
      '  node scripts/manual-fix-title-ko.mjs <record_id> --null\n',
  );
  process.exit(1);
}

const [, , recordId, titleArg] = process.argv;

if (!recordId || !titleArg) usage();

const isNull = titleArg === '--null';
const newTitleKo = isNull ? null : titleArg;

let validateSongRecord;
try {
  ({ validateSongRecord } = await import('../packages/schema/dist/index.js'));
} catch {
  process.stderr.write(
    'Cannot load @karaoke/schema. Run `corepack pnpm --filter @karaoke/schema build` first.\n',
  );
  process.exit(1);
}

const records = JSON.parse(readFileSync(CORPUS_PATH, 'utf-8'));

const matches = records.filter((r) => r.id === recordId);

if (matches.length === 0) {
  process.stderr.write(`record not found: ${recordId}\n`);
  process.exit(1);
}

if (matches.length > 1) {
  process.stderr.write(`duplicate record_id in corpus: ${recordId}\n`);
  process.exit(1);
}

const target = matches[0];
const before = JSON.stringify(target);

target.title_ko = newTitleKo;
target.title_ko_source = 'manual';
target.title_ko_confidence = undefined;

try {
  validateSongRecord(target);
} catch (err) {
  process.stderr.write(`Schema validation failed: ${err.message}\n`);
  process.exit(1);
}

const after = JSON.stringify(target);
if (before === after) {
  process.stdout.write(`no change: ${recordId}\n`);
  process.exit(0);
}

const tmpPath = `${CORPUS_PATH}.tmp`;
writeFileSync(tmpPath, `${JSON.stringify(records, null, 2)}\n`, 'utf-8');
renameSync(tmpPath, CORPUS_PATH);

process.stdout.write(`updated: ${recordId} title_ko=${JSON.stringify(newTitleKo)}\n`);
