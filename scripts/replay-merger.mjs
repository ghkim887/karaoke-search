#!/usr/bin/env node
// Re-applies the crawler's alias resolver + `mergeRecords` (Tier A + B + C)
// to the already-committed `apps/web/public/data/songs.json`, without
// re-running the full crawl. Use this whenever the merger source evolves
// (new Tier, ownership chain, conflict shape) OR when the alias-resolution
// stage's behavior changes (`packages/crawler/src/aliases.ts`).
//
// Behavior:
//   1. Build the crawler if `dist/merge.js` (or `dist/aliases.js`) is missing
//      or stale relative to its corresponding `src` file.
//   2. Load apps/web/public/data/songs.json, validate shape.
//   3. Run resolveArtistAliases(records) FIRST (spec 2026-05-04: alias
//      resolution must precede merge so pipe-form `artist_primary` is
//      canonicalized before Tier B clustering).
//   4. Run mergeRecords(resolvedRecords).
//   5. Print BEFORE/AFTER counts, delta, alias-resolution stats, Tier C
//      cluster details, and 5 sample disappeared-records.
//   6. Safety gate: delta > MAX_DELTA_THRESHOLD -> abort without write,
//      exit 2. delta = 0 AND no alias rewrites AND no same-id content changes
//      -> no-op, exit 0. otherwise -> atomic write (.tmp -> rename) and exit 0.
//      (A delta-0 run still writes when the merger changed record content
//      without changing the count, e.g. cross-record artist_ko propagation.)
//
// Output is UTF-8 on Windows: stdout is reset to utf8 explicitly.
//
// Testability refactor (2026-06): steps 2-7 live in the exported
// `runReplay(options)` (paths + thresholds injectable, defaults preserved),
// so importing this module is side-effect-free. The CLI shim at the bottom
// keeps step 1 (build-if-stale / CI dist check) + the exit-code mapping
// identical to the pre-refactor top-level script.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isCliInvocation } from './lib/cli.mjs';
import { writeCorpusAtomic } from './lib/corpus.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

// Fix F.1 (2026-05-01): named constants for safety thresholds + sample sizes.
// Pulled out of inline literals so the abort/sample policy is visible at the
// top of the file rather than buried in branch logic.
//
// MAX_DELTA_THRESHOLD: refuse to write when the merger would remove more
// records than this. Originally 30 (Tier C-only ceiling). Raised to 1000 in
// the 2026-05-04 alias-dedup migration because the alias resolver +
// subsequent Tier B merges can collapse hundreds of bare-vs-pipe-form pairs
// in a single pass on the existing corpus. Spec §9 ("Verification + rollout")
// estimates a ~50-150 drop from Tier B post-aliases, but the orchestrator's
// migration target was ~840 collapses; either is below 1000. A delta above
// 1000 is more likely a bug in the matcher than a flood of legitimate dupes
// — abort and surface for review.
export const MAX_DELTA_THRESHOLD = 1000;
// SAMPLE_DISAPPEARED_LIMIT: how many disappeared records to print in the
// console report. The full count is shown above the sample.
const SAMPLE_DISAPPEARED_LIMIT = 5;
// MIN_NON_FATAL_DELTA: the smallest delta that is NOT fatal. Anything below
// this (i.e. delta < 0) means the merger output more records than the input
// — impossible under correct merge logic. Treated as fatal (exit 2) without
// writing.
export const MIN_NON_FATAL_DELTA = 0;

// KARAOKE_SONGS_JSON: corpus-path override exported by
// scripts/run-post-crawl-pipeline.mjs when its --corpus flag is used, so the
// whole pipeline can be exercised against a copy. Unset in CI/default runs.
// (Tests injecting an explicit `songsPath` via runReplay options are
// unaffected — the env override only feeds the default.)
const defaultSongsPath = process.env.KARAOKE_SONGS_JSON
  ? resolve(process.env.KARAOKE_SONGS_JSON)
  : resolve(repoRoot, 'apps/web/public/data/songs.json');
const defaultMergeJsPath = resolve(repoRoot, 'packages/crawler/dist/merge.js');
const mergeTsPath = resolve(repoRoot, 'packages/crawler/src/merge.ts');
const defaultAliasesJsPath = resolve(repoRoot, 'packages/crawler/dist/aliases.js');
const aliasesTsPath = resolve(repoRoot, 'packages/crawler/src/aliases.ts');

/**
 * Stable, key-order-independent JSON serialization. Object keys are sorted
 * recursively so two records that differ ONLY in key order serialize
 * identically. Used by the delta-0 write gate to detect genuine same-id
 * content changes (e.g. cross-record artist_ko propagation, alias rewrites)
 * without mistaking a benign field-order difference for a change.
 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

// --- Step 1 (CLI shim only): build crawler if dist is missing or stale ---
function needsBuild() {
  for (const [jsPath, tsPath] of [
    [defaultMergeJsPath, mergeTsPath],
    [defaultAliasesJsPath, aliasesTsPath],
  ]) {
    if (!existsSync(jsPath)) return true;
    if (!existsSync(tsPath)) continue; // can't compare; trust dist
    const distMtime = statSync(jsPath).mtimeMs;
    const srcMtime = statSync(tsPath).mtimeMs;
    if (srcMtime > distMtime) return true;
  }
  return false;
}

/**
 * Steps 2-7 of the replay pipeline: import the merger, load the corpus,
 * alias-resolve, merge, report, gate, and (maybe) write.
 *
 * Never calls `process.exit` — returns the would-be exit code instead so
 * tests can drive it in-process. Console output is identical to the
 * pre-refactor top-level script.
 *
 * @param {{
 *   songsPath?: string,
 *   mergeJsPath?: string,
 *   aliasesJsPath?: string,
 *   maxDeltaThreshold?: number,
 *   minNonFatalDelta?: number,
 *   sampleDisappearedLimit?: number,
 * }} [options]
 * @returns {Promise<{
 *   exitCode: number,
 *   wrote: boolean,
 *   beforeCount?: number,
 *   afterCount?: number,
 *   delta?: number,
 *   aliasSplits?: number,
 *   aliasReKeys?: number,
 *   changedRecordCount?: number,
 * }>}
 */
export async function runReplay(options = {}) {
  const {
    songsPath = defaultSongsPath,
    mergeJsPath = defaultMergeJsPath,
    aliasesJsPath = defaultAliasesJsPath,
    maxDeltaThreshold = MAX_DELTA_THRESHOLD,
    minNonFatalDelta = MIN_NON_FATAL_DELTA,
    sampleDisappearedLimit = SAMPLE_DISAPPEARED_LIMIT,
  } = options;

  // --- Step 2: import mergeRecords + resolveArtistAliases -----------------
  const { mergeRecords } = await import(pathToFileURL(mergeJsPath).href);
  if (typeof mergeRecords !== 'function') {
    console.error('[replay-merger] dist/merge.js did not export mergeRecords');
    return { exitCode: 1, wrote: false };
  }
  const { resolveArtistAliases } = await import(pathToFileURL(aliasesJsPath).href);
  if (typeof resolveArtistAliases !== 'function') {
    console.error('[replay-merger] dist/aliases.js did not export resolveArtistAliases');
    return { exitCode: 1, wrote: false };
  }

  // --- Step 3: load corpus -------------------------------------------------
  if (!existsSync(songsPath)) {
    console.error(`[replay-merger] corpus not found: ${songsPath}`);
    return { exitCode: 1, wrote: false };
  }
  const before = JSON.parse(readFileSync(songsPath, 'utf8'));
  if (!Array.isArray(before)) {
    console.error('[replay-merger] corpus is not an array');
    return { exitCode: 1, wrote: false };
  }
  if (before.length === 0) {
    console.error('[replay-merger] corpus is empty');
    return { exitCode: 1, wrote: false };
  }
  const sample = before[0];
  if (!sample || typeof sample.id !== 'string' || typeof sample.karaoke_numbers !== 'object') {
    console.error('[replay-merger] first record does not look like a SongRecord');
    console.error(JSON.stringify(sample, null, 2));
    return { exitCode: 1, wrote: false };
  }

  // --- Step 4: alias resolve, then merge -----------------------------------
  // Spec 2026-05-04 (folded migration): alias resolution must run BEFORE the
  // merger so pipe-form `artist_primary` is canonicalized into a (canonical,
  // aliases) pair, and bare records that match a known alias re-key to the
  // canonical surface form. Once `artist_primary` is canonical for both
  // halves of an alias pair, Tier B clusters them naturally.
  const beforeCount = before.length;
  const beforeIds = new Set(before.map((r) => r.id));
  const beforeById = new Map(before.map((r) => [r.id, r]));

  const { records: resolved, warnings: aliasWarnings } = resolveArtistAliases(before);
  // Count how many records the alias stage actually rewrote, for the report.
  let aliasSplits = 0; // pipe-form records that produced canonical+aliases
  let aliasReKeys = 0; // bare records re-keyed to a canonical alias
  for (let i = 0; i < before.length; i++) {
    const b = before[i];
    const r = resolved[i];
    if (!b || !r) continue;
    if (b.artist_primary !== r.artist_primary) {
      if (b.artist_primary.includes('｜')) aliasSplits += 1;
      else aliasReKeys += 1;
    }
  }

  const { records: after, conflicts } = mergeRecords(resolved);
  const afterCount = after.length;
  const afterIds = new Set(after.map((r) => r.id));
  const delta = beforeCount - afterCount;

  // Count same-id records whose content changed (e.g. cross-record artist_ko
  // propagation, alias rewrites). The merger can change records WITHOUT
  // changing the record count — artist_ko propagation fills a missing field on
  // standalone rows that never merge — so a delta-0 / no-alias-rewrite run can
  // still carry real data changes that must be persisted. Compared via a
  // stable key-order-independent serialization so re-ordered keys are not
  // false positives. (Records that merged away are absent from `after` and not
  // counted here; any such case has delta > 0 and writes anyway.)
  let changedRecordCount = 0;
  for (const r of after) {
    const b = beforeById.get(r.id);
    if (b && canonicalJson(b) !== canonicalJson(r)) changedRecordCount += 1;
  }

  const tierCConflicts = conflicts.filter((c) => c.field === 'tier_c_merge');

  // --- Step 5: structured report ------------------------------------------
  console.log('');
  console.log('=== Replay-merger report ===');
  console.log(`Before: ${beforeCount} records`);
  console.log(`After : ${afterCount} records`);
  console.log(`Delta : ${delta}`);
  console.log(`Alias-resolution: ${aliasSplits} pipe-form splits, ${aliasReKeys} bare re-keys`);
  console.log(`Same-id content changes: ${changedRecordCount}`);
  console.log(`Alias warnings  : ${aliasWarnings.length}`);
  if (aliasWarnings.length > 0) {
    console.log('--- Alias warnings (first 5) ---');
    for (const w of aliasWarnings.slice(0, 5)) {
      console.log(`  alias=${w.alias}`);
      if (w.canonicals.length > 0) {
        console.log(`    canonicals: ${w.canonicals.join(' | ')}`);
        console.log(`    affected  : ${w.affected}`);
      } else {
        console.log('    (malformed pipe-form input — record left untouched)');
      }
    }
  }
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
    console.log(
      `--- Sample disappeared records (first ${sampleDisappearedLimit} of ${disappeared.length}) ---`,
    );
    for (const r of disappeared.slice(0, sampleDisappearedLimit)) {
      console.log(`  id=${r.id}`);
      console.log(`    title  : ${r.title_primary}`);
      console.log(`    artist : ${r.artist_primary}`);
    }
  }

  // --- Step 6: safety gate -------------------------------------------------
  const stats = { beforeCount, afterCount, delta, aliasSplits, aliasReKeys, changedRecordCount };

  if (delta < minNonFatalDelta) {
    console.error('');
    console.error(
      `[replay-merger] FATAL: delta is negative (${delta}). Merger produced more records than input. Aborting.`,
    );
    return { exitCode: 2, wrote: false, ...stats };
  }

  if (delta > maxDeltaThreshold) {
    console.error('');
    console.error(
      `[replay-merger] SAFETY GATE: delta=${delta} exceeds threshold of ${maxDeltaThreshold}. Refusing to write.`,
    );
    console.error(
      '[replay-merger] Inspect the Tier C clusters above and the disappeared-record sample, then re-run if expected.',
    );
    return { exitCode: 2, wrote: false, ...stats };
  }

  if (delta === 0 && aliasSplits === 0 && aliasReKeys === 0 && changedRecordCount === 0) {
    console.log('');
    console.log(
      '[replay-merger] no Tier C merges fired and no alias rewrites — corpus already current; skipping write',
    );
    return { exitCode: 0, wrote: false, ...stats };
  }

  // --- Step 7: atomic write ------------------------------------------------
  writeCorpusAtomic(songsPath, after);

  console.log('');
  console.log(`[replay-merger] wrote ${afterCount} records to ${songsPath}`);
  console.log(
    `[replay-merger] removed ${delta} duplicate(s) (alias-resolution + Tier A/B/C merges)`,
  );
  return { exitCode: 0, wrote: true, ...stats };
}

async function main() {
  // Fix E.1 (2026-05-01): in CI mode, the previous step (`pnpm -r build`) is
  // already responsible for ensuring `dist/merge.js` is fresh. Auto-rebuilding
  // here would mask the original failure: if the build step had a real error
  // (e.g. tsc type error) and a stale dist still existed on disk, this script
  // would silently rebuild and continue, hiding the failure. In CI, the right
  // behavior is to trust the previous step or error out loudly so the failure
  // is visible at the source.
  const isCI = !!process.env.CI;

  if (isCI) {
    for (const p of [defaultMergeJsPath, defaultAliasesJsPath]) {
      if (!existsSync(p)) {
        console.error(`[replay-merger] ${p} missing in CI; previous build step must have failed`);
        process.exit(1);
      }
    }
    console.log('[replay-merger] CI mode -> skipping auto-build (trusting previous build step)');
  } else if (needsBuild()) {
    console.log('[replay-merger] crawler dist is missing or stale -> building');
    // corepack ships with Node and shells out to pnpm. Build is sync.
    // Fix E.3 (2026-05-01): args are hardcoded literals — never set
    // `shell: true` here. If a future refactor parameterizes the args from
    // user input, leaving `shell: true` enabled would expose a shell-
    // injection vector via the unsanitized arg string.
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

  const { exitCode } = await runReplay();
  process.exit(exitCode);
}

if (isCliInvocation(import.meta.url)) {
  await main();
}
