import { applyCategoryExclusivity } from '@karaoke/category-rules';
import { type Category, type SongRecord } from '@karaoke/schema';
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
 * Per-post category override map (2026-05-04 audit, TODO 2 of vocaloid-mistag
 * audit). The blog's `/417` index lists a small handful of artists whose posts
 * are catalogs of their J-pop / J-rock career, NOT their Vocaloid catalog —
 * the index author appears to have categorized them under Vocaloid because
 * the artist had Vocaloid roots, not because the post's contents are Vocaloid
 * songs. Records emitted from these posts must be tagged `jpop`, not
 * `vocaloid`, regardless of which index page surfaced the artist path.
 *
 * Why per-post (NOT per-artist):
 *   米津玄師's early career as ハチ was a real Vocaloid producer (初音ミク /
 *   GUMI). The j-pop-playlist blog already publishes that catalog separately
 *   under post `/428` (artist name `ハチ`), and those records ARE genuinely
 *   vocaloid. An artist-name denylist would wrongly demote those. Keying on
 *   post-id is surgical: only the named posts get retagged; any future blog
 *   post about the same artist's other catalogs is unaffected (different
 *   post-id).
 *
 * Key shape: the numeric portion of the artist path. The path returned by
 * the index parser is `/101`, `/105`, `/112`; this map keys on `'101'`, etc.,
 * matching the `artistIdNumber` segment used in the record `id`
 * (`blog-{artistIdNumber}-{rowIndex}`).
 *
 * Override semantics: the override REPLACES the index-derived category set
 * (it does not union with it). Applied BEFORE `applyCategoryExclusivity` so
 * the priority rule never silently re-elevates the override.
 *
 * Audit (2026-05-04 corpus, 25,793 records):
 *   - blog-101 / 米津玄師   — 9 records, post-Vocaloid solo J-pop catalog.
 *   - blog-105 / Zutomayo   — 11 records, J-rock duo (no Vocaloid catalog).
 *   - blog-112 / Aimer      — 2 records, pop / anime singer.
 *
 * Maintenance: removing an entry is correct only when the post's contents
 * have actually shifted to Vocaloid. Adding an entry requires confirming
 * (a) the post is currently indexed under `/417`, and (b) the post's record
 * list is a different career era from the artist's actual Vocaloid catalog.
 */
export const POST_CATEGORY_OVERRIDES: Readonly<Record<string, Category>> = {
  '101': 'jpop',
  '105': 'jpop',
  '112': 'jpop',
};

/**
 * Returns the override category for an artist path (e.g. `/101`) when the path
 * is in `POST_CATEGORY_OVERRIDES`, else `null`. Exported for unit testing.
 */
export function getPostCategoryOverride(artistPath: string): Category | null {
  const m = /^\/(\d+)$/.exec(artistPath);
  if (!m) return null;
  const key = m[1] as string;
  return POST_CATEGORY_OVERRIDES[key] ?? null;
}

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
        // Per-post category override (audit TODO 2, 2026-05-04). The override
        // REPLACES the index-derived category — applied BEFORE
        // `applyCategoryExclusivity` so the priority rule (vocaloid > anime >
        // jpop) cannot silently re-elevate `vocaloid` after the override
        // demotes a post to `jpop`. See `POST_CATEGORY_OVERRIDES` above.
        const override = getPostCategoryOverride(artistPath);
        if (override !== null) {
          cats.clear();
          cats.add(override);
        }
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
