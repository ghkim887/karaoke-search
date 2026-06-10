import type { SongRecord } from '@karaoke/schema';
import { HttpClient } from '../http.js';
import { JoysoundOfficialCrawler } from './joysound-official/crawler.js';
import { BlogCrawler } from './jpop-playlist-blog/crawler.js';
import { TJDirectCrawler } from './tj-media-direct/crawler.js';

/**
 * Per-adapter crawl options. Adapters honor `limit` themselves; the pipeline
 * passes it through unchanged.
 */
export interface CrawlOptions {
  /** Maximum number of source pages (e.g., artist pages) the adapter should
   * fetch. `undefined` means no cap. */
  limit?: number;
}

/**
 * Source-specific crawler. Per-spec the interface yields `RawSongRecord`, but
 * for the Phase 2 pipeline we choose to keep adapters self-normalizing — each
 * adapter runs its own raw→`SongRecord` mapping internally so the pipeline
 * deals only in the universal record. This avoids leaking source-specific
 * raw shapes into the merger and validator stages.
 *
 * Departure from spec is intentional and documented here:
 *   normalization happens inside the adapter; pipeline operates on universal
 *   SongRecord only.
 */
export interface Crawler {
  name: string;
  crawl(options?: CrawlOptions): AsyncIterable<SongRecord>;
}

/**
 * Construct the DEFAULT registered adapter set — the ones that run on a
 * no-`--source` crawl (the weekly `crawl.yml`). Returning a fresh array per
 * call keeps adapters with mutable internal state (HTTP cache, robots cache)
 * isolated across pipeline runs in tests.
 *
 * The merger uses array order as registration order for collision tie-breaks.
 *
 * `joysound-official` is deliberately NOT here: it is opt-in only (see
 * `buildOptInAdapters`) until the joysound data-merge scope is decided, so the
 * production corpus is not silently augmented by the weekly crawl.
 */
function buildAdapters(http: HttpClient): Crawler[] {
  return [new BlogCrawler(http), new TJDirectCrawler(http)];
}

/**
 * Opt-in adapters: reachable ONLY via an explicit `--source <slug>` and never
 * part of the default no-`--source` run set. `joysound-official` lives here so
 * `--source joysound-official` keeps working while the default weekly crawl
 * stays blog + tj.
 */
function buildOptInAdapters(http: HttpClient): Crawler[] {
  return [new JoysoundOfficialCrawler(http)];
}

const defaultHttpClient = new HttpClient();
const optInHttpClient = new HttpClient();

/**
 * Default adapter set bound to a single shared `HttpClient`. The CLI consumes
 * this for a no-`--source` run. Tests that need adapter isolation should call
 * `buildAdapters(new HttpClient())` instead.
 */
export const adapters: Crawler[] = buildAdapters(defaultHttpClient);

/**
 * Opt-in adapter set bound to its own shared `HttpClient`. Not run unless an
 * explicit `--source` names one of them.
 */
const optInAdapters: Crawler[] = buildOptInAdapters(optInHttpClient);

/**
 * The shared `HttpClient` instances backing `adapters` / `optInAdapters`.
 * Cache persistence is batched, so whoever owns the run lifecycle (the CLI)
 * must `flush()` these at end-of-run or the last batch of cache stores is
 * lost.
 */
export const sharedHttpClients: readonly HttpClient[] = [defaultHttpClient, optInHttpClient];

/**
 * Resolve the adapter run set for a `--source` selection.
 *
 *  - Empty `sources` → the default set (blog + tj), in registration order.
 *  - Non-empty `sources` → look each slug up across BOTH the default set and
 *    the opt-in set (so `--source joysound-official` resolves even though it is
 *    not a default adapter). The result preserves the order in which adapters
 *    are registered, not the order the slugs were passed, matching the previous
 *    `.filter(...)` semantics.
 *  - An unknown slug throws — fail loud rather than silently running nothing.
 */
export function resolveAdaptersForSources(sources: string[]): Crawler[] {
  if (sources.length === 0) return adapters;

  const requested = new Set(sources);
  const known = [...adapters, ...optInAdapters];
  const selected = known.filter((a) => requested.has(a.name));

  const matched = new Set(selected.map((a) => a.name));
  const unknown = sources.filter((s) => !matched.has(s));
  if (unknown.length > 0) {
    const knownNames = known.map((a) => a.name).join(', ');
    throw new Error(`unknown --source: ${unknown.join(', ')} (known sources: ${knownNames})`);
  }

  return selected;
}
