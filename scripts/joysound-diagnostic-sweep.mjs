#!/usr/bin/env node
/**
 * JOYSOUND full-catalog FP/FN diagnostic sweep.
 *
 * Reads a listing-rows JSONL file (each line one JoysoundListItem with at least
 * `selSongNo, naviGroupId, songName, artistName, tieupInfo`), runs the built
 * `buildJoysoundDecision` over each row, and writes a `decision-log.jsonl`
 * (one DecisionRecord per line).
 *
 * The classifier is the single source of truth — this runner only adapts I/O.
 * The real input is ~294k lines / 55MB, so it streams line-by-line; it never
 * loads the whole file into memory.
 *
 * Usage:
 *   node scripts/joysound-diagnostic-sweep.mjs <listing-rows.jsonl> <out-decision-log.jsonl>
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const DIST_DIAGNOSTIC = new URL(
  '../packages/crawler/dist/adapters/joysound-official/diagnostic.js',
  import.meta.url,
);

async function main() {
  const [, , inPath, outPath] = process.argv;
  if (!inPath || !outPath) {
    console.error(
      'usage: node scripts/joysound-diagnostic-sweep.mjs <listing-rows.jsonl> <out-decision-log.jsonl>',
    );
    process.exit(2);
  }

  let buildJoysoundDecision;
  try {
    ({ buildJoysoundDecision } = await import(DIST_DIAGNOSTIC.href));
  } catch (err) {
    console.error(
      `[joysound-diagnostic] failed to import built classifier from ${DIST_DIAGNOSTIC.href}.\nRun \`corepack pnpm --filter @karaoke/crawler build\` first.`,
    );
    throw err;
  }

  const input = createInterface({
    input: createReadStream(inPath, { encoding: 'utf8' }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  const output = createWriteStream(outPath, { encoding: 'utf8' });

  let total = 0;
  let admitted = 0;
  let dropped = 0;
  let parseErrors = 0;

  for await (const line of input) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let listItem;
    try {
      listItem = JSON.parse(trimmed);
    } catch (err) {
      parseErrors++;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[joysound-diagnostic] skipping unparseable line ${total + 1}: ${msg}`);
      continue;
    }
    // Normalize optional listing fields the JoysoundListItem contract expects
    // but a leaner listing-rows dump may omit (artistId / tieupId / tieupInfo).
    const normalized = {
      naviGroupId: String(listItem.naviGroupId ?? ''),
      selSongNo: String(listItem.selSongNo ?? ''),
      songName: String(listItem.songName ?? ''),
      artistName: String(listItem.artistName ?? ''),
      artistId: listItem.artistId ?? null,
      tieupInfo: listItem.tieupInfo ?? null,
      tieupId: listItem.tieupId ?? null,
    };
    const decision = buildJoysoundDecision(normalized);
    if (!output.write(`${JSON.stringify(decision)}\n`)) {
      // Respect backpressure on the large stream.
      await new Promise((r) => output.once('drain', r));
    }
    total++;
    if (decision.decision === 'admit') admitted++;
    else dropped++;
  }

  await new Promise((resolve, reject) => {
    output.end((err) => (err ? reject(err) : resolve()));
  });

  console.log(
    `[joysound-diagnostic] wrote ${total} decision(s) to ${outPath}: ` +
      `${admitted} admit, ${dropped} drop, ${parseErrors} parse-error(s) skipped`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
