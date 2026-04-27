import type { RawSongRecord, SongRecord } from '@karaoke/schema';
import type { HttpClient } from '../../http.js';
import type { CrawlOptions, Crawler } from '../index.js';
import { ARTIST_SEED_LIST } from './artists.js';
import { normalize } from './normalizer.js';
import { parseListingPage } from './parser.js';

/**
 * Per-run parse-success budget. Spec: ≥90% of fetched listing pages must
 * parse without throwing or the run aborts.
 */
const PARSE_SUCCESS_RATIO_FLOOR = 0.9;

/** Max page index the 200-record cap allows useful results from. */
const MAX_PAGE_NO = 2;
const PAGE_ROW_CNT = 100;
const BASE_URL = 'https://www.tjmedia.com/song/accompaniment_search';

/**
 * `TJDirectCrawler` enumerates TJ Media's accompaniment search via the
 * curated `ARTIST_SEED_LIST` (artist-fanout). For each seed it walks
 * `pageNo=1..2` (the 200-record per-query cap makes pageNo>=3 always empty);
 * it terminates the page loop early when page 1 returns zero rows.
 *
 * Limit semantics mirror BlogCrawler: `options.limit` caps the number of
 * artist queries (not records).
 *
 * Failure semantics:
 *  - Fetch failures (robots-disallow, status >= 400, exceptions) count as
 *    "fetched but empty" — they tick the parse-success counters as
 *    fetched=yes, parsed=no — UNLESS robots disallows the URL or the
 *    underlying HttpClient throws, in which case we count fetch attempts
 *    only against the success ratio.
 *  - The per-run parse-success ratio is enforced AFTER all queries finish;
 *    below 90% the crawl throws and the pipeline aborts.
 *  - Cross-artist dedup-by-TJ#: a song that matches multiple artist queries
 *    (e.g. duets) is yielded only once.
 */
export class TJDirectCrawler implements Crawler {
  readonly name = 'tj-media-direct';

  constructor(
    private http: HttpClient,
    private artists: readonly string[] = ARTIST_SEED_LIST,
  ) {}

  async *crawl(options?: CrawlOptions): AsyncIterable<SongRecord> {
    const limit =
      options?.limit !== undefined && Number.isFinite(options.limit) && options.limit > 0
        ? options.limit
        : Number.POSITIVE_INFINITY;

    const crawledAt = new Date().toISOString();
    const yielded = new Set<string>();
    const queued: SongRecord[] = [];

    let pagesFetched = 0;
    let pagesParsed = 0;

    let attempted = 0;
    for (const artist of this.artists) {
      if (attempted >= limit) break;
      attempted++;

      for (let pageNo = 1; pageNo <= MAX_PAGE_NO; pageNo++) {
        const url = buildUrl(artist, pageNo);
        let body: string | null = null;
        try {
          const res = await this.http.fetch(url);
          if (res === null) {
            console.warn(`[tj-media-direct] ${artist} p${pageNo} blocked by robots.txt`);
          } else if (res.status < 200 || res.status >= 300) {
            console.warn(`[tj-media-direct] ${artist} p${pageNo} HTTP ${res.status}`);
          } else {
            body = res.body;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[tj-media-direct] ${artist} p${pageNo} fetch failed: ${msg}`);
        }

        if (body === null) {
          // Couldn't fetch this page — treat as empty and stop iterating
          // pages for this artist (don't speculatively burn page 2).
          break;
        }

        pagesFetched++;
        let raw: RawSongRecord[];
        try {
          raw = parseListingPage(body, url);
          pagesParsed++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[tj-media-direct] ${artist} p${pageNo} parse failed: ${msg}`);
          break;
        }

        if (raw.length === 0) {
          // First empty page terminates pagination — TJ's 200-cap means
          // pageNo>=3 is always empty so we don't waste a request.
          break;
        }

        for (const r of raw) {
          const tj = r.karaoke_numbers.tj;
          if (tj === null || yielded.has(tj)) continue;
          yielded.add(tj);
          queued.push(normalize(r, crawledAt));
        }
      }
    }

    if (pagesFetched > 0) {
      const ratio = pagesParsed / pagesFetched;
      if (ratio < PARSE_SUCCESS_RATIO_FLOOR) {
        throw new Error(
          `[tj-media-direct] parse success ratio ${ratio.toFixed(2)} below floor ` +
            `${PARSE_SUCCESS_RATIO_FLOOR} (${pagesParsed}/${pagesFetched})`,
        );
      }
    }

    for (const r of queued) yield r;
  }
}

function buildUrl(artist: string, pageNo: number): string {
  const params = new URLSearchParams({
    nationType: 'JPN',
    strType: '2',
    searchTxt: artist,
    pageNo: String(pageNo),
    pageRowCnt: String(PAGE_ROW_CNT),
  });
  return `${BASE_URL}?${params.toString()}`;
}
