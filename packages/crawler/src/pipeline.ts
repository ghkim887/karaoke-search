import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type SongRecord, validateSongRecord } from '@karaoke/schema';
import type { Crawler } from './adapters/index.js';
import { mergeRecords } from './merge.js';

export interface RunPipelineOptions {
  adapters: Crawler[];
  /** Per-source cap on records; `0` or omitted means no cap. */
  limit?: number;
  outPath: string;
}

export interface RunPipelineResult {
  written: number;
}

/**
 * Source-agnostic pipeline.
 *
 *  1. Iterate `adapters` in registration order, collecting yielded records.
 *     If `limit > 0`, cap each adapter at `limit` records.
 *  2. Dedupe via `mergeRecords` (spec collision rules).
 *  3. Validate every merged record against `songRecordSchema`. Any failure
 *     aborts the pipeline (the throw propagates).
 *  4. Atomically write `outPath` via `outPath + ".tmp"` then rename.
 */
export async function runPipeline(opts: RunPipelineOptions): Promise<RunPipelineResult> {
  const { adapters, limit, outPath } = opts;
  const cap = typeof limit === 'number' && limit > 0 ? limit : Number.POSITIVE_INFINITY;

  const collected: SongRecord[] = [];
  for (const adapter of adapters) {
    let count = 0;
    for await (const record of adapter.crawl()) {
      if (count >= cap) break;
      collected.push(record);
      count++;
    }
  }

  const merged = mergeRecords(collected);
  for (const record of merged) {
    validateSongRecord(record);
  }

  await mkdir(dirname(outPath), { recursive: true });
  const tmp = `${outPath}.tmp`;
  const json = `${JSON.stringify(merged, null, 2)}\n`;
  await writeFile(tmp, json, 'utf8');
  await rename(tmp, outPath);

  return { written: merged.length };
}
