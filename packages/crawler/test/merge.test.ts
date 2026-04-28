import type { SongRecord } from '@karaoke/schema';
import { describe, expect, it } from 'vitest';
import { applyCategoryExclusivity, mergeRecords } from '../src/merge.js';

function record(over: Partial<SongRecord>): SongRecord {
  return {
    id: 'blog-1-0',
    source_url: 'https://example.test/1',
    title_primary: 'あぶく',
    title_ko: null,
    artist_primary: 'ヨルシカ',
    artist_ko: null,
    karaoke_numbers: { tj: null, ky: null, joysound: null },
    categories: ['jpop'],
    crawled_at: '2026-04-26T10:00:00Z',
    ...over,
  };
}

describe('mergeRecords — v2 two-tier match key + per-field ownership', () => {
  // ---------------------------------------------------------------------
  // Case 1: Two-source merge by shared TJ#
  // ---------------------------------------------------------------------
  it('merges two sources sharing a TJ# (Tier A)', () => {
    const tj = record({
      id: 'tj-68923',
      source_url: 'https://tj.test/68923',
      title_primary: '群青',
      title_ko: null,
      artist_primary: 'YOASOBI',
      artist_ko: null,
      karaoke_numbers: { tj: '68923', ky: null, joysound: null },
      categories: ['jpop'],
    });
    const blog = record({
      id: 'blog-1-0',
      source_url: 'https://blog.test/1',
      title_primary: 'Gunjō',
      title_ko: '군청',
      artist_primary: 'YOASOBI',
      artist_ko: '요아소비',
      karaoke_numbers: { tj: '68923', ky: null, joysound: null },
      categories: ['jpop'],
    });

    const { records, conflicts } = mergeRecords([tj, blog]);

    expect(records).toHaveLength(1);
    expect(conflicts).toHaveLength(0);
    const m = records[0];
    if (!m) throw new Error('no record');
    // title_primary chain TJ→blog→namu: TJ wins.
    expect(m.title_primary).toBe('群青');
    expect(m.artist_primary).toBe('YOASOBI');
    // ko chain blog→namu: blog wins.
    expect(m.title_ko).toBe('군청');
    expect(m.artist_ko).toBe('요아소비');
    expect(m.karaoke_numbers.tj).toBe('68923');
    // id/source_url tiebreak: blog has higher priority (rank 1) than tj.
    expect(m.id).toBe('blog-1-0');
    expect(m.source_url).toBe('https://blog.test/1');
  });

  // ---------------------------------------------------------------------
  // Case 2: Three-source merge by shared TJ#
  // ---------------------------------------------------------------------
  it('merges three sources sharing a TJ# with per-field ownership chains', () => {
    const tj = record({
      id: 'tj-68923',
      source_url: 'https://tj.test/68923',
      title_primary: '群青',
      artist_primary: 'YOASOBI',
      karaoke_numbers: { tj: '68923', ky: null, joysound: null },
    });
    const blog = record({
      id: 'blog-1-0',
      source_url: 'https://blog.test/1',
      title_primary: 'Gunjō',
      title_ko: '군청',
      artist_primary: 'YOASOBI',
      karaoke_numbers: { tj: '68923', ky: null, joysound: null },
    });
    const namu = record({
      id: 'namu-1',
      source_url: 'https://namu.test/1',
      title_primary: '群青 (YOASOBI)',
      title_ko: '군청 (나무)',
      artist_primary: 'YOASOBI',
      artist_ko: '요아소비',
      karaoke_numbers: { tj: '68923', ky: '47474', joysound: null },
    });

    const { records, conflicts } = mergeRecords([tj, blog, namu]);

    expect(records).toHaveLength(1);
    expect(conflicts).toHaveLength(0);
    const m = records[0];
    if (!m) throw new Error('no record');
    // title_primary chain TJ→blog→namu: TJ wins.
    expect(m.title_primary).toBe('群青');
    // title_ko chain blog→namu: blog wins.
    expect(m.title_ko).toBe('군청');
    // KY contributed only by namu — survives the union.
    expect(m.karaoke_numbers).toEqual({ tj: '68923', ky: '47474', joysound: null });
  });

  // ---------------------------------------------------------------------
  // Case 3: Blog-only island
  // ---------------------------------------------------------------------
  it('keeps a blog-only record with no vendor numbers as a standalone', () => {
    const blog = record({
      id: 'blog-99-0',
      source_url: 'https://blog.test/99',
      title_primary: '夜に駆ける',
      title_ko: '밤에 달리다',
      artist_primary: 'YOASOBI',
      karaoke_numbers: { tj: null, ky: null, joysound: null },
    });

    const { records, conflicts } = mergeRecords([blog]);

    expect(records).toHaveLength(1);
    expect(conflicts).toHaveLength(0);
    expect(records[0]?.karaoke_numbers).toEqual({ tj: null, ky: null, joysound: null });
    expect(records[0]?.id).toBe('blog-99-0');
  });

  // ---------------------------------------------------------------------
  // Case 4: Blog→TJ fuzzy match (Tier B)
  // ---------------------------------------------------------------------
  it('clusters a blog row to a TJ row via Tier B fuzzy (title, artist) match', () => {
    const tj = record({
      id: 'tj-12345',
      source_url: 'https://tj.test/12345',
      title_primary: 'チューリング・ラブ',
      artist_primary: 'ナナヲアカリ',
      karaoke_numbers: { tj: '12345', ky: null, joysound: null },
    });
    const blog = record({
      id: 'blog-2-0',
      source_url: 'https://blog.test/2',
      title_primary: 'チューリング・ラブ',
      title_ko: '튜링 러브',
      artist_primary: 'ナナヲアカリ',
      karaoke_numbers: { tj: null, ky: null, joysound: null },
    });

    const { records, conflicts } = mergeRecords([tj, blog]);

    expect(records).toHaveLength(1);
    // No conflict: blog's tj is null, so no disagreement on tj.
    expect(conflicts).toHaveLength(0);
    expect(records[0]?.title_primary).toBe('チューリング・ラブ');
    expect(records[0]?.title_ko).toBe('튜링 러브');
    expect(records[0]?.karaoke_numbers.tj).toBe('12345');
  });

  // ---------------------------------------------------------------------
  // Case 5: Vendor-number conflict on Tier B
  // ---------------------------------------------------------------------
  it('logs a Tier B vendor-number conflict and lets blog win the tj field', () => {
    const blog = record({
      id: 'blog-3-0',
      source_url: 'https://blog.test/3',
      title_primary: 'アイドル',
      artist_primary: 'YOASOBI',
      karaoke_numbers: { tj: '68923', ky: null, joysound: null },
    });
    const namu = record({
      id: 'namu-2',
      source_url: 'https://namu.test/2',
      title_primary: 'アイドル',
      artist_primary: 'YOASOBI',
      karaoke_numbers: { tj: '68924', ky: null, joysound: null },
    });

    const { records, conflicts } = mergeRecords([blog, namu]);

    expect(records).toHaveLength(1);
    // Blog wins on tj (highest priority).
    expect(records[0]?.karaoke_numbers.tj).toBe('68923');
    // Exactly one conflict on the tj field.
    expect(conflicts).toHaveLength(1);
    const c = conflicts[0];
    if (!c) throw new Error('no conflict');
    expect(c.field).toBe('tj');
    expect(c.winner).toBe('68923');
    expect(c.values.map((v) => v.source).sort()).toEqual(['blog', 'namu']);
    expect(c.values.map((v) => v.value).sort()).toEqual(['68923', '68924']);
  });

  // ---------------------------------------------------------------------
  // Case 6: Multi-vendor merge via shared KY (Tier A)
  // ---------------------------------------------------------------------
  it('clusters records via shared KY# and unions all three vendor fields', () => {
    const a = record({
      id: 'tj-1',
      source_url: 'https://tj.test/1',
      title_primary: 'Song A',
      artist_primary: 'Artist A',
      karaoke_numbers: { tj: 'X', ky: 'Y', joysound: null },
    });
    const b = record({
      id: 'namu-3',
      source_url: 'https://namu.test/3',
      title_primary: 'Song A',
      artist_primary: 'Artist A',
      karaoke_numbers: { tj: null, ky: 'Y', joysound: 'Z' },
    });

    const { records, conflicts } = mergeRecords([a, b]);

    expect(records).toHaveLength(1);
    expect(conflicts).toHaveLength(0);
    expect(records[0]?.karaoke_numbers).toEqual({ tj: 'X', ky: 'Y', joysound: 'Z' });
  });

  // ---------------------------------------------------------------------
  // Case 7: TJ-less Vocaloid (namu only)
  // ---------------------------------------------------------------------
  it('keeps a namuwiki-only Vocaloid record standalone with title_primary from namu', () => {
    const namu = record({
      id: 'namu-vocaloid-1',
      source_url: 'https://namu.test/vocaloid/1',
      title_primary: 'メルト',
      title_ko: '멜트',
      artist_primary: 'ryo',
      karaoke_numbers: { tj: null, ky: null, joysound: null },
      categories: ['vocaloid'],
    });

    const { records, conflicts } = mergeRecords([namu]);

    expect(records).toHaveLength(1);
    expect(conflicts).toHaveLength(0);
    expect(records[0]?.title_primary).toBe('メルト');
    expect(records[0]?.karaoke_numbers.tj).toBeNull();
    expect(records[0]?.id).toBe('namu-vocaloid-1');
  });

  // ---------------------------------------------------------------------
  // Determinism micro-check
  // ---------------------------------------------------------------------
  it('produces byte-identical output across two runs on the same input (determinism)', () => {
    const input: SongRecord[] = [
      record({
        id: 'tj-100',
        source_url: 'https://tj.test/100',
        title_primary: 'Beta',
        artist_primary: 'X',
        karaoke_numbers: { tj: '100', ky: null, joysound: null },
      }),
      record({
        id: 'blog-50-0',
        source_url: 'https://blog.test/50',
        title_primary: 'Beta',
        title_ko: 'Beta-KO',
        artist_primary: 'X',
        karaoke_numbers: { tj: '100', ky: null, joysound: null },
      }),
      record({
        id: 'blog-51-0',
        source_url: 'https://blog.test/51',
        title_primary: 'Alpha',
        artist_primary: 'X',
        karaoke_numbers: { tj: null, ky: null, joysound: null },
      }),
      record({
        id: 'namu-99',
        source_url: 'https://namu.test/99',
        title_primary: 'Alpha',
        artist_primary: 'X',
        karaoke_numbers: { tj: null, ky: null, joysound: null },
      }),
    ];

    const a = mergeRecords(input);
    const b = mergeRecords(input);

    expect(a.records).toEqual(b.records);
    expect(a.conflicts).toEqual(b.conflicts);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('applyCategoryExclusivity — jpop drops when anime/vocaloid present', () => {
  it('leaves [jpop] unchanged', () => {
    expect(applyCategoryExclusivity(['jpop'])).toEqual(['jpop']);
  });

  it('drops jpop from [jpop, anime]', () => {
    expect(applyCategoryExclusivity(['anime', 'jpop'])).toEqual(['anime']);
  });

  it('drops jpop from [jpop, vocaloid]', () => {
    expect(applyCategoryExclusivity(['jpop', 'vocaloid'])).toEqual(['vocaloid']);
  });

  it('drops jpop from [jpop, anime, vocaloid]', () => {
    expect(applyCategoryExclusivity(['anime', 'jpop', 'vocaloid'])).toEqual(['anime', 'vocaloid']);
  });

  it('leaves [anime, vocaloid] unchanged', () => {
    expect(applyCategoryExclusivity(['anime', 'vocaloid'])).toEqual(['anime', 'vocaloid']);
  });

  it('leaves [anime] unchanged', () => {
    expect(applyCategoryExclusivity(['anime'])).toEqual(['anime']);
  });

  it('leaves [vocaloid] unchanged', () => {
    expect(applyCategoryExclusivity(['vocaloid'])).toEqual(['vocaloid']);
  });
});

describe('mergeRecords — category exclusivity (set-union then jpop drop)', () => {
  it('strips jpop when a Tier A cluster set-unions to jpop+anime', () => {
    const tj = record({
      id: 'tj-50000',
      source_url: 'https://tj.test/50000',
      title_primary: '夜に駆ける',
      artist_primary: 'YOASOBI',
      karaoke_numbers: { tj: '50000', ky: null, joysound: null },
      categories: ['jpop'],
    });
    const blog = record({
      id: 'blog-200-0',
      source_url: 'https://blog.test/200',
      title_primary: '夜に駆ける',
      artist_primary: 'YOASOBI',
      karaoke_numbers: { tj: '50000', ky: null, joysound: null },
      categories: ['anime'],
    });

    const { records } = mergeRecords([tj, blog]);
    expect(records).toHaveLength(1);
    expect(records[0]?.categories).toEqual(['anime']);
  });

  it('strips jpop when a Tier A cluster set-unions to jpop+anime+vocaloid', () => {
    const tj = record({
      id: 'tj-50001',
      source_url: 'https://tj.test/50001',
      title_primary: 'メルト',
      artist_primary: 'ryo',
      karaoke_numbers: { tj: '50001', ky: null, joysound: null },
      categories: ['jpop'],
    });
    const blog = record({
      id: 'blog-201-0',
      source_url: 'https://blog.test/201',
      title_primary: 'メルト',
      artist_primary: 'ryo',
      karaoke_numbers: { tj: '50001', ky: null, joysound: null },
      categories: ['anime'],
    });
    const namu = record({
      id: 'namu-300',
      source_url: 'https://namu.test/300',
      title_primary: 'メルト',
      artist_primary: 'ryo',
      karaoke_numbers: { tj: '50001', ky: null, joysound: null },
      categories: ['vocaloid'],
    });

    const { records } = mergeRecords([tj, blog, namu]);
    expect(records).toHaveLength(1);
    expect(records[0]?.categories).toEqual(['anime', 'vocaloid']);
  });

  it('preserves [anime, vocaloid] (the Black-Rock-Shooter case) untouched', () => {
    const blog = record({
      id: 'blog-202-0',
      source_url: 'https://blog.test/202',
      title_primary: 'ブラック★ロックシューター',
      artist_primary: 'supercell',
      karaoke_numbers: { tj: null, ky: null, joysound: null },
      categories: ['anime', 'vocaloid'],
    });

    const { records } = mergeRecords([blog]);
    expect(records).toHaveLength(1);
    expect(records[0]?.categories).toEqual(['anime', 'vocaloid']);
  });
});
