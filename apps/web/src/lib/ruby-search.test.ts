import type { SongRecord } from '@karaoke/schema';
import { describe, expect, it } from 'vitest';
import { buildIndex, searchLocalIndex } from './search.js';

function record(overrides: Partial<SongRecord> & Pick<SongRecord, 'id'>): SongRecord {
  const { id, ...rest } = overrides;
  return {
    id,
    source_url: 'https://example.test/ruby',
    title_primary: 'Placeholder',
    title_ko: null,
    artist_primary: 'Artist',
    artist_ko: null,
    karaoke_numbers: { tj: null, ky: null, joysound: '1' },
    crawled_at: '2026-06-13T00:00:00.000Z',
    ...rest,
  };
}

const RECORDS: SongRecord[] = [
  record({ id: 'maru', title_primary: '○', title_ruby: 'マル' }),
  record({ id: 'yoasobi', title_primary: '夜遊び', title_ruby: 'ヨアソビ' }),
  record({ id: 'plain', title_primary: 'Unrelated' }),
];

function ids(query: string): string[] {
  const index = buildIndex(RECORDS);
  return searchLocalIndex(index, query).map((hit) => String(hit.id));
}

describe('offline MiniSearch reading recall over title_ruby (R4)', () => {
  it('finds a kanji title by its kana reading', () => {
    expect(ids('マル')).toContain('maru');
  });

  it('finds a kanji title by its romaji reading', () => {
    expect(ids('maru')).toContain('maru');
  });

  it('finds a kanji title by its hangul reading', () => {
    expect(ids('마루')).toContain('maru');
  });

  it('supports romaji prefixes of the reading (yoa -> ヨアソビ)', () => {
    expect(ids('yoa')).toContain('yoasobi');
  });

  it('does not invent reading matches for a record with no ruby', () => {
    // "purein" is the romaji of プレイン, which no record carries.
    expect(ids('purein')).not.toContain('plain');
  });
});
