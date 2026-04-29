import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Persistent cache file for TJ `searchSong` enrichment.
 *
 * Path: `apps/web/public/data/tj-search-cache.json` (tracked in git, not
 * gitignored — CI must NOT pay the first-run enrichment cost).
 *
 * Schema (PR-1 — translit-only):
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
 *     }
 *   }
 *
 * PR-2 (filter rewrite) will add an `artistNationalityMap` sibling field. To
 * stay forward-compatible the loader tolerates an existing
 * `artistNationalityMap` and the saver passes the field through unchanged.
 *
 * The `nationalcode` field is captured into each `proEnrichmentMap` entry
 * **for PR-2's filter rewrite** (which will read it to drive the artist-
 * nationality denylist replacing today's loose-JP regex + Chinese-artist
 * denylist). PR-1 itself does NOT act on `nationalcode` — it is stored but
 * unused. Future maintainers wondering why the field is plumbed through
 * without a consumer should look at PR-2 (filter rewrite) where the value
 * becomes load-bearing.
 *
 * Atomic writes: write to `<file>.tmp`, then rename. Mirrors the
 * `scripts/ingest-anisong-pdf.py` pattern.
 *
 * 90-day staleness: entries with `lastSeen` older than 90 days are treated
 * as missing by `isFresh()` so they get re-fetched. Catalog-mutation rate is
 * low; a hard re-verify every 90 days catches metadata drift without
 * ballooning costs.
 */

/** Version of the cache file schema. Bump when adding required fields. */
export const CACHE_VERSION = 1;

/** Cache TTL (ms) — entries older than this are re-fetched. */
export const CACHE_STALENESS_MS = 90 * 24 * 60 * 60 * 1000;

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

/**
 * In-memory representation of the cache file. The `extras` bag preserves
 * any fields PR-2 (or later) might add to the file without dropping them
 * on the floor when PR-1 code rewrites the file.
 */
export interface SearchSongCache {
  version: number;
  generatedAt: string;
  proEnrichmentMap: Record<string, EnrichmentEntry>;
  /** Forward-compat: `artistNationalityMap` and any other PR-2+ fields. */
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
    extras: {},
  };
}

/**
 * Load the cache from disk. Returns an empty cache on any failure (missing
 * file, JSON parse error, wrong shape) — translit enrichment must degrade
 * gracefully rather than abort the crawl.
 *
 * Logs a single `console.warn` on malformed-file recovery so the failure
 * is visible in CI logs.
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

  // Tolerate version drift: PR-2 may bump the version. We still load PR-1's
  // proEnrichmentMap subset.
  const versionRaw = parsed.version;
  const version = typeof versionRaw === 'number' ? versionRaw : CACHE_VERSION;

  const generatedAtRaw = parsed.generatedAt;
  const generatedAt =
    typeof generatedAtRaw === 'string' ? generatedAtRaw : new Date(0).toISOString();

  const proEnrichmentMap: Record<string, EnrichmentEntry> = {};
  const rawMap = parsed.proEnrichmentMap;
  if (isPlainObject(rawMap)) {
    for (const [pro, value] of Object.entries(rawMap)) {
      const entry = coerceEntry(value);
      if (entry !== null) proEnrichmentMap[pro] = entry;
    }
  }

  // Stash any fields we don't recognize so a save() round-trip preserves
  // them. `version`/`generatedAt`/`proEnrichmentMap` are owned by PR-1; all
  // other top-level keys (e.g., PR-2's `artistNationalityMap`) are forwarded.
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key === 'version' || key === 'generatedAt' || key === 'proEnrichmentMap') continue;
    extras[key] = value;
  }

  return { version, generatedAt, proEnrichmentMap, extras };
}

/**
 * Atomically save the cache to disk. Writes to `<path>.tmp` then renames,
 * preventing partial-write corruption on crash mid-write.
 *
 * The `extras` bag is spread BEFORE the PR-1 fields so that an unexpected
 * PR-2 field collision cannot overwrite PR-1's fields. (E.g. if PR-2 ever
 * adds a key called `proEnrichmentMap` for a separate purpose, PR-1 wins.)
 */
export async function saveCache(path: string, cache: SearchSongCache): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const out = {
    ...cache.extras,
    version: cache.version,
    generatedAt: cache.generatedAt,
    proEnrichmentMap: cache.proEnrichmentMap,
  };
  const text = `${JSON.stringify(out, null, 2)}\n`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, path);
}

/**
 * Is the cached entry for `pro` fresh enough to use?
 *
 *   - missing: false
 *   - lastSeen unparseable: false
 *   - lastSeen older than 90 days: false
 *   - else: true
 */
export function isFresh(cache: SearchSongCache, pro: string, now: Date = new Date()): boolean {
  const entry = cache.proEnrichmentMap[pro];
  if (!entry) return false;
  const seen = Date.parse(entry.lastSeen);
  if (!Number.isFinite(seen)) return false;
  return now.getTime() - seen < CACHE_STALENESS_MS;
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

function nullableString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v === '' ? null : v;
  return null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
