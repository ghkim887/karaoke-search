import type { SongRecord } from '@karaoke/schema';
import { compactSearchText, normalizeSearchText } from '@karaoke/search';
import type { PreparedStatement, SongDatabase } from './schema.js';
import {
  HINT_TOKEN_FIELD_BY_HINT_FIELD,
  addSearchTokens,
  karaokeNumberKey,
  karaokeProviderMask,
  searchTextInputs,
} from './search-index.js';
import type { ResolvedSearchHint, SearchTokenInput, SearchTokenRow } from './search-index.js';

/**
 * The single set of prepared statements every write path uses. Both the
 * full-corpus {@link importSongs} and the incremental delta patcher acquire
 * these and route all row writes through {@link writeSongRecordRows}, so the
 * `songs`/`karaoke_numbers`/`artist_aliases`/`search_*` rows a song produces are
 * byte-identical no matter which path wrote them.
 */
export interface SongWriteStatements {
  upsertSong: PreparedStatement;
  updateSortOrder: PreparedStatement;
  deleteSong: PreparedStatement;
  deleteNumbers: PreparedStatement;
  deleteAliases: PreparedStatement;
  deleteSearchTexts: PreparedStatement;
  deleteSearchHints: PreparedStatement;
  insertNumber: PreparedStatement;
  insertAlias: PreparedStatement;
  insertSearchText: PreparedStatement;
  insertSearchToken: PreparedStatement;
  insertSearchHint: PreparedStatement;
}

export function prepareSongWriteStatements(db: SongDatabase): SongWriteStatements {
  return {
    upsertSong: db.prepare(`
      INSERT INTO songs (
        id,
        sort_order,
        source_url,
        title_primary,
        title_ko,
        artist_primary,
        artist_ko,
        artist_aliases_present,
        crawled_at,
        media_context_ko,
        title_ko_source,
        title_ko_confidence,
        title_ruby
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        sort_order = excluded.sort_order,
        source_url = excluded.source_url,
        title_primary = excluded.title_primary,
        title_ko = excluded.title_ko,
        artist_primary = excluded.artist_primary,
        artist_ko = excluded.artist_ko,
        artist_aliases_present = excluded.artist_aliases_present,
        crawled_at = excluded.crawled_at,
        media_context_ko = excluded.media_context_ko,
        title_ko_source = excluded.title_ko_source,
        title_ko_confidence = excluded.title_ko_confidence,
        title_ruby = excluded.title_ruby
    `),
    updateSortOrder: db.prepare('UPDATE songs SET sort_order = ? WHERE id = ? AND sort_order <> ?'),
    deleteSong: db.prepare('DELETE FROM songs WHERE id = ?'),
    deleteNumbers: db.prepare('DELETE FROM karaoke_numbers WHERE song_id = ?'),
    deleteAliases: db.prepare('DELETE FROM artist_aliases WHERE song_id = ?'),
    deleteSearchTexts: db.prepare('DELETE FROM search_texts WHERE song_id = ?'),
    deleteSearchHints: db.prepare('DELETE FROM search_hints WHERE song_id = ?'),
    insertNumber: db.prepare(
      'INSERT INTO karaoke_numbers (song_id, provider, number, number_key) VALUES (?, ?, ?, ?)',
    ),
    insertAlias: db.prepare(
      'INSERT INTO artist_aliases (song_id, position, alias) VALUES (?, ?, ?)',
    ),
    insertSearchText: db.prepare(
      `INSERT OR IGNORE INTO search_texts (
        song_id,
        field,
        text_norm,
        text_compact,
        weight,
        provider_mask
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    insertSearchToken: db.prepare(
      `INSERT OR IGNORE INTO search_tokens (
        kind,
        token,
        song_id,
        field,
        weight,
        provider_mask
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    insertSearchHint: db.prepare(
      `INSERT OR IGNORE INTO search_hints (
        song_id,
        field,
        source,
        text_norm,
        text_compact,
        weight,
        provider_mask,
        confidence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
  };
}

/**
 * Write every derived row for a single song: the `songs` upsert, its karaoke
 * numbers and aliases, the canonical `search_texts`/`search_tokens`, and any
 * SEARCH-ONLY hints plus their hint tokens. Callers are responsible for having
 * cleared prior child rows (numbers/aliases and, for delta, per-song search
 * rows); this function only inserts.
 */
export function writeSongRecordRows(
  statements: SongWriteStatements,
  record: SongRecord,
  sortOrder: number,
  hints: readonly ResolvedSearchHint[],
): void {
  statements.upsertSong.run(
    record.id,
    sortOrder,
    record.source_url,
    record.title_primary,
    record.title_ko,
    record.artist_primary,
    record.artist_ko,
    record.artist_aliases === undefined ? 0 : 1,
    record.crawled_at,
    record.media_context_ko ?? null,
    record.title_ko_source ?? null,
    record.title_ko_confidence ?? null,
    record.title_ruby ?? null,
  );
  statements.insertNumber.run(
    record.id,
    'tj',
    record.karaoke_numbers.tj,
    karaokeNumberKey(record.karaoke_numbers.tj),
  );
  statements.insertNumber.run(
    record.id,
    'ky',
    record.karaoke_numbers.ky,
    karaokeNumberKey(record.karaoke_numbers.ky),
  );
  statements.insertNumber.run(
    record.id,
    'joysound',
    record.karaoke_numbers.joysound,
    karaokeNumberKey(record.karaoke_numbers.joysound),
  );
  record.artist_aliases?.forEach((alias, aliasIndex) => {
    statements.insertAlias.run(record.id, aliasIndex, alias);
  });

  const providerMask = karaokeProviderMask(record.karaoke_numbers);
  for (const input of searchTextInputs(record)) {
    const textCompact = compactSearchText(input.value);
    if (textCompact.length === 0) {
      continue;
    }
    statements.insertSearchText.run(
      record.id,
      input.field,
      normalizeSearchText(input.value).trim(),
      textCompact,
      input.weight,
      providerMask,
    );
    writeSearchTokens(statements, {
      songId: record.id,
      field: input.field,
      value: input.value,
      textCompact,
      weight: input.weight,
      providerMask,
    });
  }

  for (const hint of hints) {
    statements.insertSearchHint.run(
      hint.songId,
      hint.field,
      hint.source,
      hint.textNorm,
      hint.textCompact,
      hint.weight,
      hint.providerMask,
      hint.confidence,
    );
    writeSearchTokens(statements, {
      songId: hint.songId,
      field: HINT_TOKEN_FIELD_BY_HINT_FIELD[hint.field],
      value: hint.textNorm,
      textCompact: hint.textCompact,
      weight: hint.weight,
      providerMask: hint.providerMask,
    });
  }
}

function writeSearchTokens(statements: SongWriteStatements, input: SearchTokenInput): void {
  const rows: SearchTokenRow[] = [];
  addSearchTokens(rows, new Set<string>(), input);
  for (const row of rows) {
    statements.insertSearchToken.run(
      row.kind,
      row.token,
      row.songId,
      row.field,
      row.weight,
      row.providerMask,
    );
  }
}
