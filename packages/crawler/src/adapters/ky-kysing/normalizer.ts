import { type SongRecord, validateSongRecord } from '@karaoke/schema';
import { normalizeKyNumber } from './normalizeKyNumber.js';

export interface NormalizeKyArgs {
  ky: string;
  title: string;
  artist: string;
  crawledAt: string;
}

/** Per-song stable back-link: the `category=1` detail page for the number. */
export function kySourceUrl(ky: string): string {
  return `https://kysing.kr/search/?category=1&keyword=${ky}`;
}

/**
 * Map a classified KY row to a validated `SongRecord`.
 *
 *  - `id` = `ky-{number}` (the catalog number is KY's stable primary key).
 *  - `source_url` = the per-song `category=1` detail page — a stable back-link
 *    keyed by the number.
 *  - `karaoke_numbers.ky` = the canonical bare-digit number; `tj` / `joysound`
 *    are forced null (this adapter only populates its own column). The number
 *    is re-run through {@link normalizeKyNumber} as a defensive invariant — a
 *    row that reaches here always carries a valid number, so a `null` is a
 *    programming error and throws.
 *  - `title_ko` / `artist_ko` are ALWAYS null: the KY jp catalog surface is
 *    Japanese and KY contributes no Korean translation. Threading anything into
 *    the KO fields would lie about provenance and contaminate the merger's
 *    KO_CHAIN.
 *  - `artist_aliases` is NOT set here — the pipeline's `resolveArtistAliases`
 *    owns alias derivation centrally.
 *
 * No schema change: every field is an existing `SongRecord` field.
 */
export function normalizeKyRecord(args: NormalizeKyArgs): SongRecord {
  const { ky, title, artist, crawledAt } = args;
  const number = normalizeKyNumber(ky);
  if (number === null) {
    throw new Error(`normalizeKyRecord: not a valid KY number: "${ky}"`);
  }
  if (title.trim() === '') {
    throw new Error(`normalizeKyRecord: empty title for ky=${number}`);
  }
  if (artist.trim() === '') {
    throw new Error(`normalizeKyRecord: empty artist for ky=${number}`);
  }

  const record: SongRecord = {
    id: `ky-${number}`,
    source_url: kySourceUrl(number),
    title_primary: title,
    title_ko: null,
    artist_primary: artist,
    artist_ko: null,
    karaoke_numbers: { tj: null, ky: number, joysound: null },
    crawled_at: crawledAt,
  };
  validateSongRecord(record);
  return record;
}
