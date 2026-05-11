import { expectTypeOf } from 'expect-type';
import { describe, expect, it } from 'vitest';
import {
  type Category,
  type KaraokeNumbers,
  type RawSongRecord,
  type SongRecord,
  validateSongRecord,
} from './index.js';

const BASE_KARAOKE_NUMBERS: KaraokeNumbers = { tj: null, ky: null, joysound: null };

const BASE_RECORD: SongRecord = {
  id: 'blog-1-0',
  source_url: 'https://example.com/1',
  title_primary: 'Foo',
  title_ko: null,
  artist_primary: 'Bar',
  artist_ko: null,
  karaoke_numbers: BASE_KARAOKE_NUMBERS,
  categories: ['jpop'],
  crawled_at: '2026-04-26T10:00:00Z',
};

/**
 * Build a SongRecord by merging `overrides` onto BASE_RECORD. `karaoke_numbers`
 * is deep-merged so callers can override a single sub-key without restating the
 * whole object. All other fields are shallow-overridden.
 */
function makeRecord(overrides: Partial<SongRecord> = {}): SongRecord {
  const { karaoke_numbers: knOverride, ...rest } = overrides;
  return {
    ...BASE_RECORD,
    ...rest,
    karaoke_numbers: { ...BASE_RECORD.karaoke_numbers, ...(knOverride ?? {}) },
  };
}

describe('validateSongRecord — worked examples (spec lines 117-146)', () => {
  it('accepts imase – NIGHT DANCER and asserts title_ko is null', () => {
    const record = makeRecord({
      id: 'blog-1700-0',
      source_url: 'https://j-pop-playlist.tistory.com/1700',
      title_primary: 'NIGHT DANCER',
      title_ko: null,
      artist_primary: 'imase',
      artist_ko: '이마세',
      karaoke_numbers: { tj: '68318', ky: null, joysound: null },
      categories: ['jpop'],
    });

    expect(() => validateSongRecord(record)).not.toThrow();
    // Per plan Phase 1 verification: explicit null assertion for the imase row.
    expect(record.title_ko).toBeNull();
  });

  it('accepts YOASOBI – アイドル', () => {
    const record = makeRecord({
      id: 'blog-1596-0',
      source_url: 'https://j-pop-playlist.tistory.com/1596',
      title_primary: 'アイドル',
      title_ko: '아이돌',
      artist_primary: 'YOASOBI',
      artist_ko: '요아소비',
      karaoke_numbers: { tj: '68425', ky: '48374', joysound: '631234' },
      categories: ['anime'],
    });

    expect(() => validateSongRecord(record)).not.toThrow();
  });

  it('accepts 米津玄師 – Lemon', () => {
    const record = makeRecord({
      id: 'blog-823-0',
      source_url: 'https://j-pop-playlist.tistory.com/823',
      title_primary: 'Lemon',
      title_ko: null,
      artist_primary: '米津玄師',
      artist_ko: '요네즈 켄시',
      karaoke_numbers: { tj: '28335', ky: '84555', joysound: null },
      categories: ['jpop'],
    });

    expect(() => validateSongRecord(record)).not.toThrow();
  });
});

describe('validateSongRecord — failure cases', () => {
  it('rejects a record missing source_url', () => {
    const { source_url: _omit, ...bad } = makeRecord();
    expect(() => validateSongRecord(bad)).toThrowError(/source_url/);
  });

  it('rejects karaoke_numbers with an unknown key', () => {
    const bad = {
      ...makeRecord(),
      karaoke_numbers: { tj: null, ky: null, joysound: null, dam: '12345' },
    };
    expect(() => validateSongRecord(bad)).toThrowError(/karaoke_numbers/);
  });

  it('rejects a record that includes the dropped title_romaji field', () => {
    const bad = { ...makeRecord(), title_romaji: 'foo' };
    expect(() => validateSongRecord(bad)).toThrowError(/additional properties/i);
  });
});

describe('validateSongRecord — Category enum coverage', () => {
  it('accepts records for each of the three live category values', () => {
    const liveValues: Category[] = ['jpop', 'vocaloid', 'anime'];
    for (const value of liveValues) {
      expect(() => validateSongRecord(makeRecord({ categories: [value] }))).not.toThrow();
    }
  });
});

describe('categories — rejection cases', () => {
  // Note: `['anime', 'vocaloid']` (and any other multi-tag combination) is
  // rejected by the schema's `maxItems: 1` constraint, NOT by category
  // priority. Priority (`vocaloid > anime > jpop`) lives in
  // `applyCategoryExclusivity` and runs BEFORE validation.
  it.each<[unknown[]]>([
    [['proseka']], // not in enum
    [['vtuber']], // not in enum
    [[]], // minItems violation
    [['anime', 'vocaloid']], // maxItems violation (NOT priority)
    [['jpop', 'anime']], // maxItems violation
    [['jpop', 'vocaloid']], // maxItems violation
    [['jpop', 'anime', 'vocaloid']], // maxItems violation
  ])('rejects categories=%j', (cats) => {
    expect(() =>
      validateSongRecord(makeRecord({ categories: cats as Category[] })),
    ).toThrowError(/categories/);
  });
});

describe('categories — accepted single-tag values', () => {
  it.each<[Category]>([['jpop'], ['anime'], ['vocaloid']])(
    'accepts categories: [%j]',
    (cat) => {
      expect(() => validateSongRecord(makeRecord({ categories: [cat] }))).not.toThrow();
    },
  );
});

describe('artist_aliases — optional field (spec 2026-05-04)', () => {
  function recordWithAliases(aliases: unknown): unknown {
    return { ...makeRecord(), artist_aliases: aliases };
  }

  it('accepts a record without artist_aliases (optional field)', () => {
    expect(() => validateSongRecord(makeRecord())).not.toThrow();
  });

  it('accepts artist_aliases: [] (empty array tolerated)', () => {
    expect(() => validateSongRecord(recordWithAliases([]))).not.toThrow();
  });

  it('accepts artist_aliases: ["ZUTOMAYO"] (single non-empty alias)', () => {
    expect(() => validateSongRecord(recordWithAliases(['ZUTOMAYO']))).not.toThrow();
  });

  it('rejects artist_aliases containing an empty string (minLength: 1 per item)', () => {
    expect(() => validateSongRecord(recordWithAliases(['', 'X']))).toThrowError(/artist_aliases/);
  });

  it('rejects artist_aliases with duplicate entries (uniqueItems: true)', () => {
    expect(() => validateSongRecord(recordWithAliases(['X', 'X']))).toThrowError(/artist_aliases/);
  });
});

describe('SongRecord — media_context_ko', () => {
  it('accepts a record with media_context_ko populated', () => {
    expect(() =>
      validateSongRecord(
        makeRecord({
          id: 'tj-1',
          source_url: 'https://example.com/x',
          title_primary: 'Somewhere',
          artist_primary: 'Some Artist',
          karaoke_numbers: { tj: '1', ky: null, joysound: null },
          categories: ['anime'],
          crawled_at: '2026-05-06T00:00:00.000Z',
          media_context_ko: '(슬레이어즈 TRY OST)',
        }),
      ),
    ).not.toThrow();
  });

  it('rejects a record with non-string media_context_ko', () => {
    const rec = {
      ...makeRecord(),
      media_context_ko: 42,
    };
    expect(() => validateSongRecord(rec)).toThrow();
  });

  it('rejects media_context_ko without surrounding parens', () => {
    expect(() =>
      validateSongRecord(makeRecord({ media_context_ko: '슬레이어즈 TRY OST' })),
    ).toThrowError(/media_context_ko/);
  });

  it('rejects media_context_ko with unclosed paren', () => {
    expect(() =>
      validateSongRecord(makeRecord({ media_context_ko: '(unclosed' })),
    ).toThrowError(/media_context_ko/);
  });
});

describe('SongRecord — title_ko_source', () => {
  it('accepts a record with title_ko_source = blog', () => {
    expect(() =>
      validateSongRecord(
        makeRecord({
          title_ko: '엑스',
          title_ko_source: 'blog',
        }),
      ),
    ).not.toThrow();
  });

  it('rejects a record with unknown title_ko_source value', () => {
    const rec = {
      ...makeRecord(),
      title_ko_source: 'tj-original', // not in enum
    };
    expect(() => validateSongRecord(rec)).toThrow();
  });
});

describe('SongRecord — title_ko_confidence', () => {
  it('accepts confidence high paired with llm-translated source', () => {
    expect(() =>
      validateSongRecord(
        makeRecord({
          title_ko: '사랑이 보이지 않아',
          title_ko_source: 'llm-translated',
          title_ko_confidence: 'high',
        }),
      ),
    ).not.toThrow();
  });

  it('rejects title_ko_confidence when title_ko_source is blog', () => {
    expect(() =>
      validateSongRecord(
        makeRecord({
          title_ko: '엑스',
          title_ko_source: 'blog',
          title_ko_confidence: 'high', // illegal: only allowed with llm-translated
        }),
      ),
    ).toThrow();
  });

  it('rejects unknown confidence value', () => {
    const rec = {
      ...makeRecord(),
      title_ko: '엑스',
      title_ko_source: 'llm-translated' as const,
      title_ko_confidence: 'super-high',
    };
    expect(() => validateSongRecord(rec)).toThrow();
  });

  // title_ko_source: 'manual' cross-field tests — cross-field rule says
  // title_ko_confidence is ONLY valid with title_ko_source === 'llm-translated'.
  it('accepts title_ko_source = manual with no confidence', () => {
    expect(() =>
      validateSongRecord(makeRecord({ title_ko_source: 'manual' })),
    ).not.toThrow();
  });

  it('rejects title_ko_source = manual paired with confidence', () => {
    expect(() =>
      validateSongRecord(
        makeRecord({
          title_ko_source: 'manual',
          title_ko_confidence: 'high' as const,
        }),
      ),
    ).toThrowError();
  });

  it('rejects title_ko_source = blog paired with confidence', () => {
    expect(() =>
      validateSongRecord(
        makeRecord({
          title_ko_source: 'blog',
          title_ko_confidence: 'high' as const,
        }),
      ),
    ).toThrowError();
  });
});

describe('RawSongRecord type shape', () => {
  // Type-level checks. These are compile-time assertions; placement inside a
  // describe block is purely organizational — they run regardless of position.
  expectTypeOf<SongRecord['categories']>().toEqualTypeOf<Category[]>();
  expectTypeOf<SongRecord['karaoke_numbers']>().toEqualTypeOf<KaraokeNumbers>();

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
