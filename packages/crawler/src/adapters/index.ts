import type { SongRecord } from '@karaoke/schema';

/**
 * Source-specific crawler. Per-spec the interface yields `RawSongRecord`, but
 * for the Phase 2 pipeline we choose to keep adapters self-normalizing — each
 * adapter runs its own raw→`SongRecord` mapping internally so the pipeline
 * deals only in the universal record. This avoids leaking source-specific
 * raw shapes into the merger and validator stages.
 *
 * Departure from spec is intentional and documented here:
 *   normalization happens inside the adapter; pipeline operates on universal
 *   SongRecord only.
 */
export interface Crawler {
  name: string;
  crawl(): AsyncIterable<SongRecord>;
}

/**
 * Registration-order list. Phase 3 appends the BlogCrawler instance here.
 * The merger uses array order as registration order for collision tie-breaks.
 */
export const adapters: Crawler[] = [];

/**
 * Append a crawler to the registry. Exposed primarily for tests; production
 * code should rely on the static `adapters` array shape.
 */
export function registerAdapter(c: Crawler): void {
  adapters.push(c);
}
