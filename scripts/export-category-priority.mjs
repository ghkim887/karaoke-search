#!/usr/bin/env node
/**
 * Export the CATEGORY_PRIORITY array as a JSON sidecar consumable from Python.
 *
 * The TS source of truth is `packages/schema/src/index.ts` which exports
 * `CATEGORY_PRIORITY` as a named constant. This script reads that constant
 * from the built dist (`packages/schema/dist/index.js`) and writes it to a
 * sidecar JSON at `packages/schema/category-priority.json` — tracked in git,
 * co-located with the schema package it describes.
 *
 * Why this matters: `scripts/ingest_anisong_pdf.py` contains
 * `_apply_category_exclusivity` which hard-codes the same
 * `('vocaloid', 'anime', 'jpop')` priority order. Previously sync was
 * test-only; now it is mechanical — Python reads the priority array from this
 * sidecar and uses it at import time. Drift → sidecar diverges from committed
 * file → `git diff --exit-code` fails in CI.
 *
 * Output schema:
 *   {
 *     "version": 1,
 *     "priority": ["vocaloid", "anime", "jpop"]
 *   }
 *
 * `generatedAt` is intentionally omitted: a timestamp would dirty the working
 * tree on every build even when nothing changed. Git history is the timeline.
 *
 * Run automatically as part of `corepack pnpm --filter @karaoke/schema build`
 * (wired into the package's `build` script). Manual invocation is also fine —
 * the script is idempotent.
 *
 * Usage:
 *   node scripts/export-category-priority.mjs
 */

import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeJsonAtomic } from './lib/atomic-write.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const DIST_MODULE = resolve(REPO_ROOT, 'packages/schema/dist/index.js');
// Sidecar lives next to the schema package root and is tracked in git.
// Co-locating means a TS edit without a sidecar regen surfaces as a
// one-of-two-files diff at code review (the staleness footgun is visible).
const OUT_PATH = resolve(REPO_ROOT, 'packages/schema/category-priority.json');

async function main() {
  // dynamic import via file URL: the dist path is absolute on disk and not
  // resolvable as a bare specifier from this script.
  const mod = await import(pathToFileURL(DIST_MODULE).href);

  const { CATEGORY_PRIORITY } = mod;
  if (!Array.isArray(CATEGORY_PRIORITY) || CATEGORY_PRIORITY.length === 0) {
    throw new Error(
      `CATEGORY_PRIORITY export not found or empty in ${DIST_MODULE} (got ${JSON.stringify(CATEGORY_PRIORITY)})`,
    );
  }

  const sidecar = {
    version: 1,
    priority: Array.from(CATEGORY_PRIORITY),
  };

  writeJsonAtomic(OUT_PATH, sidecar);
  console.log(`wrote category-priority sidecar to ${OUT_PATH}`);
  console.log(`  priority: ${JSON.stringify(Array.from(CATEGORY_PRIORITY))}`);
}

main().catch((err) => {
  console.error('export-category-priority failed:', err);
  process.exit(1);
});
