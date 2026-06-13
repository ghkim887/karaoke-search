import type { SongRecord } from '@karaoke/schema';
import MiniSearch from 'minisearch';
import { normalize } from './normalize.js';
import { fetchWithRetry } from './retry.js';

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
} as const;

/** Return type of `loadIndex`. Bundles the search index with an id→record map. */
export interface IndexBundle {
  index: MiniSearch<SongRecord>;
  byId: Map<string, SongRecord>;
}

/**
 * Build a MiniSearch index from `records`. Field values that are `null` are
 * tolerated by MiniSearch and skipped during indexing.
 */
export function buildIndex(records: SongRecord[]): MiniSearch<SongRecord> {
  const index = new MiniSearch<SongRecord>({
    idField: 'id',
    fields: [...SEARCH_FIELDS],
    storeFields: ['id'],
    processTerm: (term, _fieldName) => normalize(term),
    searchOptions: {
      boost: { ...SEARCH_BOOSTS },
      // spec asks for fuzzy distance 1; MiniSearch fuzzy is a ratio of term length, so 0.2 ≈ 1 edit per 5 chars.
      fuzzy: 0.2,
      prefix: true,
      processTerm: (term) => normalize(term),
    },
  });
  index.addAll(records);
  return index;
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

const SEARCH_RESULT_VENDOR_PRIORITY: SearchVendor[] = ['tj', 'ky', 'joysound'];

function searchResultVendorPriority(record: Pick<SongRecord, 'karaoke_numbers'>): number {
  const index = SEARCH_RESULT_VENDOR_PRIORITY.findIndex(
    (vendor) => record.karaoke_numbers[vendor] !== null,
  );
  return index === -1 ? SEARCH_RESULT_VENDOR_PRIORITY.length : index;
}

export function sortSearchResultsByProviderPriority<T extends Pick<SongRecord, 'karaoke_numbers'>>(
  records: readonly T[],
): T[] {
  return records
    .map((record, index) => ({ index, priority: searchResultVendorPriority(record), record }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map(({ record }) => record);
}

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
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(url.toString());
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
      const response = await fetchImpl(url.toString());
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
