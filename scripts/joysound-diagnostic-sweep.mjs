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
 * loads the listing into memory.
 *
 * Optional THIRD arg `<corpus.json>` (Fix F2): when supplied, the runner builds
 * a normalized known-Japanese-artist Set from every record's `artist_primary`
 * — EXCLUDING any artist that trips the production foreign drop lists and any
 * generic bucket name (Various Artists / オムニバス / Unknown) — and injects an
 * `isKnownJapaneseArtist` predicate. That enables the classifier's
 * `admit-jp-artist` recall path so kanji-only / ASCII-only-titled rows by a
 * confirmed corpus Japanese act are admitted instead of dropped. The corpus is
 * ~12MB; it is parsed once up front (the LISTING stays streamed).
 *
 * Usage:
 *   node scripts/joysound-diagnostic-sweep.mjs <listing-rows.jsonl> <out-decision-log.jsonl> [corpus.json]
 */
import { createReadStream, createWriteStream, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const DIST_DIAGNOSTIC = new URL(
  '../packages/crawler/dist/adapters/joysound-official/diagnostic.js',
  import.meta.url,
);
const DIST_CLUSTERING = new URL('../packages/crawler/dist/clustering.js', import.meta.url);
const DIST_KOREAN_DROP = new URL(
  '../packages/crawler/dist/adapters/tj-media-direct/koreanArtistDropList.js',
  import.meta.url,
);
const DIST_CHINESE_DROP = new URL(
  '../packages/crawler/dist/adapters/tj-media-direct/chineseArtistDropList.js',
  import.meta.url,
);

/**
 * Generic bucket names that must NOT seed the known-Japanese-artist set — a
 * handful of real JP rows would otherwise make `Various Artists` look Japanese
 * and admit every OST/BGM row filed under the same bucket. Mirrors
 * `GENERIC_ARTIST_JPN_ADMIT_BLOCKLIST` in the TJ filter chain and the audit.
 */
const GENERIC_ARTIST_KEYS = new Set([
  'variousartists',
  'variousartist',
  'various',
  'unknown',
  'unknownartist',
  'オムニバス',
]);

/**
 * Build the normalized known-Japanese-artist predicate from a corpus file.
 * Returns `undefined` when no corpus path was supplied so the classifier's
 * recall path stays off (production-equivalent behavior).
 */
async function buildKnownJapaneseArtistPredicate(corpusPath) {
  if (!corpusPath) return undefined;

  const { normalizeForMatch, splitArtistCollab } = await import(DIST_CLUSTERING.href);
  const { isInDropList } = await import(DIST_KOREAN_DROP.href);
  const { isInChineseDropList } = await import(DIST_CHINESE_DROP.href);

  const isDropListForeign = (artist) =>
    splitArtistCollab(artist).some((component) => {
      const key = normalizeForMatch(component);
      return key !== '' && (isInDropList(key) || isInChineseDropList(key));
    });

  const records = JSON.parse(readFileSync(corpusPath, 'utf8'));
  if (!Array.isArray(records)) {
    throw new Error(`[joysound-diagnostic] corpus ${corpusPath} is not a JSON array`);
  }

  const set = new Set();
  for (const record of records) {
    const artist = typeof record?.artist_primary === 'string' ? record.artist_primary : '';
    if (artist === '') continue;
    const key = normalizeForMatch(artist);
    if (key === '' || GENERIC_ARTIST_KEYS.has(key)) continue;
    if (isDropListForeign(artist)) continue;
    set.add(key);
  }

  console.log(
    `[joysound-diagnostic] built known-Japanese-artist set (${set.size} artists) from ${corpusPath}`,
  );
  return (artist) => set.has(normalizeForMatch(artist));
}

async function main() {
  const [, , inPath, outPath, corpusPath] = process.argv;
  if (!inPath || !outPath) {
    console.error(
      'usage: node scripts/joysound-diagnostic-sweep.mjs <listing-rows.jsonl> <out-decision-log.jsonl> [corpus.json]',
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

  const isKnownJapaneseArtist = await buildKnownJapaneseArtistPredicate(corpusPath);

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
    const decision = buildJoysoundDecision(
      normalized,
      isKnownJapaneseArtist ? { isKnownJapaneseArtist } : undefined,
    );
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
