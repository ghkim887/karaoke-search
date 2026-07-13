#!/usr/bin/env node
/**
 * On-demand TJ `searchSong` number-probe for the tjpdf catalog (ROADMAP R7).
 *
 * NETWORK tool — run manually / on-demand, NOT part of the weekly pipeline. It
 * POSTs the TJ legacy JSON API once per code and writes/refreshes the committed
 * catalog JSONL that the offline `ingest-tjpdf-catalog.mjs` step consumes. This
 * keeps the weekly post-crawl pipeline fully offline and deterministic (it reads
 * the committed catalog; it never touches the network).
 *
 *   POST https://www.tjmedia.com/legacy/api/searchSong
 *   Content-Type: application/x-www-form-urlencoded
 *   body: searchTxt=<num>&strType=16&nationType=
 *
 * `strType=16` is the exact song-number lookup. The response envelope is the
 * contract documented in
 * packages/crawler/src/adapters/tj-media-direct/searchSong.ts (resultCode 99 =
 * success, 98 = empty/no-data → []; resultData is either a flat `{ items }`
 * object or a 6-bucket array — both tolerated). The numeric endpoint can return
 * neighboring numbers, so every result is client-side EXACT-`pro`-matched
 * (leading-zero-normalized) before it is accepted — mirrors `searchSongByPro`.
 *
 * Politeness mirrors HOST_CONFIG['www.tjmedia.com'] in
 * packages/crawler/src/http.ts (minIntervalMs 500 + jitterMs 100, i.e. a
 * 500 ms ± 50 ms gap before every request) with the same crawler User-Agent as
 * scripts/joysound-detail-sweep.mjs. Transient failures (network error / 429 /
 * 5xx) get up to 3 retries with LINEAR backoff; deterministic failures (4xx,
 * malformed JSON, bad envelope) are not retried.
 *
 * Modes:
 *   (default, SEED)   Reads scripts/data/tjpdf-seed-numbers.json and refreshes
 *                     scripts/data/tjpdf-catalog.jsonl. RESUMABLE: codes already
 *                     present in the catalog are skipped unless --fresh is given.
 *                     A seed code that returns no exact hit is a reported MISS
 *                     (it would drop coverage downstream) and makes the run exit
 *                     non-zero.
 *   --range A..B      DISCOVERY: probes an arbitrary inclusive integer range and
 *                     APPENDS only exact hits (misses are normal and silent).
 *                     Use for finding new anime-block numbers. Do NOT run large
 *                     ranges casually — this is a live crawl.
 *
 * Flags:
 *   --seed <path>     Override the seed list path (SEED mode).
 *   --catalog <path>  Override the catalog JSONL path.
 *   --range A..B      DISCOVERY mode over the inclusive range [A, B].
 *   --fresh           Re-probe every in-scope code (do not skip existing).
 *   --limit N         Probe at most N in-scope codes (smoke / partial runs).
 *   --help            Print usage and exit 0.
 *
 * The catalog JSONL is a committed, deterministic artifact: one line per code,
 * fields {pro, indexTitle, subTitle, indexSong, sortTitleKo, sortSongKo,
 * nationalcode, publishdate, checkedAt} in that order, sorted by numeric `pro`.
 * `checkedAt` is an ISO-8601 UTC timestamp recording when the row's content was
 * last (re)captured from the API; the offline ingest carries it into each
 * `tjpdf-*` row's `crawled_at` so re-ingesting an unchanged catalog is byte-
 * idempotent (without it the ingest would re-stamp every row with now() each
 * week — the corpus-harvest fallback is empirically dead over a fresh crawl).
 * It is PRESERVED (not re-stamped) when a re-probe returns byte-identical
 * content for an existing code, so re-probing an unchanged catalog is itself
 * byte-idempotent; only genuinely new or content-changed rows get a fresh
 * `checkedAt`. `indexTitle` is edge-trimmed on capture (leading/trailing
 * whitespace only — interior spacing is preserved) so the API's stray trailing
 * spaces never churn corpus titles downstream.
 *
 * Usage:
 *   node scripts/probe-tjpdf-catalog.mjs                 # refresh the seed catalog
 *   node scripts/probe-tjpdf-catalog.mjs --fresh         # re-probe all seeds
 *   node scripts/probe-tjpdf-catalog.mjs --range 28900..28919   # discovery smoke
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeTextAtomic } from './lib/atomic-write.mjs';
import { isCliInvocation } from './lib/cli.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

export const SEARCH_SONG_URL = 'https://www.tjmedia.com/legacy/api/searchSong';
// Same crawler UA as scripts/joysound-detail-sweep.mjs (line ~60).
export const USER_AGENT =
  'karaoke-search-crawler/0.1 (+https://github.com/ghkim887/karaoke-search)';

export const DEFAULT_SEED_PATH = resolve(REPO_ROOT, 'scripts/data/tjpdf-seed-numbers.json');
export const DEFAULT_CATALOG_PATH = resolve(REPO_ROOT, 'scripts/data/tjpdf-catalog.jsonl');

// TJ host politeness parity: HOST_CONFIG['www.tjmedia.com'] in
// packages/crawler/src/http.ts is { minIntervalMs: 500, jitterMs: 100 }, applied
// as `gap = minIntervalMs + (Math.random() - 0.5) * jitterMs`.
export const MIN_INTERVAL_MS = 500;
export const JITTER_MS = 100;
// Task spec: 3 retries, linear backoff (delay = base * attempt).
export const MAX_RETRIES = 3;
export const RETRY_BASE_DELAY_MS = 500;

// Emitted catalog field order (one line per code). `checkedAt` (last field) is
// the row-capture timestamp the offline ingest carries into `crawled_at`; it is
// not part of the API item and is assigned/preserved by runProbe.
export const CATALOG_FIELDS = Object.freeze([
  'pro',
  'indexTitle',
  'subTitle',
  'indexSong',
  'sortTitleKo',
  'sortSongKo',
  'nationalcode',
  'publishdate',
  'checkedAt',
]);

// Content fields compared to decide whether a re-probe changed a row (i.e. all
// catalog fields EXCEPT the `checkedAt` provenance timestamp). Kept in sync with
// CATALOG_FIELDS via a filter so a future field is included automatically.
export const CATALOG_CONTENT_FIELDS = Object.freeze(
  CATALOG_FIELDS.filter((f) => f !== 'checkedAt'),
);

export const USAGE =
  'usage: node scripts/probe-tjpdf-catalog.mjs [--seed <path>] [--catalog <path>] ' +
  '[--range A..B] [--fresh] [--limit N] [--help]';

// ---------------------------------------------------------------------------
// Envelope parsing (replicated from tj-media-direct/searchSong.ts + normalize.ts
// so this standalone script has no crawler-dist build dependency).
// ---------------------------------------------------------------------------

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `indexSong` is round-tripped verbatim (trim:false parity); `indexTitle` is
 *  additionally edge-trimmed in `mapItem` (see `trimTitleEdges`). */
export function coerceNonEmptyString(v) {
  if (typeof v !== 'string') return null;
  return v === '' ? null : v;
}

/** ISO-8601 UTC ms + Z, matching JS `toISOString()`. */
export function isoUtcNow() {
  return new Date().toISOString();
}

/**
 * Edge-trim a catalog title: strip LEADING/TRAILING whitespace only — interior
 * spacing is preserved (`String.prototype.trim` never touches the middle). A
 * value that is null or trims to empty becomes null (an all-whitespace title is
 * not a usable title). The TJ API occasionally returns titles with a stray
 * trailing space (e.g. `"ハロ/ハワユ "`); left verbatim these churn corpus
 * `title_primary` every crawl, so they are normalized at the source on capture.
 */
export function trimTitleEdges(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

export function coerceProString(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'string' && v.trim() !== '') return v.trim();
  return null;
}

/** Strip leading zeros for exact-`pro` comparison (`06286` == `6286`). */
export function normalizeProQuery(pro) {
  const trimmed = String(pro).trim();
  if (trimmed === '') return '';
  return trimmed.replace(/^0+/, '') || '0';
}

export function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * Pull per-item objects out of a `resultData` payload, tolerating the flat
 * `{ items }` shape and the 6-bucket array shape. Throws on an unrecognized
 * shape (fail-loud, matching searchSong.ts's `onUnknownShape: 'throw'`).
 */
export function collectTjItems(data) {
  if (data === null || data === undefined) return [];
  if (isPlainObject(data) && Array.isArray(data.items)) {
    return data.items.filter(isPlainObject);
  }
  if (Array.isArray(data)) {
    const merged = [];
    for (const bucket of data) {
      if (!isPlainObject(bucket)) continue;
      for (const key of Object.keys(bucket)) {
        if (!key.startsWith('items')) continue;
        if (key.endsWith('TotalCount')) continue;
        const value = bucket[key];
        if (Array.isArray(value)) {
          for (const item of value) {
            if (isPlainObject(item)) merged.push(item);
          }
        }
      }
    }
    return merged;
  }
  if (typeof data === 'string') return [];
  throw new Error('[probe] resultData has unexpected shape');
}

/** Map one raw TJ item to the retained catalog subset, or null if unusable. */
export function mapItem(raw) {
  if (!isPlainObject(raw)) return null;
  const pro = coerceProString(raw.pro);
  // indexTitle is edge-trimmed on capture (interior preserved); indexSong stays
  // verbatim.
  const indexTitle = trimTitleEdges(coerceNonEmptyString(raw.indexTitle));
  const indexSong = coerceNonEmptyString(raw.indexSong);
  if (pro === null || indexTitle === null || indexSong === null) return null;
  return {
    pro,
    indexTitle,
    subTitle: coerceNonEmptyString(raw.subTitle),
    indexSong,
    sortTitleKo: coerceNonEmptyString(raw.sortTitleKo),
    sortSongKo: coerceNonEmptyString(raw.sortSongKo),
    nationalcode: coerceNonEmptyString(raw.nationalcode),
    publishdate: coerceNonEmptyString(raw.publishdate),
  };
}

/** Parse a `/legacy/api/searchSong` envelope into a flat item list. */
export function parseSearchSongResponse(json) {
  if (!isPlainObject(json)) {
    throw new Error('[probe] response is not a JSON object');
  }
  const code = json.resultCode;
  if (code === '98') return [];
  if (code !== '99') {
    const msg = typeof json.resultMsg === 'string' ? json.resultMsg : '<no message>';
    throw new Error(`[probe] resultCode=${String(code)} (${msg})`);
  }
  const items = collectTjItems(json.resultData);
  const out = [];
  for (const raw of items) {
    const item = mapItem(raw);
    if (item !== null) out.push(item);
  }
  return out;
}

/** Exact-`pro` match (leading-zero-normalized) against a code, or null. */
export function selectExactPro(items, code) {
  const norm = normalizeProQuery(code);
  return items.find((it) => normalizeProQuery(it.pro) === norm) ?? null;
}

/** Reduce a mapped item to the canonical catalog record (stable field order). */
export function toCatalogEntry(item) {
  const out = {};
  for (const f of CATALOG_FIELDS) out[f] = item[f] ?? null;
  return out;
}

/** True when two catalog entries carry identical CONTENT (ignoring `checkedAt`). */
export function catalogContentEqual(a, b) {
  if (!a || !b) return false;
  for (const f of CATALOG_CONTENT_FIELDS) {
    if ((a[f] ?? null) !== (b[f] ?? null)) return false;
  }
  return true;
}

/**
 * Decide a freshly-probed entry's `checkedAt`. Preserves the prior row's
 * timestamp when the re-probe returned byte-identical content (so re-probing an
 * unchanged catalog is byte-idempotent); stamps `now()` for a genuinely new code
 * or a content change. A prior row missing `checkedAt` (pre-field catalog) is
 * treated as changed so it gets a real timestamp.
 */
export function resolveCheckedAt(prior, fresh, nowIso = isoUtcNow) {
  if (prior?.checkedAt && catalogContentEqual(prior, fresh)) {
    return prior.checkedAt;
  }
  return nowIso();
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export function defaultSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Politeness gap before each request, TJ-host parity. */
export function politenessDelayMs(rng = Math.random) {
  return Math.max(0, MIN_INTERVAL_MS + (rng() - 0.5) * JITTER_MS);
}

/**
 * Single POST for one code. Returns the parsed item list. Throws with a
 * `.retryable` flag set (true for transient network/429/5xx, false for
 * deterministic failures) so the retry wrapper can decide.
 */
export async function probeOnce(code, { fetchFn = fetch } = {}) {
  const body = new URLSearchParams({
    searchTxt: String(code),
    strType: '16',
    nationType: '',
  }).toString();

  let res;
  try {
    res = await fetchFn(SEARCH_SONG_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
      body,
    });
  } catch (err) {
    const e = new Error(`[probe] network error for ${code}: ${err.message}`);
    e.retryable = true;
    throw e;
  }

  if (res.status < 200 || res.status >= 300) {
    const e = new Error(`[probe] HTTP ${res.status} for ${code}`);
    e.retryable = isRetryableStatus(res.status);
    throw e;
  }

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    const e = new Error(`[probe] invalid JSON for ${code}`);
    e.retryable = false;
    throw e;
  }
  // Envelope/resultCode/shape errors bubble up with no `.retryable` (→ false).
  return parseSearchSongResponse(json);
}

/** Run `fn` with up to `maxRetries` LINEAR-backoff retries on `.retryable` errors. */
export async function withRetry(
  fn,
  { maxRetries = MAX_RETRIES, baseDelayMs = RETRY_BASE_DELAY_MS, sleep = defaultSleep } = {},
) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries && err && err.retryable === true) {
        await sleep(baseDelayMs * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Catalog I/O
// ---------------------------------------------------------------------------

export function readCatalog(path) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf-8');
  const entries = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t === '') continue;
    entries.push(JSON.parse(t));
  }
  return entries;
}

/** Deterministic JSONL: canonical fields, sorted by numeric `pro`. */
export function serializeCatalog(entries) {
  const sorted = [...entries].sort((a, b) => Number(a.pro) - Number(b.pro));
  return `${sorted.map((e) => JSON.stringify(toCatalogEntry(e))).join('\n')}\n`;
}

export function writeCatalog(path, entries) {
  writeTextAtomic(path, serializeCatalog(entries));
}

// ---------------------------------------------------------------------------
// Range / seed expansion
// ---------------------------------------------------------------------------

export function parseRange(spec) {
  const m = /^(\d+)\.\.(\d+)$/.exec(String(spec).trim());
  if (!m) throw new Error(`--range must be A..B (integers), got: ${spec}`);
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (start > end) throw new Error(`--range start ${start} > end ${end}`);
  const codes = [];
  for (let n = start; n <= end; n += 1) codes.push(String(n));
  return codes;
}

export function loadSeedCodes(path) {
  const arr = JSON.parse(readFileSync(path, 'utf-8'));
  if (!Array.isArray(arr)) throw new Error(`seed list is not a JSON array: ${path}`);
  return arr.map(String);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Probe a set of codes and refresh the catalog. Pure-ish: all I/O boundaries
 * (fetch, sleep) are injectable for tests. Returns a stats object.
 *
 * @param {object} opts
 * @param {'seed'|'range'} opts.mode
 * @param {string[]} opts.codes            codes to consider probing
 * @param {string} opts.catalogPath
 * @param {boolean} [opts.fresh]
 * @param {number} [opts.limit]
 * @param {typeof fetch} [opts.fetchFn]
 * @param {(ms:number)=>Promise<void>} [opts.sleep]
 * @param {()=>number} [opts.rng]
 * @param {()=>string} [opts.nowIso]  injectable clock for `checkedAt` (tests)
 * @param {Console} [opts.log]
 */
export async function runProbe({
  mode,
  codes,
  catalogPath,
  fresh = false,
  limit = Number.POSITIVE_INFINITY,
  fetchFn = fetch,
  sleep = defaultSleep,
  rng = Math.random,
  nowIso = isoUtcNow,
  log = console,
}) {
  // On `--fresh` we re-probe every code but still read the existing catalog so
  // an unchanged row keeps its `checkedAt` (byte-idempotent re-probe); the
  // scope/skip decision below uses `fresh` independently.
  const existing = readCatalog(catalogPath);
  const priorByPro = new Map(existing.map((e) => [normalizeProQuery(e.pro), e]));
  // Preserve every pre-existing entry (resume + out-of-scope discovery hits).
  const byPro = fresh ? new Map() : new Map(priorByPro);

  const scope = fresh ? codes : codes.filter((c) => !byPro.has(normalizeProQuery(c)));
  const toProbe = Number.isFinite(limit) ? scope.slice(0, limit) : scope;

  const stats = {
    mode,
    considered: codes.length,
    skippedExisting: codes.length - scope.length,
    toProbe: toProbe.length,
    found: 0,
    misses: [],
    hits: [],
    nonJpn: [],
  };

  let i = 0;
  for (const code of toProbe) {
    i += 1;
    await sleep(politenessDelayMs(rng));
    let items;
    try {
      items = await withRetry(() => probeOnce(code, { fetchFn }), { sleep });
    } catch (err) {
      // A hard failure after retries. In seed mode this is a miss we must
      // surface; in range mode it is skipped but logged.
      log.error(`  ! ${code}: ${err.message}`);
      stats.misses.push(code);
      continue;
    }
    const hit = selectExactPro(items, code);
    if (hit === null) {
      if (mode === 'seed') stats.misses.push(code);
      continue;
    }
    const norm = normalizeProQuery(hit.pro);
    const entry = toCatalogEntry(hit);
    // Preserve `checkedAt` when the re-probe returned identical content; stamp a
    // fresh one for a new code or a content change.
    entry.checkedAt = resolveCheckedAt(priorByPro.get(norm), entry, nowIso);
    byPro.set(norm, entry);
    stats.found += 1;
    stats.hits.push(entry);
    if (entry.nationalcode !== 'JPN')
      stats.nonJpn.push({ pro: entry.pro, nationalcode: entry.nationalcode });
    if (i % 50 === 0 || i === toProbe.length) {
      log.error(`  … probed ${i}/${toProbe.length} (found ${stats.found})`);
    }
  }

  writeCatalog(catalogPath, [...byPro.values()]);
  stats.catalogSize = byPro.size;
  return stats;
}

export function parseArgs(argv) {
  const parsed = {
    seedPath: DEFAULT_SEED_PATH,
    catalogPath: DEFAULT_CATALOG_PATH,
    range: null,
    fresh: false,
    limit: Number.POSITIVE_INFINITY,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--seed') {
      const v = argv[i + 1];
      if (!v) throw new Error('--seed requires a path');
      parsed.seedPath = resolve(v);
      i += 1;
    } else if (arg === '--catalog') {
      const v = argv[i + 1];
      if (!v) throw new Error('--catalog requires a path');
      parsed.catalogPath = resolve(v);
      i += 1;
    } else if (arg === '--range') {
      const v = argv[i + 1];
      if (!v) throw new Error('--range requires an A..B value');
      parsed.range = v;
      i += 1;
    } else if (arg === '--fresh') {
      parsed.fresh = true;
    } else if (arg === '--limit') {
      const v = argv[i + 1];
      if (!v) throw new Error('--limit requires a number');
      parsed.limit = Number(v);
      if (!Number.isInteger(parsed.limit) || parsed.limit < 0) {
        throw new Error(`--limit must be a non-negative integer, got: ${v}`);
      }
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }

  const mode = args.range === null ? 'seed' : 'range';
  const codes = mode === 'seed' ? loadSeedCodes(args.seedPath) : parseRange(args.range);
  console.error(
    `probe-tjpdf-catalog: mode=${mode} codes=${codes.length} catalog=${args.catalogPath} fresh=${args.fresh}${Number.isFinite(args.limit) ? ` limit=${args.limit}` : ''}`,
  );

  const stats = await runProbe({
    mode,
    codes,
    catalogPath: args.catalogPath,
    fresh: args.fresh,
    limit: args.limit,
  });

  console.error(
    `\n=== probe summary ===\n  mode:             ${stats.mode}\n  considered:       ${stats.considered}\n  skipped existing: ${stats.skippedExisting}\n  probed:           ${stats.toProbe}\n  found (exact):    ${stats.found}\n  misses:           ${stats.misses.length}\n  non-JPN hits:     ${stats.nonJpn.length}\n  catalog size:     ${stats.catalogSize}`,
  );
  if (stats.nonJpn.length > 0) {
    console.error(`  non-JPN: ${stats.nonJpn.map((x) => `${x.pro}=${x.nationalcode}`).join(', ')}`);
  }
  if (stats.misses.length > 0) {
    console.error(`  MISSED codes: ${stats.misses.join(', ')}`);
    // Seed misses drop downstream coverage — fail loud. Range misses are normal.
    if (stats.mode === 'seed') process.exitCode = 1;
  }
}

if (isCliInvocation(import.meta.url)) {
  main().catch((err) => {
    console.error(`probe-tjpdf-catalog failed: ${err.message}`);
    process.exitCode = 1;
  });
}
