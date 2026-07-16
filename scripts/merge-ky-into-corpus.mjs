#!/usr/bin/env node
/**
 * KY-into-corpus merge driver — recompose a full corpus (e.g. v22) with the KY
 * smoke output into v23, mirroring the crawler pipeline's post-crawl stages.
 *
 * Semantics (EXACT mirror of `packages/crawler/src/pipeline.ts` `runPipeline`,
 * post-collection):
 *   collected = corpusRecords ++ kyRecords
 *   resolved  = resolveArtistAliases(collected).records
 *   { records: merged, conflicts } = mergeRecords(resolved)
 *   validateSongRecord(r) for every r in merged   // pipeline validates each
 *   atomic write merged → --out
 * `resolveArtistAliases` runs BEFORE `mergeRecords` exactly as the pipeline
 * does. Both inputs are already post-alias/post-merge corpora, so re-applying
 * the resolver is a no-op on canonical rows: it only splits pipe-form
 * `artist_primary` and re-keys bare records matching a known alias — neither
 * present in already-resolved output — so it is idempotent here. This is the
 * SAME re-application `scripts/replay-merger.mjs` performs on the committed
 * corpus every post-crawl run; mirroring it keeps "merge KY in" byte-identical
 * to "crawl everything at once". `conflicts` are collected the pipeline way and
 * summarized into the drift report.
 *
 * Drift report (the go/no-go gate — the primary artifact): classifies every
 * output record against the PRE-merge full corpus into unchanged / field-changed
 * / graduated (blog-*→ky-*) / merged-into-existing / new-standalone / unexpected,
 * plus merge conflicts, with a total-conservation check. See buildDriftReport.
 *
 * MEMORY: the full corpus is ~135MB / ~313k records; parsing + the merger's
 * union-find indexes need well above Node's default old-space. Run on a
 * high-RAM host (oci, 11GB) with an explicit heap, e.g.:
 *   node --max-old-space-size=8192 scripts/merge-ky-into-corpus.mjs \
 *     --corpus data/current/songs.json --ky data/ky/songs-ky.json \
 *     --out data/v23/songs.json --report data/v23/ky-merge-drift.json
 *
 * This driver does NOT crawl and does NOT touch live data; the orchestrator
 * runs it on the target host (execution off this branch — #94 precedent).
 *
 * BUILD PREREQUISITE: `@karaoke/crawler` + `@karaoke/schema` dist must exist
 * (run `corepack pnpm -r build` first) — this imports the compiled
 * `mergeRecords` / `resolveArtistAliases` / `validateSongRecord`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeJsonAtomic } from './lib/atomic-write.mjs';
import { stableStringify } from './lib/canonical-json.mjs';
import { isCliInvocation } from './lib/cli.mjs';
import { writeCorpusAtomic } from './lib/corpus.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const MERGE_JS = resolve(REPO_ROOT, 'packages/crawler/dist/merge.js');
const ALIASES_JS = resolve(REPO_ROOT, 'packages/crawler/dist/aliases.js');
const SCHEMA_JS = resolve(REPO_ROOT, 'packages/schema/dist/index.js');

export const USAGE =
  'usage: node [--max-old-space-size=8192] scripts/merge-ky-into-corpus.mjs --corpus <full.json> --ky <ky.json> --out <merged.json> --report <drift.json>';

/** The SongRecord scalar/array fields the drift report diffs (karaoke_numbers is drilled per vendor). */
const SCALAR_FIELDS = [
  'source_url',
  'title_primary',
  'title_ko',
  'artist_primary',
  'artist_ko',
  'artist_aliases',
  'crawled_at',
  'media_context_ko',
  'title_ko_source',
  'title_ko_confidence',
  'title_ruby',
];
const VENDORS = ['tj', 'ky', 'joysound'];

/** Return the list of field names that differ between corpus record `a` and output record `b`. */
function diffFields(a, b) {
  const changed = [];
  for (const f of SCALAR_FIELDS) {
    if (stableStringify(a?.[f]) !== stableStringify(b?.[f])) changed.push(f);
  }
  for (const v of VENDORS) {
    if (stableStringify(a?.karaoke_numbers?.[v]) !== stableStringify(b?.karaoke_numbers?.[v])) {
      changed.push(`karaoke_numbers.${v}`);
    }
  }
  return changed;
}

const kyNumberOf = (r) => r?.karaoke_numbers?.ky ?? null;

/**
 * Classify every output record against the PRE-merge full corpus. Pure.
 *
 * Categories (mutually exclusive per output record):
 *   unchanged           id kept, deep-equal to the corpus record
 *   field-changed       id kept, some field differs (no ky gained) — per-field counts
 *   merged-into-existing id kept, gained a ky number the corpus record lacked
 *   graduated           a corpus blog-* disappeared and its ky number now lives
 *                       under `ky-{n}` in the output (full from→to list)
 *   new-standalone       a ky-* output id from the KY input with no graduating blog
 *   unexpected           anything else — a corpus id that vanished without a
 *                        graduation, an output id from neither input, or a KY
 *                        input that vanished without an absorber (FULL list)
 * Plus a total-conservation check and the merge-conflict summary.
 */
export function buildDriftReport(corpus, ky, out, conflicts) {
  const corpusById = new Map(corpus.map((r) => [r.id, r]));
  const kyById = new Map(ky.map((r) => [r.id, r]));
  const outIds = new Set(out.map((r) => r.id));
  const corpusIds = new Set(corpusById.keys());
  const kyIds = new Set(kyById.keys());

  const unexpected = [];

  // Pass A — disappeared corpus ids → graduated (blog-*→ky-*) or unexpected.
  const graduated = [];
  const graduatedTargets = new Set();
  for (const id of corpusIds) {
    if (outIds.has(id)) continue;
    const c = corpusById.get(id);
    const kyNum = kyNumberOf(c);
    const target = kyNum != null ? `ky-${kyNum}` : null;
    if (id.startsWith('blog-') && target && outIds.has(target)) {
      graduated.push({ from: id, to: target });
      graduatedTargets.add(target);
    } else {
      unexpected.push({ id, reason: 'corpus-id-disappeared-without-graduation', ky: kyNum });
    }
  }

  // Pass B — every output record.
  let unchanged = 0;
  const fieldChanged = [];
  const byField = {};
  const mergedIntoExisting = [];
  const newStandalone = [];
  for (const o of out) {
    const c = corpusById.get(o.id);
    if (c !== undefined) {
      if (stableStringify(c) === stableStringify(o)) {
        unchanged += 1;
        continue;
      }
      if (kyNumberOf(c) === null && kyNumberOf(o) !== null) {
        mergedIntoExisting.push({ id: o.id, kyGained: kyNumberOf(o) });
      } else {
        const fields = diffFields(c, o);
        for (const f of fields) byField[f] = (byField[f] ?? 0) + 1;
        fieldChanged.push({ id: o.id, fields });
      }
      continue;
    }
    // Output id not from the corpus.
    if (o.id.startsWith('ky-') && kyIds.has(o.id)) {
      if (!graduatedTargets.has(o.id)) newStandalone.push(o.id);
      // else: a graduation target — already recorded under `graduated`.
    } else {
      unexpected.push({ id: o.id, reason: 'output-id-from-neither-input' });
    }
  }

  // Pass C — KY inputs consumed (absent from output): must be absorbed by an
  // output record that carries their ky number, else unexpected.
  for (const id of kyIds) {
    if (outIds.has(id)) continue;
    const kNum = kyNumberOf(kyById.get(id));
    const absorbed = kNum != null && out.some((r) => r.id !== id && kyNumberOf(r) === kNum);
    if (!absorbed) {
      unexpected.push({ id, reason: 'ky-input-disappeared-unabsorbed', ky: kNum });
    }
  }

  // Conservation: corpus + ky in, minus the absent input ids, must equal out.
  const absentCorpus = [...corpusIds].filter((id) => !outIds.has(id)).length;
  const absentKy = [...kyIds].filter((id) => !outIds.has(id)).length;
  const extraOut = [...outIds].filter((id) => !corpusIds.has(id) && !kyIds.has(id)).length;
  const expectedOut = corpus.length + ky.length - absentCorpus - absentKy + extraOut;
  const conservationOk = expectedOut === out.length && unexpected.length === 0 && extraOut === 0;

  const conflictByField = {};
  for (const c of conflicts) conflictByField[c.field] = (conflictByField[c.field] ?? 0) + 1;

  const SAMPLE = 25;
  return {
    totals: {
      corpusIn: corpus.length,
      kyIn: ky.length,
      out: out.length,
      collapsed: corpus.length + ky.length - out.length,
    },
    conservation: {
      ok: conservationOk,
      expectedOut,
      actualOut: out.length,
      absentCorpusIds: absentCorpus,
      absentKyIds: absentKy,
      extraOutIds: extraOut,
    },
    unchanged: { count: unchanged },
    fieldChanged: { count: fieldChanged.length, byField, sample: fieldChanged.slice(0, SAMPLE) },
    graduated: { count: graduated.length, entries: graduated },
    mergedIntoExisting: {
      count: mergedIntoExisting.length,
      sample: mergedIntoExisting.slice(0, SAMPLE),
    },
    newStandalone: { count: newStandalone.length, sample: newStandalone.slice(0, SAMPLE) },
    unexpected: { count: unexpected.length, entries: unexpected },
    conflicts: {
      total: conflicts.length,
      byField: conflictByField,
      sample: conflicts.slice(0, SAMPLE),
    },
  };
}

/**
 * Run the merge (pipeline mirror) and build the drift report. Dependencies are
 * injected so tests can drive it with the real dist functions or fakes.
 *
 * @returns {{ merged: object[], conflicts: object[], report: object }}
 */
export function runMergeDriver({
  corpusRecords,
  kyRecords,
  resolveArtistAliases,
  mergeRecords,
  validate,
}) {
  const collected = [...corpusRecords, ...kyRecords];
  const { records: resolved } = resolveArtistAliases(collected);
  const { records: merged, conflicts } = mergeRecords(resolved);
  if (typeof validate === 'function') {
    for (const r of merged) validate(r);
  }
  const report = buildDriftReport(corpusRecords, kyRecords, merged, conflicts);
  return { merged, conflicts, report };
}

export function parseArgs(argv) {
  const parsed = { corpus: null, ky: null, out: null, report: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--corpus' || arg === '--ky' || arg === '--out' || arg === '--report') {
      const v = argv[i + 1];
      if (!v) throw new Error(`${arg} requires a path value`);
      parsed[arg.slice(2)] = v;
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}

export async function loadDist() {
  for (const p of [MERGE_JS, ALIASES_JS, SCHEMA_JS]) {
    if (!existsSync(p)) {
      throw new Error(
        `missing build artifact: ${p} — run \`corepack pnpm -r build\` first (this driver imports the compiled merger/aliases/schema).`,
      );
    }
  }
  const { mergeRecords } = await import(pathToFileURL(MERGE_JS).href);
  const { resolveArtistAliases } = await import(pathToFileURL(ALIASES_JS).href);
  const { validateSongRecord } = await import(pathToFileURL(SCHEMA_JS).href);
  return { mergeRecords, resolveArtistAliases, validate: validateSongRecord };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  for (const [flag, val] of [
    ['--corpus', args.corpus],
    ['--ky', args.ky],
    ['--out', args.out],
    ['--report', args.report],
  ]) {
    if (!val) {
      console.error(`ERROR: ${flag} is required`);
      console.error(USAGE);
      process.exitCode = 2;
      return;
    }
  }

  const corpusPath = resolve(args.corpus);
  const kyPath = resolve(args.ky);
  for (const p of [corpusPath, kyPath]) {
    if (!existsSync(p)) {
      console.error(`ERROR: input not found: ${p}`);
      process.exitCode = 2;
      return;
    }
  }

  const deps = await loadDist();
  const corpusRecords = JSON.parse(readFileSync(corpusPath, 'utf8'));
  const kyRecords = JSON.parse(readFileSync(kyPath, 'utf8'));
  if (!Array.isArray(corpusRecords) || !Array.isArray(kyRecords)) {
    console.error('ERROR: both --corpus and --ky must be JSON arrays');
    process.exitCode = 2;
    return;
  }

  const { merged, report } = runMergeDriver({ corpusRecords, kyRecords, ...deps });

  writeCorpusAtomic(resolve(args.out), merged);
  writeJsonAtomic(resolve(args.report), report, { indent: 2, trailingNewline: true });

  const r = report;
  console.log(
    `[merge-ky] in: corpus ${r.totals.corpusIn} + ky ${r.totals.kyIn} → out ${r.totals.out} (collapsed ${r.totals.collapsed})`,
  );
  console.log(
    `[merge-ky] unchanged ${r.unchanged.count}, field-changed ${r.fieldChanged.count}, graduated ${r.graduated.count}, merged-into-existing ${r.mergedIntoExisting.count}, new-standalone ${r.newStandalone.count}, unexpected ${r.unexpected.count}`,
  );
  console.log(
    `[merge-ky] conflicts ${r.conflicts.total}; conservation ${r.conservation.ok ? 'OK' : 'FAILED'}`,
  );
  console.log(`[merge-ky] wrote ${args.out} + ${args.report}`);
  // Report-only driver: a FAILED conservation / non-empty unexpected is the
  // go/no-go signal for the orchestrator, surfaced via exit 3 (non-fatal-but-
  // flagged) so a wrapper can branch on it without confusing it with a crash.
  if (!r.conservation.ok) process.exitCode = 3;
}

if (isCliInvocation(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
