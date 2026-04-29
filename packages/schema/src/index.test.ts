import { expectTypeOf } from 'expect-type';
import { describe, expect, it } from 'vitest';
import {
  type Category,
  type KaraokeNumbers,
  type RawSongRecord,
  type SongRecord,
  applyCategoryExclusivity,
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
      karaoke_numbers: { tj: '68425', ky: '48374', joysound: '631234' },
      categories: ['anime'],
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
      karaoke_numbers: { ...baseKaraokeNumbers },
      categories: ['proseka'],
      crawled_at: '2026-04-26T10:00:00Z',
    };

    expect(() => validateSongRecord(bad)).toThrowError(/categories/);
  });

  it('rejects a record whose categories contain the dropped vtuber value', () => {
    const bad = {
      id: 'blog-1-0',
      source_url: 'https://example.com/1',
      title_primary: 'Foo',
      title_ko: null,
      artist_primary: 'Bar',
      artist_ko: null,
      karaoke_numbers: { ...baseKaraokeNumbers },
      categories: ['vtuber'],
      crawled_at: '2026-04-26T10:00:00Z',
    };

    expect(() => validateSongRecord(bad)).toThrowError(/categories/);
  });
});

describe('validateSongRecord — Category enum coverage', () => {
  it('accepts records for each of the three live category values', () => {
    const liveValues: Category[] = ['jpop', 'vocaloid', 'anime'];
    for (const value of liveValues) {
      const record: SongRecord = {
        id: 'blog-1-0',
        source_url: 'https://example.com/1',
        title_primary: 'Foo',
        title_ko: null,
        artist_primary: 'Bar',
        artist_ko: null,
        karaoke_numbers: { ...baseKaraokeNumbers },
        categories: [value],
        crawled_at: '2026-04-26T10:00:00Z',
      };

      expect(() => validateSongRecord(record)).not.toThrow();
    }
  });
});

describe('categories mutual-exclusivity', () => {
  function recordWithCategories(categories: Category[]): SongRecord {
    return {
      id: 'blog-1-0',
      source_url: 'https://example.com/1',
      title_primary: 'Foo',
      title_ko: null,
      artist_primary: 'Bar',
      artist_ko: null,
      karaoke_numbers: { ...baseKaraokeNumbers },
      categories,
      crawled_at: '2026-04-26T10:00:00Z',
    } as SongRecord;
  }

  it('accepts categories: ["jpop"]', () => {
    expect(() => validateSongRecord(recordWithCategories(['jpop']))).not.toThrow();
  });

  it('accepts categories: ["anime"]', () => {
    expect(() => validateSongRecord(recordWithCategories(['anime']))).not.toThrow();
  });

  it('accepts categories: ["vocaloid"]', () => {
    expect(() => validateSongRecord(recordWithCategories(['vocaloid']))).not.toThrow();
  });

  it('rejects categories: ["anime", "vocaloid"] (3-way exclusivity)', () => {
    expect(() => validateSongRecord(recordWithCategories(['anime', 'vocaloid']))).toThrowError(
      /categories/,
    );
  });

  it('rejects categories: ["jpop", "anime"]', () => {
    expect(() => validateSongRecord(recordWithCategories(['jpop', 'anime']))).toThrowError(
      /categories/,
    );
  });

  it('rejects categories: ["jpop", "vocaloid"]', () => {
    expect(() => validateSongRecord(recordWithCategories(['jpop', 'vocaloid']))).toThrowError(
      /categories/,
    );
  });

  it('rejects categories: ["jpop", "anime", "vocaloid"]', () => {
    expect(() =>
      validateSongRecord(recordWithCategories(['jpop', 'anime', 'vocaloid'])),
    ).toThrowError(/categories/);
  });
});

describe('applyCategoryExclusivity — priority vocaloid > anime > jpop', () => {
  function asSet(cats: Category[]): Set<Category> {
    return new Set(cats);
  }
  function asSorted(s: Set<Category>): Category[] {
    return [...s].sort();
  }

  it('leaves [jpop] unchanged', () => {
    const s = asSet(['jpop']);
    applyCategoryExclusivity(s);
    expect(asSorted(s)).toEqual(['jpop']);
  });

  it('leaves [anime] unchanged', () => {
    const s = asSet(['anime']);
    applyCategoryExclusivity(s);
    expect(asSorted(s)).toEqual(['anime']);
  });

  it('leaves [vocaloid] unchanged', () => {
    const s = asSet(['vocaloid']);
    applyCategoryExclusivity(s);
    expect(asSorted(s)).toEqual(['vocaloid']);
  });

  it('drops jpop from [jpop, anime] -> [anime]', () => {
    const s = asSet(['jpop', 'anime']);
    applyCategoryExclusivity(s);
    expect(asSorted(s)).toEqual(['anime']);
  });

  it('drops jpop from [jpop, vocaloid] -> [vocaloid]', () => {
    const s = asSet(['jpop', 'vocaloid']);
    applyCategoryExclusivity(s);
    expect(asSorted(s)).toEqual(['vocaloid']);
  });

  it('drops anime from [anime, vocaloid] -> [vocaloid] (vocaloid wins)', () => {
    const s = asSet(['anime', 'vocaloid']);
    applyCategoryExclusivity(s);
    expect(asSorted(s)).toEqual(['vocaloid']);
  });

  it('collapses [jpop, anime, vocaloid] -> [vocaloid]', () => {
    const s = asSet(['jpop', 'anime', 'vocaloid']);
    applyCategoryExclusivity(s);
    expect(asSorted(s)).toEqual(['vocaloid']);
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
    // Type-level: release_year has been removed from the schema.
    expectTypeOf<RawSongRecord>().not.toHaveProperty('release_year');
    expectTypeOf<SongRecord>().not.toHaveProperty('release_year');
  });
});
