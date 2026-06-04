import type { Category, KaraokeNumbers, SongRecord } from '@karaoke/schema';
import {
  compactSearchText,
  makeCharacterNgrams,
  makeHangulInitials,
  parseKaraokeNumberQuery,
  tokenizeSearchWords,
} from '@karaoke/search';

export interface Env {
  DB: D1DatabaseLike;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
}

export interface D1PreparedStatementLike {
  bind(...values: D1Value[]): D1PreparedStatementLike;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

export interface D1Result<T> {
  results?: T[];
}

type D1Value = string | number | null;
type Vendor = (typeof VENDORS)[number];
type TitleKoSource = NonNullable<SongRecord['title_ko_source']>;
type TitleKoConfidence = NonNullable<SongRecord['title_ko_confidence']>;

const CATEGORIES = ['jpop', 'vocaloid', 'anime'] as const;
const VENDORS = ['tj', 'ky', 'joysound'] as const;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const MAX_QUERY_TOKENS = 24;
const MAX_PREFIX_TOKEN_CHARS = 12;
const VENDOR_MASKS: Record<Vendor, number> = { tj: 1, ky: 2, joysound: 4 };
const HANGUL_INITIALS_QUERY_PATTERN = /^[ㄱ-ㅎ]+$/u;
const JSON_HEADERS = {
  'access-control-allow-origin': '*',
  'content-type': 'application/json; charset=utf-8',
};

export default {
  fetch: handleRequest,
};

export async function handleRequest(request: Request, env: Env): Promise<Response> {
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

  if (url.pathname !== '/api/search') {
    return json({ error: 'Not found' }, 404);
  }
  if (request.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    return await handleSearchRequest(request, env.DB);
  } catch (error) {
    if (error instanceof BadRequestError) {
      return json({ error: error.message }, 400);
    }
    return json({ error: 'Internal server error' }, 500);
  }
}

export async function handleSearchRequest(request: Request, db: D1DatabaseLike): Promise<Response> {
  const url = new URL(request.url);
  const query = url.searchParams.get('q')?.trim() ?? '';
  const category = parseCategory(url.searchParams.get('category'));
  const vendor = parseVendor(url.searchParams.get('vendor'));
  const limit = parseLimit(url.searchParams.get('limit'));
  const offset = parseCursor(url.searchParams.get('cursor'));

  const candidateRows = await findCandidateRows(db, {
    query,
    category,
    vendor,
    limit: limit + 1,
    offset,
  });
  const hasMore = candidateRows.length > limit;
  const pageRows = candidateRows.slice(0, limit);
  const items = await hydrateSongs(db, pageRows);

  return json({ items, nextCursor: hasMore ? String(offset + limit) : null });
}

async function findCandidateRows(
  db: D1DatabaseLike,
  params: SearchQueryParams,
): Promise<StoredSongRow[]> {
  if (params.query.length === 0) {
    return findFilteredRows(db, params);
  }
  return findIndexedCandidateRows(db, params);
}

async function findFilteredRows(
  db: D1DatabaseLike,
  params: SearchQueryParams,
): Promise<StoredSongRow[]> {
  const where: string[] = [];
  const values: D1Value[] = [];
  appendSongFilters(where, values, params, 's');

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const statement = db
    .prepare(
      `SELECT
        s.id,
        s.source_url,
        s.title_primary,
        s.title_ko,
        s.artist_primary,
        s.artist_ko,
        s.artist_aliases_present,
        s.crawled_at,
        s.media_context_ko,
        s.title_ko_source,
        s.title_ko_confidence
      FROM songs s
      ${whereSql}
      ORDER BY s.sort_order ASC, s.id ASC
      LIMIT ? OFFSET ?`,
    )
    .bind(...values, params.limit, params.offset);

  return allRows<StoredSongRow>(statement);
}

async function findIndexedCandidateRows(
  db: D1DatabaseLike,
  params: SearchQueryParams,
): Promise<StoredSongRow[]> {
  const numberQuery = parseKaraokeNumberQuery(params.query);
  if (numberQuery !== null) {
    return findKaraokeNumberCandidateRows(db, params, numberQuery);
  }

  const subqueries: string[] = [];
  const values: D1Value[] = [];
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
      SELECT st.song_id, SUM(st.weight * qt.query_weight * COALESCE(stats.idf_scaled, 1000)) AS score
      FROM search_tokens st
      JOIN query_tokens qt ON qt.kind = st.kind AND qt.token = st.token
      LEFT JOIN search_token_stats stats ON stats.kind = st.kind AND stats.token = st.token
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      GROUP BY st.song_id
    `);
  }

  const compactQuery = compactSearchText(params.query);
  if (Array.from(compactQuery).length >= 2) {
    const where = ['sx.text_compact = ?'];
    values.push(compactQuery);
    appendIndexFilters(where, values, params, 'sx');
    subqueries.push(`
      SELECT sx.song_id, MAX(sx.weight * 2000000) AS score
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
        SELECT song_id, SUM(score) AS score
        FROM candidates
        GROUP BY song_id
      )
      SELECT
        s.id,
        s.source_url,
        s.title_primary,
        s.title_ko,
        s.artist_primary,
        s.artist_ko,
        s.artist_aliases_present,
        s.crawled_at,
        s.media_context_ko,
        s.title_ko_source,
        s.title_ko_confidence
      FROM ranked r
      JOIN songs s ON s.id = r.song_id
      ORDER BY r.score DESC, s.sort_order ASC, s.id ASC
      LIMIT ? OFFSET ?`,
    )
    .bind(...values, params.limit, params.offset);

  return allRows<StoredSongRow>(statement);
}

async function findKaraokeNumberCandidateRows(
  db: D1DatabaseLike,
  params: SearchQueryParams,
  numberQuery: NonNullable<ReturnType<typeof parseKaraokeNumberQuery>>,
): Promise<StoredSongRow[]> {
  const subqueries: string[] = [];
  const values: D1Value[] = [];
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
    predicateSql: 'kn.number >= ? AND kn.number < ?',
    predicateValues: [numberQuery.number, nextDigitPrefixUpperBound(numberQuery.number)],
    notNullColumn: 'number',
    score: 900000000,
  });

  appendKaraokeNumberCandidateSubquery({
    subqueries,
    values,
    params,
    provider: numberQuery.provider,
    predicateSql: 'kn.number_key >= ? AND kn.number_key < ?',
    predicateValues: [trimmedNumber, nextDigitPrefixUpperBound(trimmedNumber)],
    notNullColumn: 'number_key',
    score: 890000000,
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
      SELECT
        s.id,
        s.source_url,
        s.title_primary,
        s.title_ko,
        s.artist_primary,
        s.artist_ko,
        s.artist_aliases_present,
        s.crawled_at,
        s.media_context_ko,
        s.title_ko_source,
        s.title_ko_confidence
      FROM ranked r
      JOIN songs s ON s.id = r.song_id
      ORDER BY r.score DESC, s.sort_order ASC, s.id ASC
      LIMIT ? OFFSET ?`,
    )
    .bind(...values, params.limit, params.offset);

  return allRows<StoredSongRow>(statement);
}

async function hydrateSongs(
  db: D1DatabaseLike,
  rows: readonly StoredSongRow[],
): Promise<SongRecord[]> {
  if (rows.length === 0) {
    return [];
  }

  const ids = rows.map((row) => row.id);
  const placeholders = ids.map(() => '?').join(', ');
  const [numberRows, categoryRows, aliasRows] = await Promise.all([
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
    allRows<CategoryRow>(
      db
        .prepare(
          `SELECT song_id, category
          FROM song_categories
          WHERE song_id IN (${placeholders})
          ORDER BY song_id ASC, position ASC`,
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
  const categoriesBySong = new Map<string, Category[]>();
  const aliasesBySong = new Map<string, string[]>();
  for (const id of ids) {
    numbersBySong.set(id, { tj: null, ky: null, joysound: null });
    categoriesBySong.set(id, []);
    aliasesBySong.set(id, []);
  }

  for (const row of numberRows) {
    const numbers = numbersBySong.get(row.song_id);
    if (numbers !== undefined) {
      numbers[row.provider] = row.number;
    }
  }
  for (const row of categoryRows) {
    categoriesBySong.get(row.song_id)?.push(row.category);
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
      categories: categoriesBySong.get(row.id) ?? [],
      crawled_at: row.crawled_at,
      ...(row.media_context_ko !== null ? { media_context_ko: row.media_context_ko } : {}),
      ...(row.title_ko_source !== null ? { title_ko_source: row.title_ko_source } : {}),
      ...(row.title_ko_confidence !== null ? { title_ko_confidence: row.title_ko_confidence } : {}),
    };
  });
}

async function allRows<T>(statement: D1PreparedStatementLike): Promise<T[]> {
  const result = await statement.all<T>();
  return result.results ?? [];
}

function appendSongFilters(
  where: string[],
  values: D1Value[],
  params: Pick<SearchQueryParams, 'category' | 'vendor'>,
  songAlias: string,
): void {
  if (params.category !== undefined) {
    where.push(`EXISTS (
      SELECT 1 FROM song_categories sc
      WHERE sc.song_id = ${songAlias}.id AND sc.category = ?
    )`);
    values.push(params.category);
  }

  if (params.vendor !== undefined) {
    where.push(`EXISTS (
      SELECT 1 FROM karaoke_numbers vn
      WHERE vn.song_id = ${songAlias}.id AND vn.provider = ? AND vn.number IS NOT NULL
    )`);
    values.push(params.vendor);
  }
}

function appendIndexFilters(
  where: string[],
  values: D1Value[],
  params: Pick<SearchQueryParams, 'category' | 'vendor'>,
  indexAlias: string,
): void {
  if (params.category !== undefined) {
    where.push(`${indexAlias}.category = ?`);
    values.push(params.category);
  }
  if (params.vendor !== undefined) {
    where.push(`(${indexAlias}.provider_mask & ?) != 0`);
    values.push(VENDOR_MASKS[params.vendor]);
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
  values: D1Value[];
  params: Pick<SearchQueryParams, 'category' | 'vendor'>;
  provider: Vendor | undefined;
  predicateSql: string;
  predicateValues: readonly D1Value[];
  notNullColumn: 'number' | 'number_key';
  score: number;
}): void {
  const where = [`kn.${notNullColumn} IS NOT NULL`, predicateSql];
  const branchValues: D1Value[] = [...predicateValues];
  if (provider !== undefined) {
    where.push('kn.provider = ?');
    branchValues.push(provider);
  }
  if (params.vendor !== undefined) {
    where.push('kn.provider = ?');
    branchValues.push(params.vendor);
  }
  if (params.category !== undefined) {
    where.push(`EXISTS (
      SELECT 1 FROM song_categories sc
      WHERE sc.song_id = kn.song_id AND sc.category = ?
    )`);
    branchValues.push(params.category);
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
    if (Array.from(token).length < 2) {
      return;
    }
    const key = `${kind}\u0000${token}`;
    const existing = byKey.get(key);
    if (existing === undefined || queryWeight > existing.queryWeight) {
      byKey.set(key, { kind, token, queryWeight });
    }
  };

  for (const word of tokenizeSearchWords(query)) {
    const wordLength = Array.from(word).length;
    add('term', word, 45);
    if (wordLength <= MAX_PREFIX_TOKEN_CHARS) {
      add('prefix', word, 30);
    } else {
      add('prefix', Array.from(word).slice(0, MAX_PREFIX_TOKEN_CHARS).join(''), 30);
    }
  }

  const compactQuery = compactSearchText(query);
  const compactLength = Array.from(compactQuery).length;
  if (hasNonAsciiCharacter(compactQuery) && compactLength >= 2) {
    for (const gram of makeCharacterNgrams(compactQuery, 2)) {
      add('gram2', gram, 12);
    }
  }
  if (hasNonAsciiCharacter(compactQuery) && compactLength >= 3) {
    for (const gram of makeCharacterNgrams(compactQuery, 3)) {
      add('gram3', gram, 18);
    }
  }

  const hangulInitials = makeHangulInitials(query);
  if (hangulInitials.length >= 2) {
    add('initial', hangulInitials.slice(0, MAX_PREFIX_TOKEN_CHARS), 35);
  }
  if (HANGUL_INITIALS_QUERY_PATTERN.test(compactQuery)) {
    add('initial', Array.from(compactQuery).slice(0, MAX_PREFIX_TOKEN_CHARS).join(''), 35);
  }

  return Array.from(byKey.values())
    .sort(
      (left, right) =>
        right.queryWeight - left.queryWeight ||
        left.kind.localeCompare(right.kind) ||
        left.token.localeCompare(right.token),
    )
    .slice(0, MAX_QUERY_TOKENS);
}

function trimLeadingZeroes(value: string): string {
  return value.replace(/^0+/u, '') || '0';
}

function nextDigitPrefixUpperBound(prefix: string): string {
  const characters = Array.from(prefix);
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index];
    if (character !== undefined && character >= '0' && character <= '8') {
      characters[index] = String(Number(character) + 1);
      return characters.slice(0, index + 1).join('');
    }
  }
  return `${characters.slice(0, -1).join('')}:`;
}

function hasNonAsciiCharacter(value: string): boolean {
  return Array.from(value).some((character) => (character.codePointAt(0) ?? 0) > 0x7f);
}

function parseCategory(value: string | null): Category | undefined {
  if (value === null || value === '') {
    return undefined;
  }
  if (!isOneOf(value, CATEGORIES)) {
    throw new BadRequestError(`Invalid category: ${value}`);
  }
  return value;
}

function parseVendor(value: string | null): Vendor | undefined {
  if (value === null || value === '') {
    return undefined;
  }
  if (!isOneOf(value, VENDORS)) {
    throw new BadRequestError(`Invalid vendor: ${value}`);
  }
  return value;
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

type SearchTokenKind = 'term' | 'prefix' | 'gram2' | 'gram3' | 'initial';

interface SearchQueryToken {
  kind: SearchTokenKind;
  token: string;
  queryWeight: number;
}

interface SearchQueryParams {
  query: string;
  category: Category | undefined;
  vendor: Vendor | undefined;
  limit: number;
  offset: number;
}

interface StoredSongRow {
  id: string;
  source_url: string;
  title_primary: string;
  title_ko: string | null;
  artist_primary: string;
  artist_ko: string | null;
  artist_aliases_present: number;
  crawled_at: string;
  media_context_ko: string | null;
  title_ko_source: TitleKoSource | null;
  title_ko_confidence: TitleKoConfidence | null;
}

interface KaraokeNumberRow {
  song_id: string;
  provider: Vendor;
  number: string | null;
}

interface CategoryRow {
  song_id: string;
  category: Category;
}

interface AliasRow {
  song_id: string;
  alias: string;
}
