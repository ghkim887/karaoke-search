import type { SongRecord } from '@karaoke/schema';
import type { HttpClient } from '../../http.js';
import type { CrawlOptions, Crawler } from '../index.js';
import { resolveCrawlLimit } from '../limit.js';
import { parseIndexPage } from './index-parser.js';
import { normalizeRawRecords } from './normalizer.js';
import { parseArtistPage } from './parser.js';

/**
 * Per-artist success/failure budget. Spec: at least 90% of artist pages must
 * parse successfully or the run aborts.
 */
const ARTIST_SUCCESS_RATIO_FLOOR = 0.9;

/**
 * `BlogCrawler` walks `/98` and `/417` index pages (both are kept for
 * coverage — together they surface the full artist set), collects per-artist
 * post URLs, dedupes them across indexes, fetches each artist page once, and
 * yields normalized `SongRecord`s.
 *
 * Failure semantics (spec line 216):
 *  - Any failure on an index page (`/98`, `/417`) aborts immediately.
 *  - Per-artist failures (HTTP error, parse error, robots block) are warned
 *    and counted; if the success ratio drops below 90% across the artists
 *    actually attempted (after limit), the crawl throws.
 *
 * Limit semantics:
 *  - `options.limit` caps the number of artist pages fetched (NOT records).
 *  - Artists are iterated in first-seen order across the de-duped union of
 *    both index pages.
 */
export class BlogCrawler implements Crawler {
  readonly name = 'jpop-playlist-blog';

  private static readonly BASE = 'https://j-pop-playlist.tistory.com';
  private static readonly INDEX_PATHS: readonly string[] = ['/98', '/417'];

  constructor(private http: HttpClient) {}

  async *crawl(options?: CrawlOptions): AsyncIterable<SongRecord> {
    const limit = resolveCrawlLimit(options);

    // 1. Fetch and parse each index page. Index failures are critical.
    //    Both indexes are walked for coverage; artist paths are de-duped
    //    across them in first-seen order.
    const artistPaths: string[] = [];
    const seen = new Set<string>();
    const indexPaths = new Set(BlogCrawler.INDEX_PATHS);
    for (const path of BlogCrawler.INDEX_PATHS) {
      const url = `${BlogCrawler.BASE}${path}`;
      const res = await this.http.fetch(url);
      if (res === null) {
        throw new Error(`[jpop-playlist-blog] index ${path} blocked by robots.txt`);
      }
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`[jpop-playlist-blog] index ${path} HTTP ${res.status}`);
      }
      for (const artistPath of parseIndexPage(res.body)) {
        // Filter out the indexes themselves (they could link to each other).
        if (indexPaths.has(artistPath)) continue;
        if (seen.has(artistPath)) continue;
        seen.add(artistPath);
        artistPaths.push(artistPath);
      }
    }

    // 2. Fetch + parse each unique artist page (capped at `limit`).
    const crawledAt = new Date().toISOString();
    let attempted = 0;
    let succeeded = 0;
    const queued: SongRecord[] = [];
    for (const artistPath of artistPaths) {
      if (attempted >= limit) break;
      attempted++;
      const url = `${BlogCrawler.BASE}${artistPath}`;
      try {
        const res = await this.http.fetch(url);
        if (res === null) {
          console.warn(`[jpop-playlist-blog] ${artistPath} blocked by robots.txt`);
          continue;
        }
        if (res.status < 200 || res.status >= 300) {
          console.warn(`[jpop-playlist-blog] ${artistPath} HTTP ${res.status}`);
          continue;
        }
        const raw = parseArtistPage(res.body, url);
        if (raw.length === 0) {
          console.warn(`[jpop-playlist-blog] ${artistPath} parsed 0 rows`);
          continue;
        }
        const records = normalizeRawRecords(raw, artistPath, crawledAt);
        for (const r of records) queued.push(r);
        succeeded++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[jpop-playlist-blog] ${artistPath} failed: ${msg}`);
      }
    }

    // 3. Enforce the success budget AFTER processing all attempted artists.
    if (attempted > 0) {
      const ratio = succeeded / attempted;
      if (ratio < ARTIST_SUCCESS_RATIO_FLOOR) {
        throw new Error(
          `[jpop-playlist-blog] artist success ratio ${ratio.toFixed(2)} below floor ` +
            `${ARTIST_SUCCESS_RATIO_FLOOR} (${succeeded}/${attempted})`,
        );
      }
    }

    for (const r of queued) yield r;
  }
}
