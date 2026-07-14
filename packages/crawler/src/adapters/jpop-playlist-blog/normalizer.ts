import {
  type KaraokeNumbers,
  type RawSongRecord,
  type SongRecord,
  validateSongRecord,
} from '@karaoke/schema';

/**
 * Vendor lookup order for residual blog-id minting. The FIRST non-null claimed
 * number decides the `{vendor}-{number}` id segment. tj → ky → joysound mirrors
 * the blog table's own column order and prefers the vendor a Korean singer is
 * most likely to search by. KY has no source adapter until R5, so a `ky-*`
 * residual id simply preserves the claim until then.
 */
const MINT_VENDOR_ORDER = ['tj', 'ky', 'joysound'] as const;

/**
 * Derive a stable blog record id from the artist page number and the row's
 * parsed karaoke numbers: `blog-{artistIdNumber}-{vendor}-{number}` where
 * `{vendor}-{number}` is the FIRST non-null of tj → ky → joysound (claimed
 * numbers, straight from the row). Examples: `blog-416-tj-26723`,
 * `blog-299-joysound-677515`.
 *
 * Returns `null` when the row claims NO karaoke number (tj/ky/joysound all
 * null) — such a row is not registered in any karaoke system and is dropped by
 * `normalizeRawRecords` rather than minted.
 *
 * The `blog` first segment is kept so `sourceSlug()` (merge.ts) and every
 * `startsWith('blog-')` classifier keep working, and the whole id stays within
 * the schema id pattern `^[a-z0-9-]+-\d+$` (vendor is a-z, number is digits, so
 * no schema change is needed). Exported as the single derivation site shared by
 * the normalizer, the sidecar re-key tooling, and the tests.
 */
export function mintBlogRecordId(artistIdNumber: string, numbers: KaraokeNumbers): string | null {
  for (const vendor of MINT_VENDOR_ORDER) {
    const number = numbers[vendor];
    if (number !== null) return `blog-${artistIdNumber}-${vendor}-${number}`;
  }
  return null;
}

/**
 * A blog row dropped at normalize time because it claimed no karaoke number
 * (tj/ky/joysound all null after cell parsing). It never becomes a record and
 * has no id; the crawl report surfaces it by title/artist/page so the drop is
 * observable rather than silent. The one caveat (accepted): a row whose ONLY
 * number cell was voided by the parser's multi-value/junk rules also lands here.
 */
export interface DroppedBlogRow {
  title_primary: string;
  artist_primary: string;
  source_url: string;
}

/** Outcome of normalizing one artist page: minted records plus dropped rows. */
export interface NormalizeResult {
  records: SongRecord[];
  dropped: DroppedBlogRow[];
}

/**
 * Map a list of `RawSongRecord`s for one artist to validated `SongRecord`s.
 *
 *  - `id` = `mintBlogRecordId(artistIdNumber, karaoke_numbers)` — a stable id
 *    derived from the row's first claimed vendor number (see that function).
 *    `artistIdNumber` is the numeric segment from `artistPath` (e.g. `/449` →
 *    `449`).
 *  - Rows that claim no vendor number are DROPPED (not registered in any
 *    karaoke system) and returned in `dropped` for the crawl report.
 *  - `crawled_at` = the passed ISO-8601 timestamp (one timestamp per run).
 *
 * A duplicate minted id within one page's run is data damage (two rows claiming
 * the same first-vendor number) and throws — loud failure over a silent
 * last-write-wins collapse.
 *
 * Each result is validated against `songRecordSchema` before being returned;
 * a validation failure throws (defense in depth — the merger and writer
 * stages also validate).
 */
export function normalizeRawRecords(
  rawRecords: RawSongRecord[],
  artistPath: string,
  crawledAt: string,
): NormalizeResult {
  const numericMatch = /^\/(\d+)$/.exec(artistPath);
  if (!numericMatch) {
    throw new Error(`normalizeRawRecords: artistPath must match /\\d+ (got ${artistPath})`);
  }
  const artistIdNumber = numericMatch[1] as string;

  const records: SongRecord[] = [];
  const dropped: DroppedBlogRow[] = [];
  const seenIds = new Set<string>();
  for (const raw of rawRecords) {
    const id = mintBlogRecordId(artistIdNumber, raw.karaoke_numbers);
    if (id === null) {
      dropped.push({
        title_primary: raw.title_primary,
        artist_primary: raw.artist_primary,
        source_url: raw.source_url,
      });
      continue;
    }
    if (seenIds.has(id)) {
      throw new Error(
        `normalizeRawRecords: duplicate minted id "${id}" on ${artistPath} — two rows claim the same first-vendor number (blog data damage)`,
      );
    }
    seenIds.add(id);
    const record: SongRecord = {
      id,
      source_url: raw.source_url,
      title_primary: raw.title_primary,
      title_ko: raw.title_ko,
      artist_primary: raw.artist_primary,
      artist_ko: raw.artist_ko,
      karaoke_numbers: { ...raw.karaoke_numbers },
      crawled_at: crawledAt,
    };
    validateSongRecord(record);
    records.push(record);
  }
  return { records, dropped };
}
