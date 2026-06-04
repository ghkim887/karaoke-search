import { type SongDatabase, openSongDatabase } from '@karaoke/data-store';
import type { D1DatabaseLike, D1PreparedStatementLike, D1Result } from './index.js';

type SqliteValue = string | number | null;
type SqliteStatement = ReturnType<SongDatabase['prepare']>;

export interface SqliteD1Options {
  inspectStatement?: (sql: string, parameters: readonly SqliteValue[]) => void;
  enforceD1SuffixLikePatternLimit?: boolean;
}

export interface OpenSqliteD1Options extends SqliteD1Options {
  /**
   * Enables SQLite query-only mode for this connection. This is the default for
   * the self-host API because the HTTP server should only serve a prebuilt DB.
   */
  queryOnly?: boolean;
}

export class SqliteD1Database implements D1DatabaseLike {
  constructor(
    private readonly db: SongDatabase,
    private readonly options: SqliteD1Options = {},
  ) {}

  prepare(sql: string): D1PreparedStatementLike {
    const statement = this.db.prepare(sql);
    return this.boundStatement(statement, []);
  }

  close(): void {
    this.db.close();
  }

  private boundStatement(
    statement: SqliteStatement,
    parameters: readonly SqliteValue[],
  ): D1PreparedStatementLike {
    return {
      bind: (...values: SqliteValue[]) => this.boundStatement(statement, values),
      all: async <T = Record<string, unknown>>(): Promise<D1Result<T>> => {
        this.options.inspectStatement?.(statement.sourceSQL, parameters);
        this.assertD1SuffixLikePatterns(parameters);
        return { results: statement.all(...parameters) as T[] };
      },
    };
  }

  private assertD1SuffixLikePatterns(parameters: readonly SqliteValue[]): void {
    if (this.options.enforceD1SuffixLikePatternLimit !== true) {
      return;
    }
    for (const parameter of parameters) {
      if (
        typeof parameter === 'string' &&
        parameter.endsWith('%') &&
        new TextEncoder().encode(parameter).length > 50
      ) {
        throw new Error('D1 LIKE/GLOB pattern limit exceeded');
      }
    }
  }
}

export function openSqliteD1Database(
  path: string,
  options: OpenSqliteD1Options = {},
): SqliteD1Database {
  const db = openSongDatabase(path);
  if (options.queryOnly !== false) {
    db.exec('PRAGMA query_only = ON');
  }
  return new SqliteD1Database(db, options);
}
