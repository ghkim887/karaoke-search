#!/usr/bin/env node
// Applies a tracked sidecar JSON of manual title_ko fixes to the corpus.
//
// Usage:
//   node scripts/apply-manual-title-ko-fixes.mjs <corpus.json> <fixes.json>
//
// Runs in CI after the Stage 2 LLM replay so manual corrections survive every
// full crawl. NFKC-compares title_primary on each fix to detect TJ title edits
// (stale-fix guard). Sets title_ko_source = 'manual' and DROPS
// title_ko_confidence (schema cross-field constraint requires its absence when
// source !== 'llm-translated').

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadCorpus, writeCorpusAtomic } from './lib/corpus.mjs';

/**
 * Apply manual fixes to a records array. Returns a new array and counters.
 *
 * @param {Array<object>} records
 * @param {Array<{id: string, title_primary: string, title_ko: string|null}>} fixes
 * @returns {{ records: Array<object>, applied: number, notFound: number, titleMismatch: number }}
 */
export function applyManualFixesToCorpus(records, fixes) {
  const byId = new Map(records.map((r, i) => [r.id, i]));
  const out = records.map((r) => r);
  let applied = 0;
  let notFound = 0;
  let titleMismatch = 0;

  for (const fix of fixes) {
    const idx = byId.get(fix.id);
    if (idx === undefined) {
      notFound += 1;
      process.stderr.write(`manual-fix: id not found in corpus: ${fix.id}\n`);
      continue;
    }
    const rec = out[idx];
    if (fix.title_primary.normalize('NFKC') !== rec.title_primary.normalize('NFKC')) {
      titleMismatch += 1;
      process.stderr.write(
        `manual-fix: title_primary mismatch for ${fix.id}: ` +
          `fix=${JSON.stringify(fix.title_primary)} corpus=${JSON.stringify(rec.title_primary)}\n`,
      );
      continue;
    }
    // Strip the optional KO trio off `rec` and re-attach in canonical order so
    // the emitted record matches the merger's key order:
    //   …crawled_at, media_context_ko, title_ko_source, title_ko_confidence
    // See packages/crawler/src/merge.ts:430-436 and the prior art in
    // scripts/translate_title_ko_via_agents.mjs applyDecisionsToCorpus.
    const {
      // eslint-disable-next-line no-unused-vars
      media_context_ko: prevMcKo,
      // eslint-disable-next-line no-unused-vars
      title_ko_source: prevSrc,
      // eslint-disable-next-line no-unused-vars
      title_ko_confidence: prevConf,
      ...base
    } = rec;
    const next = { ...base };
    next.title_ko = fix.title_ko;
    if (prevMcKo !== undefined) {
      next.media_context_ko = prevMcKo;
    }
    next.title_ko_source = 'manual';
    // Intentionally do NOT re-attach title_ko_confidence — the schema's
    // cross-field constraint forbids it when source !== 'llm-translated'.
    out[idx] = next;
    applied += 1;
  }

  return { records: out, applied, notFound, titleMismatch };
}

async function main() {
  const [, , corpusPath, fixesPath] = process.argv;
  if (!corpusPath || !fixesPath) {
    process.stderr.write(
      'Usage: node scripts/apply-manual-title-ko-fixes.mjs <corpus.json> <fixes.json>\n',
    );
    process.exit(1);
  }

  const records = loadCorpus(corpusPath);
  const fixes = JSON.parse(readFileSync(fixesPath, 'utf-8'));

  const result = applyManualFixesToCorpus(records, fixes);

  writeCorpusAtomic(corpusPath, result.records);

  process.stdout.write(
    `manual-fixes: ${result.applied} applied, ${result.notFound} not-found, ` +
      `${result.titleMismatch} title-mismatch on ${records.length}-record corpus\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
