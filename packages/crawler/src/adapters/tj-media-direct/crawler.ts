import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SongRecord } from '@karaoke/schema';
import type { HttpClient } from '../../http.js';
import type { CrawlOptions, Crawler } from '../index.js';
import { normalize } from './normalizer.js';
import { parseCatalogResponse } from './parser.js';

const CATALOG_URL = 'https://www.tjmedia.com/legacy/api/newSongOfMonth';
/** "all songs since 2000-01" — returns the full historical TJ catalog (~67k). */
const SEARCH_YM = '200001';

/**
 * Resolve to the on-disk blog corpus the rescue path reads at construction time.
 *
 * Walks up from the compiled file location
 * (`<repo>/packages/crawler/dist/adapters/tj-media-direct/crawler.js`) to the
 * repo root, then into `apps/web/public/data/songs.json`. This makes the path
 * resolution independent of `process.cwd()` so the adapter works whether the
 * CLI is invoked from the repo root, a package dir, or a CI worker.
 */
const HERE = fileURLToPath(new URL('.', import.meta.url));
const BLOG_CORPUS_PATH_DEFAULT = resolve(HERE, '../../../../../apps/web/public/data/songs.json');

/**
 * Provider for the set of TJ catalog numbers that should bypass the
 * loose-JP filter and Chinese denylist. Defaults to the on-disk blog
 * corpus (`apps/web/public/data/songs.json`).
 *
 * Pragmatic dependency: the rescue path reads the deployed blog data so the
 * adapter retains all-Latin-named Japanese acts the blog already knows about
 * (GRANRODEO, halyosy, DREAMS COME TRUE, etc.). This mirrors the small
 * architectural smell already present in `apps/web/src/lib/featured.ts`,
 * which is also tied to the blog corpus.
 */
export type BlogWhitelistSource = () => ReadonlySet<string>;

/**
 * `TJDirectCrawler` fetches TJ Media's full historical catalog via a single
 * POST to the legacy `newSongOfMonth` API and emits Japanese-relevant
 * records as `SongRecord`s.
 *
 * Endpoint contract (live-verified 2026-04-27):
 *   POST https://www.tjmedia.com/legacy/api/newSongOfMonth
 *   body: searchYm=200001 (form-urlencoded)
 *
 * No authentication, no UA gating (the legacy API is open even when the
 * public HTML site requires a Chrome UA), no per-page loop. The single
 * response yields ~67k catalog items; the parser's loose-JP filter narrows
 * that to ~7k JP-relevant records, the Chinese-artist denylist drops well-
 * known Cantopop / Mandopop acts, and the blog-whitelist rescue re-includes
 * Japanese acts whose TJ# is already in the blog corpus regardless of
 * script content.
 *
 * Failure semantics:
 *  - Any HTTP error (non-2xx, network failure, robots-disallow) throws and
 *    aborts the pipeline. Single-request crawl — there is no retry path and
 *    no success-ratio gate. Either it works or it doesn't.
 *  - The parser also throws on a malformed response shape; that propagates.
 *  - No dedup-by-tj logic is needed: the API returns each `pro` exactly once.
 *
 * Limit semantics: `options.limit` caps the number of records yielded
 * (post JP-filter). Useful for smoke tests. `0`/undefined means no cap.
 */
export class TJDirectCrawler implements Crawler {
  readonly name = 'tj-media-direct';
  private cachedWhitelist: ReadonlySet<string> | null = null;

  constructor(
    private http: HttpClient,
    private blogWhitelistSource: BlogWhitelistSource = defaultBlogWhitelistSource,
  ) {}

  async *crawl(options?: CrawlOptions): AsyncIterable<SongRecord> {
    const limit =
      options?.limit !== undefined && Number.isFinite(options.limit) && options.limit > 0
        ? options.limit
        : Number.POSITIVE_INFINITY;

    const crawledAt = new Date().toISOString();

    if (this.cachedWhitelist === null) {
      this.cachedWhitelist = this.blogWhitelistSource();
    }
    const forceIncludeTjNumbers = this.cachedWhitelist;

    const res = await this.http.postForm(CATALOG_URL, { searchYm: SEARCH_YM });
    if (res === null) {
      throw new Error(`[tj-media-direct] catalog fetch blocked by robots.txt: ${CATALOG_URL}`);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(
        `[tj-media-direct] catalog fetch returned HTTP ${res.status} (${CATALOG_URL})`,
      );
    }

    let json: unknown;
    try {
      json = JSON.parse(res.body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[tj-media-direct] catalog response is not valid JSON: ${msg}`);
    }

    const raw = parseCatalogResponse(json, CATALOG_URL, { forceIncludeTjNumbers });

    let yielded = 0;
    for (const r of raw) {
      if (yielded >= limit) break;
      yield normalize(r, crawledAt);
      yielded++;
    }
  }
}

/**
 * Default blog whitelist source: read `apps/web/public/data/songs.json` from
 * the working directory and extract every record's `karaoke_numbers.tj`.
 *
 * If the file is missing or unreadable, log a single warning and return an
 * empty set — the adapter degrades to "no rescue", not a hard failure.
 */
function defaultBlogWhitelistSource(): ReadonlySet<string> {
  try {
    const text = readFileSync(BLOG_CORPUS_PATH_DEFAULT, 'utf8');
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return new Set();
    const tjs = new Set<string>();
    for (const rec of parsed) {
      if (!rec || typeof rec !== 'object') continue;
      const numbers = (rec as { karaoke_numbers?: unknown }).karaoke_numbers;
      if (!numbers || typeof numbers !== 'object') continue;
      const tj = (numbers as { tj?: unknown }).tj;
      if (typeof tj === 'string' && tj !== '') tjs.add(tj);
    }
    return tjs;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[tj-media-direct] blog-whitelist rescue disabled: could not read ${BLOG_CORPUS_PATH_DEFAULT}: ${msg}`,
    );
    return new Set();
  }
}
