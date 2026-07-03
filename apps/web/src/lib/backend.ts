import type { SongRecord } from '@karaoke/schema';
import type { Vendor } from '../components/VendorChips.js';
import { filterByVendors } from './filter.js';
import {
  type SearchVendor,
  fetchSongsByIds,
  getApiSearchBaseUrl,
  loadIndex,
  searchApi,
  searchLocalIndex,
} from './search.js';
import type { IndexBundle } from './search.js';

/**
 * The data source for every Browse / Favorites path. Two implementations exist
 * and the mode decision (worker API vs offline bundle) is made exactly once, in
 * `createSearchBackend`, instead of being re-derived from `apiBaseUrl === null`
 * at each call site. Consumers branch on the single `requiresLocalCorpus` flag.
 */
export interface SearchBackend {
  /** True only for the offline/local-dev backend, which must download the full
   *  `songs.json` corpus before any data path works. The API backend serves
   *  every path from the worker and never downloads the corpus. */
  readonly requiresLocalCorpus: boolean;

  /** Download + build the local corpus. Resolves `null` for the API backend,
   *  which has no corpus to load (the UI is usable immediately). */
  loadCorpus(): Promise<IndexBundle | null>;

  /** Browse search for the current (query, vendors). API backend only — the
   *  offline backend searches its in-memory bundle synchronously and never
   *  calls this. */
  browse(query: string, vendors: SearchVendor[], limit: number): Promise<SongRecord[]>;

  /** Hydrate favorite records by id. API backend only — the offline backend
   *  resolves favorites from its in-memory bundle. */
  getFavorites(ids: string[]): Promise<SongRecord[]>;
}

/**
 * Optional capability implemented by a backend that can transparently fall back
 * to a local corpus when its primary (API) source fails. Lets the UI surface a
 * subtle "serving offline data" hint without every backend having to know about
 * fallback. Detected via {@link isFallbackStatusSource}.
 */
export interface FallbackStatusSource {
  /** True when the MOST RECENT data operation was served from the local
   *  fallback corpus because the primary API call failed. Reflects the current
   *  displayed data source (flips back to false once the API recovers). */
  isFallbackActive(): boolean;
  /** Subscribe to fallback-active changes. Returns an unsubscribe function. */
  subscribeFallback(listener: () => void): () => void;
}

export function isFallbackStatusSource(
  backend: SearchBackend,
): backend is SearchBackend & FallbackStatusSource {
  return (
    typeof (backend as Partial<FallbackStatusSource>).subscribeFallback === 'function' &&
    typeof (backend as Partial<FallbackStatusSource>).isFallbackActive === 'function'
  );
}

/** Worker-backed backend: every path is served by the `/api` worker. */
class ApiBackend implements SearchBackend {
  readonly requiresLocalCorpus = false;
  constructor(private readonly baseUrl: string) {}

  loadCorpus(): Promise<IndexBundle | null> {
    return Promise.resolve(null);
  }

  browse(query: string, vendors: SearchVendor[], limit: number): Promise<SongRecord[]> {
    const options = { query, limit };
    if (vendors.length > 0) Object.assign(options, { vendors });
    return searchApi(this.baseUrl, options);
  }

  getFavorites(ids: string[]): Promise<SongRecord[]> {
    return fetchSongsByIds(this.baseUrl, ids);
  }
}

/** Offline / local-dev backend: the bundled MiniSearch index over `songs.json`.
 *  Its async methods are never invoked (the offline data paths read the loaded
 *  bundle synchronously) but are implemented for interface completeness. */
class LocalBackend implements SearchBackend {
  readonly requiresLocalCorpus = true;

  loadCorpus(): Promise<IndexBundle | null> {
    return loadIndex();
  }

  async browse(): Promise<SongRecord[]> {
    return [];
  }

  async getFavorites(): Promise<SongRecord[]> {
    return [];
  }
}

/**
 * API backend with a local-corpus safety net (T4-6). Delegates every path to
 * the worker `primary`; if a worker call throws (network down, 5xx, offline),
 * it lazily downloads the same `songs.json` bundle the offline backend uses and
 * answers from the local MiniSearch index instead, so search keeps working when
 * connectivity is unreliable — the primary use case is a phone in a karaoke
 * basement.
 *
 * Behaviour contract:
 *  - `requiresLocalCorpus` stays `false`: the UI is usable immediately and the
 *    10 MB corpus is NEVER eagerly downloaded. It is fetched only on the first
 *    API failure (and thereafter served from the service-worker runtime cache).
 *  - When the API succeeds, this is byte-for-byte the plain API path — the local
 *    corpus is never touched, so the healthy-path behaviour (and its tests) is
 *    preserved exactly.
 *  - Fallback engages ONLY when a non-empty local corpus is available. If the
 *    corpus cannot be loaded (offline with a cold cache) or is empty, the
 *    original API error is re-thrown so the existing error UI surfaces — there
 *    is genuinely nothing to fall back to.
 */
class FallbackBackend implements SearchBackend, FallbackStatusSource {
  readonly requiresLocalCorpus = false;
  #fallbackActive = false;
  #listeners = new Set<() => void>();
  /** Memoized lazy corpus load. Resolves `null` if the corpus can't be loaded
   *  (so callers re-throw the API error rather than masking it). */
  #corpus: Promise<IndexBundle | null> | null = null;

  constructor(private readonly primary: SearchBackend) {}

  loadCorpus(): Promise<IndexBundle | null> {
    // Matches API mode: UI usable immediately, corpus not eagerly downloaded.
    return Promise.resolve(null);
  }

  async browse(query: string, vendors: SearchVendor[], limit: number): Promise<SongRecord[]> {
    try {
      const records = await this.primary.browse(query, vendors, limit);
      this.#setFallbackActive(false);
      return records;
    } catch (apiError) {
      const bundle = await this.#ensureCorpus();
      if (bundle === null || bundle.byId.size === 0) {
        this.#setFallbackActive(false);
        throw apiError;
      }
      const hits = searchLocalIndex(bundle.index, query);
      const records: SongRecord[] = [];
      for (const hit of hits) {
        const rec = bundle.byId.get(String(hit.id));
        if (rec !== undefined) records.push(rec);
      }
      // Mirror the API contract: vendor-filtered and capped. The caller re-applies
      // both (idempotently) via `finalizeResults`, so the visible result matches
      // the offline backend's own path exactly.
      const vendorSet: ReadonlySet<Vendor> = new Set(vendors);
      const result = filterByVendors(records, vendorSet).slice(0, limit);
      this.#setFallbackActive(true);
      return result;
    }
  }

  async getFavorites(ids: string[]): Promise<SongRecord[]> {
    try {
      const records = await this.primary.getFavorites(ids);
      this.#setFallbackActive(false);
      return records;
    } catch (apiError) {
      const bundle = await this.#ensureCorpus();
      if (bundle === null || bundle.byId.size === 0) {
        this.#setFallbackActive(false);
        throw apiError;
      }
      // Resolve favorites from the bundle in the requested id order; the caller
      // re-sorts into favorite order regardless.
      const records: SongRecord[] = [];
      for (const id of ids) {
        const rec = bundle.byId.get(id);
        if (rec !== undefined) records.push(rec);
      }
      this.#setFallbackActive(true);
      return records;
    }
  }

  isFallbackActive(): boolean {
    return this.#fallbackActive;
  }

  subscribeFallback(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #ensureCorpus(): Promise<IndexBundle | null> {
    if (this.#corpus === null) {
      // Lazy + memoized. `loadIndex` fetches `songs.json` (served from the SW
      // runtime cache when offline). A load failure resolves to `null` so the
      // caller re-throws the original API error rather than masking it.
      this.#corpus = loadIndex().catch(() => null);
    }
    return this.#corpus;
  }

  #setFallbackActive(active: boolean): void {
    if (this.#fallbackActive === active) return;
    this.#fallbackActive = active;
    for (const listener of this.#listeners) listener();
  }
}

/**
 * The single mode-decision point. Reads the configured API base URL once and
 * returns the matching backend; every downstream branch keys off
 * `backend.requiresLocalCorpus` rather than re-inspecting the URL.
 *
 * In API mode the worker backend is wrapped in a {@link FallbackBackend} so a
 * failed request transparently falls back to the local corpus (T4-6).
 */
export function createSearchBackend(): SearchBackend {
  const baseUrl = getApiSearchBaseUrl();
  if (baseUrl === null) return new LocalBackend();
  return new FallbackBackend(new ApiBackend(baseUrl));
}
