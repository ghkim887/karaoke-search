import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SongRecord } from '@karaoke/schema';
import type { HttpClient } from '../../http.js';
import type { CrawlOptions, Crawler } from '../index.js';
import { resolveCrawlLimit } from '../limit.js';
import {
  type BlogSeedSource,
  type BlogWhitelistSource,
  defaultBlogSeedSource,
  defaultBlogWhitelistSource,
} from './blogWhitelist.js';
import { bootstrapArtistMapFromCharts } from './bootstrapCharts.js';
import { type SearchSongCache, isBootstrapFresh, loadCache, saveCache } from './cache.js';
import { enrichArtistMap } from './enrichArtistMap.js';
import { enrichWithTranslit } from './enrichTranslit.js';
import { parseCatalogShell, rescueJpLikelyDroppedRecords } from './jpLikelyRescue.js';
import { extractCatalogItems } from './normalize.js';
import { type TranslitEnrichment, normalize } from './normalizer.js';
import { type TjFilterDecisionRecord, parseCatalogResponse } from './parser.js';
import { probeBlogSeedNumbers } from './seedProbe.js';

// The blog-whitelist subsystem (record type, script-signal rules, builder,
// default on-disk source) lives in `blogWhitelist.ts`; the JP-likely drop
// rescue lives in `jpLikelyRescue.ts`. Public names are re-exported here so
// existing importers (tests included) keep working unchanged.
export {
  type BlogWhitelistRecord,
  type BlogWhitelistSource,
  buildBlogWhitelist,
  shouldAdmitArtistToWhitelist,
} from './blogWhitelist.js';

const CATALOG_URL = 'https://www.tjmedia.com/legacy/api/newSongOfMonth';
/** "all songs since 2000-01" — returns the full historical TJ catalog (~67k). */
const SEARCH_YM = '200001';

/**
 * Default on-disk location of the TJ-search cache. Tracked in git
 * (NOT gitignored) — CI must NOT pay the first-run enrichment cost. See
 * `apps/web/public/data/tj-search-cache.json` and the cache module's
 * docblock for the file schema.
 *
 * Resolved from the compiled file location
 * (`<repo>/packages/crawler/dist/adapters/tj-media-direct/crawler.js`) up to
 * the repo root so the path is independent of `process.cwd()`.
 */
const HERE = fileURLToPath(new URL('.', import.meta.url));
const TRANSLIT_CACHE_PATH_DEFAULT = resolve(
  HERE,
  '../../../../../apps/web/public/data/tj-search-cache.json',
);

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
  private cachedSeed: ReadonlySet<string> | null = null;
  private readonly cachePath: string;
  private readonly disableEnrichment: boolean;

  constructor(
    private http: HttpClient,
    private blogWhitelistSource: BlogWhitelistSource = defaultBlogWhitelistSource,
    options: TJDirectCrawlerOptions = {},
    // Blog reverse-probe seed source (previous-corpus blog-claimed TJ numbers).
    // Defaulted + last positional so existing call sites are unchanged; tests
    // inject a fixture set.
    private blogSeedSource: BlogSeedSource = defaultBlogSeedSource,
  ) {
    this.cachePath = options.cachePath ?? TRANSLIT_CACHE_PATH_DEFAULT;
    this.disableEnrichment = options.disableEnrichment ?? false;
  }

  async *crawl(options?: CrawlOptions): AsyncIterable<SongRecord> {
    const limit = resolveCrawlLimit(options);

    const crawledAt = new Date().toISOString();

    if (this.cachedWhitelist === null) {
      this.cachedWhitelist = this.blogWhitelistSource();
    }
    const forceIncludeTjNumbers = this.cachedWhitelist;

    if (this.cachedSeed === null) {
      this.cachedSeed = this.blogSeedSource();
    }
    const blogSeed = this.cachedSeed;

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
    const allItems = extractCatalogItems(json, 'tj-media-direct');

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
      const artistShells: NonNullable<ReturnType<typeof asArtistShell>>[] = [];
      for (const item of allItems) {
        const shell = asArtistShell(item);
        if (shell !== null) artistShells.push(shell);
      }
      const stats = await enrichArtistMap(this.http, artistShells, cache);
      if (stats.fetches > 0) cacheMutated = true;
    }

    // Step 5: parse + filter.
    let {
      records: raw,
      stats: keepStats,
      decisions: keepDecisions,
    } = parseCatalogResponse(json, CATALOG_URL, {
      cache,
      forceIncludeTjNumbers,
    });

    if (!this.disableEnrichment) {
      const rescueStats = await rescueJpLikelyDroppedRecords(
        this.http,
        allItems,
        cache,
        forceIncludeTjNumbers,
      );
      if (rescueStats.fetches > 0) cacheMutated = true;
      if (rescueStats.admitted > 0) {
        // Rescue mutated the cache; re-parse so `raw`/`keepStats`/`keepDecisions`
        // reflect the newly-admitted rows. Only THIS final parse's decisions are
        // written below — never the pre-rescue parse — so no row is double-logged
        // with a contradictory verdict (load-bearing per the design's rescue caveat).
        ({
          records: raw,
          stats: keepStats,
          decisions: keepDecisions,
        } = parseCatalogResponse(json, CATALOG_URL, {
          cache,
          forceIncludeTjNumbers,
        }));
      }
      console.log(
        `[tj-rescue] checked ${rescueStats.candidates} JP-likely drops — fetches ${rescueStats.fetches}, admitted ${rescueStats.admitted}, misses ${rescueStats.misses}, errors ${rescueStats.errors}, skipped-cached ${rescueStats.skippedCached}`,
      );
    }

    // Step 5b: TJ reverse-probe seed ingest (Option B — adapter self-feed;
    // #152 gap closed). THIS run's TJ numbers are now settled (catalog +
    // rescue), so look up the blog-claimed numbers we did NOT emit and, for
    // hits the filter chain admits, append tj-{number} records so they
    // graduate their standalone blog rows at the next merge. Runs BEFORE the
    // translit pass so the new records get title_ko/artist_ko like any catalog
    // row. Skipped under disableEnrichment (no HTTP), same as rescue/translit;
    // an empty seed makes zero probes and adds nothing (crawl byte-identical).
    if (!this.disableEnrichment) {
      const alreadyCrawledTj = new Set<string>();
      for (const r of raw) {
        const tj = r.karaoke_numbers.tj;
        if (tj !== null) alreadyCrawledTj.add(tj);
      }
      const { records: seedRecords, stats: seedStats } = await probeBlogSeedNumbers(
        this.http,
        blogSeed,
        alreadyCrawledTj,
        cache,
        CATALOG_URL,
        forceIncludeTjNumbers,
      );
      if (seedStats.probed > 0) cacheMutated = true;
      for (const r of seedRecords) raw.push(r);
      console.log(
        `[tj-seed] probed ${seedStats.probed} blog-claimed numbers — hits ${seedStats.hits}, filtered ${seedStats.filtered}, misses ${seedStats.misses}, errors ${seedStats.errors}, skipped-already-crawled ${seedStats.skippedAlreadyCrawled}, truncated ${seedStats.truncated} (seed ${seedStats.seed})`,
      );
    }

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
      keepStats.admittedByArtist +
      keepStats.admittedByPro +
      keepStats.admittedBySongOverride +
      keepStats.admittedByRescue;
    console.log(
      `[tj-direct] kept ${keptTotal}: by-artist ${keepStats.admittedByArtist}, by-pro ${keepStats.admittedByPro}, by-song-override ${keepStats.admittedBySongOverride}, by-rescue ${keepStats.admittedByRescue}; dropped ${keepStats.dropped}`,
    );

    // Optional per-row decision log: the FINAL parse's admit/drop attribution
    // (the `keepDecisions` reassigned above by the rescue re-parse). Written
    // once, overwrite semantics, ONLY when `--decisions-out` supplied a path.
    // Fail-soft (warn, don't throw) so a diagnostic-artifact write error can
    // never abort or change the crawl — this is report-only telemetry.
    if (options?.decisionsOutPath) {
      await this.tryWriteDecisions(options.decisionsOutPath, keepDecisions);
    }

    // Step 7: persist enrichment work BEFORE yielding so a downstream
    // consumer's exception (during `yield`) cannot discard hours of bootstrap
    // + artist-scan + translit fetches. The `finally` block remains as a
    // safety net for any further mutations during yield (currently none).
    if (cacheMutated) {
      const saved = await this.trySaveCache(cache, 'pre-yield');
      if (saved) {
        cacheMutated = false; // saved successfully; finally won't re-save.
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
        await this.trySaveCache(cache, 'finally');
      }
    }
  }

  /**
   * Wrap `saveCache` with a label-tagged warn-on-failure so both the
   * pre-yield and post-yield save sites share one error-handling path.
   *
   * Returns `true` when the cache was persisted, `false` when the save threw
   * (the caller decides whether a failed pre-yield save should still let the
   * finally block retry). Failures are non-fatal — the next crawler run will
   * re-do the enrichment work; we surface them as warnings so they're visible
   * in CI logs without aborting the pipeline.
   */
  private async trySaveCache(cache: SearchSongCache, label: string): Promise<boolean> {
    try {
      await saveCache(this.cachePath, cache);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[tj-search] cache save failed at ${this.cachePath} (${label}): ${msg}`);
      return false;
    }
  }

  /**
   * Write the per-row filter decision log as JSONL (one compact object per
   * line), overwrite semantics. Fail-soft: a write error is warned, never
   * thrown — the decision log is report-only telemetry and must not abort the
   * crawl. The parent dir is created if missing (CI points this at a
   * RUNNER_TEMP subdir).
   */
  private async tryWriteDecisions(
    outPath: string,
    decisions: readonly TjFilterDecisionRecord[],
  ): Promise<void> {
    try {
      await mkdir(dirname(outPath), { recursive: true });
      const body = decisions.map((d) => JSON.stringify(d)).join('\n');
      await writeFile(outPath, decisions.length > 0 ? `${body}\n` : '', 'utf8');
      console.log(`[tj-direct] wrote ${decisions.length} filter decisions to ${outPath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[tj-direct] filter decision-log write failed at ${outPath}: ${msg}`);
    }
  }
}

// `extractCatalogItems` previously lived here as a near-duplicate of the
// version in `parser.ts`. Both now share the implementation in `normalize.ts`
// (imported above), which `isPlainObject`-filters the returned items so the
// callers can iterate without re-validating each entry's shape.

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
} | null {
  const parsed = parseCatalogShell(item);
  if (parsed === null) return null;
  return {
    source_url: CATALOG_URL,
    title_primary: parsed.title,
    title_ko: null,
    artist_primary: parsed.artist,
    artist_ko: null,
    karaoke_numbers: { tj: parsed.tj, ky: null, joysound: null },
  };
}
