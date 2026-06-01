import type { Category, KaraokeNumbers, SongRecord } from '@karaoke/schema';

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
type Vendor = keyof KaraokeNumbers;
type TitleKoSource = NonNullable<SongRecord['title_ko_source']>;
type TitleKoConfidence = NonNullable<SongRecord['title_ko_confidence']>;

const CATEGORIES = ['jpop', 'vocaloid', 'anime'] as const;
const VENDORS = ['tj', 'ky', 'joysound'] as const;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const MAX_LIKE_PATTERN_BYTES = 50;
const TEXT_ENCODER = new TextEncoder();
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
  const where: string[] = [];
  const values: D1Value[] = [];

  if (params.query.length > 0) {
    const like = makeLikePattern(params.query);
    where.push(`(
      s.title_primary LIKE ? ESCAPE '\\'
      OR s.title_ko LIKE ? ESCAPE '\\'
      OR s.artist_primary LIKE ? ESCAPE '\\'
      OR s.artist_ko LIKE ? ESCAPE '\\'
      OR EXISTS (
        SELECT 1 FROM artist_aliases aa
        WHERE aa.song_id = s.id AND aa.alias LIKE ? ESCAPE '\\'
      )
      OR EXISTS (
        SELECT 1 FROM karaoke_numbers qn
        WHERE qn.song_id = s.id AND qn.number = ?
      )
    )`);
    values.push(like, like, like, like, like, params.query);
  }

  if (params.category !== undefined) {
    where.push(`EXISTS (
      SELECT 1 FROM song_categories sc
      WHERE sc.song_id = s.id AND sc.category = ?
    )`);
    values.push(params.category);
  }

  if (params.vendor !== undefined) {
    where.push(`EXISTS (
      SELECT 1 FROM karaoke_numbers vn
      WHERE vn.song_id = s.id AND vn.provider = ? AND vn.number IS NOT NULL
    )`);
    values.push(params.vendor);
  }

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

function makeLikePattern(query: string): string {
  const pattern = `%${escapeLike(query)}%`;
  if (TEXT_ENCODER.encode(pattern).byteLength > MAX_LIKE_PATTERN_BYTES) {
    throw new BadRequestError(
      `Search query is too long: LIKE pattern exceeds ${MAX_LIKE_PATTERN_BYTES} UTF-8 bytes`,
    );
  }
  return pattern;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
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
