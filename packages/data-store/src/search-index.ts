import type { KaraokeNumbers, SongRecord } from '@karaoke/schema';
import type { SearchTokenKind } from '@karaoke/search';
import {
  MAX_PREFIX_TOKEN_CHARS,
  PROVIDER_MASKS,
  compactSearchText,
  deriveKanaRomaji,
  hasNonAsciiCharacter,
  kanaToHangul,
  kanaToRomaji,
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
 * SEARCH-ONLY reading fields (R4): the katakana `title_ruby` plus its
 * deterministic romaji and hangul transliterations. These are TOKEN-ONLY — they
 * emit `search_tokens` rows but NO `search_texts` row, so they never enter the
 * worker's exact-text tier (`MATCH_TIER_EXACT_TEXT`). That is deliberate: a
 * reading is an alternate rendering, not the title, so a song matched only
 * through its (or another song's) reading must never outrank a real exact
 * title/artist match — reading matches stay in the lower token tier, i.e.
 * strictly additive recall at lower ranks. This mirrors the search-hint pattern
 * (also token-only) while weighting a bit higher, since a ruby is authoritative
 * JOYSOUND catalog data rather than a heuristic hint.
 */
const READING_FIELDS = ['title_ruby', 'title_ruby_romaji', 'title_ruby_hangul'] as const;

/**
 * Token weight for the reading fields — the secondary/alternate-rendering tier
 * (3, same as `artist_ko`), below the primary title tier (5) and above the
 * `artist_alias` (2) / search-hint (1) tiers.
 */
const RUBY_FIELD_WEIGHT = 3;

/**
 * The reading field whose text is Latin romaji. It is pure ASCII, and the worker
 * only emits `gram1`/`gram2`/`gram3` QUERY tokens for non-ASCII queries (see
 * apps/worker `buildSearchQueryTokens`), so any ASCII n-gram INDEX token it
 * produced could never be matched. This field therefore indexes term+prefix
 * only — dropping ~6M dead gram rows on the full corpus at zero recall cost.
 */
const ROMAJI_READING_FIELD = 'title_ruby_romaji';

/**
 * SEARCH-ONLY hint weight for tokens derived from search-hint sidecar rows. Kept
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
type ReadingField = (typeof READING_FIELDS)[number];
type HintField = (typeof HINT_FIELDS)[number];
type HintTokenField = (typeof HINT_TOKEN_FIELD_BY_HINT_FIELD)[HintField];
type SearchTokenField = SearchField | ReadingField | HintTokenField;
type HintConfidence = NonNullable<TitleKoConfidence>;

export interface SearchTextInput {
  field: SearchField;
  value: string;
  weight: number;
}

/** A token-only reading source (R4): produces search_tokens rows, no search_texts. */
export interface ReadingTokenInput {
  field: ReadingField;
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

/** A normalized, corpus-validated hint ready to be materialized into hint tokens. */
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

/**
 * Document-frequency cap for `gram1` (single non-ASCII character) tokens.
 *
 * `gram1` postings are consulted by the worker for ONE query shape only: a
 * 1-character non-ASCII query (see apps/worker `buildSearchQueryTokens`,
 * `compactLength === 1`). For an ultra-common character — Japanese particles
 * like の/い, high-frequency kanji, common Hangul syllables — the posting list
 * spans thousands of songs sharing a near-flat idf, so the LIMIT-truncated
 * result is an arbitrary low-relevance long tail rather than a signal. Dropping
 * those postings is the point: the query then falls through to the higher-ranked
 * exact-text tier (which supplies the top-1 when an exact single-character title
 * or artist exists), or returns empty when nothing matches exactly — instead of
 * an arbitrary tail.
 *
 * I3 investigation (109-query top-20 recall harness, see scratchpad/i3): capping
 * gram1 at df>500 removed ~66% of gram1 postings and ~8.4% of DB bytes (VACUUMed).
 * The curated golden/smoke query sets are fully preserved — the search-parity
 * regeneration is a no-op — because their only 1-character queries (恋/光/夏/空/ㄱ,
 * and smoke 光) sit at or below the cap. The results that DO change are exactly
 * the targeted long tail: cap-exceeding ultra-high-frequency single characters
 * are intentionally emptied or reordered (in I3, い/ン/ー/이/사 drop to empty and
 * ス reorders), a deliberate quality trade rather than a recall regression.
 * Tighter caps (df>200, df>100) also dropped genuinely useful mid-frequency
 * characters (恋/光/夏/空 sit at or below 500 and MUST stay searchable), so 500 is
 * the chosen floor.
 *
 * CHANGING THIS VALUE moves worker results for any 1-character query whose
 * character's df sits between the old and new cap. The search-parity baseline
 * (apps/web/src/lib/__snapshots__/search-parity.baseline.json) is frozen against
 * the current cap, so it MUST be regenerated (`UPDATE_PARITY_SNAPSHOT=1 …`, see
 * search-parity.golden.test.ts) and the diff reviewed after any change here.
 */
export const GRAM1_DF_CAP = 500;

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

/**
 * Reading-search enrichment (R4): the katakana ruby plus its deterministic
 * romaji and hangul transliterations, so a kanji title becomes findable by its
 * reading typed in kana, Latin, or Hangul. TOKEN-ONLY (see {@link
 * READING_FIELDS}) — the caller writes these to `search_tokens` but never to
 * `search_texts`. Derived transliterations are SEARCH-ONLY and never mutate
 * canonical data; empty results (e.g. a ruby with no readable kana) are skipped
 * so no zero-content field is indexed.
 */
export function readingTokenInputs(record: SongRecord): ReadingTokenInput[] {
  const ruby = record.title_ruby ?? null;
  if (ruby === null || ruby.length === 0) {
    return [];
  }
  const inputs: ReadingTokenInput[] = [
    { field: 'title_ruby', value: ruby, weight: RUBY_FIELD_WEIGHT },
  ];
  const romaji = kanaToRomaji(ruby);
  if (romaji.length > 0) {
    inputs.push({ field: 'title_ruby_romaji', value: romaji, weight: RUBY_FIELD_WEIGHT });
  }
  const hangul = kanaToHangul(ruby);
  if (hangul.length > 0) {
    inputs.push({ field: 'title_ruby_hangul', value: hangul, weight: RUBY_FIELD_WEIGHT });
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

  // The romaji reading field is pure ASCII; the worker never emits ASCII n-gram
  // query tokens (see ROMAJI_READING_FIELD), so its grams would be dead weight.
  // Every other field keeps the full gram1/gram2/gram3 substring recall.
  if (input.field !== ROMAJI_READING_FIELD) {
    for (const gram of makeNonAsciiCharacterUnigrams(input.textCompact)) {
      addSearchToken(rows, seen, input, 'gram1', gram);
    }
    for (const gram of makeCharacterNgrams(input.textCompact, 2)) {
      addSearchToken(rows, seen, input, 'gram2', gram);
    }
    for (const gram of makeCharacterNgrams(input.textCompact, 3)) {
      addSearchToken(rows, seen, input, 'gram3', gram);
    }
  }

  // Hangul choseong-initials recall is intentionally NOT derived from the
  // reading OR hint fields. Both are SEARCH-ONLY, server-side sources, and the
  // web offline choseong layer (offline-recall.ts) computes initials from
  // canonical title/artist text only — never from readings or hints. If the
  // server indexed initials for these fields, a choseong query would gain
  // recall on the worker path but not the offline path, splitting the two
  // engines' results (a search-parity top-1 regression). Both still contribute
  // the symmetric term/prefix/gram recall the two paths share.
  if (!isReadingField(input.field) && !isHintTokenField(input.field)) {
    const initials = makeHangulInitials(input.value);
    addPrefixTokens(rows, seen, input, initials, 'initial');
  }
}

function isReadingField(field: SearchTokenField): field is ReadingField {
  return (READING_FIELDS as readonly string[]).includes(field);
}

function isHintTokenField(field: SearchTokenField): field is HintTokenField {
  return (Object.values(HINT_TOKEN_FIELD_BY_HINT_FIELD) as string[]).includes(field);
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
 * Normalize raw {@link SearchHintInput} rows into the hints materialized into
 * the `search_tokens` hint fields (`title_hint`/`artist_hint`) during import.
 *
 * Hints for unknown song ids, unknown fields, or values that compact to nothing
 * are dropped silently — a hint sidecar is advisory recall data, never a hard
 * input, so a malformed row must never fail an import. Rows are deduplicated by
 * `(songId, field, source, text_compact)`.
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

/**
 * Upper bound on how many `song_id` values a single `WHERE song_id IN (...)`
 * statement may bind. node:sqlite (SQLite ≥ 3.32) caps bound parameters at
 * `SQLITE_MAX_VARIABLE_NUMBER` = 32766 and throws "too many SQL variables"
 * past it. The delta patcher's `maxTouchedSongs` guard defaults to 1000, so a
 * single chunk covers every normal patch; this bound only splits the query if a
 * caller deliberately raises that guard into the tens of thousands. Set well
 * below the hard cap so the same list can also carry a few unrelated params if
 * ever needed, and so that fewer, larger chunks minimize full-table scans
 * (`search_tokens` has no `song_id` index — see schema.ts — so each chunk is
 * one scan).
 */
export const SONG_ID_IN_CHUNK_SIZE = 20000;

function* chunkSongIds(songIds: readonly string[]): Generator<readonly string[]> {
  for (let start = 0; start < songIds.length; start += SONG_ID_IN_CHUNK_SIZE) {
    yield songIds.slice(start, start + SONG_ID_IN_CHUNK_SIZE);
  }
}

/**
 * Collect the distinct `(kind, token)` stat keys of every `search_tokens` row
 * belonging to any of `songIds`, adding each to `out`. Set-based: one scan per
 * chunk (see {@link SONG_ID_IN_CHUNK_SIZE}) instead of one scan per song. The
 * resulting key set is exactly the union of the per-song sweeps this replaced,
 * so the delta patcher's affected-token accounting (and the gram1 df-cap prune
 * that reads it) is unchanged.
 */
export function collectTokenKeysForSongs(
  db: SongDatabase,
  songIds: readonly string[],
  out: Set<string>,
): void {
  for (const chunk of chunkSongIds(songIds)) {
    if (chunk.length === 0) {
      continue;
    }
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT DISTINCT kind, token FROM search_tokens WHERE song_id IN (${placeholders})`)
      .all(...chunk) as unknown as Array<{ kind: SearchTokenKind; token: string }>;
    for (const row of rows) {
      out.add(tokenStatKey(row.kind, row.token));
    }
  }
}

/**
 * Delete every `search_tokens` row for the given songs in one set-based pass per
 * chunk (see {@link SONG_ID_IN_CHUNK_SIZE}), replacing the delta patcher's old
 * per-song `DELETE ... WHERE song_id = ?` loop. Correct on both layouts and
 * needs no `song_id` index.
 */
export function deleteSearchTokensForSongs(db: SongDatabase, songIds: readonly string[]): void {
  for (const chunk of chunkSongIds(songIds)) {
    if (chunk.length === 0) {
      continue;
    }
    const placeholders = chunk.map(() => '?').join(',');
    db.prepare(`DELETE FROM search_tokens WHERE song_id IN (${placeholders})`).run(...chunk);
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

/**
 * Delete every `gram1` token whose document frequency exceeds `cap` from BOTH
 * `search_tokens` (the postings) and `search_token_stats` (the df/idf row), so a
 * pruned token is absent everywhere. Keeping the two tables in lock-step is the
 * invariant that matters: df is derived by COUNT-ing `search_tokens`, so a token
 * left with orphaned postings but no stat row (or vice versa) would let a later
 * recalculation resurrect a wrong df. See {@link GRAM1_DF_CAP} for the rationale.
 *
 * Reads df from `search_token_stats`, which the caller MUST have refreshed
 * (`recalculateAllTokenStats` / `recalculateAffectedTokenStats`) immediately
 * before calling. Omit `affectedTokenKeys` to sweep the whole corpus (the full
 * {@link importSongs} path). Pass it to restrict pruning to the gram1 tokens a
 * delta patch actually touched (the incremental path): this is deliberately
 * ONE-DIRECTIONAL — a delta only ever prunes newly-over-cap tokens, and a token
 * pruned by a past build whose df has since fallen back below the cap is NOT
 * restored (its postings were already deleted and the delta patcher never
 * rebuilds unaffected songs). That drift is bounded by the release cadence: the
 * served DB is a fresh full build each release, which reprunes from scratch.
 *
 * Returns the number of gram1 tokens pruned.
 */
export function pruneHighDfGram1Tokens(
  db: SongDatabase,
  cap: number,
  affectedTokenKeys?: ReadonlySet<string>,
): number {
  const tokens = collectHighDfGram1Tokens(db, cap, affectedTokenKeys);
  const deletePostings = db.prepare("DELETE FROM search_tokens WHERE kind = 'gram1' AND token = ?");
  const deleteStat = db.prepare(
    "DELETE FROM search_token_stats WHERE kind = 'gram1' AND token = ?",
  );
  for (const token of tokens) {
    deletePostings.run(token);
    deleteStat.run(token);
  }
  return tokens.length;
}

function collectHighDfGram1Tokens(
  db: SongDatabase,
  cap: number,
  affectedTokenKeys?: ReadonlySet<string>,
): string[] {
  if (affectedTokenKeys === undefined) {
    const rows = db
      .prepare("SELECT token FROM search_token_stats WHERE kind = 'gram1' AND df > ?")
      .all(cap) as unknown as Array<{ token: string }>;
    return rows.map((row) => row.token);
  }
  const getDf = db.prepare("SELECT df FROM search_token_stats WHERE kind = 'gram1' AND token = ?");
  const tokens: string[] = [];
  for (const key of affectedTokenKeys) {
    const { kind, token } = parseTokenStatKey(key);
    if (kind !== 'gram1') {
      continue;
    }
    const row = getDf.get(token) as { df: number } | undefined;
    if (row !== undefined && Number(row.df) > cap) {
      tokens.push(token);
    }
  }
  return tokens;
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
