#!/usr/bin/env node
// Re-applies the crawler's `mergeRecords` (Tier A + B + C) to the already-
// committed `apps/web/public/data/songs.json`, without re-running the full
// crawl. Use this whenever the merger source evolves (new Tier, ownership
// chain, conflict shape) but the underlying corpus hasn't been re-crawled.
//
// Behavior:
//   1. Build the crawler if `dist/merge.js` is missing or stale relative to
//      `src/merge.ts`.
//   2. Load apps/web/public/data/songs.json, validate shape.
//   3. Run mergeRecords(records).
//   4. Print BEFORE/AFTER counts, delta, Tier C cluster details, and 5
//      sample disappeared-records.
//   5. Safety gate: delta > 30 -> abort without write, exit 2.
//      delta = 0 -> no-op, exit 0.
//      otherwise -> atomic write (.tmp -> rename) and exit 0.
//
// Output is UTF-8 on Windows: stdout is reset to utf8 explicitly.

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Force UTF-8 output on Windows so kanji/hangul render correctly in the report.
if (process.stdout.setDefaultEncoding) process.stdout.setDefaultEncoding('utf8');
if (process.stderr.setDefaultEncoding) process.stderr.setDefaultEncoding('utf8');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

const songsPath = resolve(repoRoot, 'apps/web/public/data/songs.json');
const mergeJsPath = resolve(repoRoot, 'packages/crawler/dist/merge.js');
const mergeTsPath = resolve(repoRoot, 'packages/crawler/src/merge.ts');

// --- Step 1: build crawler if dist is missing or stale -------------------
function needsBuild() {
  if (!existsSync(mergeJsPath)) return true;
  if (!existsSync(mergeTsPath)) return false; // can't compare; trust dist
  const distMtime = statSync(mergeJsPath).mtimeMs;
  const srcMtime = statSync(mergeTsPath).mtimeMs;
  return srcMtime > distMtime;
}

if (needsBuild()) {
  console.log('[replay-merger] crawler dist is missing or stale -> building');
  // corepack ships with Node and shells out to pnpm. Build is sync.
  const result = spawnSync(
    process.platform === 'win32' ? 'corepack.cmd' : 'corepack',
    ['pnpm', '--filter', '@karaoke/crawler', 'build'],
    { cwd: repoRoot, stdio: 'inherit' },
  );
  if (result.status !== 0) {
    console.error('[replay-merger] crawler build failed');
    process.exit(result.status ?? 1);
  }
} else {
  console.log('[replay-merger] crawler dist is up-to-date -> skipping build');
}

// --- Step 2: import mergeRecords -----------------------------------------
const { mergeRecords } = await import(pathToFileURL(mergeJsPath).href);
if (typeof mergeRecords !== 'function') {
  console.error('[replay-merger] dist/merge.js did not export mergeRecords');
  process.exit(1);
}

// --- Step 3: load corpus -------------------------------------------------
if (!existsSync(songsPath)) {
  console.error(`[replay-merger] corpus not found: ${songsPath}`);
  process.exit(1);
}
const before = JSON.parse(readFileSync(songsPath, 'utf8'));
if (!Array.isArray(before)) {
  console.error('[replay-merger] corpus is not an array');
  process.exit(1);
}
if (before.length === 0) {
  console.error('[replay-merger] corpus is empty');
  process.exit(1);
}
const sample = before[0];
if (
  !sample ||
  typeof sample.id !== 'string' ||
  typeof sample.karaoke_numbers !== 'object' ||
  !Array.isArray(sample.categories)
) {
  console.error('[replay-merger] first record does not look like a SongRecord');
  console.error(JSON.stringify(sample, null, 2));
  process.exit(1);
}

// --- Step 4: merge -------------------------------------------------------
const beforeCount = before.length;
const beforeIds = new Set(before.map((r) => r.id));
const beforeById = new Map(before.map((r) => [r.id, r]));

const { records: after, conflicts } = mergeRecords(before);
const afterCount = after.length;
const afterIds = new Set(after.map((r) => r.id));
const delta = beforeCount - afterCount;

const tierCConflicts = conflicts.filter((c) => c.field === 'tier_c_merge');

// --- Step 5: structured report ------------------------------------------
console.log('');
console.log('=== Replay-merger report ===');
console.log(`Before: ${beforeCount} records`);
console.log(`After : ${afterCount} records`);
console.log(`Delta : ${delta}`);
console.log(`Tier C cluster fires: ${tierCConflicts.length}`);

// Tier C cluster line per fire: list each cluster's members + winner +
// title + lead artist token (sourced from the winning record).
if (tierCConflicts.length > 0) {
  console.log('');
  console.log('--- Tier C clusters ---');
  for (const c of tierCConflicts) {
    const winnerRec = after.find((r) => r.id === c.winner);
    const memberIds = c.values.map((v) => `${v.source}:${v.value}`).join(', ');
    const title = winnerRec ? winnerRec.title_primary : '(missing winner)';
    const artist = winnerRec ? winnerRec.artist_primary : '(missing winner)';
    console.log(`  cluster=${c.cluster_key}`);
    console.log(`    members  : ${memberIds}`);
    console.log(`    winner   : ${c.winner}`);
    console.log(`    title    : ${title}`);
    console.log(`    artist   : ${artist}`);
  }
}

// Disappeared records: present in before, not in after, by id.
const disappeared = [];
for (const id of beforeIds) {
  if (!afterIds.has(id)) {
    const r = beforeById.get(id);
    if (r) disappeared.push(r);
  }
}

if (disappeared.length > 0) {
  console.log('');
  console.log(`--- Sample disappeared records (first 5 of ${disappeared.length}) ---`);
  for (const r of disappeared.slice(0, 5)) {
    console.log(`  id=${r.id}`);
    console.log(`    title  : ${r.title_primary}`);
    console.log(`    artist : ${r.artist_primary}`);
  }
}

// --- Step 6: safety gate -------------------------------------------------
if (delta < 0) {
  console.error('');
  console.error(
    `[replay-merger] FATAL: delta is negative (${delta}). Merger produced more records than input. Aborting.`,
  );
  process.exit(2);
}

if (delta > 30) {
  console.error('');
  console.error(
    `[replay-merger] SAFETY GATE: delta=${delta} exceeds threshold of 30. Refusing to write.`,
  );
  console.error(
    '[replay-merger] Inspect the Tier C clusters above and the disappeared-record sample, then re-run if expected.',
  );
  process.exit(2);
}

if (delta === 0) {
  console.log('');
  console.log('[replay-merger] no Tier C merges fired - corpus already current; skipping write');
  process.exit(0);
}

// --- Step 7: atomic write ------------------------------------------------
const tmpPath = `${songsPath}.tmp`;
const json = `${JSON.stringify(after, null, 2)}\n`;
writeFileSync(tmpPath, json, { encoding: 'utf8' });
renameSync(tmpPath, songsPath);

console.log('');
console.log(`[replay-merger] wrote ${afterCount} records to ${songsPath}`);
console.log(`[replay-merger] removed ${delta} duplicate(s) via Tier C cross-source merge`);
process.exit(0);
