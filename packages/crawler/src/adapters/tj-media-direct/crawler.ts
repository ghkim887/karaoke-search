import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SongRecord } from '@karaoke/schema';
import type { HttpClient } from '../../http.js';
import type { CrawlOptions, Crawler } from '../index.js';
import { type SearchSongCache, loadCache, saveCache } from './cache.js';
import { enrichWithTranslit } from './enrichTranslit.js';
import { type TranslitEnrichment, normalize } from './normalizer.js';
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
 * Default on-disk location of the TJ-search translit cache. Tracked in git
 * (NOT gitignored) — CI must NOT pay the first-run enrichment cost. See
 * `apps/web/public/data/tj-search-cache.json` and the cache module's
 * docblock for the file schema.
 */
const TRANSLIT_CACHE_PATH_DEFAULT = resolve(
  HERE,
  '../../../../../apps/web/public/data/tj-search-cache.json',
);

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
 * Optional per-instance overrides. Tests inject a fixture cache path and a
 * disabled-enrichment flag; production uses the defaults.
 */
export interface TJDirectCrawlerOptions {
  /** Override the on-disk path of the translit cache. */
  cachePath?: string;
  /** When true, skip the enrichment pass entirely (legacy path). */
  disableEnrichment?: boolean;
}

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
 * Translit enrichment (PR-1, 2026-04-29): after the parser/filter chain runs,
 * each surviving record is enriched with Korean transliterations
 * (`sortTitleKo`/`sortSongKo`) sourced from `/legacy/api/searchSong`. Results
 * are cached in `apps/web/public/data/tj-search-cache.json` (tracked in git
 * so CI never pays the first-run cost). On HTTP error or `pro` mismatch the
 * record's `title_ko`/`artist_ko` stay `null` — same as the pre-enrichment
 * behavior, no regression.
 *
 * Failure semantics:
 *  - Any HTTP error (non-2xx, network failure, robots-disallow) on the
 *    catalog fetch throws and aborts the pipeline.
 *  - The parser also throws on a malformed response shape; that propagates.
 *  - `searchSong` enrichment errors are LOGGED and SKIPPED — they do not
 *    abort the pipeline. The record is emitted with null Korean fields.
 *  - No dedup-by-tj logic is needed: the API returns each `pro` exactly once.
 *
 * Limit semantics: `options.limit` caps the number of records yielded
 * (post JP-filter). Useful for smoke tests. `0`/undefined means no cap.
 */
export class TJDirectCrawler implements Crawler {
  readonly name = 'tj-media-direct';
  private cachedWhitelist: ReadonlySet<string> | null = null;
  private readonly cachePath: string;
  private readonly disableEnrichment: boolean;

  constructor(
    private http: HttpClient,
    private blogWhitelistSource: BlogWhitelistSource = defaultBlogWhitelistSource,
    options: TJDirectCrawlerOptions = {},
  ) {
    this.cachePath = options.cachePath ?? TRANSLIT_CACHE_PATH_DEFAULT;
    this.disableEnrichment = options.disableEnrichment ?? false;
  }

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

    // Run the translit enrichment pass over the surviving records BEFORE
    // we start yielding. This buys us a complete progress log + a single
    // atomic cache save at the end, at the cost of holding ~6k records in
    // memory between phases. The pre-enrichment record list is already in
    // memory above (`raw`), so this isn't a peak-memory regression.
    let cache: SearchSongCache | null = null;
    let enrichmentByPro: Map<string, TranslitEnrichment> | null = null;
    let cacheMutated = false;
    if (!this.disableEnrichment) {
      cache = await loadCache(this.cachePath);
      const { byPro, stats } = await enrichWithTranslit(this.http, raw, cache);
      // Cache mutated iff we actually fetched anything new from TJ — if every
      // record was a cache hit (warm-start happy path), nothing in
      // `proEnrichmentMap` changed and we can skip the file rewrite. Avoids
      // a needless `mtime` bump on `tj-search-cache.json` in the tracked git
      // tree on no-op runs.
      cacheMutated = stats.fetches > 0;
      // Project to the slimmed `TranslitEnrichment` shape the normalizer
      // accepts — we don't need the rest of the cache fields downstream.
      enrichmentByPro = new Map();
      for (const [pro, entry] of byPro) {
        enrichmentByPro.set(pro, {
          sortTitleKo: entry.sortTitleKo,
          sortSongKo: entry.sortSongKo,
        });
      }
    }

    let yielded = 0;
    let errored = false;
    try {
      for (const r of raw) {
        if (yielded >= limit) break;
        const enrichment = enrichmentByPro?.get(r.karaoke_numbers.tj ?? '');
        yield normalize(r, crawledAt, enrichment);
        yielded++;
      }
    } catch (err) {
      errored = true;
      throw err;
    } finally {
      if (cache !== null && !errored && cacheMutated) {
        try {
          await saveCache(this.cachePath, cache);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[tj-search] cache save failed at ${this.cachePath}: ${msg}`);
        }
      }
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
