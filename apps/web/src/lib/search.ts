import type { SongRecord } from '@karaoke/schema';
import MiniSearch from 'minisearch';
import { normalize } from './normalize.js';

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
 * Fetch the prebuilt `songs.json` from the static `/data/` path and build a
 * MiniSearch index in memory. Intended to run client-side after hydration.
 */
export async function loadIndex(): Promise<MiniSearch<SongRecord>> {
  const res = await fetch('/data/songs.json');
  if (!res.ok) {
    throw new Error(`Failed to load /data/songs.json: ${res.status} ${res.statusText}`);
  }
  const records = (await res.json()) as SongRecord[];
  return buildIndex(records);
}
