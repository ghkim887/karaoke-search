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
 * Map a JOYSOUND listing row (+ optional detail) to a validated `SongRecord`.
 *
 *  - `id` = `joysound-${naviGroupId}` (the listing/detail primary key).
 *  - `karaoke_numbers.joysound` = `listItem.selSongNo` (the user-facing
 *    catalog number, e.g. `190-001`). `tj` / `ky` are forced to null —
 *    this adapter only populates its own column.
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
      joysound: listItem.selSongNo,
    },
    categories: [category],
    crawled_at: crawledAt,
  };
  validateSongRecord(record);
  return record;
}
