import type { KaraokeNumbers, SongRecord } from '@karaoke/schema';
import type { SearchTokenKind } from '@karaoke/search';
import {
  MAX_PREFIX_TOKEN_CHARS,
  PROVIDER_MASKS,
  compactSearchText,
  deriveKanaRomaji,
  makeCharacterNgrams,
  makeHangulInitials,
  normalizeKaraokeNumber,
  normalizeSearchText,
  tokenizeSearchWords,
} from '@karaoke/search';
import type { SearchHintInput } from './hints.js';
import type { SongDatabase } from './schema.js';

type TitleKoConfidence = NonNullable<SongRecord['title_ko_confidence']>;

export const KARAOKE_PROVIDERS = ['tj', 'ky', 'joysound'] as const;
const SEARCH_TEXT_FIELDS = [
  { field: 'title_primary', weight: 5 },
  { field: 'title_ko', weight: 5 },
  { field: 'artist_primary', weight: 3 },
  { field: 'artist_ko', weight: 3 },
  { field: 'artist_alias', weight: 2 },
] as const;

/**
 * SEARCH-ONLY hint weight for tokens derived from `search_hints` rows. Kept
 * strictly below every canonical field weight (artist_alias is the lowest at 2)
 * so a hint match can improve recall but never outranks a canonical match, and
 * hints never receive the `search_texts` exact-compact boost at all. Search
 * hints must never feed crawler/classifier/admit/drop decisions.
 */
const HINT_TOKEN_WEIGHT = 1;
const HINT_FIELDS = ['title', 'artist'] as const;
export const HINT_TOKEN_FIELD_BY_HINT_FIELD = {
  title: 'title_hint',
  artist: 'artist_hint',
} as const;
const DEFAULT_HINT_CONFIDENCE: HintConfidence = 'medium';
/** Provenance tag for romaji hints derived from a kana hint at build time. */
const DERIVED_KANA_ROMAJI_SOURCE = 'derived_kana_romaji';

type SearchField = (typeof SEARCH_TEXT_FIELDS)[number]['field'];
type HintField = (typeof HINT_FIELDS)[number];
type HintTokenField = (typeof HINT_TOKEN_FIELD_BY_HINT_FIELD)[HintField];
type SearchTokenField = SearchField | HintTokenField;
type HintConfidence = NonNullable<TitleKoConfidence>;

export interface SearchTextInput {
  field: SearchField;
  value: string;
  weight: number;
}

export interface SearchTokenInput {
  songId: string;
  field: SearchTokenField;
  value: string;
  textCompact: string;
  weight: number;
  providerMask: number;
}

export interface SearchTokenRow {
  kind: SearchTokenKind;
  token: string;
  songId: string;
  field: SearchTokenField;
  weight: number;
  providerMask: number;
}

/** A normalized, corpus-validated hint ready to be written to `search_hints`. */
export interface ResolvedSearchHint {
  songId: string;
  field: HintField;
  source: string;
  textNorm: string;
  textCompact: string;
  weight: number;
  providerMask: number;
  confidence: HintConfidence;
}

interface SearchTokenStatSourceRow {
  kind: SearchTokenKind;
  token: string;
  df: number;
}

export function searchTextInputs(record: SongRecord): SearchTextInput[] {
  const inputs: SearchTextInput[] = [
    {
      field: 'title_primary',
      value: record.title_primary,
      weight: searchFieldWeight('title_primary'),
    },
    {
      field: 'artist_primary',
      value: record.artist_primary,
      weight: searchFieldWeight('artist_primary'),
    },
  ];

  if (record.title_ko !== null) {
    inputs.push({
      field: 'title_ko',
      value: record.title_ko,
      weight: searchFieldWeight('title_ko'),
    });
  }
  if (record.artist_ko !== null) {
    inputs.push({
      field: 'artist_ko',
      value: record.artist_ko,
      weight: searchFieldWeight('artist_ko'),
    });
  }
  for (const alias of record.artist_aliases ?? []) {
    inputs.push({ field: 'artist_alias', value: alias, weight: searchFieldWeight('artist_alias') });
  }

  return inputs;
}

export function addSearchTokens(
  rows: SearchTokenRow[],
  seen: Set<string>,
  input: SearchTokenInput,
): void {
  for (const word of tokenizeSearchWords(input.value)) {
    if (Array.from(word).length >= 2) {
      addSearchToken(rows, seen, input, 'term', word);
    }
    addPrefixTokens(rows, seen, input, word, 'prefix');
  }
  addPrefixTokens(rows, seen, input, input.textCompact, 'prefix');

  for (const gram of makeNonAsciiCharacterUnigrams(input.textCompact)) {
    addSearchToken(rows, seen, input, 'gram1', gram);
  }
  for (const gram of makeCharacterNgrams(input.textCompact, 2)) {
    addSearchToken(rows, seen, input, 'gram2', gram);
  }
  for (const gram of makeCharacterNgrams(input.textCompact, 3)) {
    addSearchToken(rows, seen, input, 'gram3', gram);
  }

  const initials = makeHangulInitials(input.value);
  addPrefixTokens(rows, seen, input, initials, 'initial');
}

function addPrefixTokens(
  rows: SearchTokenRow[],
  seen: Set<string>,
  input: SearchTokenInput,
  value: string,
  kind: SearchTokenKind,
): void {
  const characters = Array.from(value);
  for (let length = 2; length <= Math.min(MAX_PREFIX_TOKEN_CHARS, characters.length); length += 1) {
    addSearchToken(rows, seen, input, kind, characters.slice(0, length).join(''));
  }
}

function addSearchToken(
  rows: SearchTokenRow[],
  seen: Set<string>,
  input: SearchTokenInput,
  kind: SearchTokenKind,
  token: string,
): void {
  if (token.length === 0) {
    return;
  }

  const key = `${kind}\u0000${token}\u0000${input.songId}\u0000${input.field}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  rows.push({
    kind,
    token,
    songId: input.songId,
    field: input.field,
    weight: input.weight,
    providerMask: input.providerMask,
  });
}

function makeNonAsciiCharacterUnigrams(value: string): string[] {
  const grams: string[] = [];
  const seen = new Set<string>();
  for (const character of Array.from(value)) {
    if (!hasNonAsciiCharacter(character) || seen.has(character)) {
      continue;
    }
    seen.add(character);
    grams.push(character);
  }
  return grams;
}

function hasNonAsciiCharacter(value: string): boolean {
  return Array.from(value).some((character) => (character.codePointAt(0) ?? 0) > 0x7f);
}

export function karaokeProviderMask(numbers: KaraokeNumbers): number {
  let mask = 0;
  for (const provider of KARAOKE_PROVIDERS) {
    if (numbers[provider] !== null) {
      mask |= PROVIDER_MASKS[provider];
    }
  }
  return mask;
}

function searchFieldWeight(field: SearchField): number {
  const config = SEARCH_TEXT_FIELDS.find((entry) => entry.field === field);
  if (config === undefined) {
    throw new Error(`Unknown search field: ${field}`);
  }
  return config.weight;
}

export function karaokeNumberKey(number: string | null): string | null {
  if (number === null) {
    return null;
  }
  const normalized = normalizeKaraokeNumber(number);
  if (normalized.length === 0) {
    return null;
  }
  return normalized.replace(/^0+/u, '') || '0';
}

/**
 * Normalize raw {@link SearchHintInput} rows into the rows materialized into
 * `search_hints` (and, during import, the token index).
 *
 * Hints for unknown song ids, unknown fields, or values that compact to nothing
 * are dropped silently — a hint sidecar is advisory recall data, never a hard
 * input, so a malformed row must never fail an import. Rows are deduplicated by
 * `(songId, field, source, text_compact)` (the `search_hints` primary key).
 */
export function resolveSearchHints(
  inputs: readonly SearchHintInput[],
  records: readonly SongRecord[],
): ResolvedSearchHint[] {
  const providerMaskById = new Map<string, number>();
  for (const record of records) {
    providerMaskById.set(record.id, karaokeProviderMask(record.karaoke_numbers));
  }

  const resolved: ResolvedSearchHint[] = [];
  const seen = new Set<string>();
  // Every text_compact already indexed per song+field (across all sources), so
  // a derived romaji never duplicates an existing reading.
  const compactsByGroup = new Map<string, Set<string>>();
  const groupCompacts = (songId: string, field: HintField): Set<string> => {
    const groupKey = `${songId} ${field}`;
    let set = compactsByGroup.get(groupKey);
    if (set === undefined) {
      set = new Set<string>();
      compactsByGroup.set(groupKey, set);
    }
    return set;
  };
  const add = (
    songId: string,
    field: HintField,
    source: string,
    text: string,
    confidence: HintConfidence,
  ): void => {
    const providerMask = providerMaskById.get(songId);
    if (providerMask === undefined) {
      return;
    }
    const textCompact = compactSearchText(text);
    if (textCompact.length === 0) {
      return;
    }
    const key = `${songId}\u0000${field}\u0000${source}\u0000${textCompact}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    groupCompacts(songId, field).add(textCompact);
    resolved.push({
      songId,
      field,
      source,
      textNorm: normalizeSearchText(text).trim(),
      textCompact,
      weight: HINT_TOKEN_WEIGHT,
      providerMask,
      confidence,
    });
  };

  for (const input of inputs) {
    if (!isHintField(input.field)) {
      continue;
    }
    if (typeof input.text !== 'string' || typeof input.source !== 'string') {
      continue;
    }
    const confidence = isHintConfidence(input.confidence)
      ? input.confidence
      : DEFAULT_HINT_CONFIDENCE;
    add(input.songId, input.field, input.source, input.text, confidence);
  }

  // P3: derive a romaji recall variant from each directly-supplied kana hint
  // (snapshot first so we never derive from a derived row), inheriting the
  // parent confidence and skipping normalized-equivalent readings.
  for (const hint of [...resolved]) {
    if (hint.source === DERIVED_KANA_ROMAJI_SOURCE) {
      continue;
    }
    const romaji = deriveKanaRomaji(hint.textNorm);
    if (romaji === null) {
      continue;
    }
    if (groupCompacts(hint.songId, hint.field).has(compactSearchText(romaji))) {
      continue;
    }
    add(hint.songId, hint.field, DERIVED_KANA_ROMAJI_SOURCE, romaji, hint.confidence);
  }

  return resolved;
}

export function groupResolvedHints(
  hints: readonly ResolvedSearchHint[],
): Map<string, ResolvedSearchHint[]> {
  const grouped = new Map<string, ResolvedSearchHint[]>();
  for (const hint of hints) {
    const group = grouped.get(hint.songId);
    if (group === undefined) {
      grouped.set(hint.songId, [hint]);
      continue;
    }
    group.push(hint);
  }
  return grouped;
}

function isHintField(value: unknown): value is HintField {
  return typeof value === 'string' && (HINT_FIELDS as readonly string[]).includes(value);
}

function isHintConfidence(value: unknown): value is HintConfidence {
  return value === 'high' || value === 'medium' || value === 'low';
}

export function collectTokenKeysForSong(db: SongDatabase, songId: string, out: Set<string>): void {
  const rows = db
    .prepare('SELECT DISTINCT kind, token FROM search_tokens WHERE song_id = ?')
    .all(songId) as unknown as Array<{ kind: SearchTokenKind; token: string }>;
  for (const row of rows) {
    out.add(tokenStatKey(row.kind, row.token));
  }
}

export function recalculateAffectedTokenStats(
  db: SongDatabase,
  tokenKeys: ReadonlySet<string>,
  songCount: number,
): number {
  const countDf = db.prepare(
    'SELECT COUNT(DISTINCT song_id) AS df FROM search_tokens WHERE kind = ? AND token = ?',
  );
  const upsert = db.prepare(
    `INSERT INTO search_token_stats (kind, token, df, idf_scaled) VALUES (?, ?, ?, ?)
     ON CONFLICT(kind, token) DO UPDATE SET df = excluded.df, idf_scaled = excluded.idf_scaled`,
  );
  const remove = db.prepare('DELETE FROM search_token_stats WHERE kind = ? AND token = ?');
  let recalculated = 0;
  for (const key of tokenKeys) {
    const { kind, token } = parseTokenStatKey(key);
    const row = countDf.get(kind, token) as { df: number };
    const df = Number(row.df);
    if (df === 0) {
      remove.run(kind, token);
    } else {
      upsert.run(kind, token, df, tokenIdfScaled(songCount, df));
    }
    recalculated += 1;
  }
  return recalculated;
}

export function recalculateAllTokenStats(db: SongDatabase, songCount: number): number {
  const rows = db
    .prepare(
      `SELECT kind, token, COUNT(DISTINCT song_id) AS df
       FROM search_tokens
       GROUP BY kind, token`,
    )
    .all() as unknown as SearchTokenStatSourceRow[];
  const insert = db.prepare(
    'INSERT INTO search_token_stats (kind, token, df, idf_scaled) VALUES (?, ?, ?, ?)',
  );
  db.exec('DELETE FROM search_token_stats');
  for (const row of rows) {
    const df = Number(row.df);
    insert.run(row.kind, row.token, df, tokenIdfScaled(songCount, df));
  }
  return rows.length;
}

function tokenIdfScaled(songCount: number, df: number): number {
  return Math.max(1, Math.round(Math.log1p(Math.max(songCount, 1) / df) * 1000));
}

function tokenStatKey(kind: SearchTokenKind, token: string): string {
  return `${kind}\u0000${token}`;
}

function parseTokenStatKey(key: string): { kind: SearchTokenKind; token: string } {
  const separatorIndex = key.indexOf('\u0000');
  if (separatorIndex < 0) {
    throw new Error(`Invalid token stat key: ${key}`);
  }
  return {
    kind: key.slice(0, separatorIndex) as SearchTokenKind,
    token: key.slice(separatorIndex + 1),
  };
}
