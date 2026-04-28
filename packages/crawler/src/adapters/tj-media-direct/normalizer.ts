import { type RawSongRecord, type SongRecord, validateSongRecord } from '@karaoke/schema';

/**
 * Map a `RawSongRecord` from the TJ Media catalog parser to a validated
 * `SongRecord`.
 *
 *  - `id` is `tj-${karaoke_numbers.tj}` (e.g. `tj-68781`). The schema's
 *    `id` regex `^[a-z0-9-]+-\d+$` accepts this shape.
 *  - `categories` is uniformly `['jpop']`. No heuristic anime/vocaloid
 *    inference at this layer — those tags ride along through NamuWiki Tier A
 *    merges in the merger.
 *  - Korean fields (`title_ko`, `artist_ko`) stay `null` (TJ does not expose
 *    them via the catalog API).
 *  - `crawled_at` is supplied by the caller (one timestamp per crawl run,
 *    matching the blog adapter's pattern).
 */
export function normalize(raw: RawSongRecord, crawledAt: string): SongRecord {
  const tj = raw.karaoke_numbers.tj;
  if (tj === null || tj === '') {
    throw new Error(
      `tj-media-direct normalize: raw record has no TJ number (title=${raw.title_primary})`,
    );
  }

  const record: SongRecord = {
    id: `tj-${tj}`,
    source_url: raw.source_url,
    title_primary: raw.title_primary,
    title_ko: null,
    artist_primary: raw.artist_primary,
    artist_ko: null,
    karaoke_numbers: { tj, ky: null, joysound: null },
    categories: ['jpop'],
    crawled_at: crawledAt,
  };
  validateSongRecord(record);
  return record;
}
