import {
  type Category,
  type RawSongRecord,
  type SongRecord,
  validateSongRecord,
} from '@karaoke/schema';

/**
 * Map a list of `RawSongRecord`s for one artist to validated `SongRecord`s.
 *
 *  - `id` = `blog-{artistIdNumber}-{rowIndex}`. `artistIdNumber` is the
 *    numeric segment from `artistPath` (e.g. `/449` → `449`).
 *  - `crawled_at` = the passed ISO-8601 timestamp (one timestamp per run).
 *  - `categories` = the passed list (already deduped + alphabetically sorted
 *    by the caller).
 *
 * Each result is validated against `songRecordSchema` before being returned;
 * a validation failure throws (defense in depth — the merger and writer
 * stages also validate).
 */
export function normalizeRawRecords(
  rawRecords: RawSongRecord[],
  artistPath: string,
  categories: Category[],
  crawledAt: string,
): SongRecord[] {
  const numericMatch = /^\/(\d+)$/.exec(artistPath);
  if (!numericMatch) {
    throw new Error(`normalizeRawRecords: artistPath must match /\\d+ (got ${artistPath})`);
  }
  const artistIdNumber = numericMatch[1];

  const out: SongRecord[] = [];
  rawRecords.forEach((raw, rowIndex) => {
    const id = `blog-${artistIdNumber}-${rowIndex}`;
    const record: SongRecord = {
      id,
      source_url: raw.source_url,
      title_primary: raw.title_primary,
      title_ko: raw.title_ko,
      artist_primary: raw.artist_primary,
      artist_ko: raw.artist_ko,
      release_year: raw.release_year,
      karaoke_numbers: { ...raw.karaoke_numbers },
      categories: [...categories],
      crawled_at: crawledAt,
    };
    validateSongRecord(record);
    out.push(record);
  });
  return out;
}
