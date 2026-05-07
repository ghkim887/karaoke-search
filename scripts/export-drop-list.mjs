#!/usr/bin/env node
/**
 * Export the Korean-artist drop list as a JSON sidecar consumable from Python.
 *
 * The TS source of truth is `packages/crawler/src/adapters/tj-media-direct/
 * koreanArtistDropList.ts`. The Python ingest (`scripts/ingest_anisong_pdf.py`)
 * and the cleanup script (`scripts/drop_kpop_leaks.py`) need the same drop set
 * so they can refuse to insert/patch records whose artist matches a known
 * Korean act. Rather than maintain two copies, this script reads the built
 * dist (`packages/crawler/dist/...`) and writes the pre-normalized lookup keys
 * to a sidecar JSON file alongside the TS source.
 *
 * Output location (Fix 2, 2026-05-01): the sidecar lives at
 * `packages/crawler/src/adapters/tj-media-direct/korean-artist-drop-list.json`
 * — co-located with the TS source AND tracked in git. Co-locating means a TS
 * edit without a sidecar regen surfaces as a one-of-two-files diff at code
 * review (the staleness footgun is visible). Tracking in git means ad-hoc
 * local Python runs against the corpus pick up the latest list without first
 * rebuilding the crawler. The previous location under `dist/` was gitignored,
 * so a maintainer who edited the TS source then ran `drop_kpop_leaks.py`
 * locally without rebuilding would silently use a stale list. The Python
 * loader has been updated to read from the new tracked path.
 *
 * Output schema (kept minimal — Python only needs the keys for membership):
 *   {
 *     "version": 1,
 *     "keys": ["방탄소년단", "bts", "防弾少年団", ...]
 *   }
 *
 * `generatedAt` is intentionally omitted: including a timestamp made every
 * build dirty the working tree even when the drop list hadn't changed. Git
 * history is the timeline; the keys array is the payload.
 *
 * Run automatically as part of `corepack pnpm --filter @karaoke/crawler build`
 * (wired into the package's `build` script as a post-tsc step). Manual
 * invocation is also fine — the script is idempotent. The Python ingest
 * treats a missing/stale sidecar as a graceful-degradation case (logs a
 * warning, skips the filter) so a forgotten regen does not break the data
 * pipeline.
 *
 * Usage:
 *   node scripts/export-drop-list.mjs
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const DIST_MODULE = resolve(
  REPO_ROOT,
  'packages/crawler/dist/adapters/tj-media-direct/koreanArtistDropList.js',
);
// Sidecar lives next to the TS source and is tracked in git (Fix 2). The
// `src/` tree is not gitignored, so the JSON shows up in `git status` after
// every build — making a stale-sidecar / TS-edited-without-regen scenario
// visible at code-review time.
const OUT_PATH = resolve(
  REPO_ROOT,
  'packages/crawler/src/adapters/tj-media-direct/korean-artist-drop-list.json',
);

async function main() {
  // dynamic import via file URL: the dist path is absolute on disk and not
  // resolvable as a bare specifier from this script.
  const mod = await import(pathToFileURL(DIST_MODULE).href);
  const dropKeySet = mod.DROP_KEY_SET;
  if (!(dropKeySet instanceof Set)) {
    throw new Error(`DROP_KEY_SET export not found in ${DIST_MODULE} (got ${typeof dropKeySet})`);
  }

  const keys = Array.from(dropKeySet).sort();
  const sidecar = {
    version: 1,
    keys,
  };

  // Atomic write: <file>.tmp then rename, matching the project's atomic-write
  // convention (see `scripts/ingest_anisong_pdf.py::_atomic_write_corpus`).
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  const tmpPath = `${OUT_PATH}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(sidecar, null, 2)}\n`, 'utf-8');
  renameSync(tmpPath, OUT_PATH);
  console.log(`wrote ${keys.length} drop-list keys to ${OUT_PATH}`);
}

main().catch((err) => {
  console.error('export-drop-list failed:', err);
  process.exit(1);
});
