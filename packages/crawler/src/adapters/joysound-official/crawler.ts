import type { SongRecord } from '@karaoke/schema';
import type { FetchResult, HttpClient } from '../../http.js';
import type { CrawlOptions, Crawler } from '../index.js';
import { resolveCrawlLimit } from '../limit.js';
import { classifyJoysoundRecord } from './classifier.js';
import { parseJoysoundDetail } from './detail.js';
import { normalizeJoysoundRecord } from './normalizer.js';
import { parseJoysoundListItems, parseJoysoundPagination } from './rsc-parser.js';
import type { JoysoundDetail, JoysoundListItem } from './types.js';

/**
 * Default backoff before the single detail-fetch retry on a transient
 * (429 / 5xx) response. Short and fixed — the per-host rate-limit in
 * `HttpClient` already spaces requests; this is just enough to let a brief
 * server hiccup clear.
 */
const DEFAULT_DETAIL_RETRY_BACKOFF_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** A 429 or any 5xx is treated as transient and worth one retry. */
function isTransientStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

const NEW_RELEASE_LISTING_BASE = 'https://www.joysound.com/web/karaoke/contents/new';
const FULL_SONGLIST_BASE = 'https://www.joysound.com/web/search/songlist';
const DETAIL_BASE = 'https://www.joysound.com/apis/v1/ise/fetchContentsDetail';
const SONG_PAGE_BASE = 'https://www.joysound.com/web/search/song';

const JOYSOUND_FULL_CATALOG_KANA = [
  'ア',
  'イ',
  'ウ',
  'エ',
  'オ',
  'カ',
  'キ',
  'ク',
  'ケ',
  'コ',
  'サ',
  'シ',
  'ス',
  'セ',
  'ソ',
  'タ',
  'チ',
  'ツ',
  'テ',
  'ト',
  'ナ',
  'ニ',
  'ヌ',
  'ネ',
  'ノ',
  'ハ',
  'ヒ',
  'フ',
  'ヘ',
  'ホ',
  'マ',
  'ミ',
  'ム',
  'メ',
  'モ',
  'ヤ',
  'ユ',
  'ヨ',
  'ラ',
  'リ',
  'ル',
  'レ',
  'ロ',
  'ワ',
  'ヲ',
  'ン',
] as const;

interface ListingSource {
  label: string;
  urlForPage(page: number): string;
}

export interface JoysoundOfficialCrawlerOptions {
  /** Override the adapter slug. Used by the explicit full-catalog wrapper. */
  name?: string;
  /**
   * `newReleases` keeps the default small feed. `fullCatalog` walks the
   * kana-indexed `/web/search/songlist/{kana}` catalog and is intentionally
   * opt-in because it is hundreds of thousands of rows.
   */
  listingScope?: 'newReleases' | 'fullCatalog';
  /** Test/audit hook for narrowing the full-catalog kana set. */
  fullCatalogKana?: readonly string[];
  /**
   * Backoff (ms) before the single detail-fetch retry on a transient
   * (429 / 5xx) response. Defaults to {@link DEFAULT_DETAIL_RETRY_BACKOFF_MS};
   * tests pass `0` to avoid sleeping.
   */
  detailRetryBackoffMs?: number;
}

export interface JoysoundFullCatalogCrawlerOptions {
  /** Test/audit hook for narrowing the full-catalog kana set. */
  kana?: readonly string[];
}

function detailMatchesListing(item: JoysoundListItem, detail: JoysoundDetail): boolean {
  return detail.naviGroupId === item.naviGroupId && detail.selSongNo === item.selSongNo;
}

/**
 * `JoysoundOfficialCrawler` walks JOYSOUND's public new-release listing
 * (`/web/karaoke/contents/new?page=N`), classifies each row conservatively,
 * fetches the per-song detail endpoint for kept candidates, and yields
 * `SongRecord`s populating only `karaoke_numbers.joysound` (this adapter
 * never contributes TJ / KY numbers nor Korean translations).
 *
 * Use `JoysoundFullCatalogCrawler` for the explicit full songlist audit scope;
 * the default registered adapter remains the small new-release feed so normal
 * crawls do not accidentally walk the full JOYSOUND catalog.
 *
 * Failure semantics:
 *   - Listing fetch null / non-2xx: throw (listing-level errors abort).
 *   - Detail fetch transient (429 / 5xx): retry ONCE after a short backoff
 *     before giving up — a transient throttle/hiccup during rate-limiting
 *     should not silently drop a real Japanese song.
 *   - Detail fetch null / persistent non-2xx / parse error: warn, increment
 *     the skip counter, and skip the row. We do NOT fall back to listing-only
 *     classification (the conservative classifier was designed with
 *     detail-augmented input; demoting to listing-only here would let through
 *     Latin-titled K-pop with no JP signal). The total skip count is surfaced
 *     in the end-of-run summary log so a high skip rate is visible, not buried
 *     in per-row warns.
 *
 * Limit semantics: `options.limit` caps the number of records yielded
 * (post-classify). Pages are fetched lazily — page 2 only loads once page 1
 * is exhausted and we still need more records.
 */
export class JoysoundOfficialCrawler implements Crawler {
  readonly name: string;
  private readonly listingScope: 'newReleases' | 'fullCatalog';
  private readonly fullCatalogKana: readonly string[];
  private readonly detailRetryBackoffMs: number;
  /** Rows dropped because their detail fetch failed (after one retry). */
  private skippedDetailRows = 0;
  /**
   * Rows dropped because normalization/validation threw (e.g. an anomalous
   * `selSongNo` that is not digits after hyphen-strip). Per-row non-fatal —
   * one bad catalog number must not abort the whole crawl.
   */
  private skippedInvalidRows = 0;

  constructor(
    private http: HttpClient,
    options: JoysoundOfficialCrawlerOptions = {},
  ) {
    this.name = options.name ?? 'joysound-official';
    this.listingScope = options.listingScope ?? 'newReleases';
    this.fullCatalogKana = options.fullCatalogKana ?? JOYSOUND_FULL_CATALOG_KANA;
    this.detailRetryBackoffMs = options.detailRetryBackoffMs ?? DEFAULT_DETAIL_RETRY_BACKOFF_MS;
  }

  async *crawl(options?: CrawlOptions): AsyncIterable<SongRecord> {
    const limit = resolveCrawlLimit(options);
    const crawledAt = new Date().toISOString();

    this.skippedDetailRows = 0;
    this.skippedInvalidRows = 0;
    try {
      yield* this.crawlSources(limit, crawledAt);
    } finally {
      const total = this.skippedDetailRows + this.skippedInvalidRows;
      console.log(
        `[${this.name}] run summary: skipped ${total} row(s): ` +
          `${this.skippedDetailRows} detail-fetch, ${this.skippedInvalidRows} invalid`,
      );
    }
  }

  private async *crawlSources(limit: number, crawledAt: string): AsyncIterable<SongRecord> {
    let yielded = 0;
    for (const source of this.listingSources()) {
      let totalPages: number | null = null;
      let page = 1;

      while (yielded < limit) {
        const url = source.urlForPage(page);
        const res = await this.http.fetch(url);
        if (res === null) {
          throw new Error(
            `[${this.name}] ${source.label} page ${page} blocked by robots.txt: ${url}`,
          );
        }
        if (res.status < 200 || res.status >= 300) {
          throw new Error(
            `[${this.name}] ${source.label} page ${page} HTTP ${res.status} (${url})`,
          );
        }

        const items = parseJoysoundListItems(res.body);
        if (totalPages === null) {
          const pagination = parseJoysoundPagination(res.body);
          totalPages = pagination.totalPages ?? 1;
        }

        for (const item of items) {
          if (yielded >= limit) return;
          const record = await this.processItem(item, crawledAt);
          if (record === null) continue;
          yield record;
          yielded++;
        }

        page++;
        if (page > totalPages) break;
      }
    }
  }

  private listingSources(): ListingSource[] {
    if (this.listingScope === 'fullCatalog') {
      return this.fullCatalogKana.map((kana) => ({
        label: `songlist ${kana}`,
        urlForPage: (page) => `${FULL_SONGLIST_BASE}/${encodeURIComponent(kana)}?page=${page}`,
      }));
    }

    return [
      {
        label: 'new-release listing',
        urlForPage: (page) => `${NEW_RELEASE_LISTING_BASE}?page=${page}`,
      },
    ];
  }

  /**
   * Fetch the detail endpoint once, retrying ONCE on a transient (429 / 5xx)
   * response after `detailRetryBackoffMs`. Returns the final `FetchResult`
   * (which may still be a non-2xx if the retry also failed) or `null` when the
   * URL is robots-blocked.
   */
  private async fetchDetailWithRetry(detailUrl: string): Promise<FetchResult | null> {
    const first = await this.http.fetch(detailUrl);
    if (first === null) return null;
    if (!isTransientStatus(first.status)) return first;

    if (this.detailRetryBackoffMs > 0) await sleep(this.detailRetryBackoffMs);
    const retry = await this.http.fetch(detailUrl);
    // `null` on retry (robots) is unexpected mid-run; surface the first result.
    return retry ?? first;
  }

  /**
   * Fetch the detail endpoint for `item`, classify the augmented row, and
   * (when the classifier admits the row) emit a normalized
   * `SongRecord`. Detail-fetch failures (robots block / persistent non-2xx
   * after one retry) increment `skippedDetailRows`, log a warn, and return
   * `null` so the caller advances to the next item.
   */
  private async processItem(item: JoysoundListItem, crawledAt: string): Promise<SongRecord | null> {
    const detailUrl = `${DETAIL_BASE}?kind=naviGroupId&id=${encodeURIComponent(item.naviGroupId)}`;
    const detailRes = await this.fetchDetailWithRetry(detailUrl);
    if (detailRes === null) {
      this.skippedDetailRows++;
      console.warn(`[${this.name}] detail blocked by robots.txt: ${item.naviGroupId}`);
      return null;
    }
    if (detailRes.status < 200 || detailRes.status >= 300) {
      this.skippedDetailRows++;
      console.warn(
        `[${this.name}] detail HTTP ${detailRes.status} for naviGroupId=${item.naviGroupId} (skipped after retry)`,
      );
      return null;
    }

    let detail: JoysoundDetail;
    try {
      const json: unknown = JSON.parse(detailRes.body);
      detail = parseJoysoundDetail(json);
    } catch (err) {
      // The fetch succeeded but the body was unusable (malformed JSON or a
      // response missing the expected structure). This is a malformed-detail-
      // RESPONSE problem, so it shares the detail-fetch skip bucket (matching
      // the class-level failure-semantics doc that groups "parse error" with
      // detail-fetch failures). Counting it here keeps the run-summary total
      // accurate; the early `return null` ensures the row never reaches the
      // normalizer, so it can't also be counted as `skippedInvalidRows`.
      this.skippedDetailRows++;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[${this.name}] detail parse failed for naviGroupId=${item.naviGroupId}: ${msg} (skipped)`,
      );
      return null;
    }

    if (!detailMatchesListing(item, detail)) {
      console.warn(
        `[${this.name}] detail/listing mismatch for naviGroupId=${item.naviGroupId}, selSongNo=${item.selSongNo}; got naviGroupId=${detail.naviGroupId}, selSongNo=${detail.selSongNo}`,
      );
      return null;
    }

    if (!classifyJoysoundRecord({ listItem: item, detail })) return null;

    const sourceUrl = `${SONG_PAGE_BASE}/${encodeURIComponent(item.naviGroupId)}`;
    try {
      return normalizeJoysoundRecord({
        listItem: item,
        detail,
        sourceUrl,
        crawledAt,
      });
    } catch (err) {
      // Normalization/validation failures (e.g. an anomalous selSongNo that
      // isn't digits after hyphen-strip) are per-row non-fatal: warn, count,
      // and skip so one bad catalog row cannot abort the whole crawl.
      const msg = err instanceof Error ? err.message : String(err);
      this.skippedInvalidRows++;
      console.warn(
        `[${this.name}] normalize failed for naviGroupId=${item.naviGroupId}, selSongNo=${item.selSongNo}: ${msg} (skipped)`,
      );
      return null;
    }
  }
}

/**
 * Explicit opt-in crawler for full JOYSOUND leak/false-positive audits.
 * Not registered in the default adapter list because a full run walks every
 * kana bucket in `/web/search/songlist/{kana}` before detail-classifying rows.
 */
export class JoysoundFullCatalogCrawler extends JoysoundOfficialCrawler {
  constructor(http: HttpClient, options: JoysoundFullCatalogCrawlerOptions = {}) {
    super(http, {
      name: 'joysound-official-full-catalog',
      listingScope: 'fullCatalog',
      ...(options.kana !== undefined ? { fullCatalogKana: options.kana } : {}),
    });
  }
}
