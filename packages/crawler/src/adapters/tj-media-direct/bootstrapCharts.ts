import type { HttpClient } from '../../http.js';
import type { ArtistNationalityEntry, SearchSongCache } from './cache.js';
import { DROP_LIST } from './koreanArtistDropList.js';
import { normalizeForMatch } from './normalize.js';
import { searchSongByArtist } from './searchSong.js';

/**
 * Option-C bootstrap: sweep `/legacy/api/topAndHot100` per-genre over rolling
 * 2-year weekly windows to seed the artist-nationality map.
 *
 * Why this exists: PR-2's per-artist scan (`enrichArtistMap`) takes ~1.4-2 h
 * cold-start over 10-15k unique artists. Most of that time is spent on
 * Korean/English artists we'll classify as KOR/ENG and ignore. Bootstrapping
 * with the genre charts pre-tags ~hundreds of popular Japanese (and now
 * Korean — see Phase 1 spec §2.F) artists for free (~3-4 min total) — saving
 * roundtrips on the most-played artists.
 *
 * The chart endpoint does NOT return `nationalcode` per item, but the
 * `strType` filter implicitly tags everything in the genre. The genre map
 * (verified via `docs/research/2026-04-29-tj-media-api-surface.md` §2):
 *   - `strType=3` → JPOP (was the only genre swept pre-Phase-1).
 *   - `strType=1` → 가요 (K-pop) — added in Phase 1 to source KOR votes.
 *
 * Per-genre votes go into the matching `votes.JPN` / `votes.KOR` slot so the
 * Phase 1 §2.A ratio rule has data on both sides — a Korean act that
 * accidentally charts on the JPOP filter (or vice versa) ends up AMBIGUOUS
 * via the threshold rule rather than wrongly JPN.
 *
 * Items that chart in multiple weeks de-dupe by `pro` so a song charting 50
 * weeks contributes one vote, not 50.
 *
 * Confidence rule: an artist is tagged confidently with the genre's vote-as
 * code only when ≥3 distinct chart appearances are observed in that genre.
 * Singletons stay UNKNOWN.
 *
 * Cost: 104 weeks × 2 chartTypes × 2 genres × 500 ms ≈ 208 s. Logs progress
 * every 10 weekly windows.
 *
 * Idempotent: existing `JPN`/`KOR` entries are not downgraded by a fresh
 * sweep; vote counts are accumulated into a per-bootstrap counter then merged
 * in via `applyBootstrapVotes` below. Existing AMBIGUOUS entries (set by the
 * per-artist scanner) are left alone — chart-evidence-only is weaker than
 * mixed-vote evidence from `searchSong`.
 *
 * Fallback path for the KOR sweep: if the KPOP chart sweep returns zero
 * confident artists across the entire window (e.g. TJ's `strType=1` filter
 * went unsupported), the bootstrap falls back to a `searchSong?strType=2&
 * nationType=KOR` seed-list scan over the §2.E drop list canonical names.
 * This is strictly weaker than the chart sweep (a smaller seed list, no
 * fresh-discovery surface) but it guarantees we have non-zero KOR votes for
 * the §2.A ratio rule. The fallback runs ONLY when the primary path emits
 * zero KOR-tagged artists — a partial primary success skips the fallback.
 */

const TOP_AND_HOT_URL = 'https://www.tjmedia.com/legacy/api/topAndHot100';

/** Number of past weeks to sweep. 104 = ~2 years (TJ's client-side max). */
const SWEEP_WEEKS = 104;

/** Both chart types yield different orderings; sweeping both ~doubles coverage. */
const CHART_TYPES: ReadonlyArray<'TOP' | 'HOT'> = ['TOP', 'HOT'];

/** Minimum distinct chart appearances before an artist is tagged confidently. */
const CONFIDENT_THRESHOLD = 3;

/**
 * Chart genres swept on each bootstrap pass.
 *
 * `strType=1` is K-pop (가요) and `strType=3` is JPOP, per the genre table
 * in `docs/research/2026-04-29-tj-media-api-surface.md` §2 (probed live by
 * the API-surface research pass on 2026-04-29).
 *
 * `voteAs` selects which vote slot in the artist's `votes` tally a confident
 * appearance contributes to — JPN votes on the JPOP sweep, KOR votes on the
 * K-pop sweep. The `verdictFromVotes` rule (Phase 1 spec §2.A) reads both
 * slots to compute a JPN/KOR/AMBIGUOUS verdict.
 */
export const CHART_GENRES: ReadonlyArray<{
  strType: string;
  voteAs: 'JPN' | 'KOR';
  label: string;
}> = [
  { strType: '3', voteAs: 'JPN', label: 'JPOP' },
  { strType: '1', voteAs: 'KOR', label: 'KPOP' },
];

export interface BootstrapOptions {
  /** Override the date used for staleness checks. Tests inject a frozen now. */
  now?: Date;
  /** Override the per-N-weeks progress log cadence. Default 10. */
  progressEveryN?: number;
  /** Override the console used for log/warn output. Tests inject a recorder. */
  logger?: { log(msg: string): void; warn(msg: string): void };
  /** Override the number of weeks swept (tests cut to a tiny window). */
  sweepWeeks?: number;
}

export interface BootstrapStats {
  /** Total chart calls that returned 2xx and were parsed. */
  callsOk: number;
  /** Calls that threw (HTTP error etc.) — logged and skipped. */
  callsFailed: number;
  /** Distinct artists tagged confidently JPN by the sweep. */
  artistsTaggedJpn: number;
  /**
   * Distinct artists tagged confidently KOR by the sweep (Phase 1 §2.F).
   * Pre-Phase-1 callers may not read this field; default 0 is a safe no-op.
   */
  artistsTaggedKor: number;
  /** Distinct artists observed (any vote count, including singletons). */
  artistsSeen: number;
  /**
   * Whether the seed-list KOR fallback ran (spec §2.F primary→fallback).
   * `true` ONLY when the primary KPOP-chart sweep tagged 0 KOR artists AND
   * the fallback was attempted. Surfaced for observability — a stable run
   * with `kpopFallbackUsed: true` for several crawls signals TJ's `strType=1`
   * KPOP genre is broken and should be revisited.
   */
  kpopFallbackUsed: boolean;
}

/**
 * Sweep `topAndHot100` strType=3 over rolling weekly windows; mutates
 * `cache.artistNationalityMap` in place. Returns coarse stats for logging.
 *
 * Skips entirely (no HTTP calls) if the cache's bootstrap is already fresh —
 * `crawler.ts` is responsible for the gate; this function just runs.
 */
export async function bootstrapArtistMapFromCharts(
  http: Pick<HttpClient, 'postForm'>,
  cache: SearchSongCache,
  options: BootstrapOptions = {},
): Promise<BootstrapStats> {
  const now = options.now ?? new Date();
  const progressEveryN = options.progressEveryN ?? 10;
  const sweepWeeks = options.sweepWeeks ?? SWEEP_WEEKS;
  const logger = options.logger ?? {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
  };

  const stats: BootstrapStats = {
    callsOk: 0,
    callsFailed: 0,
    artistsTaggedJpn: 0,
    artistsTaggedKor: 0,
    artistsSeen: 0,
    kpopFallbackUsed: false,
  };

  // Track distinct artists across ALL genres so the union-card stat is honest.
  const seenArtistKeys = new Set<string>();

  for (const genre of CHART_GENRES) {
    // Per-genre accumulator: artist-key -> set of distinct `pro` values.
    // Using a set dedupes the same song charting in multiple weeks.
    const artistVotes = new Map<string, { displayName: string; pros: Set<string> }>();

    for (let weekIdx = 0; weekIdx < sweepWeeks; weekIdx++) {
      const { start, end } = weekWindow(now, weekIdx);
      for (const chartType of CHART_TYPES) {
        try {
          const items = await fetchChart(http, chartType, start, end, genre.strType);
          stats.callsOk++;
          for (const item of items) {
            const key = normalizeForMatch(item.indexSong);
            if (key === '') continue;
            let bucket = artistVotes.get(key);
            if (!bucket) {
              bucket = { displayName: item.indexSong, pros: new Set<string>() };
              artistVotes.set(key, bucket);
            }
            bucket.pros.add(item.pro);
          }
        } catch (err) {
          stats.callsFailed++;
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(
            `[tj-bootstrap] chart fetch failed (${genre.label} ${chartType} ${start}..${end}): ${msg}`,
          );
        }
      }
      if (progressEveryN > 0 && (weekIdx + 1) % progressEveryN === 0) {
        const callsSoFar = (weekIdx + 1) * CHART_TYPES.length;
        logger.log(
          `[tj-bootstrap] ${genre.label} swept ${weekIdx + 1}/${sweepWeeks} weekly windows (${callsSoFar} calls) — distinct ${genre.voteAs} artists tagged: ${countConfident(artistVotes)}`,
        );
      }
    }

    for (const key of artistVotes.keys()) seenArtistKeys.add(key);
    const tagged = applyBootstrapVotes(cache, artistVotes, now, genre.voteAs);
    if (genre.voteAs === 'JPN') stats.artistsTaggedJpn += tagged;
    else stats.artistsTaggedKor += tagged;

    logger.log(
      `[tj-bootstrap] ${genre.label} pass done — distinct artists tagged ${genre.voteAs}: ${tagged}`,
    );
  }

  // Fallback: if the primary KPOP chart sweep produced 0 confident KOR
  // artists, run the seed-list `searchSong?strType=2&nationType=KOR` scan
  // over the §2.E drop list canonical names. Strictly weaker than the
  // chart sweep (smaller seed list, no fresh-discovery surface) but it
  // guarantees the §2.A ratio rule has non-zero KOR data on cold-start.
  if (stats.artistsTaggedKor === 0) {
    stats.kpopFallbackUsed = true;
    logger.log(
      '[tj-bootstrap] KPOP chart sweep produced 0 confident KOR artists — running seed-list fallback (searchSong?nationType=KOR over drop-list canonicals)',
    );
    try {
      const fallbackTagged = await runKorFallback(http, cache, now, logger, stats);
      stats.artistsTaggedKor += fallbackTagged;
      logger.log(`[tj-bootstrap] KOR fallback tagged ${fallbackTagged} artists`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[tj-bootstrap] KOR fallback aborted with error: ${msg}`);
    }
  }

  stats.artistsSeen = seenArtistKeys.size;

  logger.log(
    `[tj-bootstrap] done — calls ok ${stats.callsOk}, failed ${stats.callsFailed}, artists seen ${stats.artistsSeen}, tagged JPN ${stats.artistsTaggedJpn}, tagged KOR ${stats.artistsTaggedKor}${stats.kpopFallbackUsed ? ' (fallback used)' : ''}`,
  );

  // Stamp `bootstrappedAt` ONLY when at least one sweep call succeeded. A
  // run that 100%-failed (e.g. the host briefly returned 503 every call)
  // must NOT mark the bootstrap fresh — otherwise we'd skip the next
  // crawl's retry. Independent of `generatedAt`, which translit /
  // per-artist passes also bump.
  if (stats.callsOk > 0) {
    cache.bootstrappedAt = now.toISOString();
  }
  // Bump `generatedAt` so the saved file reflects when this code last ran.
  cache.generatedAt = now.toISOString();

  return stats;
}

/**
 * Seed-list KOR fallback. Runs ONLY when the primary KPOP chart sweep
 * tagged 0 confident KOR artists.
 *
 * For each canonical name in the §2.E drop list, call `searchSong?strType=2&
 * nationType=KOR` and tally exact-match KOR votes. Reuses `searchSongByArtist`
 * so any apostrophe-strip / sanitization stays consistent with the rest of
 * the enrichment chain.
 *
 * Threshold: ≥3 KOR votes on a canonical's variant key tags that variant
 * confidently KOR — same bar as the chart sweep's CONFIDENT_THRESHOLD.
 *
 * Failure semantics: a per-name HTTP error logs and continues (does NOT
 * abort the fallback). The outer try/catch guards against catastrophic
 * failure (e.g. the http client throwing on construction).
 */
async function runKorFallback(
  http: Pick<HttpClient, 'postForm'>,
  cache: SearchSongCache,
  now: Date,
  logger: { log(msg: string): void; warn(msg: string): void },
  stats: BootstrapStats,
): Promise<number> {
  // Per-fallback accumulator mirrors the chart sweep's shape so we can
  // reuse `applyBootstrapVotes`.
  const artistVotes = new Map<string, { displayName: string; pros: Set<string> }>();

  for (const entry of DROP_LIST) {
    for (const variant of entry.variants) {
      const key = normalizeForMatch(variant);
      if (key === '') continue;
      try {
        const items = await searchSongByArtist(http, variant, 'KOR');
        stats.callsOk++;
        for (const item of items) {
          if (normalizeForMatch(item.indexSong) !== key) continue;
          // Only count items the server tagged KOR — `nationType=KOR` should
          // already filter, but defense-in-depth doesn't hurt.
          if (item.nationalcode !== 'KOR') continue;
          let bucket = artistVotes.get(key);
          if (!bucket) {
            bucket = { displayName: variant, pros: new Set<string>() };
            artistVotes.set(key, bucket);
          }
          bucket.pros.add(item.pro);
        }
      } catch (err) {
        stats.callsFailed++;
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`[tj-bootstrap] KOR fallback failed for "${variant}": ${msg}`);
      }
    }
  }

  return applyBootstrapVotes(cache, artistVotes, now, 'KOR');
}

/**
 * Merge accumulated chart votes into the cache. Idempotent: existing entries
 * with strong cross-genre evidence are not downgraded by a single-genre
 * chart sweep.
 *
 * `voteAs` selects which `votes.*` slot the confident appearances accumulate
 * into:
 *   - `'JPN'`: write votes into `votes.JPN`. Skip update when the existing
 *     entry has non-zero KOR or ENG votes (mixed-vote `searchSong` evidence
 *     is stronger than chart-only).
 *   - `'KOR'`: write votes into `votes.KOR`. Skip update when the existing
 *     entry has non-zero JPN or ENG votes (symmetric protection — a JPOP-
 *     chart-confirmed JPN artist briefly appearing on the K-pop chart
 *     should not flip).
 *
 * The verdict is set to `voteAs` when the entry IS written. The
 * `verdictFromVotes` rule (Phase 1 §2.A) is the authoritative classifier
 * once `searchSong` votes land; the chart-bootstrap verdict is a placeholder
 * for the cold-start window.
 */
function applyBootstrapVotes(
  cache: SearchSongCache,
  artistVotes: ReadonlyMap<string, { displayName: string; pros: Set<string> }>,
  now: Date,
  voteAs: 'JPN' | 'KOR',
): number {
  let tagged = 0;
  const seenAt = now.toISOString();
  for (const [key, bucket] of artistVotes) {
    const distinctPros = bucket.pros.size;
    if (distinctPros < CONFIDENT_THRESHOLD) continue;
    const existing = cache.artistNationalityMap[key];

    // Don't overwrite an entry that already has STRONGER cross-evidence
    // signal than this single-genre chart sweep can offer. Heuristic per
    // direction:
    //   - JPOP sweep: skip when KOR > 0 OR ENG > 0 (mixed-vote searchSong
    //     evidence already classified this artist; don't blow it away).
    //   - KPOP sweep: skip when JPN > 0 OR ENG > 0. JPN > 0 here covers the
    //     case where the JPOP sweep already tagged the artist confidently
    //     JPN — letting the KPOP sweep then write votes.KOR over it would
    //     flip a real JP act to KOR. The Phase 1 §2.A ratio rule then sorts
    //     out genuinely-mixed artists via `verdictFromVotes` after the
    //     `searchSong` per-artist pass runs.
    if (existing) {
      if (voteAs === 'JPN' && (existing.votes.KOR > 0 || existing.votes.ENG > 0)) continue;
      if (voteAs === 'KOR' && (existing.votes.JPN > 0 || existing.votes.ENG > 0)) continue;
    }

    const entry: ArtistNationalityEntry = {
      code: voteAs,
      votes: {
        JPN:
          voteAs === 'JPN'
            ? Math.max(existing?.votes.JPN ?? 0, distinctPros)
            : (existing?.votes.JPN ?? 0),
        KOR:
          voteAs === 'KOR'
            ? Math.max(existing?.votes.KOR ?? 0, distinctPros)
            : (existing?.votes.KOR ?? 0),
        ENG: existing?.votes.ENG ?? 0,
      },
      lastSeen: seenAt,
    };
    cache.artistNationalityMap[key] = entry;
    tagged++;
  }
  return tagged;
}

function countConfident(
  artistVotes: ReadonlyMap<string, { displayName: string; pros: Set<string> }>,
): number {
  let n = 0;
  for (const bucket of artistVotes.values()) {
    if (bucket.pros.size >= CONFIDENT_THRESHOLD) n++;
  }
  return n;
}

interface ChartItem {
  pro: string;
  indexTitle: string;
  indexSong: string;
}

async function fetchChart(
  http: Pick<HttpClient, 'postForm'>,
  chartType: 'TOP' | 'HOT',
  start: string,
  end: string,
  strType: string,
): Promise<ChartItem[]> {
  const res = await http.postForm(TOP_AND_HOT_URL, {
    chartType,
    searchStartDate: start,
    searchEndDate: end,
    strType,
  });
  if (res === null) {
    throw new Error(`[tj-bootstrap] topAndHot100 blocked by robots.txt: ${TOP_AND_HOT_URL}`);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`[tj-bootstrap] topAndHot100 returned HTTP ${res.status}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(res.body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[tj-bootstrap] topAndHot100 response is not valid JSON: ${msg}`);
  }
  return parseChartResponse(json);
}

/**
 * Parse a `/legacy/api/topAndHot100` response. Tolerates the same envelope
 * variations as `searchSong` (flat `{ items }` vs the bucketed array shape).
 *
 * Exported for unit tests.
 */
export function parseChartResponse(json: unknown): ChartItem[] {
  if (!isPlainObject(json)) {
    throw new Error('[tj-bootstrap] response is not a JSON object');
  }
  const code = json.resultCode;
  if (code === '98') return [];
  if (code !== '99') {
    const msg = typeof json.resultMsg === 'string' ? json.resultMsg : '<no message>';
    throw new Error(`[tj-bootstrap] resultCode=${String(code)} (${msg})`);
  }
  const data = json.resultData;
  const out: ChartItem[] = [];
  for (const raw of collectItems(data)) {
    const item = mapChartItem(raw);
    if (item !== null) out.push(item);
  }
  return out;
}

/**
 * Failure-mode contract: this helper TOLERATES unrecognized shapes by
 * returning `[]`. That intentionally diverges from
 * `searchSong.ts:collectItems`, which THROWS. The chart endpoint is
 * best-effort signal — losing one window's votes self-heals on the next
 * sweep, so the right behavior is to log+skip rather than abort the entire
 * bootstrap. The searchSong endpoint, by contrast, is authoritative and
 * cached for 90 days, so a silent `[]` there could persist a wrong verdict.
 * Do not unify these two helpers without preserving the divergent semantics.
 */
function collectItems(data: unknown): unknown[] {
  if (data === null || data === undefined) return [];
  if (isPlainObject(data) && Array.isArray(data.items)) return data.items;
  if (Array.isArray(data)) {
    const merged: unknown[] = [];
    for (const bucket of data) {
      if (!isPlainObject(bucket)) continue;
      for (const key of Object.keys(bucket)) {
        if (!key.startsWith('items')) continue;
        if (key.endsWith('TotalCount')) continue;
        const value = bucket[key];
        if (Array.isArray(value)) merged.push(...value);
      }
    }
    return merged;
  }
  if (typeof data === 'string') return [];
  return [];
}

function mapChartItem(raw: unknown): ChartItem | null {
  if (!isPlainObject(raw)) return null;
  const pro = coerceProString(raw.pro);
  const indexTitle = coerceNonEmpty(raw.indexTitle);
  const indexSong = coerceNonEmpty(raw.indexSong);
  if (pro === null || indexTitle === null || indexSong === null) return null;
  return { pro, indexTitle, indexSong };
}

function coerceProString(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'string' && v.trim() !== '') return v.trim();
  return null;
}

function coerceNonEmpty(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed === '' ? null : trimmed;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Compute the `[start, end]` (YYYY-MM-DD) window for the Nth-week-back from
 * `now`. Week 0 is the trailing 7 days from `now`; week 1 is the 7 days
 * before that, etc. The TJ client clamps to a 2-year max — we honor that.
 *
 * Exported for unit tests.
 */
export function weekWindow(now: Date, weekIdx: number): { start: string; end: string } {
  const day = 24 * 60 * 60 * 1000;
  const endMs = now.getTime() - weekIdx * 7 * day;
  const startMs = endMs - 6 * day;
  return { start: toYmd(new Date(startMs)), end: toYmd(new Date(endMs)) };
}

function toYmd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
