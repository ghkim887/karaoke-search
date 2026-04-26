import { expectTypeOf } from 'expect-type';
import { describe, expect, it } from 'vitest';
import {
  type Category,
  type KaraokeNumbers,
  type RawSongRecord,
  type SongRecord,
  validateSongRecord,
} from './index.js';

// Type-level checks (compile-time only).
expectTypeOf<SongRecord['categories']>().toEqualTypeOf<Category[]>();
expectTypeOf<SongRecord['karaoke_numbers']>().toEqualTypeOf<KaraokeNumbers>();

const baseKaraokeNumbers: KaraokeNumbers = { tj: null, ky: null, joysound: null };

describe('validateSongRecord — worked examples (spec lines 117-146)', () => {
  it('accepts imase – NIGHT DANCER and asserts title_ko is null', () => {
    const record: SongRecord = {
      id: 'blog-1700-0',
      source_url: 'https://j-pop-playlist.tistory.com/1700',
      title_primary: 'NIGHT DANCER',
      title_ko: null,
      artist_primary: 'imase',
      artist_ko: '이마세',
      release_year: 2022,
      karaoke_numbers: { tj: '68318', ky: null, joysound: null },
      categories: ['jpop'],
      crawled_at: '2026-04-26T10:00:00Z',
    };

    expect(() => validateSongRecord(record)).not.toThrow();
    // Per plan Phase 1 verification: explicit null assertion for the imase row.
    expect(record.title_ko).toBeNull();
  });

  it('accepts YOASOBI – アイドル', () => {
    const record: SongRecord = {
      id: 'blog-1596-0',
      source_url: 'https://j-pop-playlist.tistory.com/1596',
      title_primary: 'アイドル',
      title_ko: '아이돌',
      artist_primary: 'YOASOBI',
      artist_ko: '요아소비',
      release_year: 2023,
      karaoke_numbers: { tj: '68425', ky: '48374', joysound: '631234' },
      categories: ['anime', 'jpop'],
      crawled_at: '2026-04-26T10:00:00Z',
    };

    expect(() => validateSongRecord(record)).not.toThrow();
  });

  it('accepts 米津玄師 – Lemon', () => {
    const record: SongRecord = {
      id: 'blog-823-0',
      source_url: 'https://j-pop-playlist.tistory.com/823',
      title_primary: 'Lemon',
      title_ko: null,
      artist_primary: '米津玄師',
      artist_ko: '요네즈 켄시',
      release_year: 2018,
      karaoke_numbers: { tj: '28335', ky: '84555', joysound: null },
      categories: ['jpop'],
      crawled_at: '2026-04-26T10:00:00Z',
    };

    expect(() => validateSongRecord(record)).not.toThrow();
  });
});

describe('validateSongRecord — failure cases', () => {
  it('rejects a record missing source_url', () => {
    const bad = {
      id: 'blog-1-0',
      title_primary: 'Foo',
      title_ko: null,
      artist_primary: 'Bar',
      artist_ko: null,
      release_year: 2020,
      karaoke_numbers: { ...baseKaraokeNumbers },
      categories: ['jpop'],
      crawled_at: '2026-04-26T10:00:00Z',
    };

    expect(() => validateSongRecord(bad)).toThrowError(/source_url/);
  });

  it('rejects an empty categories array', () => {
    const bad = {
      id: 'blog-1-0',
      source_url: 'https://example.com/1',
      title_primary: 'Foo',
      title_ko: null,
      artist_primary: 'Bar',
      artist_ko: null,
      release_year: 2020,
      karaoke_numbers: { ...baseKaraokeNumbers },
      categories: [],
      crawled_at: '2026-04-26T10:00:00Z',
    };

    expect(() => validateSongRecord(bad)).toThrowError(/categories/);
  });

  it('rejects karaoke_numbers with an unknown key', () => {
    const bad = {
      id: 'blog-1-0',
      source_url: 'https://example.com/1',
      title_primary: 'Foo',
      title_ko: null,
      artist_primary: 'Bar',
      artist_ko: null,
      release_year: 2020,
      karaoke_numbers: { tj: null, ky: null, joysound: null, dam: '12345' },
      categories: ['jpop'],
      crawled_at: '2026-04-26T10:00:00Z',
    };

    expect(() => validateSongRecord(bad)).toThrowError(/karaoke_numbers/);
  });

  it('rejects a record that includes the dropped title_romaji field', () => {
    const bad = {
      id: 'blog-1-0',
      source_url: 'https://example.com/1',
      title_primary: 'Foo',
      title_ko: null,
      title_romaji: 'foo',
      artist_primary: 'Bar',
      artist_ko: null,
      release_year: 2020,
      karaoke_numbers: { ...baseKaraokeNumbers },
      categories: ['jpop'],
      crawled_at: '2026-04-26T10:00:00Z',
    };

    expect(() => validateSongRecord(bad)).toThrowError(/additional properties/i);
  });

  it('rejects a record whose categories contain the dropped proseka value', () => {
    const bad = {
      id: 'blog-1-0',
      source_url: 'https://example.com/1',
      title_primary: 'Foo',
      title_ko: null,
      artist_primary: 'Bar',
      artist_ko: null,
      release_year: 2020,
      karaoke_numbers: { ...baseKaraokeNumbers },
      categories: ['proseka'],
      crawled_at: '2026-04-26T10:00:00Z',
    };

    expect(() => validateSongRecord(bad)).toThrowError(/categories/);
  });
});

describe('validateSongRecord — Category enum coverage', () => {
  it('accepts a record whose categories contain the new vtuber value', () => {
    const record: SongRecord = {
      id: 'blog-1-0',
      source_url: 'https://example.com/1',
      title_primary: 'Foo',
      title_ko: null,
      artist_primary: 'Bar',
      artist_ko: null,
      release_year: 2024,
      karaoke_numbers: { ...baseKaraokeNumbers },
      categories: ['vtuber'],
      crawled_at: '2026-04-26T10:00:00Z',
    };

    expect(() => validateSongRecord(record)).not.toThrow();
  });
});

describe('RawSongRecord type shape', () => {
  it('compiles a raw pre-normalization record', () => {
    const raw: RawSongRecord = {
      source_url: 'https://j-pop-playlist.tistory.com/1596',
      title_primary: 'アイドル',
      title_ko: '아이돌',
      artist_primary: 'YOASOBI',
      artist_ko: '요아소비',
      release_year: 2023,
      karaoke_numbers: { tj: null, ky: null, joysound: null },
      categories: ['jpop'],
    };

    expect(raw.title_primary).toBe('アイドル');
    // Type-level: RawSongRecord must NOT have id or crawled_at.
    expectTypeOf<RawSongRecord>().not.toHaveProperty('id');
    expectTypeOf<RawSongRecord>().not.toHaveProperty('crawled_at');
    // Type-level: title_romaji has been removed from the schema.
    expectTypeOf<RawSongRecord>().not.toHaveProperty('title_romaji');
    expectTypeOf<SongRecord>().not.toHaveProperty('title_romaji');
  });
});
