import type { AliasRow, KaraokeNumberRow, StoredSongRow } from '@karaoke/data-store';
import { songServeColumnsProjection } from '@karaoke/data-store';
import type { KaraokeNumbers, SongRecord } from '@karaoke/schema';
import type { SearchTokenKind } from '@karaoke/search';
import {
  MAX_PREFIX_TOKEN_CHARS,
  PROVIDER_MASKS,
  compactSearchText,
  expandSearchQuery,
  makeCharacterNgrams,
  makeHangulInitials,
  parseKaraokeNumberQuery,
  tokenizeSearchWords,
} from '@karaoke/search';

export interface SearchContext {
  db: SearchDatabase;
}

export interface SearchDatabase {
  prepare(sql: string): PreparedStatementLike;
}

export interface PreparedStatementLike {
  bind(...values: SqlValue[]): PreparedStatementLike;
  all<T = Record<string, unknown>>(): Promise<QueryResult<T>>;
}

export interface QueryResult<T> {
  results?: T[];
}

type SqlValue = string | number | null;
type Vendor = (typeof VENDORS)[number];

const VENDORS = ['tj', 'ky', 'joysound'] as const;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const MAX_QUERY_TOKENS = 24;
// Upper bound (in code points) on the `q` search parameter. Matches the
// @karaoke/search expansion guard so wanakana (reached via expandSearchQuery)
// never sees an over-length query; a longer `q` is a clean 400, never a 500.
const MAX_QUERY_CODE_POINTS = 256;
// Weight multiplier applied to tokens from expanded romaji↔kana query variants
// (the original query keeps full weight). Biases original-query matches above
// expansion-only matches without degrading existing scoring.
const EXPANDED_VARIANT_WEIGHT_SCALE = 0.5;
const MATCH_TIER_TOKEN = 1;
const MATCH_TIER_EXACT_TEXT = 2;
const HANGUL_INITIALS_QUERY_PATTERN = /^[ㄱ-ㅎ]+$/u;
const JSON_HEADERS = {
  'access-control-allow-origin': '*',
  'content-type': 'application/json; charset=utf-8',
};

export async function handleRequest(request: Request, context: SearchContext): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-methods': 'GET, OPTIONS',
        'access-control-allow-origin': '*',
      },
    });
  }

  if (
    url.pathname !== '/api/search' &&
    url.pathname !== '/api/songs' &&
    url.pathname !== '/api/meta'
  ) {
    return json({ error: 'Not found' }, 404);
  }
  if (request.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    if (url.pathname === '/api/songs') {
      return await handleSongsByIdRequest(request, context.db);
    }
    if (url.pathname === '/api/meta') {
      return await handleMetaRequest(context.db);
    }
    return await handleSearchRequest(request, context.db);
  } catch (error) {
    if (error instanceof BadRequestError) {
      return json({ error: error.message }, 400);
    }
    return json({ error: 'Internal server error' }, 500);
  }
}

export async function handleSearchRequest(request: Request, db: SearchDatabase): Promise<Response> {
  const url = new URL(request.url);
  const query = parseQuery(url.searchParams.get('q'));
  const vendors = parseVendors(url.searchParams.get('vendor'));
  const limit = parseLimit(url.searchParams.get('limit'));
  const offset = parseCursor(url.searchParams.get('cursor'));

  const candidateRows = await findCandidateRows(db, {
    query,
    vendors,
    limit: limit + 1,
    offset,
  });
  const hasMore = candidateRows.length > limit;
  const pageRows = candidateRows.slice(0, limit);
  const items = await hydrateSongs(db, pageRows);

  return json({ items, nextCursor: hasMore ? String(offset + limit) : null });
}

export async function handleSongsByIdRequest(
  request: Request,
  db: SearchDatabase,
): Promise<Response> {
  const url = new URL(request.url);
  const ids = parseSongIds(url.searchParams.get('ids'));

  const placeholders = ids.map(() => '?').join(', ');
  const rows = await allRows<StoredSongRow>(
    db
      .prepare(
        `SELECT ${songServeColumnsProjection('s')}
        FROM songs s
        WHERE s.id IN (${placeholders})`,
      )
      .bind(...ids),
  );
  const items = await hydrateSongs(db, rows);

  return json({ items });
}

/**
 * Per-database memo for `GET /api/meta`. The serving database is immutable for
 * the lifetime of the process — a data release swaps the SQLite file via a full
 * symlink swap + service restart, never in place — so `MAX(crawled_at)` is
 * computed once per database instance and reused for every subsequent request.
 * Keyed by the database object (WeakMap) so multiple databases in the same
 * process (e.g. tests) never share a value and short-lived databases can be
 * garbage-collected. A rejected computation is evicted so it can be retried.
 */
const dbUpdatedAtCache = new WeakMap<SearchDatabase, Promise<string>>();

export async function handleMetaRequest(db: SearchDatabase): Promise<Response> {
  const dbUpdatedAt = await getDbUpdatedAt(db);
  return json({ dbUpdatedAt });
}

function getDbUpdatedAt(db: SearchDatabase): Promise<string> {
  const cached = dbUpdatedAtCache.get(db);
  if (cached !== undefined) {
    return cached;
  }
  const computed = computeDbUpdatedAt(db).catch((error) => {
    dbUpdatedAtCache.delete(db);
    throw error;
  });
  dbUpdatedAtCache.set(db, computed);
  return computed;
}

async function computeDbUpdatedAt(db: SearchDatabase): Promise<string> {
  const rows = await allRows<{ max_crawled_at: string | null }>(
    db.prepare('SELECT MAX(crawled_at) AS max_crawled_at FROM songs'),
  );
  const value = rows[0]?.max_crawled_at ?? null;
  // `crawled_at` is an ISO-8601 UTC timestamp; ISO strings sort lexicographically
  // in chronological order, so MAX is the latest instant. Truncate to its
  // YYYY-MM-DD date. An empty songs table yields '' (no date).
  return value === null ? '' : value.slice(0, 10);
}

async function findCandidateRows(
  db: SearchDatabase,
  params: SearchQueryParams,
): Promise<StoredSongRow[]> {
  if (params.query.length === 0) {
    return findFilteredRows(db, params);
  }
  return findIndexedCandidateRows(db, params);
}

async function findFilteredRows(
  db: SearchDatabase,
  params: SearchQueryParams,
): Promise<StoredSongRow[]> {
  const where: string[] = [];
  const values: SqlValue[] = [];
  appendSongFilters(where, values, params, 's');

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const statement = db
    .prepare(
      `SELECT ${songServeColumnsProjection('s')}
      FROM songs s
      ${whereSql}
      ORDER BY s.sort_order ASC, s.id ASC
      LIMIT ? OFFSET ?`,
    )
    .bind(...values, params.limit, params.offset);

  return allRows<StoredSongRow>(statement);
}

async function findIndexedCandidateRows(
  db: SearchDatabase,
  params: SearchQueryParams,
): Promise<StoredSongRow[]> {
  const numberQuery = parseKaraokeNumberQuery(params.query);
  if (numberQuery !== null) {
    return findKaraokeNumberCandidateRows(db, params, numberQuery);
  }

  const subqueries: string[] = [];
  const values: SqlValue[] = [];
  const queryTokens = buildSearchQueryTokens(params.query);
  const queryTokenValuesSql =
    queryTokens.length > 0 ? queryTokens.map(() => '(?, ?, ?)').join(', ') : null;
  if (queryTokens.length > 0) {
    const where: string[] = [];
    for (const token of queryTokens) {
      values.push(token.kind, token.token, token.queryWeight);
    }
    appendIndexFilters(where, values, params, 'st');
    subqueries.push(`
      SELECT
        st.song_id,
        SUM(st.weight * qt.query_weight * COALESCE(stats.idf_scaled, 1000)) AS score,
        ${MATCH_TIER_TOKEN} AS match_tier
      FROM search_tokens st
      JOIN query_tokens qt ON qt.kind = st.kind AND qt.token = st.token
      LEFT JOIN search_token_stats stats ON stats.kind = st.kind AND stats.token = st.token
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      GROUP BY st.song_id
    `);
  }

  const compactQuery = compactSearchText(params.query);
  if (Array.from(compactQuery).length >= 1) {
    const where = ['sx.text_compact = ?'];
    values.push(compactQuery);
    appendIndexFilters(where, values, params, 'sx');
    subqueries.push(`
      SELECT
        sx.song_id,
        MAX(sx.weight * 2000000) AS score,
        ${MATCH_TIER_EXACT_TEXT} AS match_tier
      FROM search_texts sx
      WHERE ${where.join(' AND ')}
      GROUP BY sx.song_id
    `);
  }

  if (subqueries.length === 0) {
    return [];
  }

  const queryTokensCte =
    queryTokenValuesSql !== null
      ? `query_tokens(kind, token, query_weight) AS (VALUES ${queryTokenValuesSql}),`
      : '';

  const statement = db
    .prepare(
      `WITH ${queryTokensCte} candidates AS (
        ${subqueries.join('\nUNION ALL\n')}
      ), ranked AS (
        SELECT song_id, SUM(score) AS score, MAX(match_tier) AS match_tier
        FROM candidates
        GROUP BY song_id
      )
      SELECT ${songServeColumnsProjection('s')}
      FROM ranked r
      JOIN songs s ON s.id = r.song_id
      ORDER BY r.match_tier DESC, r.score DESC, s.sort_order ASC, s.id ASC
      LIMIT ? OFFSET ?`,
    )
    .bind(...values, params.limit, params.offset);

  return allRows<StoredSongRow>(statement);
}

async function findKaraokeNumberCandidateRows(
  db: SearchDatabase,
  params: SearchQueryParams,
  numberQuery: NonNullable<ReturnType<typeof parseKaraokeNumberQuery>>,
): Promise<StoredSongRow[]> {
  const subqueries: string[] = [];
  const values: SqlValue[] = [];
  const trimmedNumber = trimLeadingZeroes(numberQuery.number);
  appendKaraokeNumberCandidateSubquery({
    subqueries,
    values,
    params,
    provider: numberQuery.provider,
    predicateSql: 'kn.number = ?',
    predicateValues: [numberQuery.number],
    notNullColumn: 'number',
    score: 1000000000,
  });
  appendKaraokeNumberCandidateSubquery({
    subqueries,
    values,
    params,
    provider: numberQuery.provider,
    predicateSql: 'kn.number_key = ?',
    predicateValues: [trimmedNumber],
    notNullColumn: 'number_key',
    score: 990000000,
  });

  appendKaraokeNumberCandidateSubquery({
    subqueries,
    values,
    params,
    provider: numberQuery.provider,
    predicateSql: 'kn.number LIKE ?',
    predicateValues: [makeNumericPrefixPattern(numberQuery.number)],
    notNullColumn: 'number',
    score: 900000000,
  });

  appendKaraokeNumberCandidateSubquery({
    subqueries,
    values,
    params,
    provider: numberQuery.provider,
    predicateSql: 'kn.number_key LIKE ?',
    predicateValues: [makeNumericPrefixPattern(trimmedNumber)],
    notNullColumn: 'number_key',
    score: 900000000,
  });

  const statement = db
    .prepare(
      `WITH candidates AS (
        ${subqueries.join('\nUNION ALL\n')}
      ), ranked AS (
        SELECT song_id, SUM(score) AS score
        FROM candidates
        GROUP BY song_id
      )
      SELECT ${songServeColumnsProjection('s')}
      FROM ranked r
      JOIN songs s ON s.id = r.song_id
      ORDER BY r.score DESC, s.sort_order ASC, s.id ASC
      LIMIT ? OFFSET ?`,
    )
    .bind(...values, params.limit, params.offset);

  return allRows<StoredSongRow>(statement);
}

async function hydrateSongs(
  db: SearchDatabase,
  rows: readonly StoredSongRow[],
): Promise<SongRecord[]> {
  if (rows.length === 0) {
    return [];
  }

  const ids = rows.map((row) => row.id);
  const placeholders = ids.map(() => '?').join(', ');
  const [numberRows, aliasRows] = await Promise.all([
    allRows<KaraokeNumberRow>(
      db
        .prepare(
          `SELECT song_id, provider, number
          FROM karaoke_numbers
          WHERE song_id IN (${placeholders})
          ORDER BY song_id ASC, provider ASC`,
        )
        .bind(...ids),
    ),
    allRows<AliasRow>(
      db
        .prepare(
          `SELECT song_id, alias
          FROM artist_aliases
          WHERE song_id IN (${placeholders})
          ORDER BY song_id ASC, position ASC`,
        )
        .bind(...ids),
    ),
  ]);

  const numbersBySong = new Map<string, KaraokeNumbers>();
  const aliasesBySong = new Map<string, string[]>();
  for (const id of ids) {
    numbersBySong.set(id, { tj: null, ky: null, joysound: null });
    aliasesBySong.set(id, []);
  }

  for (const row of numberRows) {
    const numbers = numbersBySong.get(row.song_id);
    if (numbers !== undefined) {
      numbers[row.provider] = row.number;
    }
  }
  for (const row of aliasRows) {
    aliasesBySong.get(row.song_id)?.push(row.alias);
  }

  return rows.map((row): SongRecord => {
    const aliases = aliasesBySong.get(row.id) ?? [];
    return {
      id: row.id,
      source_url: row.source_url,
      title_primary: row.title_primary,
      title_ko: row.title_ko,
      artist_primary: row.artist_primary,
      artist_ko: row.artist_ko,
      ...(row.artist_aliases_present === 1 || aliases.length > 0
        ? { artist_aliases: aliases }
        : {}),
      karaoke_numbers: numbersBySong.get(row.id) ?? { tj: null, ky: null, joysound: null },
      crawled_at: row.crawled_at,
      ...(row.media_context_ko !== null ? { media_context_ko: row.media_context_ko } : {}),
      ...(row.title_ko_source !== null ? { title_ko_source: row.title_ko_source } : {}),
      ...(row.title_ko_confidence !== null ? { title_ko_confidence: row.title_ko_confidence } : {}),
    };
  });
}

async function allRows<T>(statement: PreparedStatementLike): Promise<T[]> {
  const result = await statement.all<T>();
  return result.results ?? [];
}

function appendSongFilters(
  where: string[],
  values: SqlValue[],
  params: Pick<SearchQueryParams, 'vendors'>,
  songAlias: string,
): void {
  if (params.vendors !== undefined) {
    const placeholders = params.vendors.map(() => '?').join(', ');
    where.push(`EXISTS (
      SELECT 1 FROM karaoke_numbers vn
      WHERE vn.song_id = ${songAlias}.id AND vn.provider IN (${placeholders}) AND vn.number IS NOT NULL
    )`);
    values.push(...params.vendors);
  }
}

function appendIndexFilters(
  where: string[],
  values: SqlValue[],
  params: Pick<SearchQueryParams, 'vendors'>,
  indexAlias: string,
): void {
  if (params.vendors !== undefined) {
    where.push(`(${indexAlias}.provider_mask & ?) != 0`);
    values.push(combinedVendorMask(params.vendors));
  }
}

function appendKaraokeNumberCandidateSubquery({
  subqueries,
  values,
  params,
  provider,
  predicateSql,
  predicateValues,
  notNullColumn,
  score,
}: {
  subqueries: string[];
  values: SqlValue[];
  params: Pick<SearchQueryParams, 'vendors'>;
  provider: Vendor | undefined;
  predicateSql: string;
  predicateValues: readonly SqlValue[];
  notNullColumn: 'number' | 'number_key';
  score: number;
}): void {
  const where = [`kn.${notNullColumn} IS NOT NULL`, predicateSql];
  const branchValues: SqlValue[] = [...predicateValues];
  if (provider !== undefined) {
    where.push('kn.provider = ?');
    branchValues.push(provider);
  }
  if (params.vendors !== undefined) {
    const placeholders = params.vendors.map(() => '?').join(', ');
    where.push(`kn.provider IN (${placeholders})`);
    branchValues.push(...params.vendors);
  }

  subqueries.push(`
    SELECT kn.song_id, ${score} AS score
    FROM karaoke_numbers kn
    WHERE ${where.join(' AND ')}
    GROUP BY kn.song_id
  `);
  values.push(...branchValues);
}

function buildSearchQueryTokens(query: string): SearchQueryToken[] {
  const byKey = new Map<string, SearchQueryToken>();
  const add = (kind: SearchTokenKind, token: string, queryWeight: number): void => {
    if (kind !== 'gram1' && Array.from(token).length < 2) {
      return;
    }
    const key = `${kind}\u0000${token}`;
    const existing = byKey.get(key);
    if (existing === undefined || queryWeight > existing.queryWeight) {
      byKey.set(key, { kind, token, queryWeight });
    }
  };

  // Original query first (full weight), then safe romaji↔kana variants at a
  // reduced weight so expanded-only matches never outrank or degrade the
  // original query's matches. `expandSearchQuery` only adds variants for
  // kana/romaji input and never for kanji — so kanji/Hangul queries keep the
  // same tokens and weights as before, while romaji gets reduced-weight kana
  // recall tokens.
  const variants = expandSearchQuery(query);
  const effectiveVariants = variants.length > 0 ? variants : [query];
  effectiveVariants.forEach((variant, index) => {
    addVariantQueryTokens(add, variant, index === 0 ? 1 : EXPANDED_VARIANT_WEIGHT_SCALE);
  });

  return Array.from(byKey.values())
    .sort(
      (left, right) =>
        right.queryWeight - left.queryWeight ||
        left.kind.localeCompare(right.kind) ||
        left.token.localeCompare(right.token),
    )
    .slice(0, MAX_QUERY_TOKENS);
}

/**
 * Emit the term/prefix/gram/initial query tokens for a single query variant,
 * scaling each token's weight by `weightScale` (1 for the original query,
 * `< 1` for expanded romaji↔kana variants). With `weightScale === 1` the
 * tokens and weights are identical to the pre-expansion behaviour.
 */
function addVariantQueryTokens(
  add: (kind: SearchTokenKind, token: string, queryWeight: number) => void,
  query: string,
  weightScale: number,
): void {
  const scaled = (weight: number): number => Math.round(weight * weightScale);

  for (const word of tokenizeSearchWords(query)) {
    const wordLength = Array.from(word).length;
    add('term', word, scaled(45));
    if (wordLength <= MAX_PREFIX_TOKEN_CHARS) {
      add('prefix', word, scaled(30));
    } else {
      add('prefix', Array.from(word).slice(0, MAX_PREFIX_TOKEN_CHARS).join(''), scaled(30));
    }
  }

  const compactQuery = compactSearchText(query);
  const compactLength = Array.from(compactQuery).length;
  if (hasNonAsciiCharacter(compactQuery) && compactLength === 1) {
    add('gram1', compactQuery, scaled(14));
  }
  if (hasNonAsciiCharacter(compactQuery) && compactLength >= 2) {
    for (const gram of makeCharacterNgrams(compactQuery, 2)) {
      add('gram2', gram, scaled(12));
    }
  }
  if (hasNonAsciiCharacter(compactQuery) && compactLength >= 3) {
    for (const gram of makeCharacterNgrams(compactQuery, 3)) {
      add('gram3', gram, scaled(18));
    }
  }

  const hangulInitials = makeHangulInitials(query);
  if (hangulInitials.length >= 2) {
    add('initial', hangulInitials.slice(0, MAX_PREFIX_TOKEN_CHARS), scaled(35));
  }
  if (HANGUL_INITIALS_QUERY_PATTERN.test(compactQuery)) {
    add('initial', Array.from(compactQuery).slice(0, MAX_PREFIX_TOKEN_CHARS).join(''), scaled(35));
  }
}

function trimLeadingZeroes(value: string): string {
  return value.replace(/^0+/u, '') || '0';
}

function hasNonAsciiCharacter(value: string): boolean {
  return Array.from(value).some((character) => (character.codePointAt(0) ?? 0) > 0x7f);
}

function parseVendors(value: string | null): Vendor[] | undefined {
  if (value === null || value === '') {
    return undefined;
  }
  const vendors: Vendor[] = [];
  const seen = new Set<Vendor>();
  for (const part of value.split(',')) {
    const candidate = part.trim();
    if (candidate === '') {
      continue;
    }
    if (!isOneOf(candidate, VENDORS)) {
      throw new BadRequestError(`Invalid vendor: ${candidate}`);
    }
    if (!seen.has(candidate)) {
      seen.add(candidate);
      vendors.push(candidate);
    }
  }
  return vendors.length > 0 ? vendors : undefined;
}

function combinedVendorMask(vendors: readonly Vendor[]): number {
  let mask = 0;
  for (const vendor of vendors) {
    mask |= PROVIDER_MASKS[vendor];
  }
  return mask;
}

function parseSongIds(value: string | null): string[] {
  if (value === null) {
    throw new BadRequestError('Missing ids');
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const part of value.split(',')) {
    const id = part.trim();
    if (id === '') {
      continue;
    }
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  if (ids.length === 0) {
    throw new BadRequestError('Invalid ids: at least one id is required');
  }
  if (ids.length > MAX_LIMIT) {
    throw new BadRequestError(`Invalid ids: at most ${MAX_LIMIT} ids per request`);
  }
  return ids;
}

function parseQuery(value: string | null): string {
  const query = value?.trim() ?? '';
  if (Array.from(query).length > MAX_QUERY_CODE_POINTS) {
    throw new BadRequestError(`Invalid q: at most ${MAX_QUERY_CODE_POINTS} characters per query`);
  }
  return query;
}

function parseLimit(value: string | null): number {
  if (value === null || value === '') {
    return DEFAULT_LIMIT;
  }
  const limit = parseNonNegativeInteger(value, 'limit');
  if (limit < 1) {
    throw new BadRequestError('Invalid limit: must be at least 1');
  }
  return Math.min(limit, MAX_LIMIT);
}

function parseCursor(value: string | null): number {
  if (value === null || value === '') {
    return 0;
  }
  return parseNonNegativeInteger(value, 'cursor');
}

function parseNonNegativeInteger(value: string, field: string): number {
  if (!/^\d+$/.test(value)) {
    throw new BadRequestError(`Invalid ${field}: ${value}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new BadRequestError(`Invalid ${field}: ${value}`);
  }
  return parsed;
}

function makeNumericPrefixPattern(value: string): string {
  return `${value}%`;
}

function isOneOf<T extends readonly string[]>(value: string, allowed: T): value is T[number] {
  return (allowed as readonly string[]).includes(value);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
}

class BadRequestError extends Error {}

interface SearchQueryToken {
  kind: SearchTokenKind;
  token: string;
  queryWeight: number;
}

interface SearchQueryParams {
  query: string;
  vendors: Vendor[] | undefined;
  limit: number;
  offset: number;
}
