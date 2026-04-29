import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SongRecord } from '@karaoke/schema';
import type { HttpClient } from '../../http.js';
import type { CrawlOptions, Crawler } from '../index.js';
import { bootstrapArtistMapFromCharts } from './bootstrapCharts.js';
import { isBootstrapFresh, loadCache, saveCache } from './cache.js';
import { enrichArtistMap } from './enrichArtistMap.js';
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
 * Default on-disk location of the TJ-search cache. Tracked in git
 * (NOT gitignored) — CI must NOT pay the first-run enrichment cost. See
 * `apps/web/public/data/tj-search-cache.json` and the cache module's
 * docblock for the file schema.
 */
const TRANSLIT_CACHE_PATH_DEFAULT = resolve(
  HERE,
  '../../../../../apps/web/public/data/tj-search-cache.json',
);

/**
 * Provider for the set of TJ catalog numbers that should bypass the per-record
 * + per-artist cache filter (defense-in-depth rescue). Defaults to the on-disk
 * blog corpus (`apps/web/public/data/songs.json`).
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
  /** Override the on-disk path of the search cache. */
  cachePath?: string;
  /**
   * When true, skip ALL enrichment passes (bootstrap + per-artist scan +
   * per-record translit) and run the parser with the cache as-loaded from
   * disk. Used by tests to exercise the parser/filter without HTTP.
   *
   * Note: this does NOT skip cache loading — the parser still needs the
   * cache for its filter chain. Passing `disableEnrichment: true` with a
   * cold (empty) cache + an empty whitelist will drop every record because
   * no path can confirm JPN.
   */
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
 * response yields ~67k catalog items.
 *
 * --- PR-2 enrichment chain (replaces the legacy JP-regex + Chinese denylist) ---
 *
 *   1. **Bulk fetch.** One POST to `newSongOfMonth?searchYm=200001`.
 *   2. **Cache load.** Read `apps/web/public/data/tj-search-cache.json`.
 *   3. **Bootstrap (Option C).** If the cache's bootstrap is stale (>7 days
 *      old, or `artistNationalityMap` is empty), sweep the JPOP charts via
 *      `topAndHot100` for the past 2 years to seed confident-JPN artists.
 *      ~2 minutes; cheap-but-not-free, hence the 7-day cadence.
 *   4. **Per-artist scan.** For every distinct artist in the catalog, call
 *      `searchSong?strType=2` and tally `nationalcode` votes from exact-match
 *      results. Cache hits skip; misses fetch. ~1.4-2h cold-start, near-zero
 *      on warm cache.
 *   5. **Filter via parser.** The parser's 3-path chain (per-record JPN /
 *      per-artist JPN / blog rescue) keeps a record iff any path confirms.
 *   6. **Translit pass (PR-1).** For each surviving record, populate
 *      `title_ko`/`artist_ko` from `searchSong?strType=1` exact-`pro` match.
 *   7. **Cache save.** Atomic rewrite if anything was fetched.
 *   8. **Yield.** Normalize each kept record into a `SongRecord`.
 *
 * Failure semantics:
 *  - HTTP error on the catalog fetch: throws and aborts the pipeline.
 *  - Parser throws on a malformed response shape: propagates.
 *  - Bootstrap / per-artist / translit errors: LOGGED and SKIPPED. Records
 *    where the artist scan errored stay UNKNOWN -> dropped, except for blog
 *    whitelist rescues.
 *
 * Limit semantics: `options.limit` caps the number of records yielded
 * (post-filter). `0`/undefined means no cap.
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

    // Step 1: bulk catalog fetch.
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

    // Step 2: load cache (always; the parser filter needs it).
    const cache = await loadCache(this.cachePath);
    let cacheMutated = false;

    // Build the unfiltered raw record list once: it's the input to the
    // per-artist scanner (we want to scan every distinct artist in the
    // catalog, not just the ones already cached as JPN) AND the input to
    // the parser filter. Re-using the records as a flat list avoids a
    // second JSON walk; the in-memory cost is the same as before.
    const allItems = extractCatalogItems(json);

    // Step 3: bootstrap (Option C) if stale.
    // Step 4: per-artist scan.
    if (!this.disableEnrichment) {
      if (!isBootstrapFresh(cache)) {
        try {
          await bootstrapArtistMapFromCharts(this.http, cache);
          cacheMutated = true;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[tj-bootstrap] bootstrap pass failed: ${msg}`);
        }
      } else {
        console.log('[tj-bootstrap] skipped — cache bootstrap is fresh (<7 days)');
      }

      // The artist scanner takes pseudo-RawSongRecord input — we pass shells
      // with just `artist_primary` populated since that's all the scanner
      // reads. Importing `RawSongRecord` here is a slight schema lean-in but
      // keeps the scanner reusable for the post-filter case too.
      const artistShells = allItems.map(asArtistShell).filter((s) => s !== null);
      const stats = await enrichArtistMap(this.http, artistShells, cache);
      if (stats.fetches > 0) cacheMutated = true;
    }

    // Step 5: parse + filter.
    const { records: raw, stats: keepStats } = parseCatalogResponse(json, CATALOG_URL, {
      cache,
      forceIncludeTjNumbers,
    });

    // Step 6: translit pass (PR-1).
    let enrichmentByPro: Map<string, TranslitEnrichment> | null = null;
    if (!this.disableEnrichment) {
      const { byPro, stats } = await enrichWithTranslit(this.http, raw, cache);
      if (stats.fetches > 0) cacheMutated = true;
      enrichmentByPro = new Map();
      for (const [pro, entry] of byPro) {
        enrichmentByPro.set(pro, {
          sortTitleKo: entry.sortTitleKo,
          sortSongKo: entry.sortSongKo,
        });
      }
    }

    // Surface per-path admit counters so post-pre-seed we can see how often
    // each filter path is the first admitter. A high `by-rescue` value means
    // the searchSong index is missing real JPN records and the blog-whitelist
    // rescue is hiding gaps; a low value means the rescue is doing minimal
    // safety-net work as designed.
    const keptTotal =
      keepStats.admittedByArtist + keepStats.admittedByPro + keepStats.admittedByRescue;
    console.log(
      `[tj-direct] kept ${keptTotal}: by-artist ${keepStats.admittedByArtist}, by-pro ${keepStats.admittedByPro}, by-rescue ${keepStats.admittedByRescue}; dropped ${keepStats.dropped}`,
    );

    // Step 7: persist enrichment work BEFORE yielding so a downstream
    // consumer's exception (during `yield`) cannot discard hours of bootstrap
    // + artist-scan + translit fetches. The `finally` block remains as a
    // safety net for any further mutations during yield (currently none).
    if (cacheMutated) {
      try {
        await saveCache(this.cachePath, cache);
        cacheMutated = false; // saved successfully; finally won't re-save.
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[tj-search] cache save failed at ${this.cachePath}: ${msg}`);
      }
    }

    // Step 8: yield. No further cache mutations happen here today; the
    // `finally` save below covers the future case where one is added.
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
      if (!errored && cacheMutated) {
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
 * Pull the items array out of the catalog JSON envelope. Mirrors
 * `parseCatalogResponse`'s extraction but returns the raw item objects so the
 * artist-scanner step can iterate them without parser-level filtering.
 *
 * Throws on malformed envelope shapes — same failure semantics as
 * `parseCatalogResponse`.
 */
function extractCatalogItems(json: unknown): ReadonlyArray<Record<string, unknown>> {
  if (!isPlainObject(json)) {
    throw new Error('tj-media-direct: response is not a JSON object');
  }
  const data = json.resultData;
  if (!isPlainObject(data)) {
    throw new Error('tj-media-direct: response.resultData missing or not an object');
  }
  const items = data.items;
  if (!Array.isArray(items)) {
    throw new Error('tj-media-direct: response.resultData.items is not an array');
  }
  return items.filter(isPlainObject);
}

/**
 * Build a minimal `RawSongRecord`-shaped shell from a catalog item — only
 * `artist_primary` is meaningful; the rest is filled with placeholder values
 * so the type-check passes. The artist scanner only reads `artist_primary`.
 *
 * Returns `null` for items missing pro/title/artist (skipped upstream too).
 */
function asArtistShell(item: Record<string, unknown>): {
  source_url: string;
  title_primary: string;
  title_ko: null;
  artist_primary: string;
  artist_ko: null;
  karaoke_numbers: { tj: string | null; ky: null; joysound: null };
  categories: ['jpop'];
} | null {
  const proRaw = item.pro;
  const title = typeof item.indexTitle === 'string' ? item.indexTitle.trim() : '';
  const artist = typeof item.indexSong === 'string' ? item.indexSong.trim() : '';
  let tj: string | null = null;
  if (typeof proRaw === 'number' && Number.isFinite(proRaw)) tj = String(proRaw);
  else if (typeof proRaw === 'string' && proRaw.trim() !== '') tj = proRaw.trim();
  if (!tj || !title || !artist) return null;
  return {
    source_url: CATALOG_URL,
    title_primary: title,
    title_ko: null,
    artist_primary: artist,
    artist_ko: null,
    karaoke_numbers: { tj, ky: null, joysound: null },
    categories: ['jpop'],
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
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
