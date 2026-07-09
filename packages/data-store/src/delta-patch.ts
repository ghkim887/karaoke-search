import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { KaraokeNumbers, SongRecord } from '@karaoke/schema';
import { parseSearchHintFile } from './hints.js';
import type { SearchHintInput } from './hints.js';
import { exportSongs, readSongRecordsJson, validateSongCorpus } from './import-export.js';
import { createSongDatabase, openSongDatabase } from './schema.js';
import type { SongDatabase } from './schema.js';
import {
  GRAM1_DF_CAP,
  KARAOKE_PROVIDERS,
  collectTokenKeysForSongs,
  deleteSearchTokensForSongs,
  groupResolvedHints,
  pruneHighDfGram1Tokens,
  recalculateAffectedTokenStats,
  recalculateAllTokenStats,
  resolveSearchHints,
} from './search-index.js';
import type { ResolvedSearchHint } from './search-index.js';
import { prepareSongWriteStatements, writeSongRecordRows } from './song-writer.js';
import type { SongWriteStatements } from './song-writer.js';

export type DeltaPatchTokenStatMode = 'affected' | 'all';

export interface ApplySongDeltaPatchArgs {
  db: SongDatabase;
  baseRecords: readonly SongRecord[];
  candidateRecords: readonly SongRecord[];
  searchHints?: readonly SearchHintInput[];
  /** Validate that the SQLite DB currently exports exactly to `baseRecords`. Defaults to true. */
  checkDbMatchesBase?: boolean;
  /** Refuse broad changes unless the caller explicitly raises this limit. Defaults to 1000. */
  maxTouchedSongs?: number;
  /** Refuse broad changes by corpus ratio. Defaults to 0.02 (2%). */
  maxTouchedRatio?: number;
  /**
   * `affected` updates df/idf for tokens touched by changed songs only. `all`
   * fully refreshes `search_token_stats` without rebuilding per-song tokens.
   */
  tokenStatMode?: DeltaPatchTokenStatMode;
  /** Produce a manifest without mutating the DB. */
  dryRun?: boolean;
}

export interface PatchSongsJsonDeltaArgs
  extends Omit<ApplySongDeltaPatchArgs, 'db' | 'baseRecords' | 'candidateRecords' | 'searchHints'> {
  basePath: string;
  candidatePath: string;
  dbPath: string;
  searchHintPaths?: readonly string[];
  manifestPath?: string;
}

export interface ProviderNumberDuplicate {
  provider: keyof KaraokeNumbers;
  number: string;
  firstSongId: string;
  secondSongId: string;
}

export interface SongDeltaPatchManifest {
  generatedAt: string;
  dryRun: boolean;
  baseCount: number;
  candidateCount: number;
  addedCount: number;
  removedCount: number;
  changedCount: number;
  touchedSongCount: number;
  touchedSongRatio: number;
  sortOrderChangedCount: number;
  providerCounts: {
    base: Record<keyof KaraokeNumbers, number>;
    candidate: Record<keyof KaraokeNumbers, number>;
  };
  guardrails: {
    maxTouchedSongs: number;
    maxTouchedRatio: number;
    checkDbMatchesBase: boolean;
    duplicateProviderNumberCheck: 'passed';
    touchedLimitCheck: 'passed';
  };
  ids: {
    added: string[];
    removed: string[];
    changed: string[];
  };
  duplicateProviderNumbers: ProviderNumberDuplicate[];
  tokenStats: {
    mode: DeltaPatchTokenStatMode;
    affectedTokenCount: number;
    recalculatedTokenStatCount: number;
    /**
     * gram1 tokens deleted by the df-cap prune ({@link GRAM1_DF_CAP}) after this
     * patch's stat recalculation. In `affected` mode only tokens touched by the
     * delta are considered (one-directional — see `pruneHighDfGram1Tokens`).
     */
    prunedGram1TokenCount: number;
  };
  sqlite: {
    mutated: boolean;
    baseDbMatch: 'checked' | 'skipped';
  };
  rollback: {
    backupCreated: false;
    note: string;
  };
}

export function patchSongsJsonDelta(args: PatchSongsJsonDeltaArgs): SongDeltaPatchManifest {
  const baseRecords = readSongRecordsJson(args.basePath);
  const candidateRecords = readSongRecordsJson(args.candidatePath);
  const fileHints = (args.searchHintPaths ?? []).flatMap((path) => parseSearchHintFile(path));
  const db = openSongDatabase(args.dbPath);
  try {
    const patchArgs: ApplySongDeltaPatchArgs = {
      db,
      baseRecords,
      candidateRecords,
      searchHints: fileHints,
    };
    if (args.checkDbMatchesBase !== undefined) {
      patchArgs.checkDbMatchesBase = args.checkDbMatchesBase;
    }
    if (args.dryRun !== undefined) {
      patchArgs.dryRun = args.dryRun;
    }
    if (args.maxTouchedRatio !== undefined) {
      patchArgs.maxTouchedRatio = args.maxTouchedRatio;
    }
    if (args.maxTouchedSongs !== undefined) {
      patchArgs.maxTouchedSongs = args.maxTouchedSongs;
    }
    if (args.tokenStatMode !== undefined) {
      patchArgs.tokenStatMode = args.tokenStatMode;
    }
    const manifest = applySongDeltaPatch(patchArgs);
    if (args.manifestPath !== undefined) {
      writeJsonFile(args.manifestPath, manifest);
    }
    return manifest;
  } finally {
    db.close();
  }
}

export function applySongDeltaPatch(args: ApplySongDeltaPatchArgs): SongDeltaPatchManifest {
  validateSongCorpus(args.baseRecords);
  validateSongCorpus(args.candidateRecords);

  const checkDbMatchesBase = args.checkDbMatchesBase !== false;
  const maxTouchedSongs = args.maxTouchedSongs ?? 1000;
  const maxTouchedRatio = args.maxTouchedRatio ?? 0.02;
  const tokenStatMode = args.tokenStatMode ?? 'affected';
  if (tokenStatMode !== 'affected' && tokenStatMode !== 'all') {
    throw new Error(`Unknown token stat mode: ${tokenStatMode}`);
  }

  const delta = computeSongDelta(args.baseRecords, args.candidateRecords);
  const duplicateProviderNumbers = findDuplicateProviderNumbers(args.candidateRecords);
  if (duplicateProviderNumbers.length > 0) {
    const first = duplicateProviderNumbers[0] as ProviderNumberDuplicate;
    throw new Error(
      `Refusing delta patch with duplicate provider number: ${first.provider}:${first.number} ` +
        `appears on ${first.firstSongId} and ${first.secondSongId}`,
    );
  }
  if (delta.touchedIds.length > maxTouchedSongs) {
    throw new Error(
      `Refusing broad delta patch: ${delta.touchedIds.length} touched songs exceeds maxTouchedSongs=${maxTouchedSongs}`,
    );
  }
  if (delta.touchedRatio > maxTouchedRatio) {
    throw new Error(
      `Refusing broad delta patch: touched ratio ${formatRatio(delta.touchedRatio)} exceeds maxTouchedRatio=${maxTouchedRatio}`,
    );
  }

  if (checkDbMatchesBase) {
    assertDatabaseExportsBase(args.db, args.baseRecords);
  }

  const manifest = createPatchManifest({
    baseRecords: args.baseRecords,
    candidateRecords: args.candidateRecords,
    delta,
    duplicateProviderNumbers,
    dryRun: args.dryRun === true,
    maxTouchedRatio,
    maxTouchedSongs,
    checkDbMatchesBase,
    tokenStatMode,
  });
  if (args.dryRun === true) {
    return manifest;
  }

  const patchResult = mutateSongDelta(args.db, {
    candidateRecords: args.candidateRecords,
    delta,
    searchHints: args.searchHints ?? [],
    tokenStatMode,
  });
  manifest.sqlite.mutated = true;
  manifest.tokenStats.affectedTokenCount = patchResult.affectedTokenCount;
  manifest.tokenStats.recalculatedTokenStatCount = patchResult.recalculatedTokenStatCount;
  manifest.tokenStats.prunedGram1TokenCount = patchResult.prunedGram1TokenCount;
  return manifest;
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

interface SongDeltaComputation {
  addedIds: string[];
  removedIds: string[];
  changedIds: string[];
  touchedIds: string[];
  touchedRatio: number;
  sortOrderChangedCount: number;
}

function computeSongDelta(
  baseRecords: readonly SongRecord[],
  candidateRecords: readonly SongRecord[],
): SongDeltaComputation {
  const baseById = new Map(baseRecords.map((record) => [record.id, record]));
  const candidateById = new Map(candidateRecords.map((record) => [record.id, record]));
  const baseOrderById = new Map(baseRecords.map((record, index) => [record.id, index]));
  const addedIds: string[] = [];
  const removedIds: string[] = [];
  const changedIds: string[] = [];

  for (const record of candidateRecords) {
    const baseRecord = baseById.get(record.id);
    if (baseRecord === undefined) {
      addedIds.push(record.id);
    } else if (JSON.stringify(baseRecord) !== JSON.stringify(record)) {
      changedIds.push(record.id);
    }
  }
  for (const record of baseRecords) {
    if (!candidateById.has(record.id)) {
      removedIds.push(record.id);
    }
  }

  let sortOrderChangedCount = 0;
  candidateRecords.forEach((record, index) => {
    if (baseOrderById.get(record.id) !== index) {
      sortOrderChangedCount += 1;
    }
  });

  const touchedIds = [...addedIds, ...removedIds, ...changedIds].sort();
  const denominator = Math.max(baseRecords.length, 1);
  return {
    addedIds,
    removedIds,
    changedIds,
    touchedIds,
    touchedRatio: touchedIds.length / denominator,
    sortOrderChangedCount,
  };
}

function findDuplicateProviderNumbers(records: readonly SongRecord[]): ProviderNumberDuplicate[] {
  const duplicates: ProviderNumberDuplicate[] = [];
  for (const provider of KARAOKE_PROVIDERS) {
    const seen = new Map<string, string>();
    for (const record of records) {
      const number = record.karaoke_numbers[provider];
      if (number === null) {
        continue;
      }
      const previous = seen.get(number);
      if (previous !== undefined && previous !== record.id) {
        duplicates.push({
          provider,
          number,
          firstSongId: previous,
          secondSongId: record.id,
        });
        continue;
      }
      seen.set(number, record.id);
    }
  }
  return duplicates;
}

function assertDatabaseExportsBase(db: SongDatabase, baseRecords: readonly SongRecord[]): void {
  const exported = exportSongs(db);
  if (JSON.stringify(exported) === JSON.stringify(baseRecords)) {
    return;
  }
  const mismatch = firstCorpusMismatch(exported, baseRecords);
  throw new Error(`Refusing delta patch because SQLite DB does not match base corpus: ${mismatch}`);
}

function firstCorpusMismatch(
  actual: readonly SongRecord[],
  expected: readonly SongRecord[],
): string {
  if (actual.length !== expected.length) {
    return `db has ${actual.length} records but base has ${expected.length}`;
  }
  for (let index = 0; index < expected.length; index += 1) {
    const actualRecord = actual[index];
    const expectedRecord = expected[index];
    if (actualRecord === undefined || expectedRecord === undefined) {
      return `missing record at index ${index}`;
    }
    if (actualRecord.id !== expectedRecord.id) {
      return `index ${index} id differs: db=${actualRecord.id} base=${expectedRecord.id}`;
    }
    if (JSON.stringify(actualRecord) !== JSON.stringify(expectedRecord)) {
      return `record ${expectedRecord.id} differs`;
    }
  }
  return 'unknown mismatch';
}

function createPatchManifest({
  baseRecords,
  candidateRecords,
  delta,
  duplicateProviderNumbers,
  dryRun,
  maxTouchedRatio,
  maxTouchedSongs,
  checkDbMatchesBase,
  tokenStatMode,
}: {
  baseRecords: readonly SongRecord[];
  candidateRecords: readonly SongRecord[];
  delta: SongDeltaComputation;
  duplicateProviderNumbers: ProviderNumberDuplicate[];
  dryRun: boolean;
  maxTouchedRatio: number;
  maxTouchedSongs: number;
  checkDbMatchesBase: boolean;
  tokenStatMode: DeltaPatchTokenStatMode;
}): SongDeltaPatchManifest {
  return {
    generatedAt: new Date().toISOString(),
    dryRun,
    baseCount: baseRecords.length,
    candidateCount: candidateRecords.length,
    addedCount: delta.addedIds.length,
    removedCount: delta.removedIds.length,
    changedCount: delta.changedIds.length,
    touchedSongCount: delta.touchedIds.length,
    touchedSongRatio: delta.touchedRatio,
    sortOrderChangedCount: delta.sortOrderChangedCount,
    providerCounts: {
      base: providerCounts(baseRecords),
      candidate: providerCounts(candidateRecords),
    },
    guardrails: {
      maxTouchedSongs,
      maxTouchedRatio,
      checkDbMatchesBase,
      duplicateProviderNumberCheck: 'passed',
      touchedLimitCheck: 'passed',
    },
    ids: {
      added: delta.addedIds,
      removed: delta.removedIds,
      changed: delta.changedIds,
    },
    duplicateProviderNumbers,
    tokenStats: {
      mode: tokenStatMode,
      affectedTokenCount: 0,
      recalculatedTokenStatCount: 0,
      prunedGram1TokenCount: 0,
    },
    sqlite: {
      mutated: false,
      baseDbMatch: checkDbMatchesBase ? 'checked' : 'skipped',
    },
    rollback: {
      backupCreated: false,
      note: 'No SQLite backup is created by the delta patcher. Patch a staging DB or keep a prior release/symlink target for rollback before mutating a live DB.',
    },
  };
}

function providerCounts(records: readonly SongRecord[]): Record<keyof KaraokeNumbers, number> {
  return {
    tj: records.filter((record) => record.karaoke_numbers.tj !== null).length,
    ky: records.filter((record) => record.karaoke_numbers.ky !== null).length,
    joysound: records.filter((record) => record.karaoke_numbers.joysound !== null).length,
  };
}

interface DeltaMutationOptions {
  candidateRecords: readonly SongRecord[];
  delta: SongDeltaComputation;
  searchHints: readonly SearchHintInput[];
  tokenStatMode: DeltaPatchTokenStatMode;
}

interface DeltaMutationResult {
  affectedTokenCount: number;
  recalculatedTokenStatCount: number;
  prunedGram1TokenCount: number;
}

function mutateSongDelta(db: SongDatabase, options: DeltaMutationOptions): DeltaMutationResult {
  const migration = createSongDatabase(db);
  const candidateById = new Map(options.candidateRecords.map((record) => [record.id, record]));
  const sortOrderById = new Map(
    options.candidateRecords.map((record, index) => [record.id, index]),
  );
  const hintsBySongId = groupResolvedHints(
    resolveSearchHints(options.searchHints, options.candidateRecords),
  );
  const statements = prepareSongWriteStatements(db);
  const affectedTokenKeys = new Set<string>();

  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('BEGIN');
  try {
    // Converging a legacy DB may have DROPped+recreated a fully-derived search
    // table (see createSongDatabase), which empties it for EVERY song. The
    // touched-only path below would then leave untouched songs with no index
    // rows, so re-derive the whole corpus instead — the derived index tables
    // (search_texts/search_tokens/search_token_stats + hint tokens) then match a
    // fresh full import of the candidate corpus (the delta path never runs
    // ANALYZE, so sqlite_stat1 planner stats may still differ).
    if (migration.droppedDerivedTable) {
      const result = rebuildAllDerivedRows(db, statements, options, hintsBySongId);
      db.exec('COMMIT');
      return result;
    }

    // Collect the touched songs' OLD token keys in one set-based sweep before
    // deleting them (see collectTokenKeysForSongs), then drop their tokens in a
    // single set-based DELETE. `search_tokens` has no `song_id` index, so this
    // one-pass shape is what keeps the sweep cheap (I4) — the old per-song loop
    // would be one full scan per song without that index.
    collectTokenKeysForSongs(db, options.delta.touchedIds, affectedTokenKeys);
    deleteSearchTokensForSongs(db, options.delta.touchedIds);

    // The remaining child tables are `WITHOUT ROWID` with a `song_id`-leading
    // primary key, so a per-song delete already probes by PK — no index gap and
    // no benefit from batching. Keep them per-song alongside the conditional
    // `songs` delete for removed ids.
    for (const songId of options.delta.touchedIds) {
      statements.deleteSearchTexts.run(songId);
      statements.deleteNumbers.run(songId);
      statements.deleteAliases.run(songId);
      if (!candidateById.has(songId)) {
        statements.deleteSong.run(songId);
      }
    }

    for (const songId of options.delta.touchedIds) {
      const record = candidateById.get(songId);
      if (record === undefined) {
        continue;
      }
      const sortOrder = sortOrderById.get(songId);
      if (sortOrder === undefined) {
        throw new Error(`Missing candidate sort order for ${songId}`);
      }
      writeSongRecordRows(statements, record, sortOrder, hintsBySongId.get(songId) ?? []);
    }

    // Collect the NEW token keys in one set-based sweep after re-inserting.
    // Removed songs have no rows now, so they contribute nothing — making this
    // union over all touched ids identical to the old per-re-inserted-song
    // collect, and keeping affectedTokenKeys (which the gram1 prune consumes)
    // byte-for-byte equivalent to the previous per-song accumulation.
    collectTokenKeysForSongs(db, options.delta.touchedIds, affectedTokenKeys);

    // Preserve exact candidate export order even when the delta removed rows and
    // shifted many untouched records. This is cheap relative to token rebuilds.
    options.candidateRecords.forEach((record, index) => {
      statements.updateSortOrder.run(index, record.id, index);
    });

    const recalculatedTokenStatCount =
      options.tokenStatMode === 'all'
        ? recalculateAllTokenStats(db, options.candidateRecords.length)
        : recalculateAffectedTokenStats(db, affectedTokenKeys, options.candidateRecords.length);
    // Apply the same gram1 df-cap as the full import, over freshly-recomputed df.
    // `all` mode re-swept every stat, so prune the whole corpus; `affected` mode
    // only refreshed touched tokens, so restrict the prune to those (the
    // documented one-directional behavior — see pruneHighDfGram1Tokens).
    const prunedGram1TokenCount =
      options.tokenStatMode === 'all'
        ? pruneHighDfGram1Tokens(db, GRAM1_DF_CAP)
        : pruneHighDfGram1Tokens(db, GRAM1_DF_CAP, affectedTokenKeys);
    db.exec('COMMIT');
    return {
      affectedTokenCount: affectedTokenKeys.size,
      recalculatedTokenStatCount,
      prunedGram1TokenCount,
    };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Recovery path for when {@link createSongDatabase} had to DROP+recreate a
 * fully-derived search table to converge a legacy DB. That drop empties the
 * table for EVERY song, so a touched-only re-derivation would strand untouched
 * songs with no index rows. Instead, re-derive the entire corpus like a full
 * {@link importSongs}: the enumerated derived index tables
 * (`search_texts`/`search_tokens`/`search_token_stats` and the hint tokens) are
 * identical to a fresh full import of the candidate corpus. This does NOT run
 * ANALYZE (the delta path never does), so `sqlite_stat1` planner statistics may
 * differ from a full import — a planner-only artifact, never query results or
 * exported data. Runs inside the caller's transaction. `affectedTokenCount`
 * reflects that every stat row was recomputed (the whole corpus was affected).
 */
function rebuildAllDerivedRows(
  db: SongDatabase,
  statements: SongWriteStatements,
  options: DeltaMutationOptions,
  hintsBySongId: Map<string, ResolvedSearchHint[]>,
): DeltaMutationResult {
  // Drop songs the candidate no longer contains; ON DELETE CASCADE clears their
  // numbers/aliases (search rows were already emptied by the migration).
  for (const songId of options.delta.removedIds) {
    statements.deleteSong.run(songId);
  }
  // Clear all derived index state so the re-derivation starts from a clean,
  // corpus-complete slate. `search_texts`/`search_tokens` are already empty from
  // the migration drop; `search_token_stats` (never dropped by a migration)
  // still holds the pre-drop rows and must be discarded before recompute.
  db.exec('DELETE FROM search_token_stats; DELETE FROM search_tokens; DELETE FROM search_texts');
  options.candidateRecords.forEach((record, index) => {
    // Numbers/aliases survive for untouched songs; clear before the shared
    // writer re-inserts them, exactly as the full-import path does. The upsert
    // sets each song's sort_order to its candidate index, so no separate
    // sort-order pass is needed.
    statements.deleteNumbers.run(record.id);
    statements.deleteAliases.run(record.id);
    writeSongRecordRows(statements, record, index, hintsBySongId.get(record.id) ?? []);
  });
  const recalculatedTokenStatCount = recalculateAllTokenStats(db, options.candidateRecords.length);
  const prunedGram1TokenCount = pruneHighDfGram1Tokens(db, GRAM1_DF_CAP);
  return {
    affectedTokenCount: recalculatedTokenStatCount,
    recalculatedTokenStatCount,
    prunedGram1TokenCount,
  };
}

function formatRatio(value: number): string {
  return Number.isFinite(value) ? value.toFixed(6) : String(value);
}
