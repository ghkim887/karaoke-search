import { type SongRecord, validateSongRecord } from '@karaoke/schema';
import type { JoysoundDetail, JoysoundListItem } from './types.js';

export interface NormalizeArgs {
  listItem: JoysoundListItem;
  detail?: JoysoundDetail;
  sourceUrl: string;
  crawledAt: string;
}

/**
 * Kana (hiragana U+3040–U+309F + katakana U+30A0–U+30FF + half-width katakana
 * U+FF66–U+FF9F). A `artistNameForeign` consisting ONLY of kana is a Japanese-
 * title echo, NOT a cross-script alias — see {@link buildArtistAliases}.
 */
const RE_KANA = /[぀-ヿｦ-ﾟ]/u;
/** Any non-kana code point — used to test "is the string PURELY kana". */
const RE_NON_KANA = /[^぀-ヿｦ-ﾟ]/u;

/**
 * A1 (2026-06-09): build the optional `artist_aliases` array from the detail's
 * NATIVE artist name (`artistNameForeign`). JOYSOUND surfaces this field only
 * for foreign entries; for the curated reviewed-allow records (K-pop/Korean
 * acts' Japanese releases) it carries the native Hangul while `artist_primary`
 * stays katakana, so emitting it as an alias restores native-name search recall
 * (the field is MiniSearch-indexed at artist boost). The pre-merge alias
 * resolver preserves and unions this array; the merger's `mergeArtistAliases`
 * unions it across a karaoke-number cluster onto a TJ/blog twin.
 *
 * Emit only when the native name is:
 *  - present (non-empty after trim),
 *  - NOT equal to `artist_primary` (no self-alias), and
 *  - NOT a pure-kana echo (a kana-only foreign-name is a JP-title echo, not a
 *    cross-script alias).
 *
 * Returns `undefined` when there is no qualifying alias so the caller omits the
 * field entirely (schema prefers absence over `[]`).
 */
function buildArtistAliases(artistPrimary: string, detail?: JoysoundDetail): string[] | undefined {
  const foreign = detail?.artistNameForeign?.trim();
  if (foreign === undefined || foreign === '') return undefined;
  if (foreign === artistPrimary) return undefined;
  // Pure-kana echo: contains kana AND no non-kana code points.
  if (RE_KANA.test(foreign) && !RE_NON_KANA.test(foreign)) return undefined;
  return [foreign];
}

/**
 * Canonicalize a JOYSOUND `selSongNo` to the corpus form.
 *
 * JOYSOUND's public surface renders the catalog number hyphenated
 * (`190-001`, `900-000`), but every existing corpus joysound number — the
 * ~20.9k from the blog adapter — is stored as bare digits (`190001`). The
 * canonical form strips all hyphens so official records Tier-A-union with the
 * blog numbers in `merge.ts` (which indexes joysound by raw string, no
 * normalization). After stripping, the result MUST be non-empty digits;
 * anything else is a malformed number and throws.
 */
export function normalizeJoysoundNumber(raw: string): string {
  const dashless = raw.replace(/-/g, '');
  if (!/^[0-9]+$/.test(dashless)) {
    throw new Error(`normalizeJoysoundNumber: not a digits-only number after stripping: "${raw}"`);
  }
  return dashless;
}

/**
 * Map a JOYSOUND listing row (+ optional detail) to a validated `SongRecord`.
 *
 *  - `id` = `joysound-${naviGroupId}` (the listing/detail primary key).
 *  - `karaoke_numbers.joysound` = `normalizeJoysoundNumber(listItem.selSongNo)`
 *    — the user-facing catalog number (e.g. `190-001`) with hyphens stripped
 *    to the dashless corpus form (`190001`), so it unions with the blog
 *    numbers in the merger. `tj` / `ky` are forced to null — this adapter
 *    only populates its own column.
 *  - `title_primary` / `artist_primary` prefer the detail payload when
 *    present (it carries the canonical normalized strings), falling back
 *    to the listing cell.
 *  - `title_ko` / `artist_ko` are ALWAYS null. The JOYSOUND surface text
 *    is Japanese; Korean translations belong to the blog / TJ
 *    transliteration paths. Threading detail ruby data here would lie
 *    about provenance and contaminate the merger's KO_CHAIN.
 */
export function normalizeJoysoundRecord(args: NormalizeArgs): SongRecord {
  const { listItem, detail, sourceUrl, crawledAt } = args;

  if (listItem.naviGroupId === '') {
    throw new Error('normalizeJoysoundRecord: listItem.naviGroupId is empty');
  }
  if (listItem.selSongNo === '') {
    throw new Error('normalizeJoysoundRecord: listItem.selSongNo is empty');
  }

  const titlePrimary = detail?.songName ?? listItem.songName;
  const artistPrimary = detail?.artistName ?? listItem.artistName;
  const artistAliases = buildArtistAliases(artistPrimary, detail);

  const record: SongRecord = {
    id: `joysound-${listItem.naviGroupId}`,
    source_url: sourceUrl,
    title_primary: titlePrimary,
    title_ko: null,
    artist_primary: artistPrimary,
    artist_ko: null,
    // A1: omit the field when there are no aliases (schema prefers absence).
    ...(artistAliases !== undefined ? { artist_aliases: artistAliases } : {}),
    karaoke_numbers: {
      tj: null,
      ky: null,
      joysound: normalizeJoysoundNumber(listItem.selSongNo),
    },
    crawled_at: crawledAt,
  };
  validateSongRecord(record);
  return record;
}
