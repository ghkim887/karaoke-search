import type { SongRecord } from '@karaoke/schema';
import type { HttpClient } from '../../http.js';
import type { CrawlOptions, Crawler } from '../index.js';
import { normalize } from './normalizer.js';
import { parseCatalogResponse } from './parser.js';

const CATALOG_URL = 'https://www.tjmedia.com/legacy/api/newSongOfMonth';
/** "all songs since 2000-01" — returns the full historical TJ catalog (~67k). */
const SEARCH_YM = '200001';

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
 * that to ~7k JP-relevant records.
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

  constructor(private http: HttpClient) {}

  async *crawl(options?: CrawlOptions): AsyncIterable<SongRecord> {
    const limit =
      options?.limit !== undefined && Number.isFinite(options.limit) && options.limit > 0
        ? options.limit
        : Number.POSITIVE_INFINITY;

    const crawledAt = new Date().toISOString();

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

    const raw = parseCatalogResponse(json, CATALOG_URL);

    let yielded = 0;
    for (const r of raw) {
      if (yielded >= limit) break;
      yield normalize(r, crawledAt);
      yielded++;
    }
  }
}
