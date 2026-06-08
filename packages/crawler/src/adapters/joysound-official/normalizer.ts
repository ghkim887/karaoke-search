import { type Category, type SongRecord, validateSongRecord } from '@karaoke/schema';
import type { JoysoundDetail, JoysoundListItem } from './types.js';

export interface NormalizeArgs {
  listItem: JoysoundListItem;
  detail?: JoysoundDetail;
  category: Category;
  sourceUrl: string;
  crawledAt: string;
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
 *  - `categories` = `[category]` — exactly one tag, pre-classified by the
 *    caller using the conservative classifier.
 */
export function normalizeJoysoundRecord(args: NormalizeArgs): SongRecord {
  const { listItem, detail, category, sourceUrl, crawledAt } = args;

  if (listItem.naviGroupId === '') {
    throw new Error('normalizeJoysoundRecord: listItem.naviGroupId is empty');
  }
  if (listItem.selSongNo === '') {
    throw new Error('normalizeJoysoundRecord: listItem.selSongNo is empty');
  }

  const titlePrimary = detail?.songName ?? listItem.songName;
  const artistPrimary = detail?.artistName ?? listItem.artistName;

  const record: SongRecord = {
    id: `joysound-${listItem.naviGroupId}`,
    source_url: sourceUrl,
    title_primary: titlePrimary,
    title_ko: null,
    artist_primary: artistPrimary,
    artist_ko: null,
    karaoke_numbers: {
      tj: null,
      ky: null,
      joysound: normalizeJoysoundNumber(listItem.selSongNo),
    },
    categories: [category],
    crawled_at: crawledAt,
  };
  validateSongRecord(record);
  return record;
}
