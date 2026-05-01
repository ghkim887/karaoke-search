import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type SongRecord, validateSongRecord } from '@karaoke/schema';
import type { Crawler } from './adapters/index.js';
import { type MergeConflict, mergeRecords } from './merge.js';

export interface RunPipelineOptions {
  adapters: Crawler[];
  /** Per-adapter source-page cap (e.g. artist pages). `0` or omitted means no
   * cap. The pipeline forwards this to each adapter unchanged; adapters
   * decide what "one unit" means. */
  limit?: number;
  outPath: string;
  /**
   * Optional sibling-output path for the merge-conflicts JSON summary
   * (Tier B vendor-number disagreements). When set, the pipeline writes
   * `{ total, sample }` (sample=first 10) to this path so the crawl
   * GitHub Actions workflow can append it to the PR body.
   */
  conflictsOutPath?: string;
}

export interface RunPipelineResult {
  written: number;
  conflicts: MergeConflict[];
}

/**
 * Source-agnostic pipeline.
 *
 *  1. Iterate `adapters` in registration order, passing `{ limit }` to each.
 *     Each adapter is responsible for honoring the cap on its own units
 *     (e.g. artist-page fetches), so a limit of N produces a balanced sample
 *     rather than truncating the resulting record list arbitrarily.
 *  2. Dedupe via `mergeRecords` (spec collision rules).
 *  3. Validate every merged record against `songRecordSchema`. Any failure
 *     aborts the pipeline (the throw propagates).
 *  4. Atomically write `outPath` via `outPath + ".tmp"` then rename.
 */
export async function runPipeline(opts: RunPipelineOptions): Promise<RunPipelineResult> {
  const { adapters, limit, outPath, conflictsOutPath } = opts;
  const adapterOptions = typeof limit === 'number' && limit > 0 ? { limit } : undefined;

  const collected: SongRecord[] = [];
  for (const adapter of adapters) {
    for await (const record of adapter.crawl(adapterOptions)) {
      collected.push(record);
    }
  }

  const { records: merged, conflicts } = mergeRecords(collected);
  for (const record of merged) {
    validateSongRecord(record);
  }

  await mkdir(dirname(outPath), { recursive: true });
  const tmp = `${outPath}.tmp`;
  const json = `${JSON.stringify(merged, null, 2)}\n`;
  await writeFile(tmp, json, 'utf8');
  await rename(tmp, outPath);

  if (conflictsOutPath) {
    // Fix B.1 (2026-05-01): exclude `tier_c_merge` from the headline `total`.
    // The PR body composition step in `.github/workflows/crawl.yml` reads
    // `total` and surfaces it as "Merge conflicts during dedup", but Tier C
    // merges are NOT disagreements — they're successful soft-merges flagged
    // for visibility. Counting them in the headline number was misleading.
    //
    // Asymmetry (Fix 3, 2026-05-01): only the headline `total` is filtered.
    // The `sample` (and the full conflicts list) remains UNFILTERED so Tier C
    // cluster details stay visible for forensic inspection per spec §3.C —
    // a reader of the JSON file can still see which Tier C clusters fired.
    const headlineConflicts = conflicts.filter((c) => c.field !== 'tier_c_merge');
    const summary = {
      total: headlineConflicts.length,
      sample: conflicts.slice(0, 10),
    };
    await mkdir(dirname(conflictsOutPath), { recursive: true });
    await writeFile(conflictsOutPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  }

  return { written: merged.length, conflicts };
}
