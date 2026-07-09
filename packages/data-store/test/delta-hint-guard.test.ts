import type { SongRecord } from '@karaoke/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SearchHintInput } from '../src/hints.js';
import {
  applySongDeltaPatch,
  createSongDatabase,
  importSongs,
  openSongDatabase,
} from '../src/index.js';
import type { SongDatabase } from '../src/schema.js';

const openDatabases: SongDatabase[] = [];

function openMemoryDb(): SongDatabase {
  const db = openSongDatabase(':memory:');
  openDatabases.push(db);
  return db;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (openDatabases.length > 0) {
    openDatabases.pop()?.close();
  }
});

function song(id: string, title: string, artist: string): SongRecord {
  return {
    id,
    source_url: 'https://example.com/x',
    title_primary: title,
    title_ko: null,
    artist_primary: artist,
    artist_ko: null,
    karaoke_numbers: { tj: id.replace(/[^0-9]/gu, '') || '1', ky: null, joysound: null },
    crawled_at: '2026-01-01T00:00:00.000Z',
  };
}

function hintTokenCount(
  db: SongDatabase,
  songId: string,
  field: 'title_hint' | 'artist_hint',
): number {
  return (
    db
      .prepare('SELECT COUNT(*) AS c FROM search_tokens WHERE song_id = ? AND field = ?')
      .get(songId, field) as { c: number }
  ).c;
}

// A delta re-resolves search hints against the FULL candidate corpus but only
// materializes hint tokens for the songs it touched. A hint whose target song
// is untouched is therefore silently ignored on the touched-only delta path
// (a full import/release build would apply it). The delta patcher emits ONE
// non-fatal stderr warning in that case and leaves materialization unchanged.
describe('delta patch — search-hint guard for untouched songs', () => {
  const base: SongRecord[] = [
    song('tj-1', 'alpha song', 'first artist'),
    song('tj-2', 'beta song', 'second artist'),
  ];
  // Only tj-1 changes; tj-2 is untouched by the delta.
  const candidate: SongRecord[] = [
    song('tj-1', 'alpha song remastered', 'first artist'),
    song('tj-2', 'beta song', 'second artist'),
  ];

  it('warns (non-fatally) and does NOT materialize a hint targeting an untouched song', () => {
    const db = openMemoryDb();
    createSongDatabase(db);
    importSongs(db, base);

    const untouchedHint: SearchHintInput[] = [
      {
        songId: 'tj-2',
        field: 'artist',
        text: 'curated alias',
        source: 'manual',
        confidence: 'high',
      },
    ];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    applySongDeltaPatch({
      db,
      baseRecords: base,
      candidateRecords: candidate,
      searchHints: untouchedHint,
      checkDbMatchesBase: false,
      maxTouchedSongs: 100,
      maxTouchedRatio: 1,
    });

    // Exactly one warning: count + sample id + the remediation guidance.
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('1 song');
    expect(message).toContain('tj-2');
    expect(message).toContain('full import');
    // The untouched song's hint tokens are NOT materialized by the delta.
    expect(hintTokenCount(db, 'tj-2', 'artist_hint')).toBe(0);
  });

  it('does NOT warn and DOES materialize a hint targeting a touched song', () => {
    const db = openMemoryDb();
    createSongDatabase(db);
    importSongs(db, base);

    const touchedHint: SearchHintInput[] = [
      {
        songId: 'tj-1',
        field: 'artist',
        text: 'curated alias',
        source: 'manual',
        confidence: 'high',
      },
    ];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    applySongDeltaPatch({
      db,
      baseRecords: base,
      candidateRecords: candidate,
      searchHints: touchedHint,
      checkDbMatchesBase: false,
      maxTouchedSongs: 100,
      maxTouchedRatio: 1,
    });

    expect(warn).not.toHaveBeenCalled();
    // The touched song's hint tokens ARE materialized (existing behavior).
    expect(hintTokenCount(db, 'tj-1', 'artist_hint')).toBeGreaterThan(0);
  });
});
