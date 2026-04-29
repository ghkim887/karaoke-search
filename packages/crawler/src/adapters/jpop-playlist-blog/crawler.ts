import { type Category, type SongRecord, applyCategoryExclusivity } from '@karaoke/schema';
import type { HttpClient } from '../../http.js';
import type { CrawlOptions, Crawler } from '../index.js';
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
 *    and counted; if the success ratio drops below 90% across the artists
 *    actually attempted (after limit + interleaving), the crawl throws.
 *
 * Limit semantics:
 *  - `options.limit` caps the number of artist pages fetched (NOT records).
 *  - To balance categories under a small limit, the de-duped artist set is
 *    interleaved round-robin: jpop-only artists, vocaloid-only artists,
 *    then mixed-category artists appended at the end.
 */
export class BlogCrawler implements Crawler {
  readonly name = 'jpop-playlist-blog';

  private static readonly BASE = 'https://j-pop-playlist.tistory.com';
  private static readonly INDEXES: readonly IndexEntry[] = [
    { path: '/98', category: 'jpop' },
    { path: '/417', category: 'vocaloid' },
  ];

  constructor(private http: HttpClient) {}

  async *crawl(options?: CrawlOptions): AsyncIterable<SongRecord> {
    const limit =
      options?.limit !== undefined && Number.isFinite(options.limit) && options.limit > 0
        ? options.limit
        : Number.POSITIVE_INFINITY;

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

    // 2. Bucket de-duped artists by category profile, then interleave so a
    //    small `limit` produces a balanced sample of jpop and vocaloid.
    const ordered = orderArtists(pathToCategories);

    // 3. Fetch + parse each unique artist page (capped at `limit`).
    const crawledAt = new Date().toISOString();
    let attempted = 0;
    let succeeded = 0;
    const queued: SongRecord[] = [];
    for (const { path: artistPath, categories: categorySet } of ordered) {
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
        // Defensive copy: callsite below may share `categorySet` between rounds.
        const cats = new Set<Category>(categorySet);
        applyCategoryExclusivity(cats);
        const categories = [...cats].sort() as Category[];
        const records = normalizeRawRecords(raw, artistPath, categories, crawledAt);
        for (const r of records) queued.push(r);
        succeeded++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[jpop-playlist-blog] ${artistPath} failed: ${msg}`);
      }
    }

    // 4. Enforce the success budget AFTER processing all attempted artists.
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

interface OrderedArtist {
  path: string;
  categories: Set<Category>;
}

/**
 * Produce a category-balanced ordering of `pathToCategories`:
 *   jpop-only and vocaloid-only artists are interleaved round-robin
 *   (jpop first, then vocaloid, repeat) starting from the original
 *   index-page iteration order; mixed-category (both indexes) artists
 *   are appended at the end. Exported separately for unit-testing the
 *   ordering rule without exercising HTTP.
 */
export function orderArtists(pathToCategories: Map<string, Set<Category>>): OrderedArtist[] {
  const jpopOnly: OrderedArtist[] = [];
  const vocaloidOnly: OrderedArtist[] = [];
  const mixed: OrderedArtist[] = [];
  for (const [path, categories] of pathToCategories) {
    const isJ = categories.has('jpop');
    const isV = categories.has('vocaloid');
    if (isJ && isV) {
      mixed.push({ path, categories });
    } else if (isJ) {
      jpopOnly.push({ path, categories });
    } else if (isV) {
      vocaloidOnly.push({ path, categories });
    } else {
      // Defensive: indexes only emit jpop/vocaloid today, but tolerate it.
      mixed.push({ path, categories });
    }
  }
  const interleaved: OrderedArtist[] = [];
  const max = Math.max(jpopOnly.length, vocaloidOnly.length);
  for (let i = 0; i < max; i++) {
    const j = jpopOnly[i];
    const v = vocaloidOnly[i];
    if (j) interleaved.push(j);
    if (v) interleaved.push(v);
  }
  return [...interleaved, ...mixed];
}
