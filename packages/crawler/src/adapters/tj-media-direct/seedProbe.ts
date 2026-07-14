import type { RawSongRecord } from '@karaoke/schema';
import type { HttpClient } from '../../http.js';
import type { EnrichmentEntry, SearchSongCache } from './cache.js';
import { classifyRecordWithReason } from './parser.js';
import { reviewedTjSongRender } from './reviewedSongOverrides.js';
import { searchSongByPro } from './searchSong.js';

/**
 * Default safety cap on how many blog-claimed TJ numbers a single run will
 * probe. This is a blog-data-damage guard, NOT a coverage tuning knob: the
 * residual seed (claimed numbers no crawl has matched) is tiny in steady
 * state, so a seed larger than this signals damaged blog data rather than real
 * work. On exceed we WARN and probe the first `cap` (sorted) so a run stays
 * bounded and deterministic.
 */
export const BLOG_SEED_PROBE_CAP = 500;

/** Per-run counters for the seed-probe pass, surfaced on the `[tj-seed]` line. */
export interface SeedProbeStats {
  /** Blog-claimed TJ numbers in the seed before subtraction. */
  seed: number;
  /** Numbers already emitted by this run's catalog crawl (subtracted, not probed). */
  skippedAlreadyCrawled: number;
  /** searchSongByPro calls actually issued. */
  probed: number;
  /** Probe hits that passed classification and produced an emitted record. */
  hits: number;
  /** Probe hits that classification dropped (Korean/Chinese/no-JPN gates) — NOT emitted. */
  filtered: number;
  /** Probe misses (searchSongByPro found no TJ record for the number). */
  misses: number;
  /** Probe errors (HTTP / parse); treated like misses but counted apart. */
  errors: number;
  /** Numbers left unprobed because the seed exceeded the cap. */
  truncated: number;
}

/**
 * Reverse-probe the blog-claimed TJ numbers this run did NOT already emit
 * (Option B — adapter self-feed; design 2026-07-14 §3, gap #152 closed).
 *
 * `seed` is the set of TJ numbers claimed by blog-origin records in the
 * previous corpus (`buildBlogSeed`). We subtract `alreadyCrawledTj` (the TJ
 * numbers this run's catalog crawl + rescue already produced) so we probe ONLY
 * claimed-but-unmatched numbers, then look each remaining number up via the
 * existing `searchSongByPro` machinery (which rides the shared HttpClient's TJ
 * politeness/delay).
 *
 * Each hit is run through the SAME admission path as a jpLikelyRescue hit: a
 * JPN `nationalcode` is admitted to `cache.proEnrichmentMap` (so the per-pro
 * filter path can confirm it), then `classifyRecordWithReason` runs the full
 * FILTER_STEPS chain (the #97/#143/#148 gates apply — a probe hit does NOT
 * bypass classification). Only records the chain admits are built, mirroring
 * `parseCatalogResponse`'s record construction (incl. the reviewed per-song
 * render override). Misses and filtered hits emit nothing — they stay standalone
 * blog records and remain visible in the post-merge reverse-lookup report.
 *
 * Returns the admitted `RawSongRecord`s (the caller appends them to the crawl's
 * raw list before the translit pass, so they graduate to `tj-{number}` records
 * that merge with their standalone blog rows on the next merge). Pure w.r.t.
 * the record list; it MAY mutate `cache.proEnrichmentMap` (same as rescue).
 */
export async function probeBlogSeedNumbers(
  http: Pick<HttpClient, 'postForm'>,
  seed: ReadonlySet<string>,
  alreadyCrawledTj: ReadonlySet<string>,
  cache: SearchSongCache,
  sourceUrl: string,
  force?: ReadonlySet<string>,
  cap: number = BLOG_SEED_PROBE_CAP,
): Promise<{ records: RawSongRecord[]; stats: SeedProbeStats }> {
  const stats: SeedProbeStats = {
    seed: seed.size,
    skippedAlreadyCrawled: 0,
    probed: 0,
    hits: 0,
    filtered: 0,
    misses: 0,
    errors: 0,
    truncated: 0,
  };
  const records: RawSongRecord[] = [];

  // Subtract this run's already-emitted TJ numbers.
  const remaining: string[] = [];
  for (const n of seed) {
    if (alreadyCrawledTj.has(n)) {
      stats.skippedAlreadyCrawled++;
      continue;
    }
    remaining.push(n);
  }
  // Sorted so the cap truncation is deterministic across runs.
  remaining.sort();

  let toProbe = remaining;
  if (remaining.length > cap) {
    stats.truncated = remaining.length - cap;
    console.warn(
      `[tj-seed] blog-claimed probe seed ${remaining.length} exceeds cap ${cap} — probing the first ${cap} (sorted); ${stats.truncated} left unprobed (blog-data-damage guard)`,
    );
    toProbe = remaining.slice(0, cap);
  }

  const now = new Date().toISOString();
  // Guard against a probe normalizing two seed numbers onto one pro, or onto a
  // pro this run already emitted (subtraction is on the seed's own strings).
  const emitted = new Set<string>();
  for (const number of toProbe) {
    stats.probed++;
    let item: Awaited<ReturnType<typeof searchSongByPro>>;
    try {
      item = await searchSongByPro(http, number);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[tj-seed] probe failed for pro=${number}: ${msg}`);
      stats.errors++;
      continue;
    }
    if (item === null) {
      stats.misses++;
      continue;
    }
    const tj = item.pro;
    const title = item.indexTitle.trim();
    const artist = item.indexSong.trim();
    if (tj === '' || title === '' || artist === '') {
      stats.misses++;
      continue;
    }
    if (alreadyCrawledTj.has(tj) || emitted.has(tj)) {
      stats.skippedAlreadyCrawled++;
      continue;
    }

    // Mirror jpLikelyRescue: a JPN hit is admitted to the enrichment cache so
    // the per-pro filter path can confirm it. Non-JPN hits fall to the other
    // paths (force whitelist / per-artist / song-override) and are dropped if
    // none admits — exactly the catalog-row behavior.
    if (item.nationalcode === 'JPN' && !cache.proEnrichmentMap[tj]?.nationalcode) {
      const entry: EnrichmentEntry = {
        nationalcode: item.nationalcode,
        sortTitleKo: item.sortTitleKo,
        sortSongKo: item.sortSongKo,
        subTitle: item.subTitle,
        publishdate: item.publishdate,
        lastSeen: now,
      };
      cache.proEnrichmentMap[tj] = entry;
      cache.generatedAt = now;
    }

    const { verdict } = classifyRecordWithReason(tj, title, artist, cache, force);
    if (verdict === 'drop') {
      stats.filtered++;
      continue;
    }

    // Mirror parseCatalogResponse's record construction (incl. the reviewed
    // per-song render override for curated Hangul-gloss artist strings).
    const render = reviewedTjSongRender(tj);
    records.push({
      source_url: sourceUrl,
      title_primary: title,
      title_ko: null,
      artist_primary: render ? render.artist_primary : artist,
      artist_ko: render ? render.artist_ko : null,
      karaoke_numbers: { tj, ky: null, joysound: null },
    });
    emitted.add(tj);
    stats.hits++;
  }

  return { records, stats };
}
