import type { SongRecord } from '@karaoke/schema';
import { HttpClient } from '../http.js';
import { BlogCrawler } from './jpop-playlist-blog/crawler.js';

/**
 * Per-adapter crawl options. Adapters honor `limit` themselves; the pipeline
 * passes it through unchanged.
 */
export interface CrawlOptions {
  /** Maximum number of source pages (e.g., artist pages) the adapter should
   * fetch. `undefined` means no cap. */
  limit?: number;
}

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
  crawl(options?: CrawlOptions): AsyncIterable<SongRecord>;
}

/**
 * Construct the registered adapter set. Phase 3 registers the
 * `jpop-playlist-blog` BlogCrawler. Returning a fresh array per call keeps
 * adapters with mutable internal state (HTTP cache, robots cache) isolated
 * across pipeline runs in tests.
 *
 * The merger uses array order as registration order for collision tie-breaks.
 */
export function buildAdapters(http: HttpClient): Crawler[] {
  return [new BlogCrawler(http)];
}

/**
 * Default adapter set bound to a single shared `HttpClient`. The CLI consumes
 * this directly. Tests that need adapter isolation should call
 * `buildAdapters(new HttpClient())` instead.
 */
export const adapters: Crawler[] = buildAdapters(new HttpClient());

/**
 * Append a crawler to the default registry. Exposed primarily for tests;
 * production code should rely on the static `adapters` array shape.
 */
export function registerAdapter(c: Crawler): void {
  adapters.push(c);
}
