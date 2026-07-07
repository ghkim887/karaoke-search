// Barrel entry for @karaoke/data-store. The implementation is split by
// responsibility across sibling modules; this file re-exports the complete
// public API (unchanged names and signatures) that the worker, the CLI, and
// tests depend on. Keep additions here in sync with the owning module.
export { SONG_SCHEMA_SQL, createSongDatabase, openSongDatabase } from './schema.js';
export type { SongDatabase } from './schema.js';

export { parseSearchHintFile } from './hints.js';
export type { SearchHintInput } from './hints.js';

export {
  SONG_COLUMNS,
  SONG_SERVE_COLUMNS,
  exportSongs,
  exportSongsJson,
  importSongs,
  importSongsJson,
  readSongRecordsJson,
  songColumnsProjection,
  songServeColumnsProjection,
} from './import-export.js';
export type {
  AliasRow,
  ExportSongsJsonArgs,
  ImportSongsJsonArgs,
  ImportSongsOptions,
  KaraokeNumberRow,
  StoredSongRow,
} from './import-export.js';

export { applySongDeltaPatch, patchSongsJsonDelta } from './delta-patch.js';
export type {
  ApplySongDeltaPatchArgs,
  DeltaPatchTokenStatMode,
  PatchSongsJsonDeltaArgs,
  ProviderNumberDuplicate,
  SongDeltaPatchManifest,
} from './delta-patch.js';
