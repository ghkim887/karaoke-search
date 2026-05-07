import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isPlainObject } from './normalize.js';

/**
 * Persistent cache file for TJ `searchSong` enrichment.
 *
 * Path: `apps/web/public/data/tj-search-cache.json` (tracked in git, not
 * gitignored — CI must NOT pay the first-run enrichment cost).
 *
 * Schema (PR-2 — translit + nationality filter):
 *   {
 *     "version": 1,
 *     "generatedAt": "<ISO-8601>",
 *     "proEnrichmentMap": {
 *       "<pro>": {
 *         "nationalcode": "JPN" | "KOR" | "ENG" | null,
 *         "sortTitleKo": "...",
 *         "sortSongKo": "...",
 *         "subTitle": "...",
 *         "publishdate": "YYYY-MM-DD",
 *         "lastSeen": "<ISO-8601>"
 *       }
 *     },
 *     "artistNationalityMap": {
 *       "<normalize(artist)>": {
 *         "code": "JPN" | "KOR" | "ENG" | "AMBIGUOUS" | "UNKNOWN",
 *         "votes": { "JPN": <int>, "KOR": <int>, "ENG": <int> },
 *         "lastSeen": "<ISO-8601>"
 *       }
 *     }
 *   }
 *
 * The `artistNationalityMap` was added in PR-2 (the searchSong-backed filter
 * replacing the loose-JP regex + Chinese denylist). Keys are produced by
 * `normalizeForMatch` from `./normalize.ts` so matching is consistent across
 * the per-artist scanner, the parser's filter, and any future consumer.
 *
 * Atomic writes: write to `<file>.tmp`, then rename. Mirrors the
 * `scripts/ingest_anisong_pdf.py` pattern.
 *
 * 90-day staleness: entries with `lastSeen` older than 90 days are treated
 * as missing by the freshness helpers so they get re-fetched. Catalog-mutation
 * rate is low; a hard re-verify every 90 days catches metadata drift without
 * ballooning costs.
 */

/**
 * Version of the cache file schema. Bumped when adding required fields.
 *
 * Note: the loader is structurally tolerant of older versions — it reads any
 * fields it recognizes and forwards unrecognized top-level keys via `extras`.
 * The `version` field is informational, used to identify cache provenance in
 * logs and to signal schema-shape expectations to future maintainers; it is
 * NOT compared at load time. Bumps therefore never reject a cache; they just
 * record that this code wrote it.
 *
 * Version history:
 *   - v1: PR-1 shape (proEnrichmentMap only).
 *   - v2: PR-2 adds `artistNationalityMap` and `bootstrappedAt`.
 */
export const CACHE_VERSION = 2;

/** Cache TTL (ms) — entries older than this are re-fetched. */
export const CACHE_STALENESS_MS = 90 * 24 * 60 * 60 * 1000;

/** Bootstrap (Option-C topAndHot100 sweep) refresh cadence: 7 days. */
export const BOOTSTRAP_STALENESS_MS = 7 * 24 * 60 * 60 * 1000;

/** Single per-`pro` cache entry. */
export interface EnrichmentEntry {
  nationalcode: string | null;
  sortTitleKo: string | null;
  sortSongKo: string | null;
  subTitle: string | null;
  publishdate: string | null;
  /** ISO-8601 when this entry was last refreshed. */
  lastSeen: string;
}

/** Classification verdict for an artist. */
export type ArtistNationalityCode = 'JPN' | 'KOR' | 'ENG' | 'AMBIGUOUS' | 'UNKNOWN';

/** Per-artist nationality vote tally + verdict. */
export interface ArtistNationalityEntry {
  code: ArtistNationalityCode;
  /** Vote counts collected from exact-match `searchSong` results. */
  votes: { JPN: number; KOR: number; ENG: number };
  /** ISO-8601 when this entry was last refreshed. */
  lastSeen: string;
}

/**
 * In-memory representation of the cache file. The `extras` bag preserves
 * any fields a future PR might add to the file without dropping them on the
 * floor when current code rewrites the file.
 *
 * `generatedAt` reflects the most recent write to the file (translit fetches
 * + artist scans both bump it). `bootstrappedAt` is independent: it tracks
 * specifically when the Option-C topAndHot100 sweep last successfully ran,
 * so a translit-only refresh cannot mask a stale chart bootstrap. Optional
 * because PR-1-shape caches do not carry it.
 */
export interface SearchSongCache {
  version: number;
  generatedAt: string;
  /**
   * ISO-8601 of the last successful Option-C bootstrap sweep. Independent of
   * `generatedAt` so other enrichment passes (translit, artist scan) don't
   * make a stale bootstrap appear fresh. Missing on PR-1-shape caches; the
   * freshness helper treats missing as stale.
   */
  bootstrappedAt?: string;
  proEnrichmentMap: Record<string, EnrichmentEntry>;
  artistNationalityMap: Record<string, ArtistNationalityEntry>;
  /** Forward-compat: any future top-level fields not owned by current code. */
  extras: Record<string, unknown>;
}

/**
 * Build an empty cache shell. Used as the cold-start state and as the
 * fallback when the on-disk file is missing or malformed.
 */
export function emptyCache(now: Date = new Date()): SearchSongCache {
  return {
    version: CACHE_VERSION,
    generatedAt: now.toISOString(),
    proEnrichmentMap: {},
    artistNationalityMap: {},
    extras: {},
  };
}

/**
 * Load the cache from disk. Returns an empty cache on any failure (missing
 * file, JSON parse error, wrong shape) — enrichment must degrade gracefully
 * rather than abort the crawl.
 *
 * Logs a single `console.warn` on malformed-file recovery so the failure is
 * visible in CI logs.
 */
export async function loadCache(path: string): Promise<SearchSongCache> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    // Missing file is an expected cold-start state; do not warn.
    return emptyCache();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[tj-search] cache file at ${path} is not valid JSON; starting fresh: ${msg}`);
    return emptyCache();
  }

  if (!isPlainObject(parsed)) {
    console.warn(`[tj-search] cache file at ${path} is not a JSON object; starting fresh`);
    return emptyCache();
  }

  // Tolerate version drift: an older or newer file is still loadable; we read
  // the fields we recognize and pass everything else through `extras`.
  const versionRaw = parsed.version;
  const version = typeof versionRaw === 'number' ? versionRaw : CACHE_VERSION;

  const generatedAtRaw = parsed.generatedAt;
  const generatedAt =
    typeof generatedAtRaw === 'string' ? generatedAtRaw : new Date(0).toISOString();

  // PR-1-shape caches don't carry `bootstrappedAt`; leave it undefined so the
  // freshness helper treats them as "bootstrap never ran" and re-runs once.
  const bootstrappedAtRaw = parsed.bootstrappedAt;
  const bootstrappedAt = typeof bootstrappedAtRaw === 'string' ? bootstrappedAtRaw : undefined;

  const proEnrichmentMap: Record<string, EnrichmentEntry> = {};
  const rawProMap = parsed.proEnrichmentMap;
  if (isPlainObject(rawProMap)) {
    for (const [pro, value] of Object.entries(rawProMap)) {
      const entry = coerceEntry(value);
      if (entry !== null) proEnrichmentMap[pro] = entry;
    }
  }

  const artistNationalityMap: Record<string, ArtistNationalityEntry> = {};
  const rawArtistMap = parsed.artistNationalityMap;
  if (isPlainObject(rawArtistMap)) {
    for (const [key, value] of Object.entries(rawArtistMap)) {
      const entry = coerceArtistEntry(value);
      if (entry !== null) artistNationalityMap[key] = entry;
    }
  }

  // Stash any fields we don't recognize so a save() round-trip preserves them.
  // `version` / `generatedAt` / `bootstrappedAt` / `proEnrichmentMap` /
  // `artistNationalityMap` are owned by current code; all other top-level keys
  // are forwarded.
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (
      key === 'version' ||
      key === 'generatedAt' ||
      key === 'bootstrappedAt' ||
      key === 'proEnrichmentMap' ||
      key === 'artistNationalityMap'
    ) {
      continue;
    }
    extras[key] = value;
  }

  // Only include `bootstrappedAt` when it was present in the on-disk file —
  // PR-1-shape caches must round-trip without growing the field. The
  // `exactOptionalPropertyTypes` tsconfig flag treats `prop?: string` as
  // distinct from `prop: string | undefined`, so we conditionally spread.
  const result: SearchSongCache = {
    version,
    generatedAt,
    proEnrichmentMap,
    artistNationalityMap,
    extras,
  };
  if (bootstrappedAt !== undefined) {
    result.bootstrappedAt = bootstrappedAt;
  }
  return result;
}

/**
 * Atomically save the cache to disk. Writes to `<path>.tmp` then renames,
 * preventing partial-write corruption on crash mid-write.
 *
 * The `extras` bag is spread BEFORE the owned fields so an unexpected key
 * collision in `extras` cannot overwrite a real owned field.
 */
export async function saveCache(path: string, cache: SearchSongCache): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  // Build the on-disk shape. Drop `bootstrappedAt` from the output when it's
  // undefined so PR-1-shape caches don't suddenly grow a `null` field.
  const out: Record<string, unknown> = {
    ...cache.extras,
    version: cache.version,
    generatedAt: cache.generatedAt,
    proEnrichmentMap: cache.proEnrichmentMap,
    artistNationalityMap: cache.artistNationalityMap,
  };
  if (cache.bootstrappedAt !== undefined) {
    out.bootstrappedAt = cache.bootstrappedAt;
  }
  const text = `${JSON.stringify(out, null, 2)}\n`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, path);
}

/**
 * Is the cached `proEnrichmentMap` entry for `pro` fresh enough to use?
 *
 *   - missing: false
 *   - lastSeen unparseable: false
 *   - lastSeen older than 90 days: false
 *   - else: true
 */
export function isFresh(cache: SearchSongCache, pro: string, now: Date = new Date()): boolean {
  const entry = cache.proEnrichmentMap[pro];
  if (!entry) return false;
  return isLastSeenFresh(entry.lastSeen, CACHE_STALENESS_MS, now);
}

/**
 * Is the cached `artistNationalityMap` entry for `key` (already-normalized)
 * fresh enough to use? Same 90-day TTL as the per-pro map.
 */
export function isArtistNationalityFresh(
  cache: SearchSongCache,
  key: string,
  now: Date = new Date(),
): boolean {
  const entry = cache.artistNationalityMap[key];
  if (!entry) return false;
  return isLastSeenFresh(entry.lastSeen, CACHE_STALENESS_MS, now);
}

/**
 * Is the artist-nationality map's bootstrap (Option-C charts sweep) fresh?
 *
 * Keyed off `bootstrappedAt` — set ONLY when an Option-C sweep actually
 * succeeds — so that other enrichment passes (per-record translit,
 * per-artist scan) cannot mask a stale bootstrap by bumping `generatedAt`.
 *
 *   - missing `bootstrappedAt`: stale (PR-1-shape cache, or sweep never ran).
 *   - unparseable `bootstrappedAt`: stale.
 *   - older than 7 days (`ttlMs` override): stale.
 *   - else: fresh.
 *
 * 7-day cadence — bootstrap is cheap enough (~2 min) that we can re-run
 * weekly to catch new chart entries; cheap-but-not-free, so we skip if
 * fresher than that. The `ttlMs` override is for tests.
 */
export function isBootstrapFresh(
  cache: SearchSongCache,
  now: Date = new Date(),
  ttlMs: number = BOOTSTRAP_STALENESS_MS,
): boolean {
  if (cache.bootstrappedAt === undefined) return false;
  return isLastSeenFresh(cache.bootstrappedAt, ttlMs, now);
}

function isLastSeenFresh(lastSeen: string, ttlMs: number, now: Date): boolean {
  const seen = Date.parse(lastSeen);
  if (!Number.isFinite(seen)) return false;
  return now.getTime() - seen < ttlMs;
}

function coerceEntry(value: unknown): EnrichmentEntry | null {
  if (!isPlainObject(value)) return null;
  const lastSeen = value.lastSeen;
  if (typeof lastSeen !== 'string') return null;
  return {
    nationalcode: nullableString(value.nationalcode),
    sortTitleKo: nullableString(value.sortTitleKo),
    sortSongKo: nullableString(value.sortSongKo),
    subTitle: nullableString(value.subTitle),
    publishdate: nullableString(value.publishdate),
    lastSeen,
  };
}

function coerceArtistEntry(value: unknown): ArtistNationalityEntry | null {
  if (!isPlainObject(value)) return null;
  const lastSeen = value.lastSeen;
  if (typeof lastSeen !== 'string') return null;
  const code = coerceArtistCode(value.code);
  if (code === null) return null;
  const votes = coerceVotes(value.votes);
  return { code, votes, lastSeen };
}

function coerceArtistCode(v: unknown): ArtistNationalityCode | null {
  if (v === 'JPN' || v === 'KOR' || v === 'ENG' || v === 'AMBIGUOUS' || v === 'UNKNOWN') return v;
  return null;
}

function coerceVotes(v: unknown): { JPN: number; KOR: number; ENG: number } {
  if (!isPlainObject(v)) return { JPN: 0, KOR: 0, ENG: 0 };
  return {
    JPN: coerceVoteCount(v.JPN),
    KOR: coerceVoteCount(v.KOR),
    ENG: coerceVoteCount(v.ENG),
  };
}

function coerceVoteCount(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.floor(v);
  return 0;
}

function nullableString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v === '' ? null : v;
  return null;
}
