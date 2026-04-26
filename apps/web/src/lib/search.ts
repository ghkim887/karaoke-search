import type { SongRecord } from '@karaoke/schema';
import MiniSearch from 'minisearch';
import { normalize } from './normalize.js';
import { fetchWithRetry } from './retry.js';

/**
 * Fields indexed by MiniSearch. Keep in sync with the boost map below.
 */
const SEARCH_FIELDS = ['title_primary', 'title_ko', 'artist_primary', 'artist_ko'] as const;

/**
 * Per-field boosts. Title fields outrank artist fields.
 * Spec: docs/superpowers/specs/2026-04-26-karaoke-search-design.md.
 */
const SEARCH_BOOSTS = {
  title_primary: 3,
  title_ko: 3,
  artist_primary: 2,
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
