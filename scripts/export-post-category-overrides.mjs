#!/usr/bin/env node
/**
 * Export the per-post category override map as a JSON sidecar consumable from
 * Python.
 *
 * The TS source of truth is `packages/crawler/src/adapters/jpop-playlist-blog/
 * crawler.ts` (`POST_CATEGORY_OVERRIDES`). The Python corpus retag
 * (`scripts/retag_blog_vocaloid_mistags.py`) needs the same map so it can
 * re-apply the same demote-to-jpop fix to existing records without paying the
 * cost of a fresh blog re-crawl. Rather than maintain two copies of the map,
 * this script reads the built dist (`packages/crawler/dist/...`) and writes
 * the post-id → category lookup to a sidecar JSON file alongside the TS source.
 *
 * Output location: the sidecar lives at
 * `packages/crawler/src/adapters/jpop-playlist-blog/post-category-overrides.json`
 * — co-located with the TS source AND tracked in git, mirroring the pattern
 * established by `export-drop-list.mjs`. Co-locating means a TS edit without
 * a sidecar regen surfaces as a one-of-two-files diff at code review (the
 * staleness footgun is visible). Tracking in git means ad-hoc local Python
 * runs against the corpus pick up the latest map without first rebuilding
 * the crawler.
 *
 * Output schema (kept minimal — Python only needs the post-id → category map):
 *   {
 *     "version": 1,
 *     "overrides": { "101": "jpop", "105": "jpop", "112": "jpop" }
 *   }
 *
 * `generatedAt` is intentionally omitted: including a timestamp made every
 * build dirty the working tree even when the override map hadn't changed.
 * Git history is the timeline; the overrides object is the payload.
 *
 * Run automatically as part of `corepack pnpm --filter @karaoke/crawler build`
 * (wired into the package's `build` script as a post-tsc step). Manual
 * invocation is also fine — the script is idempotent. The Python retag
 * treats a missing sidecar as a hard error (the override map is the script's
 * entire reason for existing; failing loud is correct).
 *
 * Usage:
 *   node scripts/export-post-category-overrides.mjs
 */

import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeJsonAtomic } from './lib/atomic-write.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const DIST_MODULE = resolve(
  REPO_ROOT,
  'packages/crawler/dist/adapters/jpop-playlist-blog/crawler.js',
);
// Sidecar lives next to the TS source and is tracked in git, mirroring
// `export-drop-list.mjs`. The `src/` tree is not gitignored, so the JSON
// shows up in `git status` after every build — making a stale-sidecar /
// TS-edited-without-regen scenario visible at code-review time.
const OUT_PATH = resolve(
  REPO_ROOT,
  'packages/crawler/src/adapters/jpop-playlist-blog/post-category-overrides.json',
);

async function main() {
  // dynamic import via file URL: the dist path is absolute on disk and not
  // resolvable as a bare specifier from this script.
  const mod = await import(pathToFileURL(DIST_MODULE).href);
  const overrides = mod.POST_CATEGORY_OVERRIDES;
  if (overrides === null || typeof overrides !== 'object') {
    throw new Error(
      `POST_CATEGORY_OVERRIDES export not found in ${DIST_MODULE} (got ${typeof overrides})`,
    );
  }

  // Sort keys for byte-deterministic output (idempotent across builds).
  const sortedKeys = Object.keys(overrides).sort();
  const sortedOverrides = {};
  for (const k of sortedKeys) {
    sortedOverrides[k] = overrides[k];
  }

  const sidecar = {
    version: 1,
    overrides: sortedOverrides,
  };

  writeJsonAtomic(OUT_PATH, sidecar);
  console.log(`wrote ${sortedKeys.length} post-category overrides to ${OUT_PATH}`);
}

main().catch((err) => {
  console.error('export-post-category-overrides failed:', err);
  process.exit(1);
});
