/**
 * Shared known-Japanese-artist predicate for the JOYSOUND scripts.
 *
 * The detail sweep and the listing diagnostic sweep both built a normalized
 * known-Japanese-artist Set from a corpus's `artist_primary` values (excluding
 * foreign-drop-list artists and generic bucket names) to drive the classifier's
 * `admit-jp-artist` recall path; the replay classifier rebuilt the EXACT same
 * Set so its verdicts match the sweep. That code was byte-duplicated across the
 * detail sweep (exported) and the diagnostic sweep (a local copy). It lives
 * here now as the single source of truth.
 *
 * The only per-script difference was the console-log prefix, parametrised via
 * the `label` option so each caller's stdout/stderr stays byte-identical.
 */

import { readFileSync } from 'node:fs';
import { loadJpArtistDropDeps } from './joysound-dist.mjs';

/**
 * Generic bucket names that must NOT seed the known-Japanese-artist set — a
 * handful of real JP rows would otherwise make `Various Artists` look Japanese
 * and admit every OST/BGM row filed under the same bucket. Mirrors
 * `GENERIC_ARTIST_JPN_ADMIT_BLOCKLIST` in the TJ filter chain and the audit.
 */
export const GENERIC_ARTIST_KEYS = new Set([
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
 * `admit-jp-artist` recall path stays off (production-equivalent behavior).
 *
 * @param {string|undefined} corpusPath
 * @param {{ label?: string }} [opts] - the calling script's log prefix
 * @returns {Promise<((artist: string) => boolean) | undefined>}
 */
export async function buildKnownJapaneseArtistPredicate(corpusPath, { label = 'joysound' } = {}) {
  if (!corpusPath) return undefined;

  const { normalizeForMatch, splitArtistCollab, isInDropList, isInChineseDropList } =
    await loadJpArtistDropDeps();

  const isDropListForeign = (artist) =>
    splitArtistCollab(artist).some((component) => {
      const key = normalizeForMatch(component);
      return key !== '' && (isInDropList(key) || isInChineseDropList(key));
    });

  const records = JSON.parse(readFileSync(corpusPath, 'utf8'));
  if (!Array.isArray(records)) {
    throw new Error(`[${label}] corpus ${corpusPath} is not a JSON array`);
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
    `[${label}] built known-Japanese-artist set (${set.size} artists) from ${corpusPath}`,
  );
  return (artist) => set.has(normalizeForMatch(artist));
}
