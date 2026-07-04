import type { SongRecord } from '@karaoke/schema';
import {
  type KaraokeProvider,
  compactSearchText,
  expandSearchQuery,
  kanaToHangul,
  kanaToRomaji,
} from '@karaoke/search';
import MiniSearch, { type SearchResult } from 'minisearch';
import { type OfflineRecallIndex, buildOfflineRecallIndex } from './offline-recall.js';
import { fetchWithRetry, fetchWithTransientRetry } from './retry.js';

/**
 * Fields indexed by MiniSearch. Keep in sync with the boost map below.
 *
 * Spec 2026-05-04: `artist_aliases` is included so typing `"ZUTOMAYO"` or
 * `"40meterP"` finds the canonical record after the alias-resolution stage.
 * MiniSearch's default field accessor joins array values with whitespace, so
 * an `artist_aliases: ["ZUTOMAYO"]` record is searchable on `"ZUTOMAYO"`.
 */
const SEARCH_FIELDS = [
  'title_primary',
  'title_ko',
  'artist_primary',
  'artist_aliases',
  'artist_ko',
  // Reading-search enrichment (R4): the katakana ruby plus its deterministic
  // romaji + hangul transliterations, so the offline path gains the same
  // reading recall as the worker on the ruby-carrying subset. These are DERIVED
  // fields (not properties on SongRecord) computed by `extractRubyField` below.
  'title_ruby',
  'title_ruby_romaji',
  'title_ruby_hangul',
] as const;

/**
 * Per-field boosts. Title fields outrank artist fields.
 * Spec: docs/superpowers/specs/2026-04-26-karaoke-search-design.md plus the
 * 2026-05-04 alias-dedup spec for `artist_aliases` (boost equal to
 * `artist_primary`).
 */
const SEARCH_BOOSTS = {
  title_primary: 3,
  title_ko: 3,
  artist_primary: 2,
  artist_aliases: 2,
  artist_ko: 2,
  // Reading fields are secondary renderings, boosted below the primary title
  // (3) to mirror the server weight decision (ruby weight 3 < title weight 5):
  // reading matches add recall without displacing a real-title match.
  title_ruby: 2,
  title_ruby_romaji: 2,
  title_ruby_hangul: 2,
} as const;

/**
 * Compute a derived reading field for MiniSearch. `title_ruby` is the raw
 * katakana reading (may be absent/null); the romaji and hangul fields are its
 * deterministic transliterations via the SAME `@karaoke/search` functions the
 * server index uses (single source of truth). Returns `''` when there is no
 * ruby, which MiniSearch indexes as empty (no tokens).
 */
function extractRubyField(record: SongRecord, fieldName: string): string {
  const ruby = record.title_ruby ?? '';
  if (ruby.length === 0) {
    return '';
  }
  if (fieldName === 'title_ruby_romaji') {
    return kanaToRomaji(ruby);
  }
  if (fieldName === 'title_ruby_hangul') {
    return kanaToHangul(ruby);
  }
  return ruby;
}

const RUBY_FIELDS: ReadonlySet<string> = new Set([
  'title_ruby',
  'title_ruby_romaji',
  'title_ruby_hangul',
]);

/**
 * MiniSearch's own default field accessor, reused verbatim for every
 * non-reading field so their extraction (including the `artist_aliases` array
 * handling the existing config relies on) is byte-for-byte unchanged; only the
 * derived reading fields take the custom path.
 */
const defaultExtractField = MiniSearch.getDefault('extractField') as (
  document: SongRecord,
  fieldName: string,
) => string;

/** Return type of `loadIndex`. Bundles the search index with an id→record map. */
export interface IndexBundle {
  index: MiniSearch<SongRecord>;
  byId: Map<string, SongRecord>;
}

/**
 * Side-index of the number + Hangul-initials recall data, keyed by the
 * MiniSearch instance `buildIndex` returns. A `WeakMap` keeps `searchLocalIndex`
 * signature-compatible for every existing caller (and the parity gate) while
 * letting it reach the auxiliary structures the text index cannot cover, and it
 * is collected automatically once the index is dropped. See {@link
 * OfflineRecallIndex}.
 */
const recallByIndex = new WeakMap<MiniSearch<SongRecord>, OfflineRecallIndex>();

/**
 * Build a MiniSearch index from `records`. Field values that are `null` are
 * tolerated by MiniSearch and skipped during indexing.
 *
 * A companion {@link OfflineRecallIndex} (karaoke-number + Hangul-initials
 * recall) is built from the same records and associated with the returned index
 * so `searchLocalIndex` can serve those query shapes offline (T6-1).
 */
export function buildIndex(records: SongRecord[]): MiniSearch<SongRecord> {
  const index = new MiniSearch<SongRecord>({
    idField: 'id',
    fields: [...SEARCH_FIELDS],
    storeFields: ['id'],
    extractField: (document, fieldName) =>
      RUBY_FIELDS.has(fieldName)
        ? extractRubyField(document, fieldName)
        : defaultExtractField(document, fieldName),
    processTerm: (term, _fieldName) => compactSearchText(term),
    searchOptions: {
      boost: { ...SEARCH_BOOSTS },
      // spec asks for fuzzy distance 1; MiniSearch fuzzy is a ratio of term length, so 0.2 ≈ 1 edit per 5 chars.
      fuzzy: 0.2,
      prefix: true,
      processTerm: (term) => compactSearchText(term),
    },
  });
  index.addAll(records);
  recallByIndex.set(index, buildOfflineRecallIndex(records));
  return index;
}

/** Options for {@link searchLocalIndex}. */
export interface LocalSearchOptions {
  /** Restricts karaoke-number matches to these providers (vendor-chip scoping,
   *  mirroring the worker's `kn.provider IN (...)` filter). Ignored by the text
   *  and initials paths. Omit to match numbers on any provider. */
  vendors?: ReadonlySet<KaraokeProvider>;
}

/** Wrap ranked record ids as MiniSearch-shaped results. Only `id` is consumed
 *  downstream; the remaining fields satisfy the `SearchResult` contract. The
 *  ids are already in rank order, so the descending `score` is informational. */
function toSearchResults(ids: readonly string[]): SearchResult[] {
  return ids.map((id, rank) => ({
    id,
    score: ids.length - rank,
    terms: [],
    queryTerms: [],
    match: {},
  }));
}

/**
 * Query a local MiniSearch index with safe romaji↔kana expansion so the offline
 * fallback can match kana title/artist/alias text from a romaji query (and vice
 * versa), mirroring the worker `/api/search` behaviour.
 *
 * Two query shapes the text index cannot cover are served from the companion
 * {@link OfflineRecallIndex} BEFORE the text path (T6-1): karaoke-number queries
 * and all-choseong Hangul-initials queries. Both mirror the worker's number /
 * initial semantics. Every OTHER query is unaffected — it flows through the
 * unchanged text path below, so existing text results are byte-for-byte stable.
 *
 * The original query is searched first and its hits keep their MiniSearch rank;
 * variant ("expansion-only") hits are appended after, so original-query hits are
 * preferred. Hits are merged and deduplicated by id. When a query does not
 * expand (kanji, Hangul, etc.) this is exactly `index.search(query)`.
 *
 * Expansion is SEARCH RECALL ONLY — it never affects indexing or canonical data.
 */
export function searchLocalIndex(
  index: MiniSearch<SongRecord>,
  query: string,
  options?: LocalSearchOptions,
): SearchResult[] {
  const recall = recallByIndex.get(index);
  if (recall !== undefined) {
    const numberIds = recall.matchNumberQuery(query, options?.vendors);
    if (numberIds !== null) {
      return toSearchResults(numberIds);
    }
    const initialIds = recall.matchInitialsQuery(query);
    if (initialIds !== null) {
      return toSearchResults(initialIds);
    }
  }

  const variants = expandSearchQuery(query);
  if (variants.length <= 1) {
    return index.search(query);
  }

  const seen = new Set<string>();
  const merged: SearchResult[] = [];
  for (const variant of variants) {
    for (const hit of index.search(variant)) {
      const id = String(hit.id);
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      merged.push(hit);
    }
  }
  return merged;
}

/**
 * Fetch the prebuilt `songs.json` from the static `/data/` path, build a
 * MiniSearch index, and return both the index and an id→record map so callers
 * need only one network request.
 */
export async function loadIndex(): Promise<IndexBundle> {
  const url = `${import.meta.env.BASE_URL}data/songs.json`;
  const res = await fetchWithRetry(url);
  // fetchWithRetry guarantees an `ok` response or throws; parsing failures
  // (200 OK with malformed JSON) are deterministic and propagate as-is.
  const records = (await res.json()) as SongRecord[];
  const index = buildIndex(records);
  const byId = new Map<string, SongRecord>();
  for (const r of records) byId.set(r.id, r);
  return { index, byId };
}

export type SearchVendor = 'tj' | 'ky' | 'joysound';

export interface ApiSearchOptions {
  query: string;
  /** Single-vendor filter. Mutually exclusive in practice with `vendors`; when
   *  both are set, `vendors` wins. Kept for the existing single-select call sites. */
  vendor?: SearchVendor;
  /** Multi-vendor filter (UNION). Sent as a comma-joined `vendor` param. A
   *  single-element array behaves identically to the singular `vendor` option. */
  vendors?: SearchVendor[];
  limit?: number;
  fetchImpl?: typeof fetch;
}

/** Worker `/api/songs` per-request id cap (mirrors the worker's MAX_LIMIT). */
const SONGS_BY_ID_BATCH = 100;

interface ApiSearchResponse {
  items?: SongRecord[];
  nextCursor?: string | null;
}

export function getApiSearchBaseUrl(): string | null {
  const raw = import.meta.env.PUBLIC_KARAOKE_API_BASE_URL as string | undefined;
  return resolveApiSearchBaseUrl(raw);
}

export function resolveApiSearchBaseUrl(
  raw: string | undefined,
  origin: string | undefined = globalThis.location?.origin,
): string | null {
  if (raw === undefined || raw.trim() === '') {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('../')) {
    const baseOrigin = origin ?? 'http://localhost';
    return new URL(trimmed, `${baseOrigin.replace(/\/+$/u, '')}/`).toString().replace(/\/+$/u, '');
  }
  return trimmed.replace(/\/+$/u, '');
}

export async function searchApi(baseUrl: string, options: ApiSearchOptions): Promise<SongRecord[]> {
  const url = new URL('api/search', `${baseUrl.replace(/\/+$/u, '')}/`);
  url.searchParams.set('q', options.query);
  url.searchParams.set('limit', String(options.limit ?? 50));
  // `vendors` (multi-select UNION) takes precedence; the worker accepts a
  // comma-joined `vendor` param and treats it as a union (single value still works).
  const vendors =
    options.vendors !== undefined && options.vendors.length > 0
      ? options.vendors
      : options.vendor !== undefined
        ? [options.vendor]
        : [];
  if (vendors.length > 0) {
    url.searchParams.set('vendor', vendors.join(','));
  }
  // Browse search is interactive (debounced): cap at 2 attempts so a single
  // transient blip is absorbed without stalling the "검색 중" state, and a
  // superseded query is not held open through a long backoff chain.
  const response = await fetchWithTransientRetry(url.toString(), undefined, {
    fetchImpl: options.fetchImpl,
    maxAttempts: 2,
  });
  if (!response.ok) {
    throw new Error(`Search API failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as ApiSearchResponse;
  if (!Array.isArray(body.items)) {
    throw new Error('Search API response missing items array');
  }
  return body.items;
}

/**
 * Hydrate full `SongRecord`s by id via the worker `GET /api/songs?ids=...`
 * endpoint. The worker caps each request at 100 ids, so callers that may exceed
 * that (e.g. a large favorites set) are batched into parallel requests of
 * `SONGS_BY_ID_BATCH` ids each and concatenated. The worker does NOT guarantee
 * result order — callers that need a specific order must re-sort.
 */
export async function fetchSongsByIds(
  baseUrl: string,
  ids: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<SongRecord[]> {
  if (ids.length === 0) return [];
  const base = `${baseUrl.replace(/\/+$/u, '')}/`;
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += SONGS_BY_ID_BATCH) {
    batches.push(ids.slice(i, i + SONGS_BY_ID_BATCH));
  }
  const results = await Promise.all(
    batches.map(async (batch) => {
      const url = new URL('api/songs', base);
      url.searchParams.set('ids', batch.join(','));
      // Favorites hydration is not per-keystroke (fires on favorite-set change),
      // so the default 3-attempt policy applies — more headroom for transient
      // failures than the interactive Browse path.
      const response = await fetchWithTransientRetry(url.toString(), undefined, { fetchImpl });
      if (!response.ok) {
        throw new Error(`Songs API failed: HTTP ${response.status}`);
      }
      const body = (await response.json()) as ApiSearchResponse;
      if (!Array.isArray(body.items)) {
        throw new Error('Songs API response missing items array');
      }
      return body.items;
    }),
  );
  return results.flat();
}
