import type { HttpClient } from '../../http.js';
import type { ArtistNationalityEntry, SearchSongCache } from './cache.js';
import { normalizeForMatch } from './normalize.js';

/**
 * Option-C bootstrap: sweep `/legacy/api/topAndHot100?strType=3` (JPOP genre)
 * over rolling 2-year weekly windows to seed the artist-nationality map.
 *
 * Why this exists: PR-2's per-artist scan (`enrichArtistMap`) takes ~1.4-2 h
 * cold-start over 10-15k unique artists. Most of that time is spent on
 * Korean/English artists we'll classify as KOR/ENG and ignore. Bootstrapping
 * with the JPOP charts pre-tags ~hundreds of popular Japanese artists for
 * free (~2 min total) — saving roundtrips on the most-played artists where
 * the per-artist scan would have just confirmed JPN anyway.
 *
 * The chart endpoint does NOT return `nationalcode` per item, but `strType=3`
 * is the JPOP filter so every item returned counts as +1 JPN vote on its
 * artist. Items that chart in multiple weeks de-dupe by `pro` so a song
 * charting 50 weeks contributes one vote, not 50.
 *
 * Confidence rule: an artist is tagged confidently `JPN` only when ≥3
 * distinct chart appearances are observed (different `pro` values).
 * Singletons stay UNKNOWN — a one-off chart entry isn't enough signal to
 * override an artist who turns out KOR-tagged in `searchSong`.
 *
 * Cost: 104 weeks × 2 chartTypes × 500ms ≈ 104s. Logs progress every 10
 * weekly windows.
 *
 * Idempotent: existing `JPN` entries are not downgraded by a fresh sweep;
 * vote counts are accumulated into a per-bootstrap counter then merged in
 * via `applyBootstrapVotes` below. Existing AMBIGUOUS entries (set by the
 * per-artist scanner) are left alone — chart-evidence-only is weaker than
 * mixed-vote evidence from `searchSong`.
 */

const TOP_AND_HOT_URL = 'https://www.tjmedia.com/legacy/api/topAndHot100';

/** Number of past weeks to sweep. 104 = ~2 years (TJ's client-side max). */
const SWEEP_WEEKS = 104;

/** Both chart types yield different orderings; sweeping both ~doubles coverage. */
const CHART_TYPES: ReadonlyArray<'TOP' | 'HOT'> = ['TOP', 'HOT'];

/** Minimum distinct chart appearances before an artist is tagged confidently JPN. */
const CONFIDENT_THRESHOLD = 3;

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
  /** Distinct artists observed (any vote count, including singletons). */
  artistsSeen: number;
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

  // Per-bootstrap accumulator: artist-key -> set of distinct `pro` values.
  // Using a set dedupes the same song charting in multiple weeks.
  const artistVotes = new Map<string, { displayName: string; pros: Set<string> }>();

  const stats: BootstrapStats = {
    callsOk: 0,
    callsFailed: 0,
    artistsTaggedJpn: 0,
    artistsSeen: 0,
  };

  for (let weekIdx = 0; weekIdx < sweepWeeks; weekIdx++) {
    const { start, end } = weekWindow(now, weekIdx);
    for (const chartType of CHART_TYPES) {
      try {
        const items = await fetchChart(http, chartType, start, end);
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
        logger.warn(`[tj-bootstrap] chart fetch failed (${chartType} ${start}..${end}): ${msg}`);
      }
    }
    if (progressEveryN > 0 && (weekIdx + 1) % progressEveryN === 0) {
      const callsSoFar = (weekIdx + 1) * CHART_TYPES.length;
      logger.log(
        `[tj-bootstrap] swept ${weekIdx + 1}/${sweepWeeks} weekly windows (${callsSoFar} calls) — distinct artists tagged: ${countConfident(artistVotes)}`,
      );
    }
  }

  stats.artistsSeen = artistVotes.size;
  stats.artistsTaggedJpn = applyBootstrapVotes(cache, artistVotes, now);

  logger.log(
    `[tj-bootstrap] done — calls ok ${stats.callsOk}, failed ${stats.callsFailed}, artists seen ${stats.artistsSeen}, tagged JPN ${stats.artistsTaggedJpn}`,
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
 * Merge accumulated chart votes into the cache. Idempotent: existing JPN /
 * AMBIGUOUS entries are not overwritten by chart evidence (which is weaker
 * than mixed-vote `searchSong` evidence). Existing UNKNOWN / KOR / ENG
 * entries get bumped to JPN if the chart sweep produced ≥3 distinct
 * appearances and the entry is not the much-stronger searchSong-vote tally.
 */
function applyBootstrapVotes(
  cache: SearchSongCache,
  artistVotes: ReadonlyMap<string, { displayName: string; pros: Set<string> }>,
  now: Date,
): number {
  let tagged = 0;
  const seenAt = now.toISOString();
  for (const [key, bucket] of artistVotes) {
    const distinctPros = bucket.pros.size;
    if (distinctPros < CONFIDENT_THRESHOLD) continue;
    const existing = cache.artistNationalityMap[key];
    // Don't overwrite a stronger `searchSong`-derived tally. Heuristic: any
    // entry with non-zero KOR or ENG votes came from `searchSong` (which
    // collects mixed-nationality evidence); chart-only votes only ever hit
    // JPN. Don't downgrade or override mixed-evidence entries.
    if (existing && (existing.votes.KOR > 0 || existing.votes.ENG > 0)) continue;
    const entry: ArtistNationalityEntry = {
      code: 'JPN',
      votes: {
        JPN: Math.max(existing?.votes.JPN ?? 0, distinctPros),
        KOR: existing?.votes.KOR ?? 0,
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
): Promise<ChartItem[]> {
  const res = await http.postForm(TOP_AND_HOT_URL, {
    chartType,
    searchStartDate: start,
    searchEndDate: end,
    strType: '3',
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
