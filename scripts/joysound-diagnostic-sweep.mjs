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
import { createWriteStream } from 'node:fs';
import { isCliInvocation } from './lib/cli.mjs';
import { loadJoysoundClassifier } from './lib/joysound-dist.mjs';
import { buildKnownJapaneseArtistPredicate } from './lib/joysound-jp-artist.mjs';
import { streamJsonl } from './lib/jsonl.mjs';
import { endStream, writeLineBackpressured } from './lib/stream.mjs';

async function main() {
  const [, , inPath, outPath, corpusPath] = process.argv;
  if (!inPath || !outPath) {
    console.error(
      'usage: node scripts/joysound-diagnostic-sweep.mjs <listing-rows.jsonl> <out-decision-log.jsonl> [corpus.json]',
    );
    process.exit(2);
  }

  const { buildJoysoundDecision } = await loadJoysoundClassifier('joysound-diagnostic');

  const isKnownJapaneseArtist = await buildKnownJapaneseArtistPredicate(corpusPath, {
    label: 'joysound-diagnostic',
  });

  const output = createWriteStream(outPath, { encoding: 'utf8' });

  let total = 0;
  let admitted = 0;
  let dropped = 0;
  let parseErrors = 0;

  const onParseError = (err) => {
    parseErrors++;
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[joysound-diagnostic] skipping unparseable line ${total + 1}: ${msg}`);
  };
  for await (const listItem of streamJsonl(inPath, { onParseError })) {
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
    // Respect backpressure on the large stream.
    await writeLineBackpressured(output, `${JSON.stringify(decision)}\n`);
    total++;
    if (decision.decision === 'admit') admitted++;
    else dropped++;
  }

  await endStream(output);

  console.log(
    `[joysound-diagnostic] wrote ${total} decision(s) to ${outPath}: ` +
      `${admitted} admit, ${dropped} drop, ${parseErrors} parse-error(s) skipped`,
  );
}

if (isCliInvocation(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
