import type { Category, SongRecord } from '@karaoke/schema';
import type { HttpClient } from '../../http.js';
import type { Crawler } from '../index.js';
import { parseIndexPage } from './index-parser.js';
import { normalizeRawRecords } from './normalizer.js';
import { parseArtistPage } from './parser.js';

interface IndexEntry {
  path: string;
  category: Category;
}

/**
 * Per-artist success/failure budget. Spec: at least 90% of artist pages must
 * parse successfully or the run aborts.
 */
const ARTIST_SUCCESS_RATIO_FLOOR = 0.9;

/**
 * `BlogCrawler` walks `/98` (J-POP) and `/417` (Vocaloid) index pages,
 * collects per-artist post URLs, dedupes them across indexes, fetches each
 * artist page once, and yields normalized `SongRecord`s tagged with the
 * union of categories from every index that surfaced the artist.
 *
 * Failure semantics (spec line 216):
 *  - Any failure on an index page (`/98`, `/417`) aborts immediately.
 *  - Per-artist failures (HTTP error, parse error, robots block) are warned
 *    and counted; if the success ratio drops below 90% across all artists,
 *    the crawl throws after processing.
 */
export class BlogCrawler implements Crawler {
  readonly name = 'jpop-playlist-blog';

  private static readonly BASE = 'https://j-pop-playlist.tistory.com';
  private static readonly INDEXES: readonly IndexEntry[] = [
    { path: '/98', category: 'jpop' },
    { path: '/417', category: 'vocaloid' },
  ];

  constructor(private http: HttpClient) {}

  async *crawl(): AsyncIterable<SongRecord> {
    // 1. Fetch and parse each index page. Index failures are critical.
    const pathToCategories = new Map<string, Set<Category>>();
    for (const { path, category } of BlogCrawler.INDEXES) {
      const url = `${BlogCrawler.BASE}${path}`;
      const res = await this.http.fetch(url);
      if (res === null) {
        throw new Error(`[jpop-playlist-blog] index ${path} blocked by robots.txt`);
      }
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`[jpop-playlist-blog] index ${path} HTTP ${res.status}`);
      }
      const artistPaths = parseIndexPage(res.body);
      // Filter out the indexes themselves (they could link to each other).
      const indexPaths = new Set(BlogCrawler.INDEXES.map((i) => i.path));
      for (const artistPath of artistPaths) {
        if (indexPaths.has(artistPath)) continue;
        const set = pathToCategories.get(artistPath) ?? new Set<Category>();
        set.add(category);
        pathToCategories.set(artistPath, set);
      }
    }

    // 2. Fetch + parse each unique artist page. Per-page failures are
    //    counted toward the success budget, not fatal individually.
    const crawledAt = new Date().toISOString();
    let attempted = 0;
    let succeeded = 0;
    const queued: SongRecord[] = [];
    for (const [artistPath, categorySet] of pathToCategories) {
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
        const categories = [...categorySet].sort() as Category[];
        const records = normalizeRawRecords(raw, artistPath, categories, crawledAt);
        for (const r of records) queued.push(r);
        succeeded++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[jpop-playlist-blog] ${artistPath} failed: ${msg}`);
      }
    }

    // 3. Enforce the success budget AFTER processing all artists.
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
