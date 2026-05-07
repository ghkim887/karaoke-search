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

describe('mergeRecords — empty-input regression (Fix A.4)', () => {
  it('handles empty input', () => {
    const result = mergeRecords([]);
    expect(result.records).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });
});

describe('mergeRecords — sort with supplementary-plane TJ codes (Fix A.1)', () => {
  it('null-TJ records sort last regardless of the non-null side codepoint (incl. supplementary-plane)', () => {
    // The pre-Fix-A.1 sort used `'￿'` (U+FFFF) as a "push to end" sentinel.
    // Supplementary-plane chars (codepoint > U+FFFF) start with a UTF-16
    // surrogate in U+D800–DBFF, which sorts BELOW U+FFFF — so a record like
    // `karaoke_numbers.tj === '𠀀1'` would have sorted BEFORE a null-TJ
    // record under the old sentinel. Fix A.1 makes nulls always-last via
    // explicit branches in the comparator.
    //
    // We exercise the path with three records:
    //   A: tj='𠀀1' (supplementary plane, U+20000 + ASCII '1')
    //   B: tj='99'  (ordinary ASCII)
    //   C: tj=null
    // Expected: A and B come first (in ascending compare order between
    // themselves), C comes last.
    const supp = record({
      id: 'tj-99001',
      source_url: 'https://tj.test/99001',
      title_primary: 'SortA',
      artist_primary: 'X',
      karaoke_numbers: { tj: '𠀀1', ky: null, joysound: null },
    });
    const ascii = record({
      id: 'tj-99002',
      source_url: 'https://tj.test/99002',
      title_primary: 'SortB',
      artist_primary: 'Y',
      karaoke_numbers: { tj: '99', ky: null, joysound: null },
    });
    const nullTj = record({
      id: 'blog-9001-0',
      source_url: 'https://blog.test/9001',
      title_primary: 'SortC',
      artist_primary: 'Z',
      karaoke_numbers: { tj: null, ky: null, joysound: null },
    });

    const { records: out } = mergeRecords([nullTj, supp, ascii]);
    expect(out).toHaveLength(3);
    // Null-TJ record is always at the end.
    expect(out[out.length - 1]?.karaoke_numbers.tj).toBeNull();
    // The two non-null TJs precede the null one.
    expect(out[0]?.karaoke_numbers.tj).not.toBeNull();
    expect(out[1]?.karaoke_numbers.tj).not.toBeNull();
  });
});

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

describe('applyCategoryExclusivity — priority vocaloid > anime > jpop', () => {
  it('leaves [jpop] unchanged', () => {
    expect(applyCategoryExclusivity(['jpop'])).toEqual(['jpop']);
  });

  it('drops jpop from [jpop, anime] -> [anime]', () => {
    expect(applyCategoryExclusivity(['anime', 'jpop'])).toEqual(['anime']);
  });

  it('drops jpop from [jpop, vocaloid] -> [vocaloid]', () => {
    expect(applyCategoryExclusivity(['jpop', 'vocaloid'])).toEqual(['vocaloid']);
  });

  it('collapses [jpop, anime, vocaloid] -> [vocaloid]', () => {
    expect(applyCategoryExclusivity(['anime', 'jpop', 'vocaloid'])).toEqual(['vocaloid']);
  });

  it('drops anime from [anime, vocaloid] -> [vocaloid] (vocaloid wins)', () => {
    expect(applyCategoryExclusivity(['anime', 'vocaloid'])).toEqual(['vocaloid']);
  });

  it('leaves [anime] unchanged', () => {
    expect(applyCategoryExclusivity(['anime'])).toEqual(['anime']);
  });

  it('leaves [vocaloid] unchanged', () => {
    expect(applyCategoryExclusivity(['vocaloid'])).toEqual(['vocaloid']);
  });
});

describe('mergeRecords — category exclusivity (priority vocaloid > anime > jpop)', () => {
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

  it('collapses [jpop, anime, vocaloid] -> [vocaloid] when a Tier A cluster set-unions across all three', () => {
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
    expect(records[0]?.categories).toEqual(['vocaloid']);
  });

  it('two single-tag inputs anime + vocaloid collapse to [vocaloid] (vocaloid wins)', () => {
    const a = record({
      id: 'tj-50100',
      source_url: 'https://tj.test/50100',
      title_primary: 'Sample',
      artist_primary: 'Artist',
      karaoke_numbers: { tj: '50100', ky: null, joysound: null },
      categories: ['anime'],
    });
    const b = record({
      id: 'blog-300-0',
      source_url: 'https://blog.test/300',
      title_primary: 'Sample',
      artist_primary: 'Artist',
      karaoke_numbers: { tj: '50100', ky: null, joysound: null },
      categories: ['vocaloid'],
    });

    const { records } = mergeRecords([a, b]);
    expect(records).toHaveLength(1);
    expect(records[0]?.categories).toEqual(['vocaloid']);
  });

  it('two anime inputs stay [anime] under set-union', () => {
    const a = record({
      id: 'tj-50200',
      source_url: 'https://tj.test/50200',
      title_primary: 'Anime A',
      artist_primary: 'X',
      karaoke_numbers: { tj: '50200', ky: null, joysound: null },
      categories: ['anime'],
    });
    const b = record({
      id: 'blog-301-0',
      source_url: 'https://blog.test/301',
      title_primary: 'Anime A',
      artist_primary: 'X',
      karaoke_numbers: { tj: '50200', ky: null, joysound: null },
      categories: ['anime'],
    });

    const { records } = mergeRecords([a, b]);
    expect(records).toHaveLength(1);
    expect(records[0]?.categories).toEqual(['anime']);
  });
});

// ---------------------------------------------------------------------
// Tier C — cross-source primary-artist-token merge with cross-source gate
// ---------------------------------------------------------------------
describe('mergeRecords — Tier C cross-source primary-token merge', () => {
  it('merges 椎名もた 少女A across TJ + blog (cross-source) and emits a tier_c_merge conflict', () => {
    const tj = record({
      id: 'tj-52498',
      source_url: 'https://tj.test/52498',
      title_primary: '少女A',
      artist_primary: '椎名もた(Feat.鏡音リン)',
      karaoke_numbers: { tj: '52498', ky: null, joysound: null },
      categories: ['vocaloid'],
    });
    const blog = record({
      id: 'blog-487-1',
      source_url: 'https://blog.test/487',
      title_primary: '少女A',
      artist_primary: '椎名もた｜ぽわぽわP',
      title_ko: '소녀A',
      karaoke_numbers: { tj: null, ky: null, joysound: '672848' },
      categories: ['vocaloid'],
    });

    const { records, conflicts } = mergeRecords([tj, blog]);

    expect(records).toHaveLength(1);
    const m = records[0];
    if (!m) throw new Error('no record');
    // Vendor numbers union across the cross-source pair.
    expect(m.karaoke_numbers).toEqual({ tj: '52498', ky: null, joysound: '672848' });
    // TJ wins title/artist via the title-artist chain (tj > blog > namu).
    expect(m.title_primary).toBe('少女A');
    expect(m.artist_primary).toBe('椎名もた(Feat.鏡音リン)');
    // blog wins title_ko via the ko chain (blog > namu > tj).
    expect(m.title_ko).toBe('소녀A');
    expect(m.categories).toEqual(['vocaloid']);
    // id/source_url tiebreak: blog (rank 1) wins over tj (rank 3).
    expect(m.id).toBe('blog-487-1');

    // Exactly one tier_c_merge conflict for the cluster.
    const tierC = conflicts.filter((c) => c.field === 'tier_c_merge');
    expect(tierC).toHaveLength(1);
    expect(tierC[0]?.values.map((v) => v.source).sort()).toEqual(['blog', 'tj']);
    expect(tierC[0]?.values.map((v) => v.value).sort()).toEqual(['blog-487-1', 'tj-52498']);
    expect(tierC[0]?.winner).toBe('blog-487-1');
  });

  it('does NOT merge two TJ-source BTS IDOL twins with same primary token (cross-source gate)', () => {
    const idol = record({
      id: 'tj-98374',
      source_url: 'https://tj.test/98374',
      title_primary: 'IDOL',
      artist_primary: '방탄소년단',
      karaoke_numbers: { tj: '98374', ky: null, joysound: null },
      categories: ['jpop'],
    });
    const idolFeat = record({
      id: 'tj-98392',
      source_url: 'https://tj.test/98392',
      title_primary: 'IDOL',
      artist_primary: '방탄소년단(Feat.Nicki Minaj)',
      karaoke_numbers: { tj: '98392', ky: null, joysound: null },
      categories: ['jpop'],
    });

    const { records, conflicts } = mergeRecords([idol, idolFeat]);

    // Same primary token (방탄소년단) but both `tj-` — gate blocks the merge.
    expect(records).toHaveLength(2);
    expect(conflicts.filter((c) => c.field === 'tier_c_merge')).toHaveLength(0);
  });

  it('merges two blog-source ナユタン星人 太陽系デスコ records via feat-asymmetry+vocaloid exception', () => {
    // Previously documented as "does NOT merge" (cross-source gate). That was
    // a false negative — this pair is structurally identical to the 40mP-class
    // duplicate (same vocaloid producer, same song, one record with the
    // voicebank feat-credit and one without). The Bug 3 fix (2026-05-03) now
    // correctly merges them via the feat-asymmetry+vocaloid exception.
    const a = record({
      id: 'blog-429-1',
      source_url: 'https://blog.test/429',
      title_primary: '太陽系デスコ',
      artist_primary: 'ナユタン星人(Feat.初音ミク)',
      karaoke_numbers: { tj: null, ky: null, joysound: '111111' },
      categories: ['vocaloid'],
    });
    const b = record({
      id: 'blog-429-58',
      source_url: 'https://blog.test/429',
      title_primary: '太陽系デスコ',
      artist_primary: 'ナユタン星人',
      karaoke_numbers: { tj: null, ky: null, joysound: '222222' },
      categories: ['vocaloid'],
    });

    const { records, conflicts } = mergeRecords([a, b]);

    // feat-asymmetry + both vocaloid → Tier C merges them.
    expect(records).toHaveLength(1);
    const tierC = conflicts.filter((c) => c.field === 'tier_c_merge');
    expect(tierC).toHaveLength(1);
    expect(tierC[0]?.values.map((v) => v.value).sort()).toEqual(['blog-429-1', 'blog-429-58']);
  });

  it('does NOT cluster 中森明菜 少女A with 椎名もた 少女A (different primary tokens)', () => {
    const akina = record({
      id: 'blog-539-2',
      source_url: 'https://blog.test/539',
      title_primary: '少女A',
      artist_primary: '中森明菜',
      karaoke_numbers: { tj: null, ky: null, joysound: '999999' },
      categories: ['jpop'],
    });
    const tj = record({
      id: 'tj-52498',
      source_url: 'https://tj.test/52498',
      title_primary: '少女A',
      artist_primary: '椎名もた(Feat.鏡音リン)',
      karaoke_numbers: { tj: '52498', ky: null, joysound: null },
      categories: ['vocaloid'],
    });
    const blog = record({
      id: 'blog-487-1',
      source_url: 'https://blog.test/487',
      title_primary: '少女A',
      artist_primary: '椎名もた｜ぽわぽわP',
      karaoke_numbers: { tj: null, ky: null, joysound: '672848' },
      categories: ['vocaloid'],
    });

    const { records, conflicts } = mergeRecords([akina, tj, blog]);

    // 椎名もた pair merges (Tier C, via cross-source path; feat-asymmetry exception not invoked); 中森明菜 stays separate (different token).
    expect(records).toHaveLength(2);
    const akinaOut = records.find((r) => r.artist_primary === '中森明菜');
    expect(akinaOut).toBeDefined();
    expect(akinaOut?.id).toBe('blog-539-2');
    // Exactly one tier_c_merge conflict — the 椎名もた cluster.
    expect(conflicts.filter((c) => c.field === 'tier_c_merge')).toHaveLength(1);
  });

  it('records with empty-after-normalize artist_primary stay singletons (tierCKey null)', () => {
    // artist_primary is non-null in the schema, but a punctuation-only string
    // normalizes to '' so `tierCKey` returns null and Tier C cannot key the
    // record. Different titles ensure Tier B doesn't fire either — these
    // records must survive the merger as two singletons.
    const a = record({
      id: 'tj-77777',
      source_url: 'https://tj.test/77777',
      title_primary: 'Title One',
      artist_primary: '???',
      karaoke_numbers: { tj: '77777', ky: null, joysound: null },
    });
    const b = record({
      id: 'blog-77-7',
      source_url: 'https://blog.test/77',
      title_primary: 'Title Two',
      artist_primary: '!!!',
      karaoke_numbers: { tj: null, ky: null, joysound: '888888' },
    });

    const { records, conflicts } = mergeRecords([a, b]);

    // Both records' tierCKey is null — no merge.
    expect(records).toHaveLength(2);
    expect(conflicts.filter((c) => c.field === 'tier_c_merge')).toHaveLength(0);
  });

  it('merges a 3-source cluster (tj + blog + namu) when all share the primary token', () => {
    const tj = record({
      id: 'tj-68689',
      source_url: 'https://tj.test/68689',
      title_primary: '月光',
      artist_primary: 'キタニタツヤ(Feat.はるまきごはん)',
      karaoke_numbers: { tj: '68689', ky: null, joysound: null },
      categories: ['jpop'],
    });
    const blog = record({
      id: 'blog-262-57',
      source_url: 'https://blog.test/262',
      title_primary: '月光',
      artist_primary: 'キタニタツヤ',
      karaoke_numbers: { tj: null, ky: null, joysound: '500001' },
      categories: ['vocaloid'],
    });
    const namu = record({
      id: 'namu-9001',
      source_url: 'https://namu.test/9001',
      title_primary: '月光',
      artist_primary: 'キタニタツヤ & はるまきごはん',
      title_ko: '월광',
      karaoke_numbers: { tj: null, ky: '40001', joysound: null },
      categories: ['vocaloid'],
    });

    const { records, conflicts } = mergeRecords([tj, blog, namu]);

    expect(records).toHaveLength(1);
    const m = records[0];
    if (!m) throw new Error('no record');
    // All three vendor numbers union across sources.
    expect(m.karaoke_numbers).toEqual({ tj: '68689', ky: '40001', joysound: '500001' });
    // Categories collapse to [vocaloid] via priority (vocaloid > jpop).
    expect(m.categories).toEqual(['vocaloid']);
    // ko chain blog→namu→tj: namu wins (blog has null title_ko).
    expect(m.title_ko).toBe('월광');

    // One tier_c_merge conflict, three contributors.
    const tierC = conflicts.filter((c) => c.field === 'tier_c_merge');
    expect(tierC).toHaveLength(1);
    expect(tierC[0]?.values).toHaveLength(3);
    expect(tierC[0]?.values.map((v) => v.source).sort()).toEqual(['blog', 'namu', 'tj']);
  });

  // -------------------------------------------------------------------
  // Feat-asymmetry + vocaloid exception (Bug 3 fix 2026-05-03)
  // Same-source clusters where EXACTLY ONE member carries a feat-paren, the
  // others do not, AND all members are tagged `vocaloid` are admitted via
  // Tier C. This catches the 40mP-class duplicate: the same Vocaloid
  // producer track published twice, once crediting the voicebank feat. and
  // once without. The vocaloid-category gate is what distinguishes this from
  // the BTS-IDOL class (jpop, genuinely distinct collab release).
  // -------------------------------------------------------------------
  it('merges same-source 40mP pair (feat-asymmetric, both vocaloid) via feat-asymmetry+vocaloid exception', () => {
    const plain = record({
      id: 'blog-440-0',
      source_url: 'https://blog.test/440',
      title_primary: 'Tell Your World',
      artist_primary: '40mP',
      karaoke_numbers: { tj: null, ky: null, joysound: '700001' },
      categories: ['vocaloid'],
    });
    const feat = record({
      id: 'blog-440-1',
      source_url: 'https://blog.test/440',
      title_primary: 'Tell Your World',
      artist_primary: '40mP(Feat.初音ミク)',
      karaoke_numbers: { tj: null, ky: null, joysound: '700002' },
      categories: ['vocaloid'],
    });

    const { records, conflicts } = mergeRecords([plain, feat]);

    // feat-asymmetric + both vocaloid → Tier C merges the same-source pair.
    expect(records).toHaveLength(1);
    const tierC = conflicts.filter((c) => c.field === 'tier_c_merge');
    expect(tierC).toHaveLength(1);
    expect(tierC[0]?.values.map((v) => v.source).sort()).toEqual(['blog', 'blog']);
  });

  it('does NOT merge same-source vocaloid pair when BOTH members have feat-parens (asymmetry fails)', () => {
    // Asymmetry condition fails (withFeat=2, withoutFeat=0) — the vocaloid
    // gate passes but the feat-asymmetry gate does not. No merge.
    const featA = record({
      id: 'blog-500-0',
      source_url: 'https://blog.test/500',
      title_primary: 'Collab Song',
      artist_primary: 'VocaProd(Feat.初音ミク)',
      karaoke_numbers: { tj: null, ky: null, joysound: '710001' },
      categories: ['vocaloid'],
    });
    const featB = record({
      id: 'blog-500-1',
      source_url: 'https://blog.test/500',
      title_primary: 'Collab Song',
      artist_primary: 'VocaProd(Feat.鏡音リン)',
      karaoke_numbers: { tj: null, ky: null, joysound: '710002' },
      categories: ['vocaloid'],
    });

    const { records, conflicts } = mergeRecords([featA, featB]);

    expect(records).toHaveLength(2);
    expect(conflicts.filter((c) => c.field === 'tier_c_merge')).toHaveLength(0);
  });

  it('does NOT merge same-source jpop pair even with feat-asymmetry (category gate blocks)', () => {
    // Same structural shape as the 40mP case (feat-asymmetric, same-source,
    // same primary token after getLeadComponent) but `jpop` category.
    // The vocaloid-category gate blocks the merge — BTS-IDOL class.
    const plain = record({
      id: 'tj-98374',
      source_url: 'https://tj.test/98374',
      title_primary: 'IDOL',
      artist_primary: '방탄소년단',
      karaoke_numbers: { tj: '98374', ky: null, joysound: null },
      categories: ['jpop'],
    });
    const feat = record({
      id: 'tj-98392',
      source_url: 'https://tj.test/98392',
      title_primary: 'IDOL',
      artist_primary: '방탄소년단(Feat.Nicki Minaj)',
      karaoke_numbers: { tj: '98392', ky: null, joysound: null },
      categories: ['jpop'],
    });

    const { records, conflicts } = mergeRecords([plain, feat]);

    // jpop → category gate fails → no merge (preserves BTS-IDOL guard).
    expect(records).toHaveLength(2);
    expect(conflicts.filter((c) => c.field === 'tier_c_merge')).toHaveLength(0);
  });

  it('Tier C does NOT merge same-source vocaloid cluster when 2 of 3 members have feat-paren (asymmetry condition fails)', () => {
    // withFeat=2, withoutFeat=1 → `withFeat === 1` is false → gate rejects.
    // Pins the off-by-one boundary: only EXACTLY ONE feat-paren member admits.
    const plain = record({
      id: 'blog-430-0',
      source_url: 'https://blog.test/430',
      title_primary: 'エイリアンエイリアン',
      artist_primary: 'ナユタン星人',
      karaoke_numbers: { tj: null, ky: null, joysound: '800001' },
      categories: ['vocaloid'],
    });
    const featMiku = record({
      id: 'blog-430-1',
      source_url: 'https://blog.test/430',
      title_primary: 'エイリアンエイリアン',
      artist_primary: 'ナユタン星人(Feat.初音ミク)',
      karaoke_numbers: { tj: null, ky: null, joysound: '800002' },
      categories: ['vocaloid'],
    });
    const featRin = record({
      id: 'blog-430-2',
      source_url: 'https://blog.test/430',
      title_primary: 'エイリアンエイリアン',
      artist_primary: 'ナユタン星人(Feat.鏡音リン)',
      karaoke_numbers: { tj: null, ky: null, joysound: '800003' },
      categories: ['vocaloid'],
    });

    const { records, conflicts } = mergeRecords([plain, featMiku, featRin]);

    // withFeat=2 fails the `withFeat === 1` check — no same-source Tier C merge.
    expect(records).toHaveLength(3);
    expect(conflicts.filter((c) => c.field === 'tier_c_merge')).toHaveLength(0);
  });

  it('Tier C only sees post-Tier-A/B residuals — does not double-merge a Tier B cluster', () => {
    // Pair A: identical title+artist+TJ — Tier A merges via shared TJ.
    const tjA = record({
      id: 'tj-11111',
      source_url: 'https://tj.test/11111',
      title_primary: 'SongA',
      artist_primary: 'ArtistA',
      karaoke_numbers: { tj: '11111', ky: null, joysound: null },
    });
    const blogA = record({
      id: 'blog-1111-0',
      source_url: 'https://blog.test/1111',
      title_primary: 'SongA',
      artist_primary: 'ArtistA',
      karaoke_numbers: { tj: '11111', ky: null, joysound: null },
    });
    // Pair B: same title+token as a different feat. — would Tier C if singleton.
    const tjB = record({
      id: 'tj-22222',
      source_url: 'https://tj.test/22222',
      title_primary: 'SongA',
      artist_primary: 'ArtistA(Feat.Guest)',
      karaoke_numbers: { tj: '22222', ky: null, joysound: null },
    });
    const blogB = record({
      id: 'blog-2222-0',
      source_url: 'https://blog.test/2222',
      title_primary: 'SongA',
      artist_primary: 'ArtistA(Feat.Guest)',
      karaoke_numbers: { tj: null, ky: null, joysound: '900001' },
    });

    const { records, conflicts } = mergeRecords([tjA, blogA, tjB, blogB]);

    // Pair A merges via Tier A (shared TJ#11111).
    // Pair B merges via Tier B (identical title+artist; no shared vendor).
    // Tier C does NOT re-cluster either — they're already in 2-member clusters.
    expect(records).toHaveLength(2);
    expect(conflicts.filter((c) => c.field === 'tier_c_merge')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// title_ko optional-field trio preservation (FIX-1 regression tests)
// Covers: media_context_ko, title_ko_source, title_ko_confidence surviving
// mergeCluster via pickKoDonor.
// ---------------------------------------------------------------------
describe('mergeRecords — title_ko optional-field trio preservation (FIX-1)', () => {
  it('Test 1 — pairs title_ko_source with the blog title_ko donor', () => {
    const blog = record({
      id: 'blog-100-0',
      source_url: 'https://blog.test/100',
      title_primary: '夜に駆ける',
      title_ko: '블로그번역',
      title_ko_source: 'blog',
    });
    const tj = record({
      id: 'tj-20001',
      source_url: 'https://tj.test/20001',
      title_primary: '夜に駆ける',
      title_ko: null,
      karaoke_numbers: { tj: '20001', ky: null, joysound: null },
    });
    // Force Tier B cluster: same title+artist, no shared vendor.
    const { records } = mergeRecords([blog, tj]);
    expect(records).toHaveLength(1);
    const m = records[0];
    if (!m) throw new Error('no record');
    expect(m.title_ko).toBe('블로그번역');
    expect(m.title_ko_source).toBe('blog');
    // title_ko_confidence must NOT be present (blog source disallows it).
    expect(m.title_ko_confidence).toBeUndefined();
  });

  it('Test 2 — preserves llm-translated trio (source + confidence) through merge', () => {
    const blog = record({
      id: 'blog-101-0',
      source_url: 'https://blog.test/101',
      title_primary: '群青',
      title_ko: 'LLM 번역',
      title_ko_source: 'llm-translated',
      title_ko_confidence: 'high',
    });
    const tj = record({
      id: 'tj-20002',
      source_url: 'https://tj.test/20002',
      title_primary: '群青',
      title_ko: null,
      karaoke_numbers: { tj: '20002', ky: null, joysound: null },
    });
    const { records } = mergeRecords([blog, tj]);
    expect(records).toHaveLength(1);
    const m = records[0];
    if (!m) throw new Error('no record');
    expect(m.title_ko).toBe('LLM 번역');
    expect(m.title_ko_source).toBe('llm-translated');
    expect(m.title_ko_confidence).toBe('high');
  });

  it('Test 3 — preserves media_context_ko on Latin-titled record (title_ko null)', () => {
    const blog = record({
      id: 'blog-102-0',
      source_url: 'https://blog.test/102',
      title_primary: 'Attack on Titan OP',
      title_ko: null,
      media_context_ko: '(진격의 거인 OP)',
    });
    const { records } = mergeRecords([blog]);
    expect(records).toHaveLength(1);
    const m = records[0];
    if (!m) throw new Error('no record');
    expect(m.media_context_ko).toBe('(진격의 거인 OP)');
  });

  it('Test 4 — exhaustiveness guard: every optional SongRecord field survives singleton-cluster merge', () => {
    // Populate every optional field defined in SongRecord. If a future field is
    // added to the schema but NOT threaded through mergeCluster, this test
    // fails loudly (missing field on the output).
    //
    // Cross-field constraint: title_ko_confidence requires title_ko_source='llm-translated'.
    // 'manual' source does NOT carry confidence — tested separately in Test 1.
    // Here we use 'llm-translated' to exercise the confidence path.
    const full = record({
      id: 'blog-103-0',
      source_url: 'https://blog.test/103',
      title_primary: 'メルト',
      title_ko: '멜트',
      artist_primary: 'ryo｜supercell',
      artist_aliases: ['supercell'],
      media_context_ko: '(초음 미크 오리지널)',
      title_ko_source: 'llm-translated',
      title_ko_confidence: 'medium',
      categories: ['vocaloid'],
    });

    const { records } = mergeRecords([full]);
    expect(records).toHaveLength(1);
    const m = records[0];
    if (!m) throw new Error('no record');

    // Required fields.
    expect(m.id).toBe('blog-103-0');
    expect(m.title_primary).toBe('メルト');
    expect(m.title_ko).toBe('멜트');
    expect(m.artist_primary).toBe('ryo｜supercell');
    expect(m.artist_ko).toBeNull();
    expect(m.categories).toEqual(['vocaloid']);

    // Optional fields — none should be missing.
    expect(m.artist_aliases).toEqual(['supercell']);
    expect(m.media_context_ko).toBe('(초음 미크 오리지널)');
    expect(m.title_ko_source).toBe('llm-translated');
    expect(m.title_ko_confidence).toBe('medium');
  });
});

// ---------------------------------------------------------------------
// getLeadComponent — verified through Tier C clustering integration
// ---------------------------------------------------------------------
describe('getLeadComponent (via Tier C integration)', () => {
  it('splits on (Prod. — LE SSERAFIM(Prod.imase) shares token with imase', () => {
    const tj = record({
      id: 'tj-90001',
      source_url: 'https://tj.test/90001',
      title_primary: 'TestProd',
      // Hypothetical: a Prod-tagged primary artist string.
      artist_primary: 'imase(Prod.someone)',
      karaoke_numbers: { tj: '90001', ky: null, joysound: null },
    });
    const blog = record({
      id: 'blog-9001-0',
      source_url: 'https://blog.test/9001',
      title_primary: 'TestProd',
      artist_primary: 'imase',
      karaoke_numbers: { tj: null, ky: null, joysound: '500200' },
    });

    const { records } = mergeRecords([tj, blog]);
    expect(records).toHaveLength(1);
  });

  it('splits on " with " — X with Y matches X (cross-source)', () => {
    const tj = record({
      id: 'tj-90002',
      source_url: 'https://tj.test/90002',
      title_primary: 'TestWith',
      artist_primary: 'X with Y',
      karaoke_numbers: { tj: '90002', ky: null, joysound: null },
    });
    const blog = record({
      id: 'blog-9002-0',
      source_url: 'https://blog.test/9002',
      title_primary: 'TestWith',
      artist_primary: 'X',
      karaoke_numbers: { tj: null, ky: null, joysound: '500300' },
    });

    const { records } = mergeRecords([tj, blog]);
    expect(records).toHaveLength(1);
  });

  it('splits on ", " (comma+space) — A, B matches A (cross-source)', () => {
    const tj = record({
      id: 'tj-90003',
      source_url: 'https://tj.test/90003',
      title_primary: 'TestComma',
      artist_primary: 'A, B',
      karaoke_numbers: { tj: '90003', ky: null, joysound: null },
    });
    const blog = record({
      id: 'blog-9003-0',
      source_url: 'https://blog.test/9003',
      title_primary: 'TestComma',
      artist_primary: 'A',
      karaoke_numbers: { tj: null, ky: null, joysound: '500400' },
    });

    const { records } = mergeRecords([tj, blog]);
    expect(records).toHaveLength(1);
  });

  it('does NOT split soloName (no delimiter) — unrelated artists stay separate', () => {
    const tj = record({
      id: 'tj-90004',
      source_url: 'https://tj.test/90004',
      title_primary: 'TestSolo',
      artist_primary: 'SoloOne',
      karaoke_numbers: { tj: '90004', ky: null, joysound: null },
    });
    const blog = record({
      id: 'blog-9004-0',
      source_url: 'https://blog.test/9004',
      title_primary: 'TestSolo',
      artist_primary: 'SoloTwo',
      karaoke_numbers: { tj: null, ky: null, joysound: '500500' },
    });

    const { records } = mergeRecords([tj, blog]);
    // Different soloName values → different primary tokens → no merge.
    expect(records).toHaveLength(2);
  });
});
