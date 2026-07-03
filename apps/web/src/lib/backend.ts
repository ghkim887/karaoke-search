import type { SongRecord } from '@karaoke/schema';
import {
  type SearchVendor,
  fetchSongsByIds,
  getApiSearchBaseUrl,
  loadIndex,
  searchApi,
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
 * The single mode-decision point. Reads the configured API base URL once and
 * returns the matching backend; every downstream branch keys off
 * `backend.requiresLocalCorpus` rather than re-inspecting the URL.
 */
export function createSearchBackend(): SearchBackend {
  const baseUrl = getApiSearchBaseUrl();
  return baseUrl === null ? new LocalBackend() : new ApiBackend(baseUrl);
}
