import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type SongRecord, validateSongRecord } from '@karaoke/schema';
import type { CrawlOptions, Crawler } from './adapters/index.js';
import { type AliasConflict, resolveArtistAliases } from './aliases.js';
import { type MergeConflict, headlineConflicts, mergeRecords } from './merge.js';
import { type BlogReverseLookup, computeBlogReverseLookup } from './reverseLookup.js';

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
  /**
   * Optional path for the TJ per-row filter decision log (JSONL). Forwarded
   * verbatim into each adapter's `CrawlOptions`; only `tj-media-direct` writes
   * it. `undefined` (the default) leaves adapter behavior byte-identical.
   */
  decisionsOutPath?: string;
  /**
   * Optional path for the numberless-blog-drop report (JSONL). Forwarded
   * verbatim into each adapter's `CrawlOptions`; only `jpop-playlist-blog`
   * writes it. `undefined` (the default) leaves adapter behavior byte-identical.
   */
  blogDropsOutPath?: string;
  /**
   * Optional path for the blog reverse-lookup artifact (JSON). When set, the
   * pipeline writes the claimed-but-unmatched vendor numbers on standalone blog
   * records after merge: the TJ probe seed and the JOYSOUND delisted/typo
   * report (design 2026-07-14 §3). `undefined` (the default) writes nothing and
   * leaves a plain crawl byte-identical.
   *
   * NOTE (consumption gap): nothing ingests the seed automatically yet — the
   * tj-media-direct R7 probe (`searchSongByPro`) only runs over its own crawled
   * catalog plus the blog-whitelist rescue. Feeding this seed into the probe is
   * a follow-up; today the artifact is emitted for the crawl report and manual
   * re-seeding.
   */
  reverseLookupOutPath?: string;
}

export interface RunPipelineResult {
  written: number;
  conflicts: MergeConflict[];
  aliasConflicts: AliasConflict[];
  reverseLookup: BlogReverseLookup;
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
  const {
    adapters,
    limit,
    outPath,
    conflictsOutPath,
    decisionsOutPath,
    blogDropsOutPath,
    reverseLookupOutPath,
  } = opts;
  // Preserve the original `undefined` when no adapter-facing knob is set, so a
  // plain crawl passes exactly what it did before (byte-identical adapter
  // behavior).
  const hasLimit = typeof limit === 'number' && limit > 0;
  const adapterOptions: CrawlOptions | undefined =
    hasLimit || decisionsOutPath || blogDropsOutPath
      ? {
          ...(hasLimit ? { limit } : {}),
          ...(decisionsOutPath ? { decisionsOutPath } : {}),
          ...(blogDropsOutPath ? { blogDropsOutPath } : {}),
        }
      : undefined;

  const collected: SongRecord[] = [];
  for (const adapter of adapters) {
    for await (const record of adapter.crawl(adapterOptions)) {
      collected.push(record);
    }
  }

  // Spec 2026-05-04: alias resolution runs BEFORE the merger so that pipe-form
  // `artist_primary` strings (`"X｜Y"`) are split into a canonical+aliases pair
  // and bare records whose value matches a known alias are re-keyed to the
  // canonical surface form. Once `artist_primary` is canonical for both halves
  // of an alias pair, Tier B's `(normalize(title), normalize(artist))` clusters
  // them naturally — no changes to `merge.ts` are required.
  const { records: resolved, warnings: aliasConflicts } = resolveArtistAliases(collected);

  const { records: merged, conflicts } = mergeRecords(resolved);
  for (const record of merged) {
    validateSongRecord(record);
  }

  await mkdir(dirname(outPath), { recursive: true });
  const tmp = `${outPath}.tmp`;
  const json = `${JSON.stringify(merged, null, 2)}\n`;
  await writeFile(tmp, json, 'utf8');
  await rename(tmp, outPath);

  if (conflictsOutPath) {
    // Asymmetry (Fix 3, 2026-05-01): only the headline `total` is filtered
    // via `headlineConflicts()`. The `sample` (and the full conflicts list)
    // remains UNFILTERED so soft-merge marker rows stay visible for forensic
    // inspection per spec §3.C — a reader of the JSON file can still see
    // which Tier C/Tier D clusters fired.
    const summary = {
      total: headlineConflicts(conflicts).length,
      sample: conflicts.slice(0, 10),
      aliasConflicts: {
        total: aliasConflicts.length,
        sample: aliasConflicts.slice(0, 5),
      },
    };
    await mkdir(dirname(conflictsOutPath), { recursive: true });
    await writeFile(conflictsOutPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  }

  // Reverse lookup: claimed-but-unmatched vendor numbers on standalone blog
  // records (design §3). Always computed (cheap, returned for callers); written
  // only when a path is supplied, so a plain crawl is byte-identical.
  const reverseLookup = computeBlogReverseLookup(merged);
  if (reverseLookupOutPath) {
    const artifact = {
      tjProbeSeed: {
        total: reverseLookup.tjProbeSeed.length,
        numbers: reverseLookup.tjProbeSeed,
      },
      joysoundDelistedReport: {
        total: reverseLookup.joysoundDelistedReport.length,
        numbers: reverseLookup.joysoundDelistedReport,
      },
    };
    await mkdir(dirname(reverseLookupOutPath), { recursive: true });
    await writeFile(reverseLookupOutPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  }

  return { written: merged.length, conflicts, aliasConflicts, reverseLookup };
}
