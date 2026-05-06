#!/usr/bin/env node
/**
 * Export the Chinese-artist (Cantopop / Mandopop) drop list as a JSON sidecar
 * consumable from Python.
 *
 * The TS source of truth is `packages/crawler/src/adapters/tj-media-direct/
 * chineseArtistDropList.ts`. The Python cleanup script
 * (`scripts/drop_cpop_leaks.py`) needs the same drop set so it can drop any
 * leaked records from `apps/web/public/data/songs.json` without paying the
 * cost of a fresh re-crawl. Mirrors the pattern established by
 * `export-drop-list.mjs` (the Korean one).
 *
 * Output location: the sidecar lives at
 * `packages/crawler/src/adapters/tj-media-direct/chinese-artist-drop-list.json`
 * — co-located with the TS source AND tracked in git. Co-locating means a TS
 * edit without a sidecar regen surfaces as a one-of-two-files diff at code
 * review (the staleness footgun is visible). Tracking in git means ad-hoc
 * local Python runs against the corpus pick up the latest list without first
 * rebuilding the crawler.
 *
 * Output schema (kept minimal — Python only needs the keys for membership):
 *   {
 *     "version": 1,
 *     "keys": ["beyond", "f4", "s.h.e", ...]
 *   }
 *
 * `generatedAt` is intentionally omitted: including a timestamp would dirty
 * the working tree on every build even when the drop list hadn't changed.
 * Git history is the timeline; the keys array is the payload.
 *
 * Run automatically as part of `corepack pnpm --filter @karaoke/crawler build`
 * (wired into the package's `build` script as a post-tsc step). Manual
 * invocation is also fine — the script is idempotent.
 *
 * Usage:
 *   node scripts/export-chinese-drop-list.mjs
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const DIST_MODULE = resolve(
  REPO_ROOT,
  'packages/crawler/dist/adapters/tj-media-direct/chineseArtistDropList.js',
);
// Sidecar lives next to the TS source and is tracked in git, mirroring
// `export-drop-list.mjs`. The `src/` tree is not gitignored, so the JSON
// shows up in `git status` after every build — making a stale-sidecar /
// TS-edited-without-regen scenario visible at code-review time.
const OUT_PATH = resolve(
  REPO_ROOT,
  'packages/crawler/src/adapters/tj-media-direct/chinese-artist-drop-list.json',
);

async function main() {
  // dynamic import via file URL: the dist path is absolute on disk and not
  // resolvable as a bare specifier from this script.
  const mod = await import(pathToFileURL(DIST_MODULE).href);
  const dropKeySet = mod.CHINESE_ARTIST_DROP_LIST;
  if (!(dropKeySet instanceof Set)) {
    throw new Error(
      `CHINESE_ARTIST_DROP_LIST export not found in ${DIST_MODULE} (got ${typeof dropKeySet})`,
    );
  }

  const keys = Array.from(dropKeySet).sort();
  const sidecar = {
    version: 1,
    keys,
  };

  // Atomic write: <file>.tmp then rename, matching the project's atomic-write
  // convention (see `scripts/ingest-anisong-pdf.py::_atomic_write_corpus`).
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  const tmpPath = `${OUT_PATH}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(sidecar, null, 2)}\n`, 'utf-8');
  renameSync(tmpPath, OUT_PATH);
  console.log(`wrote ${keys.length} chinese drop-list keys to ${OUT_PATH}`);
}

main().catch((err) => {
  console.error('export-chinese-drop-list failed:', err);
  process.exit(1);
});
