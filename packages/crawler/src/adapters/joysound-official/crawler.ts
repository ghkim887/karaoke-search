import type { SongRecord } from '@karaoke/schema';
import type { HttpClient } from '../../http.js';
import type { CrawlOptions, Crawler } from '../index.js';
import { resolveCrawlLimit } from '../limit.js';
import { classifyJoysoundRecord } from './classifier.js';
import { parseJoysoundDetail } from './detail.js';
import { normalizeJoysoundRecord } from './normalizer.js';
import { parseJoysoundListItems, parseJoysoundPagination } from './rsc-parser.js';
import type { JoysoundDetail, JoysoundListItem } from './types.js';

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
 *   - Detail fetch null / non-2xx / parse error: warn + skip the row, do not
 *     fall back to listing-only classification (the conservative classifier
 *     was designed with detail-augmented input; demoting to listing-only
 *     here would let through Latin-titled K-pop with no JP signal).
 *
 * Limit semantics: `options.limit` caps the number of records yielded
 * (post-classify). Pages are fetched lazily — page 2 only loads once page 1
 * is exhausted and we still need more records.
 */
export class JoysoundOfficialCrawler implements Crawler {
  readonly name: string;
  private readonly listingScope: 'newReleases' | 'fullCatalog';
  private readonly fullCatalogKana: readonly string[];

  constructor(
    private http: HttpClient,
    options: JoysoundOfficialCrawlerOptions = {},
  ) {
    this.name = options.name ?? 'joysound-official';
    this.listingScope = options.listingScope ?? 'newReleases';
    this.fullCatalogKana = options.fullCatalogKana ?? JOYSOUND_FULL_CATALOG_KANA;
  }

  async *crawl(options?: CrawlOptions): AsyncIterable<SongRecord> {
    const limit = resolveCrawlLimit(options);
    const crawledAt = new Date().toISOString();

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
   * Fetch the detail endpoint for `item`, classify the augmented row, and
   * (when the classifier returns a non-null category) emit a normalized
   * `SongRecord`. Detail failures log a warn and return `null` so the
   * caller advances to the next item.
   */
  private async processItem(item: JoysoundListItem, crawledAt: string): Promise<SongRecord | null> {
    const detailUrl = `${DETAIL_BASE}?kind=naviGroupId&id=${encodeURIComponent(item.naviGroupId)}`;
    const detailRes = await this.http.fetch(detailUrl);
    if (detailRes === null) {
      console.warn(`[${this.name}] detail blocked by robots.txt: ${item.naviGroupId}`);
      return null;
    }
    if (detailRes.status < 200 || detailRes.status >= 300) {
      console.warn(
        `[${this.name}] detail HTTP ${detailRes.status} for naviGroupId=${item.naviGroupId}`,
      );
      return null;
    }

    let detail: JoysoundDetail;
    try {
      const json: unknown = JSON.parse(detailRes.body);
      detail = parseJoysoundDetail(json);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[${this.name}] detail parse failed for naviGroupId=${item.naviGroupId}: ${msg}`,
      );
      return null;
    }

    if (!detailMatchesListing(item, detail)) {
      console.warn(
        `[${this.name}] detail/listing mismatch for naviGroupId=${item.naviGroupId}, selSongNo=${item.selSongNo}; got naviGroupId=${detail.naviGroupId}, selSongNo=${detail.selSongNo}`,
      );
      return null;
    }

    const category = classifyJoysoundRecord({ listItem: item, detail });
    if (category === null) return null;

    const sourceUrl = `${SONG_PAGE_BASE}/${encodeURIComponent(item.naviGroupId)}`;
    return normalizeJoysoundRecord({
      listItem: item,
      detail,
      category,
      sourceUrl,
      crawledAt,
    });
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
