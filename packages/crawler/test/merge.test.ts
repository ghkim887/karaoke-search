import type { SongRecord } from '@karaoke/schema';
import { describe, expect, it } from 'vitest';
import { headlineConflicts, mergeRecords } from '../src/merge.js';

function record(over: Partial<SongRecord>): SongRecord {
  return {
    id: 'blog-1-0',
    source_url: 'https://example.test/1',
    title_primary: 'あぶく',
    title_ko: null,
    artist_primary: 'ヨルシカ',
    artist_ko: null,
    karaoke_numbers: { tj: null, ky: null, joysound: null },
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
      id: 'blog-9001-joysound-500200',
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
    });
    const blog = record({
      id: 'blog-1-tj-68923',
      source_url: 'https://blog.test/1',
      title_primary: 'Gunjō',
      title_ko: '군청',
      artist_primary: 'YOASOBI',
      artist_ko: '요아소비',
      karaoke_numbers: { tj: '68923', ky: null, joysound: null },
    });

    const { records, conflicts } = mergeRecords([tj, blog]);

    expect(records).toHaveLength(1);
    expect(conflicts).toHaveLength(0);
    const m = records[0];
    if (!m) throw new Error('no record');
    // title_primary chain TJ→blog→tjpdf: TJ wins.
    expect(m.title_primary).toBe('群青');
    expect(m.artist_primary).toBe('YOASOBI');
    // ko chain blog→tj→tjpdf→joysound: blog wins.
    expect(m.title_ko).toBe('군청');
    expect(m.artist_ko).toBe('요아소비');
    expect(m.karaoke_numbers.tj).toBe('68923');
    // id/source_url tiebreak: tj (rank 1) now wins over blog (rank 4).
    expect(m.id).toBe('tj-68923');
    expect(m.source_url).toBe('https://tj.test/68923');
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
      id: 'blog-1-tj-68923',
      source_url: 'https://blog.test/1',
      title_primary: 'Gunjō',
      title_ko: '군청',
      artist_primary: 'YOASOBI',
      karaoke_numbers: { tj: '68923', ky: null, joysound: null },
    });
    const tjpdf = record({
      id: 'tjpdf-1',
      source_url: 'https://tjpdf.test/1',
      title_primary: '群青 (YOASOBI)',
      title_ko: '군청 (TJPDF)',
      artist_primary: 'YOASOBI',
      artist_ko: '요아소비',
      karaoke_numbers: { tj: '68923', ky: '47474', joysound: null },
    });

    const { records, conflicts } = mergeRecords([tj, blog, tjpdf]);

    expect(records).toHaveLength(1);
    expect(conflicts).toHaveLength(0);
    const m = records[0];
    if (!m) throw new Error('no record');
    // title_primary chain TJ→blog→tjpdf: TJ wins.
    expect(m.title_primary).toBe('群青');
    // title_ko chain blog→tj→tjpdf→joysound: blog wins.
    expect(m.title_ko).toBe('군청');
    // KY contributed only by tjpdf — survives the union.
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
  it('logs a Tier B vendor-number conflict and lets the vendor (tjpdf) win the tj field', () => {
    const blog = record({
      id: 'blog-3-tj-68923',
      source_url: 'https://blog.test/3',
      title_primary: 'アイドル',
      artist_primary: 'YOASOBI',
      karaoke_numbers: { tj: '68923', ky: null, joysound: null },
    });
    const tjpdf = record({
      id: 'tjpdf-2',
      source_url: 'https://tjpdf.test/2',
      title_primary: 'アイドル',
      artist_primary: 'YOASOBI',
      karaoke_numbers: { tj: '68924', ky: null, joysound: null },
    });

    const { records, conflicts } = mergeRecords([blog, tjpdf]);

    expect(records).toHaveLength(1);
    // tjpdf wins on tj: blog is now the lowest-priority source.
    expect(records[0]?.karaoke_numbers.tj).toBe('68924');
    // Exactly one conflict on the tj field.
    expect(conflicts).toHaveLength(1);
    const c = conflicts[0];
    if (!c) throw new Error('no conflict');
    expect(c.field).toBe('tj');
    expect(c.winner).toBe('68924');
    expect(c.values.map((v) => v.source).sort()).toEqual(['blog', 'tjpdf']);
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
      id: 'tjpdf-3',
      source_url: 'https://tjpdf.test/3',
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
  // Case 7: TJ-less Vocaloid (tjpdf only)
  // ---------------------------------------------------------------------
  it('keeps a tjpdf-only Vocaloid record standalone with title_primary from tjpdf', () => {
    const tjpdf = record({
      id: 'tjpdf-vocaloid-1',
      source_url: 'https://tjpdf.test/vocaloid/1',
      title_primary: 'メルト',
      title_ko: '멜트',
      artist_primary: 'ryo',
      karaoke_numbers: { tj: null, ky: null, joysound: null },
    });

    const { records, conflicts } = mergeRecords([tjpdf]);

    expect(records).toHaveLength(1);
    expect(conflicts).toHaveLength(0);
    expect(records[0]?.title_primary).toBe('メルト');
    expect(records[0]?.karaoke_numbers.tj).toBeNull();
    expect(records[0]?.id).toBe('tjpdf-vocaloid-1');
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
        id: 'blog-50-tj-100',
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
        id: 'tjpdf-99',
        source_url: 'https://tjpdf.test/99',
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
    });
    const blog = record({
      id: 'blog-487-joysound-672848',
      source_url: 'https://blog.test/487',
      title_primary: '少女A',
      artist_primary: '椎名もた｜ぽわぽわP',
      title_ko: '소녀A',
      karaoke_numbers: { tj: null, ky: null, joysound: '672848' },
    });

    const { records, conflicts } = mergeRecords([tj, blog]);

    expect(records).toHaveLength(1);
    const m = records[0];
    if (!m) throw new Error('no record');
    // Vendor numbers union across the cross-source pair.
    expect(m.karaoke_numbers).toEqual({ tj: '52498', ky: null, joysound: '672848' });
    // TJ wins title/artist via the title-artist chain (tj > blog > tjpdf).
    expect(m.title_primary).toBe('少女A');
    expect(m.artist_primary).toBe('椎名もた(Feat.鏡音リン)');
    // blog wins title_ko via the ko chain (blog > tjpdf > tj).
    expect(m.title_ko).toBe('소녀A');
    // id/source_url tiebreak: tj (rank 1) now wins over blog (rank 4).
    expect(m.id).toBe('tj-52498');

    // Exactly one tier_c_merge conflict for the cluster.
    const tierC = conflicts.filter((c) => c.field === 'tier_c_merge');
    expect(tierC).toHaveLength(1);
    expect(tierC[0]?.values.map((v) => v.source).sort()).toEqual(['blog', 'tj']);
    expect(tierC[0]?.values.map((v) => v.value).sort()).toEqual([
      'blog-487-joysound-672848',
      'tj-52498',
    ]);
    expect(tierC[0]?.winner).toBe('tj-52498');
  });

  it('does NOT merge two TJ-source BTS IDOL twins with same primary token (cross-source gate)', () => {
    const idol = record({
      id: 'tj-98374',
      source_url: 'https://tj.test/98374',
      title_primary: 'IDOL',
      artist_primary: '방탄소년단',
      karaoke_numbers: { tj: '98374', ky: null, joysound: null },
    });
    const idolFeat = record({
      id: 'tj-98392',
      source_url: 'https://tj.test/98392',
      title_primary: 'IDOL',
      artist_primary: '방탄소년단(Feat.Nicki Minaj)',
      karaoke_numbers: { tj: '98392', ky: null, joysound: null },
    });

    const { records, conflicts } = mergeRecords([idol, idolFeat]);

    // Same primary token (방탄소년단) but both `tj-` — gate blocks the merge.
    expect(records).toHaveLength(2);
    expect(conflicts.filter((c) => c.field === 'tier_c_merge')).toHaveLength(0);
  });

  it('does NOT merge two blog-source ナユタン星人 太陽系デスコ records (same-source gate, no feat-asymmetry exception)', () => {
    // With the category dimension removed, the feat-asymmetry+vocaloid
    // exception is gone — same-source clusters never union. This same-source
    // feat-asymmetric pair therefore stays as two records.
    const a = record({
      id: 'blog-429-joysound-111111',
      source_url: 'https://blog.test/429',
      title_primary: '太陽系デスコ',
      artist_primary: 'ナユタン星人(Feat.初音ミク)',
      karaoke_numbers: { tj: null, ky: null, joysound: '111111' },
    });
    const b = record({
      id: 'blog-429-joysound-222222',
      source_url: 'https://blog.test/429',
      title_primary: '太陽系デスコ',
      artist_primary: 'ナユタン星人',
      karaoke_numbers: { tj: null, ky: null, joysound: '222222' },
    });

    const { records, conflicts } = mergeRecords([a, b]);

    // Same-source → no Tier C merge.
    expect(records).toHaveLength(2);
    expect(conflicts.filter((c) => c.field === 'tier_c_merge')).toHaveLength(0);
  });

  it('does NOT cluster 中森明菜 少女A with 椎名もた 少女A (different primary tokens)', () => {
    const akina = record({
      id: 'blog-539-joysound-999999',
      source_url: 'https://blog.test/539',
      title_primary: '少女A',
      artist_primary: '中森明菜',
      karaoke_numbers: { tj: null, ky: null, joysound: '999999' },
    });
    const tj = record({
      id: 'tj-52498',
      source_url: 'https://tj.test/52498',
      title_primary: '少女A',
      artist_primary: '椎名もた(Feat.鏡音リン)',
      karaoke_numbers: { tj: '52498', ky: null, joysound: null },
    });
    const blog = record({
      id: 'blog-487-joysound-672848',
      source_url: 'https://blog.test/487',
      title_primary: '少女A',
      artist_primary: '椎名もた｜ぽわぽわP',
      karaoke_numbers: { tj: null, ky: null, joysound: '672848' },
    });

    const { records, conflicts } = mergeRecords([akina, tj, blog]);

    // 椎名もた pair merges (Tier C, cross-source path); 中森明菜 stays separate (different token).
    expect(records).toHaveLength(2);
    const akinaOut = records.find((r) => r.artist_primary === '中森明菜');
    expect(akinaOut).toBeDefined();
    expect(akinaOut?.id).toBe('blog-539-joysound-999999');
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
      id: 'blog-77-joysound-888888',
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

  it('merges a 3-source cluster (tj + blog + tjpdf) when all share the primary token', () => {
    const tj = record({
      id: 'tj-68689',
      source_url: 'https://tj.test/68689',
      title_primary: '月光',
      artist_primary: 'キタニタツヤ(Feat.はるまきごはん)',
      karaoke_numbers: { tj: '68689', ky: null, joysound: null },
    });
    const blog = record({
      id: 'blog-262-joysound-500001',
      source_url: 'https://blog.test/262',
      title_primary: '月光',
      artist_primary: 'キタニタツヤ',
      karaoke_numbers: { tj: null, ky: null, joysound: '500001' },
    });
    const tjpdf = record({
      id: 'tjpdf-9001',
      source_url: 'https://tjpdf.test/9001',
      title_primary: '月光',
      artist_primary: 'キタニタツヤ & はるまきごはん',
      title_ko: '월광',
      karaoke_numbers: { tj: null, ky: '40001', joysound: null },
    });

    const { records, conflicts } = mergeRecords([tj, blog, tjpdf]);

    expect(records).toHaveLength(1);
    const m = records[0];
    if (!m) throw new Error('no record');
    // All three vendor numbers union across sources.
    expect(m.karaoke_numbers).toEqual({ tj: '68689', ky: '40001', joysound: '500001' });
    // ko chain blog→tj→tjpdf→joysound: tjpdf wins (blog has null title_ko).
    expect(m.title_ko).toBe('월광');

    // One tier_c_merge conflict, three contributors.
    const tierC = conflicts.filter((c) => c.field === 'tier_c_merge');
    expect(tierC).toHaveLength(1);
    expect(tierC[0]?.values).toHaveLength(3);
    expect(tierC[0]?.values.map((v) => v.source).sort()).toEqual(['blog', 'tj', 'tjpdf']);
  });

  // -------------------------------------------------------------------
  // Same-source clusters never union (Tier C is cross-source-only).
  // The feat-asymmetry+vocaloid exception was removed with the category
  // dimension; same-source twins sharing a primary token stay distinct.
  // -------------------------------------------------------------------
  it('does NOT merge a same-source 40mP feat-asymmetric pair (same-source gate)', () => {
    const plain = record({
      id: 'blog-440-joysound-700001',
      source_url: 'https://blog.test/440',
      title_primary: 'Tell Your World',
      artist_primary: '40mP',
      karaoke_numbers: { tj: null, ky: null, joysound: '700001' },
    });
    const feat = record({
      id: 'blog-440-joysound-700002',
      source_url: 'https://blog.test/440',
      title_primary: 'Tell Your World',
      artist_primary: '40mP(Feat.初音ミク)',
      karaoke_numbers: { tj: null, ky: null, joysound: '700002' },
    });

    const { records, conflicts } = mergeRecords([plain, feat]);

    // Same-source → no Tier C merge.
    expect(records).toHaveLength(2);
    expect(conflicts.filter((c) => c.field === 'tier_c_merge')).toHaveLength(0);
  });

  it('does NOT merge a same-source cluster when 2 of 3 members have a feat-paren', () => {
    const plain = record({
      id: 'blog-430-joysound-800001',
      source_url: 'https://blog.test/430',
      title_primary: 'エイリアンエイリアン',
      artist_primary: 'ナユタン星人',
      karaoke_numbers: { tj: null, ky: null, joysound: '800001' },
    });
    const featMiku = record({
      id: 'blog-430-joysound-800002',
      source_url: 'https://blog.test/430',
      title_primary: 'エイリアンエイリアン',
      artist_primary: 'ナユタン星人(Feat.初音ミク)',
      karaoke_numbers: { tj: null, ky: null, joysound: '800002' },
    });
    const featRin = record({
      id: 'blog-430-joysound-800003',
      source_url: 'https://blog.test/430',
      title_primary: 'エイリアンエイリアン',
      artist_primary: 'ナユタン星人(Feat.鏡音リン)',
      karaoke_numbers: { tj: null, ky: null, joysound: '800003' },
    });

    const { records, conflicts } = mergeRecords([plain, featMiku, featRin]);

    // All same-source → no Tier C merge.
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
      id: 'blog-1111-tj-11111',
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
      id: 'blog-2222-joysound-900001',
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
      id: 'blog-9001-joysound-500200',
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
      id: 'blog-9002-joysound-500300',
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
      id: 'blog-9003-joysound-500400',
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
      id: 'blog-9004-joysound-500500',
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

describe('mergeRecords — joysound-official adapter regressions', () => {
  function joysoundRec(over: Partial<SongRecord> = {}): SongRecord {
    return record({
      id: 'joysound-190001',
      source_url: 'https://www.joysound.com/web/search/song/190001',
      title_primary: '夜に駆ける',
      title_ko: null,
      artist_primary: 'YOASOBI',
      artist_ko: null,
      karaoke_numbers: { tj: null, ky: null, joysound: '190-001' },
      ...over,
    });
  }

  it('passes through a joysound-only record unchanged', () => {
    const js = joysoundRec();
    const { records, conflicts } = mergeRecords([js]);
    expect(records).toHaveLength(1);
    expect(conflicts).toHaveLength(0);
    expect(records[0]?.id).toBe('joysound-190001');
    expect(records[0]?.karaoke_numbers).toEqual({ tj: null, ky: null, joysound: '190-001' });
    expect(records[0]?.title_ko).toBeNull();
    expect(records[0]?.artist_ko).toBeNull();
  });

  it('Tier B merges a joysound row with a blog row sharing title+artist; joysound wins id, blog still wins title/artist_primary/title_ko, joysound# is unioned', () => {
    const blog = record({
      id: 'blog-7777-0',
      source_url: 'https://blog.test/7777',
      title_primary: '夜に駆ける',
      title_ko: '밤에 달리다',
      artist_primary: 'YOASOBI',
      artist_ko: '요아소비',
      karaoke_numbers: { tj: null, ky: null, joysound: null },
    });
    const js = joysoundRec();

    const { records, conflicts } = mergeRecords([blog, js]);
    expect(records).toHaveLength(1);
    expect(conflicts).toHaveLength(0);
    const m = records[0];
    if (!m) throw new Error('no record');
    // Primary id/source_url: joysound (rank 3) now wins over blog (rank 4).
    expect(m.id).toBe('joysound-190001');
    expect(m.source_url).toBe('https://www.joysound.com/web/search/song/190001');
    // title_primary chain TJ→blog: blog wins (no TJ).
    expect(m.title_primary).toBe('夜に駆ける');
    expect(m.artist_primary).toBe('YOASOBI');
    // KO_CHAIN blog→tj: blog's KO fields propagate.
    expect(m.title_ko).toBe('밤에 달리다');
    expect(m.artist_ko).toBe('요아소비');
    // karaoke_numbers union: joysound# is preserved from the joysound record.
    expect(m.karaoke_numbers).toEqual({ tj: null, ky: null, joysound: '190-001' });
  });

  it('Tier B merges a joysound row with a tj row; tj wins title_primary, joysound# joins karaoke_numbers, title_ko stays null (no KO source)', () => {
    const tj = record({
      id: 'tj-68923',
      source_url: 'https://tj.test/68923',
      title_primary: '夜に駆ける',
      title_ko: null,
      artist_primary: 'YOASOBI',
      artist_ko: null,
      karaoke_numbers: { tj: '68923', ky: null, joysound: null },
    });
    const js = joysoundRec();

    const { records, conflicts } = mergeRecords([tj, js]);
    expect(records).toHaveLength(1);
    expect(conflicts).toHaveLength(0);
    const m = records[0];
    if (!m) throw new Error('no record');
    // TJ wins title_primary (TITLE_ARTIST_CHAIN starts with tj).
    expect(m.title_primary).toBe('夜に駆ける');
    // Both vendor numbers union.
    expect(m.karaoke_numbers).toEqual({ tj: '68923', ky: null, joysound: '190-001' });
    // No source contributed title_ko; merger must not invent one from joysound.
    expect(m.title_ko).toBeNull();
    expect(m.artist_ko).toBeNull();
    // id tiebreak: tj (rank 1) wins over joysound.
    expect(m.id).toBe('tj-68923');
  });

  it('Three-way merge blog+tj+joysound (shared Tier B key): tj id wins, tj title wins, blog ko wins, joysound# preserved', () => {
    // All three records share the same normalized title + artist so they
    // cluster together at Tier B. No shared vendor # means no Tier A subset
    // cluster that would split the three apart.
    const blog = record({
      id: 'blog-7777-0',
      source_url: 'https://blog.test/7777',
      title_primary: '夜に駆ける',
      title_ko: '밤에 달리다',
      artist_primary: 'YOASOBI',
      artist_ko: '요아소비',
      karaoke_numbers: { tj: null, ky: null, joysound: null },
    });
    const tj = record({
      id: 'tj-68923',
      source_url: 'https://tj.test/68923',
      title_primary: '夜に駆ける',
      title_ko: null,
      artist_primary: 'YOASOBI',
      artist_ko: null,
      karaoke_numbers: { tj: '68923', ky: null, joysound: null },
    });
    const js = joysoundRec();

    const { records, conflicts } = mergeRecords([blog, tj, js]);
    expect(records).toHaveLength(1);
    expect(conflicts).toHaveLength(0);
    const m = records[0];
    if (!m) throw new Error('no record');
    // tj (rank 1) now wins id/source_url over blog; blog still owns the ko fields.
    expect(m.id).toBe('tj-68923');
    expect(m.title_primary).toBe('夜に駆ける');
    expect(m.title_ko).toBe('밤에 달리다');
    expect(m.artist_ko).toBe('요아소비');
    expect(m.karaoke_numbers).toEqual({ tj: '68923', ky: null, joysound: '190-001' });
  });

  it('SOURCE_RANK ranks blog lowest — a vendor id wins the tiebreak over blog', () => {
    // Construct a cluster of 4 records sharing Tier B key (same normalized
    // title + artist). All vendor numbers are null so no Tier A unions and no
    // vendor conflicts; tiebreak on id must follow source priority
    // (tj > tjpdf > joysound > blog).
    const blog = record({
      id: 'blog-101-0',
      source_url: 'https://blog.test/101',
      title_primary: 'Generic',
      title_ko: null,
      artist_primary: 'A',
      artist_ko: null,
      karaoke_numbers: { tj: null, ky: null, joysound: null },
    });
    const tj = record({
      id: 'tj-100',
      source_url: 'https://tj.test/100',
      title_primary: 'Generic',
      title_ko: null,
      artist_primary: 'A',
      artist_ko: null,
      karaoke_numbers: { tj: null, ky: null, joysound: null },
    });
    const tjpdf = record({
      id: 'tjpdf-100',
      source_url: 'https://tjpdf.test/100',
      title_primary: 'Generic',
      title_ko: null,
      artist_primary: 'A',
      artist_ko: null,
      karaoke_numbers: { tj: null, ky: null, joysound: null },
    });
    const js = record({
      id: 'joysound-100',
      source_url: 'https://www.joysound.com/web/search/song/100',
      title_primary: 'Generic',
      title_ko: null,
      artist_primary: 'A',
      artist_ko: null,
      karaoke_numbers: { tj: null, ky: null, joysound: '100-000' },
    });

    const { records } = mergeRecords([js, tjpdf, tj, blog]);
    expect(records).toHaveLength(1);
    // tj is highest priority; blog is now lowest, so it never wins the id.
    expect(records[0]?.id).toBe('tj-100');
  });

  it('joysound vs an unknown-source record: joysound wins id (deterministic — joysound is in SOURCE_RANK)', () => {
    // Tier B merge of joysound + unknown source. joysound has a SOURCE_RANK
    // entry; "mystery" does not (Infinity). The deterministic tiebreak
    // should pick joysound's id.
    const js = record({
      id: 'joysound-200',
      source_url: 'https://www.joysound.com/web/search/song/200',
      title_primary: 'GenericTiebreak',
      title_ko: null,
      artist_primary: 'B',
      artist_ko: null,
      karaoke_numbers: { tj: null, ky: null, joysound: '200-000' },
    });
    const unknown = record({
      id: 'mystery-1',
      source_url: 'https://mystery.test/1',
      title_primary: 'GenericTiebreak',
      title_ko: null,
      artist_primary: 'B',
      artist_ko: null,
      karaoke_numbers: { tj: null, ky: null, joysound: null },
    });
    const { records } = mergeRecords([unknown, js]);
    expect(records).toHaveLength(1);
    expect(records[0]?.id).toBe('joysound-200');
  });

  it('Tier A unions a JOYSOUND-official record with a blog record sharing the SAME dashless joysound# (P0-1 collapse)', () => {
    // The actual P0-1 goal: the official normalizer now emits a dashless
    // joysound number (e.g. '190001'), matching the ~20.9k dashless blog
    // numbers. Two records carrying the same dashless joysound# must collapse
    // via the Tier A joysound vendor index into exactly ONE record — even with
    // DIFFERENT title/artist text, so the union is provably driven by the
    // shared number, not by a Tier B title+artist match.
    const blog = record({
      id: 'blog-7777-joysound-190001',
      source_url: 'https://blog.test/7777',
      title_primary: '夜に駆ける',
      title_ko: '밤에 달리다',
      artist_primary: 'YOASOBI',
      artist_ko: '요아소비',
      // Dashless — the form every blog joysound number is stored in.
      karaoke_numbers: { tj: null, ky: null, joysound: '190001' },
    });
    const js = record({
      id: 'joysound-190001',
      source_url: 'https://www.joysound.com/web/search/song/190001',
      // Deliberately divergent surface text — only the shared number can union.
      title_primary: 'Yoru ni Kakeru',
      title_ko: null,
      artist_primary: 'YOASOBI (Official)',
      artist_ko: null,
      // Dashless, post-normalizer form (was '190-001' on the JOYSOUND surface).
      karaoke_numbers: { tj: null, ky: null, joysound: '190001' },
    });

    const { records } = mergeRecords([blog, js]);
    // Exactly ONE record — they collapsed instead of duplicating.
    expect(records).toHaveLength(1);
    const m = records[0];
    if (!m) throw new Error('no record');
    // The shared dashless joysound# survives on the merged record.
    expect(m.karaoke_numbers.joysound).toBe('190001');
  });
});

describe('mergeRecords — dash/prolonged-sound-mark fold in clustering keys', () => {
  // TJ writes the katakana long vowel `ー` (U+30FC) as an ASCII hyphen in
  // some catalog titles. `normalize()` strips every punctuation dash but
  // U+30FC is category Lm (letter) and survives — so without the fold the
  // same song splits into two records when no karaoke number is shared.
  // The merger's `clusterKeyPart` strips the whole dash class on top of
  // `normalize()` for Tier B/C keys only.

  it('Tier B (cross-source): ASCII-hyphen vs U+30FC titles merge (特者生存 pair)', () => {
    const tj = record({
      id: 'tj-54060',
      source_url: 'https://tj.test/54060',
      title_primary: '特者生存ワンダラダ-!!', // U+002D
      artist_primary: '天音かなた',
      karaoke_numbers: { tj: '54060', ky: null, joysound: null },
    });
    const js = record({
      id: 'joysound-895499',
      source_url: 'https://www.joysound.com/web/search/song/895499',
      title_primary: '特者生存ワンダラダー!!', // U+30FC
      artist_primary: '天音かなた',
      karaoke_numbers: { tj: null, ky: null, joysound: '499965' },
    });

    const { records, conflicts } = mergeRecords([tj, js]);
    expect(records).toHaveLength(1);
    const m = records[0];
    if (!m) throw new Error('no record');
    // TJ is the higher-priority source for id/title; the joysound number
    // unions onto the merged record.
    expect(m.id).toBe('tj-54060');
    expect(m.karaoke_numbers.tj).toBe('54060');
    expect(m.karaoke_numbers.joysound).toBe('499965');
    // Vendor numbers don't disagree (each vendor has one contributor) and a
    // Tier B union emits no tier_c_merge marker — conflicts must stay empty.
    expect(conflicts).toHaveLength(0);
  });

  it('Tier B (cross-source): artist-side fold — fullwidth hyphen U+FF0D vs U+30FC (春一番 pair)', () => {
    // NFKC folds U+FF0D to U+002D, which normalize() strips — leaving
    // `キャンディズ` vs `キャンディーズ`. The fold strips the surviving
    // U+30FC so both artist keys collapse to the same value.
    const tj = record({
      id: 'tj-6487',
      source_url: 'https://tj.test/6487',
      title_primary: '春一番',
      artist_primary: 'キャンディ－ズ', // U+FF0D fullwidth hyphen
      karaoke_numbers: { tj: '6487', ky: null, joysound: null },
    });
    const js = record({
      id: 'joysound-2096',
      source_url: 'https://www.joysound.com/web/search/song/2096',
      title_primary: '春一番',
      artist_primary: 'キャンディーズ', // U+30FC
      karaoke_numbers: { tj: null, ky: null, joysound: '2096' },
    });

    const { records, conflicts } = mergeRecords([tj, js]);
    expect(records).toHaveLength(1);
    expect(records[0]?.karaoke_numbers.joysound).toBe('2096');
    // No vendor disagreement, Tier B union — no spurious conflicts.
    expect(conflicts).toHaveLength(0);
  });

  it('Tier B (cross-source): trailing U+30FC vs absence (サチコ pair)', () => {
    // The fold strips U+30FC from BOTH sides, so `ニューサー` vs `ニューサ`
    // key identically — a presence/absence difference, not a substitution.
    const tj = record({
      id: 'tj-6299',
      source_url: 'https://tj.test/6299',
      title_primary: 'サチコ',
      artist_primary: 'ニック・ニューサー', // trailing U+30FC
      karaoke_numbers: { tj: '6299', ky: null, joysound: null },
    });
    const js = record({
      id: 'joysound-2564',
      source_url: 'https://www.joysound.com/web/search/song/2564',
      title_primary: 'サチコ',
      artist_primary: 'ニック・ニューサ', // no trailing mark
      karaoke_numbers: { tj: null, ky: null, joysound: '2564' },
    });

    const { records, conflicts } = mergeRecords([tj, js]);
    expect(records).toHaveLength(1);
    expect(records[0]?.karaoke_numbers.joysound).toBe('2564');
    // No vendor disagreement, Tier B union — no spurious conflicts.
    expect(conflicts).toHaveLength(0);
  });

  it('Tier C fold-union: dash-variant titles + divergent full artist strings merge via the folded lead-component key', () => {
    // The FULL artist strings differ (`天音かなた(Feat.桐生ココ)` vs bare
    // `天音かなた`), so even the FOLDED Tier B keys diverge and Tier B cannot
    // group them. No shared vendor number (Tier A can't fire) — both records
    // are residual singletons entering Tier C. The union can therefore ONLY
    // happen via tierCKey's `foldDashes(getLeadComponent(...))` path:
    // `getLeadComponent` strips the feat decoration to the shared lead, and
    // the fold collapses the title's `ダ-` (U+002D) / `ダー` (U+30FC)
    // variants. Cross-source (tj + joysound) so the Tier C gate admits.
    const tj = record({
      id: 'tj-54060',
      source_url: 'https://tj.test/54060',
      title_primary: '特者生存ワンダラダ-!!', // U+002D
      artist_primary: '天音かなた(Feat.桐生ココ)',
      karaoke_numbers: { tj: '54060', ky: null, joysound: null },
    });
    const js = record({
      id: 'joysound-895499',
      source_url: 'https://www.joysound.com/web/search/song/895499',
      title_primary: '特者生存ワンダラダー!!', // U+30FC
      artist_primary: '天音かなた',
      karaoke_numbers: { tj: null, ky: null, joysound: '499965' },
    });

    const { records, conflicts } = mergeRecords([tj, js]);
    expect(records).toHaveLength(1);
    const m = records[0];
    if (!m) throw new Error('no record');
    // Vendor numbers union across the fold-keyed Tier C cluster.
    expect(m.karaoke_numbers).toEqual({ tj: '54060', ky: null, joysound: '499965' });
    // Exactly one tier_c_merge marker for the fired cluster — and NO
    // spurious vendor-number conflicts (each vendor has one contributor).
    expect(conflicts.filter((c) => c.field === 'tier_c_merge')).toHaveLength(1);
    expect(conflicts.filter((c) => c.field !== 'tier_c_merge')).toHaveLength(0);
  });

  it('same-source gate: dash-variant twins from ONE source stay distinct (PUFFY スイスイ pair)', () => {
    // JOYSOUND catalogs BOTH spellings as separate entries — different
    // selSongNos AND different lyricists (大貫亜美 vs 吉村由美). They are
    // distinct songs, not transcription variants. A fold-induced Tier B
    // union therefore requires ≥2 distinct source slugs; this same-source
    // pair must NOT merge (and its second joysound number must survive).
    const a = record({
      id: 'joysound-30614',
      source_url: 'https://www.joysound.com/web/search/song/35118',
      title_primary: 'スイスイ',
      artist_primary: 'PUFFY',
      karaoke_numbers: { tj: null, ky: null, joysound: '35118' },
    });
    const b = record({
      id: 'joysound-30679',
      source_url: 'https://www.joysound.com/web/search/song/35183',
      title_primary: 'スーイスーイ',
      artist_primary: 'PUFFY',
      karaoke_numbers: { tj: null, ky: null, joysound: '35183' },
    });

    const { records } = mergeRecords([a, b]);
    expect(records).toHaveLength(2);
    const numbers = records.map((r) => r.karaoke_numbers.joysound).sort();
    expect(numbers).toEqual(['35118', '35183']);
  });

  it('mixed-group bridge: a TJ dash variant bridges two same-source JOYSOUND twins — all three union', () => {
    // Three records share ONE folded Tier B key (`スイスイ|puffy`) across
    // THREE distinct unfolded keys. The two JOYSOUND records are the
    // genuinely-distinct twins from the same-source-gate test above; the TJ
    // record is a dash variant whose UNFOLDED key (`スイスーイ`) matches
    // NEITHER JOYSOUND partition — so a partition-local fallback could not
    // place it anywhere. Because the group now spans ≥ 2 source slugs, the
    // cross-source gate unions ALL THREE: the TJ record bridges the twins.
    // This is the deliberately-chosen semantics — exactly Tier C's risk
    // profile (cross-source clustering accepts occasional over-merges in
    // exchange for vendor-number union coverage), with the JOYSOUND number
    // disagreement surfacing as a vendor conflict for PR-body review.
    const a = record({
      id: 'joysound-30614',
      source_url: 'https://www.joysound.com/web/search/song/35118',
      title_primary: 'スイスイ',
      artist_primary: 'PUFFY',
      karaoke_numbers: { tj: null, ky: null, joysound: '35118' },
    });
    const b = record({
      id: 'joysound-30679',
      source_url: 'https://www.joysound.com/web/search/song/35183',
      title_primary: 'スーイスーイ',
      artist_primary: 'PUFFY',
      karaoke_numbers: { tj: null, ky: null, joysound: '35183' },
    });
    const tj = record({
      id: 'tj-33333',
      source_url: 'https://tj.test/33333',
      title_primary: 'スイスーイ', // unfolded key matches neither a nor b
      artist_primary: 'PUFFY',
      karaoke_numbers: { tj: '33333', ky: null, joysound: null },
    });

    const { records, conflicts } = mergeRecords([a, b, tj]);
    expect(records).toHaveLength(1);
    const m = records[0];
    if (!m) throw new Error('no record');
    expect(m.karaoke_numbers.tj).toBe('33333');
    // joysound disagreement: equal source rank — first contribution (input
    // order) wins.
    expect(m.karaoke_numbers.joysound).toBe('35118');
    // Exactly one conflict: the joysound vendor disagreement, keyed by the
    // FOLDED Tier B cluster key.
    expect(conflicts).toHaveLength(1);
    const c = conflicts[0];
    if (!c) throw new Error('no conflict');
    expect(c.field).toBe('joysound');
    expect(c.cluster_key).toBe('スイスイ|puffy');
    expect(c.winner).toBe('35118');
    expect(c.values.map((v) => v.value).sort()).toEqual(['35118', '35183']);
  });

  it('same-source gate fallback: identical un-folded keys still merge as pre-fold Tier B', () => {
    // Two same-source records with byte-identical normalized keys (no fold
    // involvement) must keep merging — the gate only restricts unions the
    // fold itself created.
    const a = record({
      id: 'blog-100-0',
      source_url: 'https://blog.test/100/0',
      title_primary: '夜に駆ける',
      artist_primary: 'YOASOBI',
      karaoke_numbers: { tj: null, ky: null, joysound: null },
    });
    const b = record({
      id: 'blog-200-joysound-190001',
      source_url: 'https://blog.test/200/3',
      title_primary: '夜に駆ける',
      artist_primary: 'YOASOBI',
      karaoke_numbers: { tj: null, ky: null, joysound: '190001' },
    });

    const { records } = mergeRecords([a, b]);
    expect(records).toHaveLength(1);
    expect(records[0]?.karaoke_numbers.joysound).toBe('190001');
  });

  it('negative control: genuinely different titles by the same artist stay distinct', () => {
    const a = record({
      id: 'tj-11111',
      source_url: 'https://tj.test/11111',
      title_primary: 'カードキャプター',
      artist_primary: '天音かなた',
      karaoke_numbers: { tj: '11111', ky: null, joysound: null },
    });
    const b = record({
      id: 'joysound-22222',
      source_url: 'https://www.joysound.com/web/search/song/22222',
      title_primary: '全く別の曲',
      artist_primary: '天音かなた',
      karaoke_numbers: { tj: null, ky: null, joysound: '22222' },
    });

    const { records } = mergeRecords([a, b]);
    expect(records).toHaveLength(2);
  });
});

describe('mergeRecords — Tier D context-suffix title merge', () => {
  it('merges TJ anime/game OST context suffix with bare JOYSOUND title (カナデトモスソラ)', () => {
    const tj = record({
      id: 'tj-68745',
      source_url: 'https://tj.test/68745',
      title_primary: "カナデトモスソラ('プロジェクトセカイ カラフルステージ！ feat. 初音ミク' OST)",
      title_ko: "카나데 토모스 소라('프로젝트 세카이 컬러풀 스테이지! feat.하츠네 미쿠' OST)",
      artist_primary: '25時,ナイトコードで。',
      karaoke_numbers: { tj: '68745', ky: null, joysound: null },
    });
    const js = record({
      id: 'joysound-890058',
      source_url: 'https://www.joysound.com/web/search/song/890058',
      title_primary: 'カナデトモスソラ',
      artist_primary: '25時、ナイトコードで。',
      karaoke_numbers: { tj: null, ky: null, joysound: '612018' },
    });

    const { records, conflicts } = mergeRecords([tj, js]);

    expect(records).toHaveLength(1);
    const m = records[0];
    if (!m) throw new Error('no record');
    expect(m.id).toBe('tj-68745');
    expect(m.title_primary).toBe(
      "カナデトモスソラ('プロジェクトセカイ カラフルステージ！ feat. 初音ミク' OST)",
    );
    expect(m.artist_primary).toBe('25時,ナイトコードで。');
    expect(m.karaoke_numbers).toEqual({ tj: '68745', ky: null, joysound: '612018' });

    const tierD = conflicts.filter((c) => c.field === 'tier_d_context_title_merge');
    expect(tierD).toHaveLength(1);
    expect(tierD[0]?.values.map((v) => v.value).sort()).toEqual(['joysound-890058', 'tj-68745']);
    expect(headlineConflicts(conflicts)).toHaveLength(0);
  });

  it('merges TJ OP context suffix with bare JOYSOUND title (恋愛サーキュレーション)', () => {
    const tj = record({
      id: 'tj-27027',
      source_url: 'https://tj.test/27027',
      title_primary: '恋愛サーキュレーション(化物語 OP)',
      artist_primary: '千石撫子(花澤香菜)',
      karaoke_numbers: { tj: '27027', ky: null, joysound: null },
    });
    const js = record({
      id: 'joysound-149774',
      source_url: 'https://www.joysound.com/web/search/song/149774',
      title_primary: '恋愛サーキュレーション',
      artist_primary: '千石撫子(花澤香菜)',
      karaoke_numbers: { tj: null, ky: null, joysound: '128291' },
    });

    const { records, conflicts } = mergeRecords([tj, js]);

    expect(records).toHaveLength(1);
    expect(records[0]?.id).toBe('tj-27027');
    expect(records[0]?.karaoke_numbers).toEqual({ tj: '27027', ky: null, joysound: '128291' });
    expect(conflicts.filter((c) => c.field === 'tier_d_context_title_merge')).toHaveLength(1);
  });

  it('preserves explicit version markers such as TV size even when another record strips an OP suffix', () => {
    const tj = record({
      id: 'tj-25005',
      source_url: 'https://tj.test/25005',
      title_primary: 'The Rumbling(進撃の巨人 OP)',
      artist_primary: 'SiM',
      karaoke_numbers: { tj: '25005', ky: null, joysound: null },
    });
    const tvSize = record({
      id: 'joysound-910272',
      source_url: 'https://www.joysound.com/web/search/song/910272',
      title_primary: 'The Rumbling (TV size)',
      artist_primary: 'SiM',
      karaoke_numbers: { tj: null, ky: null, joysound: '495625' },
    });

    const { records, conflicts } = mergeRecords([tj, tvSize]);

    expect(records).toHaveLength(2);
    expect(conflicts.filter((c) => c.field === 'tier_d_context_title_merge')).toHaveLength(0);
  });

  it('preserves size markers even when they contain a role token such as オープニング', () => {
    const full = record({
      id: 'tjpdf-28785',
      source_url: 'https://tjpdf.test/28785',
      title_primary: 'EXCITE',
      artist_primary: '三浦大知',
      karaoke_numbers: { tj: '28785', ky: null, joysound: '691428' },
    });
    const openingSize = record({
      id: 'joysound-596642',
      source_url: 'https://www.joysound.com/web/search/song/596642',
      title_primary: 'EXCITE (テレビオープニングサイズ)',
      artist_primary: '三浦大知',
      karaoke_numbers: { tj: null, ky: null, joysound: '690705' },
    });

    const { records, conflicts } = mergeRecords([full, openingSize]);

    expect(records).toHaveLength(2);
    expect(conflicts.filter((c) => c.field === 'tier_d_context_title_merge')).toHaveLength(0);
  });

  it('does not strip bare role-only suffixes such as (Ending)', () => {
    const full = record({
      id: 'tj-50100',
      source_url: 'https://tj.test/50100',
      title_primary: 'Hello, I am KOE',
      artist_primary: 'KOE',
      karaoke_numbers: { tj: '50100', ky: null, joysound: null },
    });
    const ending = record({
      id: 'joysound-50101',
      source_url: 'https://www.joysound.com/web/search/song/50101',
      title_primary: 'Hello, I am KOE(Ending)',
      artist_primary: 'KOE',
      karaoke_numbers: { tj: null, ky: null, joysound: '50101' },
    });

    const { records, conflicts } = mergeRecords([full, ending]);

    expect(records).toHaveLength(2);
    expect(conflicts.filter((c) => c.field === 'tier_d_context_title_merge')).toHaveLength(0);
  });

  it('does not strip role-only ordinal suffixes such as (OP2) or (第2期OP)', () => {
    const full = record({
      id: 'tj-50200',
      source_url: 'https://tj.test/50200',
      title_primary: 'Ordinal Song',
      artist_primary: 'Ordinal Artist',
      karaoke_numbers: { tj: '50200', ky: null, joysound: null },
    });
    const op2 = record({
      id: 'joysound-50201',
      source_url: 'https://www.joysound.com/web/search/song/50201',
      title_primary: 'Ordinal Song(OP2)',
      artist_primary: 'Ordinal Artist',
      karaoke_numbers: { tj: null, ky: null, joysound: '50201' },
    });
    const secondSeasonOp = record({
      id: 'joysound-50202',
      source_url: 'https://www.joysound.com/web/search/song/50202',
      title_primary: 'Ordinal Song(第2期OP)',
      artist_primary: 'Ordinal Artist',
      karaoke_numbers: { tj: null, ky: null, joysound: '50202' },
    });

    const { records, conflicts } = mergeRecords([full, op2, secondSeasonOp]);

    expect(records).toHaveLength(3);
    expect(conflicts.filter((c) => c.field === 'tier_d_context_title_merge')).toHaveLength(0);
  });

  it('does not merge same-source context-suffix twins through Tier D', () => {
    const a = record({
      id: 'joysound-50301',
      source_url: 'https://www.joysound.com/web/search/song/50301',
      title_primary: 'Same Source Song(Example Anime OP)',
      artist_primary: 'Same Source Artist',
      karaoke_numbers: { tj: null, ky: null, joysound: '50301' },
    });
    const b = record({
      id: 'joysound-50302',
      source_url: 'https://www.joysound.com/web/search/song/50302',
      title_primary: 'Same Source Song',
      artist_primary: 'Same Source Artist',
      karaoke_numbers: { tj: null, ky: null, joysound: '50302' },
    });

    const { records, conflicts } = mergeRecords([a, b]);

    expect(records).toHaveLength(2);
    expect(conflicts.filter((c) => c.field === 'tier_d_context_title_merge')).toHaveLength(0);
  });

  it('uses full artist for Tier D, not the Tier C lead-artist token', () => {
    const tj = record({
      id: 'tj-50400',
      source_url: 'https://tj.test/50400',
      title_primary: 'Full Artist Song(Example Anime OP)',
      artist_primary: 'Main Artist(Feat.Guest)',
      karaoke_numbers: { tj: '50400', ky: null, joysound: null },
    });
    const js = record({
      id: 'joysound-50401',
      source_url: 'https://www.joysound.com/web/search/song/50401',
      title_primary: 'Full Artist Song',
      artist_primary: 'Main Artist',
      karaoke_numbers: { tj: null, ky: null, joysound: '50401' },
    });

    const { records, conflicts } = mergeRecords([tj, js]);

    expect(records).toHaveLength(2);
    expect(conflicts.filter((c) => c.field === 'tier_d_context_title_merge')).toHaveLength(0);
  });

  it('blocks Tier D auto-merge and emits a review conflict when same-provider numbers disagree', () => {
    // Non-reviewed synthetic tj numbers: the original real fixture used tj-27098,
    // which the 2026-07-16 audit-B batch promoted to a reviewed Tier F pair
    // (tj-27098 ↔ joysound-91999). With the reviewed-tier cluster-attach
    // relaxation that pair now also (correctly) conflicts with this blog row's
    // tj-27011, adding a second headline conflict. To keep this a focused Tier D
    // regression (automatic tier unchanged), the numbers are synthetic and
    // untouched by any reviewed pair; the reviewed conflict-guard block has its
    // own dedicated test below.
    const blog = record({
      id: 'blog-523-tj-990011',
      source_url: 'https://blog.test/523',
      title_primary: 'ALWAYS',
      artist_primary: '中島美嘉',
      karaoke_numbers: { tj: '990011', ky: '990189', joysound: '990999' },
    });
    const tj = record({
      id: 'tj-990098',
      source_url: 'https://tj.test/990098',
      title_primary: 'Always(サヨナライツカ OST)',
      artist_primary: '中島美嘉',
      karaoke_numbers: { tj: '990098', ky: null, joysound: null },
    });

    const { records, conflicts } = mergeRecords([blog, tj]);

    expect(records).toHaveLength(2);
    expect(conflicts.filter((c) => c.field === 'tier_d_context_title_merge')).toHaveLength(0);
    const tjConflict = conflicts.find((c) => c.field === 'tj');
    expect(tjConflict).toBeDefined();
    expect(tjConflict?.cluster_key).toBe('always|中島美嘉');
    expect(tjConflict?.values.map((v) => v.value).sort()).toEqual(['990011', '990098']);
    expect(headlineConflicts(conflicts)).toHaveLength(1);
  });
});

describe('mergeRecords — Tier E reviewed strong artist-credit merge', () => {
  it('merges only reviewed-strong TJ↔JOYSOUND artist-credit expansions', () => {
    const tj = record({
      id: 'tj-25031',
      source_url: 'https://tj.test/25031',
      title_primary: '六幻(東京リベンジャーズ OST)',
      artist_primary: '林勇',
      karaoke_numbers: { tj: '25031', ky: null, joysound: null },
    });
    const js = record({
      id: 'joysound-879376',
      source_url: 'https://www.joysound.com/web/search/song/879376',
      title_primary: '六幻',
      artist_primary: '佐野万次郎(CV:林勇)',
      karaoke_numbers: { tj: null, ky: null, joysound: '492355' },
    });

    const { records, conflicts } = mergeRecords([tj, js]);

    expect(records).toHaveLength(1);
    expect(records[0]?.id).toBe('tj-25031');
    expect(records[0]?.karaoke_numbers).toEqual({ tj: '25031', ky: null, joysound: '492355' });
    expect(conflicts.filter((c) => c.field === 'tier_e_artist_credit_merge')).toHaveLength(1);
    expect(headlineConflicts(conflicts)).toHaveLength(0);
  });

  it('merges reviewed-strong featuring/credit expansions from the 65-pair allowlist', () => {
    const tj = record({
      id: 'tj-25542',
      source_url: 'https://tj.test/25542',
      title_primary: 'storm(真ゲッターロボ対ネオゲッターロボ OP)',
      artist_primary: 'JAM Project',
      karaoke_numbers: { tj: '25542', ky: null, joysound: null },
    });
    const js = record({
      id: 'joysound-32005',
      source_url: 'https://www.joysound.com/web/search/song/32005',
      title_primary: 'STORM',
      artist_primary: 'JAM Project featuring 水木一郎&影山ヒロノブ',
      karaoke_numbers: { tj: null, ky: null, joysound: '36509' },
    });

    const { records, conflicts } = mergeRecords([tj, js]);

    expect(records).toHaveLength(1);
    expect(records[0]?.karaoke_numbers).toEqual({ tj: '25542', ky: null, joysound: '36509' });
    expect(conflicts.filter((c) => c.field === 'tier_e_artist_credit_merge')).toHaveLength(1);
  });

  it('does not merge reviewed-but-not-strong pairs that need raw tieup/credit corroboration', () => {
    const tj = record({
      id: 'tj-68183',
      source_url: 'https://tj.test/68183',
      title_primary: 'Radio Happy(アイドルマスターシンデレラガールズスターライトステージ OST)',
      artist_primary: '山下七海',
      karaoke_numbers: { tj: '68183', ky: null, joysound: null },
    });
    const js = record({
      id: 'joysound-562326',
      source_url: 'https://www.joysound.com/web/search/song/562326',
      title_primary: 'Radio Happy',
      artist_primary: '大槻唯(CV:山下七海)',
      karaoke_numbers: { tj: null, ky: null, joysound: '683200' },
    });

    const { records, conflicts } = mergeRecords([tj, js]);

    expect(records).toHaveLength(2);
    expect(conflicts.filter((c) => c.field === 'tier_e_artist_credit_merge')).toHaveLength(0);
  });

  it('does not merge short-token false positives such as FLOW X GRANRODEO vs XG', () => {
    const tj = record({
      id: 'tj-28852',
      source_url: 'https://tj.test/28852',
      title_primary: 'Howling(七つの大罪-戒めの復活 OP)',
      artist_primary: 'FLOW X GRANRODEO',
      karaoke_numbers: { tj: '28852', ky: null, joysound: null },
    });
    const js = record({
      id: 'joysound-1073238',
      source_url: 'https://www.joysound.com/web/search/song/1073238',
      title_primary: 'HOWLING',
      artist_primary: 'XG',
      karaoke_numbers: { tj: null, ky: null, joysound: '631988' },
    });

    const { records, conflicts } = mergeRecords([tj, js]);

    expect(records).toHaveLength(2);
    expect(conflicts.filter((c) => c.field === 'tier_e_artist_credit_merge')).toHaveLength(0);
  });

  it('does not choose among multi-JOYSOUND variants for one TJ number', () => {
    const tj = record({
      id: 'tj-26121',
      source_url: 'https://tj.test/26121',
      title_primary: 'ハッピー☆マテリアル(魔法先生 ネギま! OP)',
      artist_primary: '麻帆良学園中等部2-A',
      karaoke_numbers: { tj: '26121', ky: null, joysound: null },
    });
    const april = record({
      id: 'joysound-51658',
      source_url: 'https://www.joysound.com/web/search/song/51658',
      title_primary: 'ハッピー☆マテリアル(4月度オープニングテーマ)',
      artist_primary: '麻帆良学園中等部2-A(椎名桜子/龍宮真名/超鈴音/長瀬楓/那波千鶴)',
      karaoke_numbers: { tj: null, ky: null, joysound: '77873' },
    });
    const june = record({
      id: 'joysound-51659',
      source_url: 'https://www.joysound.com/web/search/song/51659',
      title_primary: 'ハッピー☆マテリアル(6月度オープニングテーマ)',
      artist_primary: '麻帆良学園中等部2-A(宮崎のどか/村上夏美/雪広あやか/四葉五月/Zazie Rainyday)',
      karaoke_numbers: { tj: null, ky: null, joysound: '78108' },
    });

    const { records, conflicts } = mergeRecords([tj, april, june]);

    expect(records).toHaveLength(3);
    expect(conflicts.filter((c) => c.field === 'tier_e_artist_credit_merge')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// Tier F — post-crawl reviewed residual split-pair allowlist
// ---------------------------------------------------------------------
describe('mergeRecords — Tier F post-crawl reviewed split-pair merge', () => {
  it('merges a same-source TJ-only/JOYSOUND-only split from the reviewed post-crawl allowlist', () => {
    const tjOnly = record({
      id: 'blog-112-tj-52784',
      source_url: 'https://j-pop-playlist.tistory.com/112',
      title_primary: "うつくしい世界('出光興産' CM)",
      title_ko: '아름다운 세계',
      artist_primary: 'Aimer',
      artist_ko: '에메',
      karaoke_numbers: { tj: '52784', ky: null, joysound: null },
    });
    const joyOnly = record({
      id: 'blog-112-joysound-634289',
      source_url: 'https://j-pop-playlist.tistory.com/112',
      title_primary: 'うつくしい世界',
      title_ko: '아름다운 세계',
      artist_primary: 'Aimer',
      artist_ko: '에메',
      karaoke_numbers: { tj: null, ky: null, joysound: '634289' },
    });

    const { records, conflicts } = mergeRecords([tjOnly, joyOnly]);

    expect(records).toHaveLength(1);
    expect(records[0]?.karaoke_numbers).toEqual({ tj: '52784', ky: null, joysound: '634289' });
    expect(conflicts.filter((c) => c.field === 'tier_f_postcrawl_split_merge')).toHaveLength(1);
    expect(headlineConflicts(conflicts)).toHaveLength(0);
  });

  it('supports the reviewed KY↔JOYSOUND split pair without treating KY and TJ as interchangeable', () => {
    const kyOnly = record({
      id: 'blog-628-ky-44158',
      source_url: 'https://j-pop-playlist.tistory.com/628',
      title_primary: 'No title',
      artist_primary: 'Reol',
      artist_ko: '레오루',
      karaoke_numbers: { tj: null, ky: '44158', joysound: null },
    });
    const joyOnly = record({
      id: 'tj-28704',
      source_url: 'https://tj.test/28704',
      title_primary: 'No title',
      artist_primary: 'れをる',
      artist_ko: '레오루',
      karaoke_numbers: { tj: '28704', ky: null, joysound: '689337' },
    });

    const { records, conflicts } = mergeRecords([kyOnly, joyOnly]);

    expect(records).toHaveLength(1);
    expect(records[0]?.karaoke_numbers).toEqual({ tj: '28704', ky: '44158', joysound: '689337' });
    expect(conflicts.filter((c) => c.field === 'tier_f_postcrawl_split_merge')).toHaveLength(1);
  });

  it('does not treat a TJ number as the reviewed KY number for a Tier F pair', () => {
    const tjOnly = record({
      id: 'blog-628-tj-44158',
      source_url: 'https://j-pop-playlist.tistory.com/628',
      title_primary: 'No title',
      artist_primary: 'Reol',
      artist_ko: '레오루',
      karaoke_numbers: { tj: '44158', ky: null, joysound: null },
    });
    const joyOnly = record({
      id: 'tj-28704',
      source_url: 'https://tj.test/28704',
      title_primary: 'No title',
      artist_primary: 'れをる',
      artist_ko: '레오루',
      karaoke_numbers: { tj: null, ky: null, joysound: '689337' },
    });

    const { records, conflicts } = mergeRecords([tjOnly, joyOnly]);

    expect(records).toHaveLength(2);
    expect(conflicts.filter((c) => c.field === 'tier_f_postcrawl_split_merge')).toHaveLength(0);
  });

  it('keeps existing Tier-E reviewed-but-not-strong pairs out of the post-crawl allowlist', () => {
    const tj = record({
      id: 'tj-68183',
      source_url: 'https://tj.test/68183',
      title_primary: 'Radio Happy(アイドルマスターシンデレラガールズスターライトステージ OST)',
      artist_primary: '山下七海',
      karaoke_numbers: { tj: '68183', ky: null, joysound: null },
    });
    const js = record({
      id: 'joysound-562326',
      source_url: 'https://www.joysound.com/web/search/song/562326',
      title_primary: 'Radio Happy',
      artist_primary: '大槻唯(CV:山下七海)',
      karaoke_numbers: { tj: null, ky: null, joysound: '683200' },
    });

    const { records, conflicts } = mergeRecords([tj, js]);

    expect(records).toHaveLength(2);
    expect(conflicts.filter((c) => c.field === 'tier_e_artist_credit_merge')).toHaveLength(0);
    expect(conflicts.filter((c) => c.field === 'tier_f_postcrawl_split_merge')).toHaveLength(0);
  });

  it('does not merge artist_ko leakage from a featured artist as a strong pair', () => {
    const tjOnly = record({
      id: 'blog-338-tj-28895',
      source_url: 'https://j-pop-playlist.tistory.com/338',
      title_primary: "アイノカタチ(ドラマ'義母と娘のブルース' OST)",
      artist_primary: 'MISIA(Feat.HIDE(GReeeeN))',
      artist_ko: '그린',
      karaoke_numbers: { tj: '28895', ky: null, joysound: null },
    });
    const joyOnly = record({
      id: 'joysound-775260',
      source_url: 'https://www.joysound.com/web/search/song/775260',
      title_primary: 'アイノカタチ',
      artist_primary: 'GReeeeN',
      artist_ko: '그린',
      karaoke_numbers: { tj: null, ky: null, joysound: '441874' },
    });

    const { records, conflicts } = mergeRecords([tjOnly, joyOnly]);

    expect(records).toHaveLength(2);
    expect(conflicts.filter((c) => c.field === 'tier_f_postcrawl_split_merge')).toHaveLength(0);
  });

  it('does not merge short numeric artist aliases such as 19 without manual review', () => {
    const tjOnly = record({
      id: 'tj-25022',
      source_url: 'https://tj.test/25022',
      title_primary: 'たいせつなひと',
      artist_primary: '19',
      artist_ko: '쥬우쿠',
      karaoke_numbers: { tj: '25022', ky: null, joysound: null },
    });
    const joyOnly = record({
      id: 'joysound-11794',
      source_url: 'https://www.joysound.com/web/search/song/11794',
      title_primary: 'たいせつなひと',
      artist_primary: '19(ジューク)',
      karaoke_numbers: { tj: null, ky: null, joysound: '11802' },
    });

    const { records, conflicts } = mergeRecords([tjOnly, joyOnly]);

    expect(records).toHaveLength(2);
    expect(conflicts.filter((c) => c.field === 'tier_f_postcrawl_split_merge')).toHaveLength(0);
  });

  it('does not apply a reviewed pair when the JOYSOUND side now has a same-provider conflict', () => {
    const tjOnly = record({
      id: 'blog-112-tj-52784',
      source_url: 'https://j-pop-playlist.tistory.com/112',
      title_primary: "うつくしい世界('出光興産' CM)",
      artist_primary: 'Aimer',
      karaoke_numbers: { tj: '52784', ky: null, joysound: null },
    });
    const conflictingJoy = record({
      id: 'blog-112-tj-99999',
      source_url: 'https://j-pop-playlist.tistory.com/112',
      title_primary: 'うつくしい世界',
      artist_primary: 'Aimer',
      karaoke_numbers: { tj: '99999', ky: null, joysound: '634289' },
    });

    const { records, conflicts } = mergeRecords([tjOnly, conflictingJoy]);

    expect(records).toHaveLength(2);
    expect(conflicts.filter((c) => c.field === 'tier_f_postcrawl_split_merge')).toHaveLength(0);
  });

  it('attaches to a JOYSOUND-side row carrying a non-conflicting extra provider (cluster-attach relaxation)', () => {
    // Pre-2026-07-17 this asserted the reviewed pair did NOT merge because the
    // JOYSOUND-side row carried an unreviewed third provider (ky-99999). The
    // reviewed-tier cluster-attach relaxation removed that joy-side shape gate:
    // a reviewed pair is a human-confirmed identity, so it now attaches
    // regardless of the JOYSOUND row's shape, gated ONLY by the vendor-number
    // conflict guard. Here no vendor cell collides (tj 52784 / ky 99999 /
    // joysound 634289 are each single-valued), so the rows merge and the extra
    // ky travels with its own physical row.
    const tjOnly = record({
      id: 'blog-112-tj-52784',
      source_url: 'https://j-pop-playlist.tistory.com/112',
      title_primary: "うつくしい世界('出光興産' CM)",
      artist_primary: 'Aimer',
      karaoke_numbers: { tj: '52784', ky: null, joysound: null },
    });
    const joyWithKy = record({
      id: 'blog-112-ky-99999',
      source_url: 'https://j-pop-playlist.tistory.com/112',
      title_primary: 'うつくしい世界',
      artist_primary: 'Aimer',
      karaoke_numbers: { tj: null, ky: '99999', joysound: '634289' },
    });

    const { records, conflicts } = mergeRecords([tjOnly, joyWithKy]);

    expect(records).toHaveLength(1);
    expect(records[0]?.karaoke_numbers).toEqual({ tj: '52784', ky: '99999', joysound: '634289' });
    // The merge now fires, so the informational Tier F marker is emitted (one
    // per successful split-pair merge).
    expect(conflicts.filter((c) => c.field === 'tier_f_postcrawl_split_merge')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------
// Reviewed-tier cluster-attach relaxation (2026-07-17). A reviewed pair
// attaches its target's cluster to the joysound's cluster regardless of either
// side's cluster state, gated ONLY by the vendor-number conflict guard. Uses
// the real reviewed Tier F pair (ky-40138 ↔ joysound-2238, 明日の詩/杉良太郎)
// and Tier E pair (tj-6284 ↔ joysound-1755, 別離/小林幸子). Relies on
// normalize NOT folding 郞≠郎, which is exactly why the KY row needed review.
// ---------------------------------------------------------------------
describe('mergeRecords — reviewed-tier cluster-attach relaxation', () => {
  const kyTarget = () =>
    record({
      id: 'ky-40138',
      source_url: 'https://ky.test/40138',
      title_primary: '明日の詩',
      artist_primary: '杉良太郞',
      karaoke_numbers: { tj: null, ky: '40138', joysound: null },
    });
  const joy2238 = (over = {}) =>
    record({
      id: 'joysound-2238',
      source_url: 'https://www.joysound.com/web/search/song/2238',
      title_primary: '明日の詩',
      artist_primary: '杉良太郎',
      karaoke_numbers: { tj: null, ky: null, joysound: '2238', ...over },
    });

  it('Case A: fires when both sides are singletons', () => {
    const { records } = mergeRecords([kyTarget(), joy2238()]);
    expect(records).toHaveLength(1);
    expect(records[0]?.karaoke_numbers).toEqual({ tj: null, ky: '40138', joysound: '2238' });
  });

  it('Case B: attaches to a joysound already merged into a cluster by an earlier tier', () => {
    // A tj twin (同artist 杉良太郎) Tier-B-merges with the joysound first, so the
    // joysound is a NON-singleton by the time Tier F runs.
    const tjTwin = record({
      id: 'tj-990500',
      source_url: 'https://tj.test/990500',
      title_primary: '明日の詩',
      artist_primary: '杉良太郎',
      karaoke_numbers: { tj: '990500', ky: null, joysound: null },
    });
    const { records } = mergeRecords([kyTarget(), joy2238(), tjTwin]);
    expect(records).toHaveLength(1);
    expect(records[0]?.karaoke_numbers).toEqual({ tj: '990500', ky: '40138', joysound: '2238' });
  });

  it('Case C: attaches when the joysound row natively carries another vendor number', () => {
    const { records } = mergeRecords([kyTarget(), joy2238({ tj: '990501' })]);
    expect(records).toHaveLength(1);
    expect(records[0]?.karaoke_numbers).toEqual({ tj: '990501', ky: '40138', joysound: '2238' });
  });

  it('target-nonsingleton: attaches when the target itself is already in a cluster', () => {
    // A tj row with the SAME 杉良太郞 rendering Tier-B-merges with the KY target,
    // so the target is a non-singleton; the reviewed pair still attaches it.
    const tjSameAsTarget = record({
      id: 'tj-990602',
      source_url: 'https://tj.test/990602',
      title_primary: '明日の詩',
      artist_primary: '杉良太郞',
      karaoke_numbers: { tj: '990602', ky: null, joysound: null },
    });
    const { records } = mergeRecords([kyTarget(), tjSameAsTarget, joy2238()]);
    expect(records).toHaveLength(1);
    expect(records[0]?.karaoke_numbers).toEqual({ tj: '990602', ky: '40138', joysound: '2238' });
  });

  it('conflict guard: skips + logs when attaching would collide on a vendor cell', () => {
    // The joysound row natively carries a DIFFERENT ky (990700) than the reviewed
    // target (40138): merging would put two values in the ky cell → blocked.
    const { records, conflicts } = mergeRecords([kyTarget(), joy2238({ ky: '990700' })]);
    expect(records).toHaveLength(2);
    const kyConflict = conflicts.find(
      (c) => c.field === 'ky' && c.cluster_key === 'ky:40138|joysound:2238',
    );
    expect(kyConflict).toBeDefined();
    expect(kyConflict?.values.map((v) => v.value).sort()).toEqual(['40138', '990700']);
  });

  it('Tier E: attaches a reviewed tj↔joysound pair to a pre-merged joysound cluster', () => {
    // tj-6284 ↔ joysound-1755 (別離/小林幸子) is a reviewed Tier E pair. Put the
    // joysound in a cluster first via a same-title/artist blog twin.
    const tjTarget = record({
      id: 'tj-6284',
      source_url: 'https://tj.test/6284',
      title_primary: '別 離',
      artist_primary: '小林幸子',
      karaoke_numbers: { tj: '6284', ky: null, joysound: null },
    });
    const joyTwin = record({
      id: 'blog-9-ky-990900',
      source_url: 'https://blog.test/9',
      title_primary: '別離(わかれ)',
      artist_primary: '小林幸子',
      karaoke_numbers: { tj: null, ky: '990900', joysound: '1755' },
    });
    const { records } = mergeRecords([tjTarget, joyTwin]);
    expect(records).toHaveLength(1);
    expect(records[0]?.karaoke_numbers).toEqual({ tj: '6284', ky: '990900', joysound: '1755' });
  });

  it('both-vendor non-tj id: a Tier E pair fires via the tj cell of a ky-slug row (ky-42670 メルト)', () => {
    // The reviewed MERGE target carries BOTH tj (26749) and ky (42670) under a
    // KY id-slug — a "both-vendor, non-tj id" row #163 could not encode. The
    // Tier E pair [26749, 91145] (encoded 2026-07-20) fires by matching the tj
    // vendor-number cell irrespective of id-slug. Distinct artists (初音ミク vs
    // supercell) keep the automatic tiers off, isolating the reviewed tier.
    const bothVendor = record({
      id: 'ky-42670',
      source_url: 'https://ky.test/42670',
      title_primary: 'メルト',
      artist_primary: '初音ミク',
      karaoke_numbers: { tj: '26749', ky: '42670', joysound: null },
    });
    const joyOnly = record({
      id: 'joysound-91145',
      source_url: 'https://www.joysound.com/web/search/song/91145',
      title_primary: 'メルト',
      artist_primary: 'supercell',
      karaoke_numbers: { tj: null, ky: null, joysound: '91145' },
    });
    const { records } = mergeRecords([bothVendor, joyOnly]);
    expect(records).toHaveLength(1);
    expect(records[0]?.karaoke_numbers).toEqual({ tj: '26749', ky: '42670', joysound: '91145' });
  });

  it('automatic-tier regression: an unreviewed KY row is NOT attached to a cluster', () => {
    // Same shape as Case B but with a NON-reviewed KY number: the relaxation is
    // scoped to reviewed pairs, so the automatic tiers must leave the KY row
    // split (no general singleton→cluster attach).
    const unreviewedKy = record({
      id: 'ky-990800',
      source_url: 'https://ky.test/990800',
      title_primary: '明日の詩',
      artist_primary: '杉良太郞',
      karaoke_numbers: { tj: null, ky: '990800', joysound: null },
    });
    const joyOther = record({
      id: 'joysound-990801',
      source_url: 'https://www.joysound.com/web/search/song/990801',
      title_primary: '明日の詩',
      artist_primary: '杉良太郎',
      karaoke_numbers: { tj: null, ky: null, joysound: '990801' },
    });
    const tjTwin = record({
      id: 'tj-990802',
      source_url: 'https://tj.test/990802',
      title_primary: '明日の詩',
      artist_primary: '杉良太郎',
      karaoke_numbers: { tj: '990802', ky: null, joysound: null },
    });
    const { records } = mergeRecords([unreviewedKy, joyOther, tjTwin]);
    // tjTwin + joyOther merge (Tier B, same 杉良太郎); the unreviewed 杉良太郞 KY
    // row stays separate.
    expect(records).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------
// R1 audit batch (2026-07-02 owner-reviewed missing-JOYSOUND residuals)
// ---------------------------------------------------------------------
describe('mergeRecords — R1 reviewed missing-JOYSOUND batch', () => {
  it('lands the JOYSOUND number for a new Tier E pair (tj-6284 ↔ 別離/小林幸子)', () => {
    const tjOnly = record({
      id: 'tj-6284',
      source_url: 'https://tj.test/6284',
      title_primary: '別 離',
      artist_primary: '小林幸子',
      karaoke_numbers: { tj: '6284', ky: null, joysound: null },
    });
    const joyOnly = record({
      id: 'joysound-1755',
      source_url: 'https://www.joysound.com/web/search/song/1755',
      title_primary: '別離(わかれ)',
      artist_primary: '小林幸子',
      karaoke_numbers: { tj: null, ky: null, joysound: '1755' },
    });

    const { records, conflicts } = mergeRecords([tjOnly, joyOnly]);

    expect(records).toHaveLength(1);
    expect(records[0]?.karaoke_numbers).toEqual({ tj: '6284', ky: null, joysound: '1755' });
    expect(conflicts.filter((c) => c.field === 'tier_e_artist_credit_merge')).toHaveLength(1);
  });

  it('lands the JOYSOUND number for a new Tier F pair (tjpdf-28113 ↔ Ready!!)', () => {
    const tjOnly = record({
      id: 'tjpdf-28113',
      source_url: 'https://tj.test/pdf/28113',
      title_primary: 'Ready!!',
      artist_primary: '765PRO ALLSTARS',
      karaoke_numbers: { tj: '28113', ky: null, joysound: null },
    });
    const joyOnly = record({
      id: 'joysound-171278',
      source_url: 'https://www.joysound.com/web/search/song/171278',
      title_primary: 'READY!!(M@STER VERSION)',
      artist_primary: '765PRO ALLSTARS',
      karaoke_numbers: { tj: null, ky: null, joysound: '110661' },
    });

    const { records, conflicts } = mergeRecords([tjOnly, joyOnly]);

    expect(records).toHaveLength(1);
    expect(records[0]?.karaoke_numbers).toEqual({ tj: '28113', ky: null, joysound: '110661' });
    expect(conflicts.filter((c) => c.field === 'tier_f_postcrawl_split_merge')).toHaveLength(1);
  });

  it('lands JOYSOUND + KY for the tj-68342 Tier F pair via its explicit extra-provider allowance', () => {
    const tjOnly = record({
      id: 'tj-68342',
      source_url: 'https://tj.test/68342',
      title_primary: '再会',
      artist_primary: 'LiSA,Uru(produced by Ayase)',
      karaoke_numbers: { tj: '68342', ky: null, joysound: null },
    });
    const joyWithKy = record({
      id: 'blog-153-ky-44631',
      source_url: 'https://j-pop-playlist.tistory.com/153',
      title_primary: '再会 (produced by Ayase)',
      artist_primary: 'LiSA',
      karaoke_numbers: { tj: null, ky: '44631', joysound: '487541' },
    });

    const { records, conflicts } = mergeRecords([tjOnly, joyWithKy]);

    expect(records).toHaveLength(1);
    expect(records[0]?.karaoke_numbers).toEqual({ tj: '68342', ky: '44631', joysound: '487541' });
    expect(conflicts.filter((c) => c.field === 'tier_f_postcrawl_split_merge')).toHaveLength(1);
  });

  it('lands the JOYSOUND number for a both-vendor Tier E pair (blog-1184-tj-28002 ↔ &Z, #165 enablement)', () => {
    // The reviewed MERGE target carries BOTH tj (28002) and ky (43884) under a
    // blog id-slug. #163 left it unencodable ("both-vendor, non-tj id"): Tier E
    // then needed a tj id-slug and Tier F a single-vendor target. #165 removed
    // that guard, so the reviewed Tier E pair [28002, 670815] (encoded
    // 2026-07-20) now fires by matching the tj vendor-number cell regardless of
    // the row's id-slug. The distinct artists keep the automatic tiers from
    // merging, so the merge proves the reviewed Tier E pair fired.
    const bothVendor = record({
      id: 'blog-1184-tj-28002',
      source_url: 'https://j-pop-playlist.tistory.com/1184',
      title_primary: '&Z',
      artist_primary: '澤野弘之',
      karaoke_numbers: { tj: '28002', ky: '43884', joysound: null },
    });
    const joyOnly = record({
      id: 'joysound-418665',
      source_url: 'https://www.joysound.com/web/search/song/418665',
      title_primary: '&Z',
      artist_primary: 'SawanoHiroyuki[nZk]:mizuki',
      karaoke_numbers: { tj: null, ky: null, joysound: '670815' },
    });

    const { records } = mergeRecords([bothVendor, joyOnly]);

    expect(records).toHaveLength(1);
    expect(records[0]?.karaoke_numbers).toEqual({ tj: '28002', ky: '43884', joysound: '670815' });
  });

  it('leaves a pair unmerged when the candidate carries its own conflicting TJ number (tj-25103 ↔ tj-6579)', () => {
    const tjOnly = record({
      id: 'tj-25103',
      source_url: 'https://tj.test/25103',
      title_primary: 'Rocket Dive',
      artist_primary: 'hide',
      karaoke_numbers: { tj: '25103', ky: null, joysound: null },
    });
    const joyWithTj = record({
      id: 'tj-6579',
      source_url: 'https://tj.test/6579',
      title_primary: 'ROCKET DIVE(AWOL OP)',
      artist_primary: 'hide with Spread Beaver',
      karaoke_numbers: { tj: '6579', ky: null, joysound: '17108' },
    });

    const { records } = mergeRecords([tjOnly, joyWithTj]);

    expect(records).toHaveLength(2);
  });

  // --- R1 audit batch 2 (2026-07-05 tier-A web-review) ---
  it('lands the JOYSOUND number for a new Tier E pair (tj-25219 ↔ DEPARTURES/globe)', () => {
    const tjOnly = record({
      id: 'tj-25219',
      source_url: 'https://tj.test/25219',
      title_primary: 'Departures',
      artist_primary: 'globe',
      karaoke_numbers: { tj: '25219', ky: null, joysound: null },
    });
    const joyOnly = record({
      id: 'joysound-681847',
      source_url: 'https://www.joysound.com/web/search/song/681847',
      title_primary: 'DEPARTURES (20th edit)',
      artist_primary: 'globe',
      karaoke_numbers: { tj: null, ky: null, joysound: '681847' },
    });

    const { records } = mergeRecords([tjOnly, joyOnly]);

    expect(records).toHaveLength(1);
    expect(records[0]?.karaoke_numbers).toEqual({ tj: '25219', ky: null, joysound: '681847' });
  });

  it('lands the JOYSOUND number for a new Tier F pair (tjpdf-28511 ↔ 2人/ともさかりえ)', () => {
    const tjOnly = record({
      id: 'tjpdf-28511',
      source_url: 'https://tj.test/pdf/28511',
      title_primary: '2人',
      artist_primary: 'ともさか りえ',
      karaoke_numbers: { tj: '28511', ky: null, joysound: null },
    });
    const joyOnly = record({
      id: 'joysound-15420',
      source_url: 'https://www.joysound.com/web/search/song/15420',
      title_primary: '2人(ふたり)',
      artist_primary: 'ともさかりえ',
      karaoke_numbers: { tj: null, ky: null, joysound: '15420' },
    });

    const { records } = mergeRecords([tjOnly, joyOnly]);

    expect(records).toHaveLength(1);
    expect(records[0]?.karaoke_numbers).toEqual({ tj: '28511', ky: null, joysound: '15420' });
  });

  it('lands the JOYSOUND number for a batch-2 angle-tag pair (tj-26849 ↔ GREEN〈Original mix〉/浜崎あゆみ)', () => {
    const tjOnly = record({
      id: 'tj-26849',
      source_url: 'https://tj.test/26849',
      title_primary: 'GREEN',
      artist_primary: '浜崎あゆみ',
      karaoke_numbers: { tj: '26849', ky: null, joysound: null },
    });
    const joyOnly = record({
      id: 'joysound-69852',
      source_url: 'https://www.joysound.com/web/search/song/69852',
      title_primary: 'GREEN〈Original mix〉',
      artist_primary: '浜崎あゆみ',
      karaoke_numbers: { tj: null, ky: null, joysound: '69852' },
    });

    const { records } = mergeRecords([tjOnly, joyOnly]);

    expect(records).toHaveLength(1);
    expect(records[0]?.karaoke_numbers).toEqual({ tj: '26849', ky: null, joysound: '69852' });
  });

  // --- R1 B-tier review batch (2026-07-05) ---
  it('lands the JOYSOUND number for a B-tier rename pair (tj-25869 関ジャニ∞ ↔ 浪花いろは節/SUPER EIGHT)', () => {
    const tjOnly = record({
      id: 'tj-25869',
      source_url: 'https://tj.test/25869',
      title_primary: '浪花いろは節',
      artist_primary: '関ジャニ∞',
      karaoke_numbers: { tj: '25869', ky: null, joysound: null },
    });
    const joyOnly = record({
      id: 'joysound-32579',
      source_url: 'https://www.joysound.com/web/search/song/32579',
      title_primary: '浪花いろは節',
      artist_primary: 'SUPER EIGHT',
      karaoke_numbers: { tj: null, ky: null, joysound: '32579' },
    });

    const { records } = mergeRecords([tjOnly, joyOnly]);

    expect(records).toHaveLength(1);
    expect(records[0]?.karaoke_numbers).toEqual({ tj: '25869', ky: null, joysound: '32579' });
  });

  it('lands the JOYSOUND number for a B-tier Tier F romaji pair (tjpdf-28389 ↔ 絶望ビリー/Maximum The Hormone)', () => {
    const tjOnly = record({
      id: 'tjpdf-28389',
      source_url: 'https://tj.test/pdf/28389',
      title_primary: '絶望ビリー',
      artist_primary: 'マキシマム ザ ホルモン',
      karaoke_numbers: { tj: '28389', ky: null, joysound: null },
    });
    const joyOnly = record({
      id: 'joysound-163185',
      source_url: 'https://www.joysound.com/web/search/song/163185',
      title_primary: '絶望ビリー',
      artist_primary: 'Maximum The Hormone',
      karaoke_numbers: { tj: null, ky: null, joysound: '163185' },
    });

    const { records } = mergeRecords([tjOnly, joyOnly]);

    expect(records).toHaveLength(1);
    expect(records[0]?.karaoke_numbers).toEqual({ tj: '28389', ky: null, joysound: '163185' });
  });

  // --- R1 reject-set audit (2026-07-05): artistId false-reject recovery ---
  it('lands the JOYSOUND number for an artistId false-reject recovery (tj-52758 RATS&STAR ↔ め組のひと/ラッツ&スター)', () => {
    const tjOnly = record({
      id: 'tj-52758',
      source_url: 'https://tj.test/52758',
      title_primary: 'め組のひと',
      artist_primary: 'RATS&STAR',
      karaoke_numbers: { tj: '52758', ky: null, joysound: null },
    });
    const joyOnly = record({
      id: 'joysound-1006',
      source_url: 'https://www.joysound.com/web/search/song/1006',
      title_primary: 'め組のひと',
      artist_primary: 'ラッツ&スター',
      karaoke_numbers: { tj: null, ky: null, joysound: '1006' },
    });

    const { records } = mergeRecords([tjOnly, joyOnly]);

    expect(records).toHaveLength(1);
    expect(records[0]?.karaoke_numbers).toEqual({ tj: '52758', ky: null, joysound: '1006' });
  });

  // --- R1 C-tier review (2026-07-05): title-rendering recovery ---
  it('lands the JOYSOUND number for a C-tier kyūjitai title recovery (tj-6659 歸る ↔ 帰る/島和彦)', () => {
    const tjOnly = record({
      id: 'tj-6659',
      source_url: 'https://tj.test/6659',
      title_primary: '雨の夜あなたは歸る',
      artist_primary: '島和彦',
      karaoke_numbers: { tj: '6659', ky: null, joysound: null },
    });
    const joyOnly = record({
      id: 'joysound-19047',
      source_url: 'https://www.joysound.com/web/search/song/19047',
      title_primary: '雨の夜あなたは帰る',
      artist_primary: '島和彦',
      karaoke_numbers: { tj: null, ky: null, joysound: '19047' },
    });

    const { records } = mergeRecords([tjOnly, joyOnly]);

    expect(records).toHaveLength(1);
    expect(records[0]?.karaoke_numbers).toEqual({ tj: '6659', ky: null, joysound: '19047' });
  });
});

// ---------------------------------------------------------------------
// Tier G — automatic no-manual-review residual split rules
// ---------------------------------------------------------------------
describe('mergeRecords — Tier G automatic residual split rules', () => {
  it('merges exact-title expanded-artist-credit pairs without an exact allowlist entry', () => {
    const tjOnly = record({
      id: 'tj-25090',
      source_url: 'https://tj.test/25090',
      title_primary: 'Vanilla',
      artist_primary: 'Gackt',
      artist_ko: '각트',
      karaoke_numbers: { tj: '25090', ky: null, joysound: null },
    });
    const joyOnly = record({
      id: 'joysound-20605',
      source_url: 'https://www.joysound.com/web/search/song/20605',
      title_primary: 'Vanilla',
      artist_primary: 'GACKT(Gackt)',
      karaoke_numbers: { tj: null, ky: null, joysound: '20669' },
    });

    const { records, conflicts } = mergeRecords([tjOnly, joyOnly]);

    expect(records).toHaveLength(1);
    expect(records[0]?.karaoke_numbers).toEqual({ tj: '25090', ky: null, joysound: '20669' });
    expect(conflicts.filter((c) => c.field === 'tier_g_auto_residual_merge')).toHaveLength(1);
    expect(headlineConflicts(conflicts)).toHaveLength(0);
  });

  it('merges same-artist old/new kanji title variants', () => {
    const tjOnly = record({
      id: 'tj-26881',
      source_url: 'https://tj.test/26881',
      title_primary: '涙のムコウ(機動戦士ガンダム00 OP)',
      artist_primary: 'ステレオポニー',
      karaoke_numbers: { tj: '26881', ky: null, joysound: null },
    });
    const joyOnly = record({
      id: 'joysound-131123',
      source_url: 'https://www.joysound.com/web/search/song/131123',
      title_primary: '泪のムコウ',
      artist_primary: 'ステレオポニー',
      karaoke_numbers: { tj: null, ky: null, joysound: '90712' },
    });

    const { records, conflicts } = mergeRecords([tjOnly, joyOnly]);

    expect(records).toHaveLength(1);
    expect(records[0]?.karaoke_numbers).toEqual({ tj: '26881', ky: null, joysound: '90712' });
    expect(conflicts.filter((c) => c.field === 'tier_g_auto_residual_merge')).toHaveLength(1);
  });

  it('merges simple artist_ko bridges only when primary artist surfaces are non-collab', () => {
    const kyOnly = record({
      id: 'blog-900-ky-50001',
      source_url: 'https://blog.test/900',
      title_primary: 'Alias Song',
      artist_primary: 'Reol',
      artist_ko: '레오루',
      karaoke_numbers: { tj: null, ky: '50001', joysound: null },
    });
    const joyOnly = record({
      id: 'joysound-900001',
      source_url: 'https://www.joysound.com/web/search/song/900001',
      title_primary: 'Alias Song',
      artist_primary: 'れをる',
      artist_ko: '레오루',
      karaoke_numbers: { tj: null, ky: null, joysound: '900001' },
    });

    const { records, conflicts } = mergeRecords([kyOnly, joyOnly]);

    expect(records).toHaveLength(1);
    expect(records[0]?.karaoke_numbers).toEqual({ tj: null, ky: '50001', joysound: '900001' });
    expect(conflicts.filter((c) => c.field === 'tier_g_auto_residual_merge')).toHaveLength(1);
  });

  it('does not merge short numeric expanded-artist credits without manual review', () => {
    const tjOnly = record({
      id: 'tj-25022',
      source_url: 'https://tj.test/25022',
      title_primary: 'たいせつなひと',
      artist_primary: '19',
      karaoke_numbers: { tj: '25022', ky: null, joysound: null },
    });
    const joyOnly = record({
      id: 'joysound-11794',
      source_url: 'https://www.joysound.com/web/search/song/11794',
      title_primary: 'たいせつなひと',
      artist_primary: '19(ジューク)',
      karaoke_numbers: { tj: null, ky: null, joysound: '11802' },
    });

    const { records, conflicts } = mergeRecords([tjOnly, joyOnly]);

    expect(records).toHaveLength(2);
    expect(conflicts.filter((c) => c.field === 'tier_g_auto_residual_merge')).toHaveLength(0);
  });

  it('does not merge CV-credit prefix containment without manual review', () => {
    // Non-allowlisted numbers (tj 29401 / joysound 990143): the original real
    // example (tj-28894 / joysound 429143) was promoted to a reviewed Tier F
    // pair in the 2026-07-16 audit follow-up B, so this Tier G assertion uses
    // synthetic numbers to keep testing the automatic tier's conservatism.
    const tjOnly = record({
      id: 'tj-29401',
      source_url: 'https://tj.test/29401',
      title_primary: 'IKEBUKURO WEST GAME PARK',
      artist_primary: 'Buster Bros!!!',
      karaoke_numbers: { tj: '29401', ky: null, joysound: null },
    });
    const joyOnly = record({
      id: 'joysound-990805',
      source_url: 'https://www.joysound.com/web/search/song/990805',
      title_primary: 'IKEBUKURO WEST GAME PARK',
      artist_primary: 'Buster Bros!!!(CV.木村昴・石谷春貴・天崎滉平)',
      karaoke_numbers: { tj: null, ky: null, joysound: '990143' },
    });

    const { records, conflicts } = mergeRecords([tjOnly, joyOnly]);

    expect(records).toHaveLength(2);
    expect(conflicts.filter((c) => c.field === 'tier_g_auto_residual_merge')).toHaveLength(0);
  });

  it('does not merge artist_ko leakage from a featured artist', () => {
    const tjOnly = record({
      id: 'blog-338-tj-28895',
      source_url: 'https://j-pop-playlist.tistory.com/338',
      title_primary: "アイノカタチ(ドラマ'義母と娘のブルース' OST)",
      artist_primary: 'MISIA(Feat.HIDE(GReeeeN))',
      artist_ko: '그린',
      karaoke_numbers: { tj: '28895', ky: null, joysound: null },
    });
    const joyOnly = record({
      id: 'joysound-775260',
      source_url: 'https://www.joysound.com/web/search/song/775260',
      title_primary: 'アイノカタチ',
      artist_primary: 'GReeeeN',
      artist_ko: '그린',
      karaoke_numbers: { tj: null, ky: null, joysound: '441874' },
    });

    const { records, conflicts } = mergeRecords([tjOnly, joyOnly]);

    expect(records).toHaveLength(2);
    expect(conflicts.filter((c) => c.field === 'tier_g_auto_residual_merge')).toHaveLength(0);
  });

  it('keeps version/remix title variants out of the automatic rule tier', () => {
    // Non-allowlisted numbers (tj 29402 / joysound 990141): the original real
    // example (tj-25065 / joysound 26141) was promoted to a reviewed Tier E
    // pair in the 2026-07-16 audit follow-up B, so this Tier G assertion uses
    // synthetic numbers to keep testing the automatic tier's conservatism.
    const tjOnly = record({
      id: 'tj-29402',
      source_url: 'https://tj.test/29402',
      title_primary: 'Simply Wonderful',
      artist_primary: '倉木麻衣',
      karaoke_numbers: { tj: '29402', ky: null, joysound: null },
    });
    const joyOnly = record({
      id: 'joysound-990651',
      source_url: 'https://www.joysound.com/web/search/song/990651',
      title_primary: 'Simply Wonderful〈Club Edit〉',
      artist_primary: '倉木麻衣',
      karaoke_numbers: { tj: null, ky: null, joysound: '990141' },
    });

    const { records, conflicts } = mergeRecords([tjOnly, joyOnly]);

    expect(records).toHaveLength(2);
    expect(conflicts.filter((c) => c.field === 'tier_g_auto_residual_merge')).toHaveLength(0);
  });

  it('does not strip kana-only version parentheticals as automatic readings', () => {
    // NOTE: uses non-allowlisted numbers (tj 26298 / joysound 7119) so this
    // Tier G regression is not short-circuited by a reviewed Tier E/F pair.
    // The real tj-26299 ↔ joysound-7118 pair is now an owner-reviewed Tier E
    // merge (R1 batch), which is exercised separately.
    const tjOnly = record({
      id: 'tj-26298',
      source_url: 'https://tj.test/26298',
      title_primary: '私がオバさんになっても',
      artist_primary: '森高千里',
      karaoke_numbers: { tj: '26298', ky: null, joysound: null },
    });
    const joyVersion = record({
      id: 'joysound-7119',
      source_url: 'https://www.joysound.com/web/search/song/7119',
      title_primary: '私がオバさんになっても (シングル・ヴァージョン)',
      artist_primary: '森高千里',
      karaoke_numbers: { tj: null, ky: null, joysound: '7119' },
    });

    const { records, conflicts } = mergeRecords([tjOnly, joyVersion]);

    expect(records).toHaveLength(2);
    expect(conflicts.filter((c) => c.field === 'tier_g_auto_residual_merge')).toHaveLength(0);
  });

  it('keeps plus-title variants out of the automatic rule tier', () => {
    const tjOnly = record({
      id: 'tj-882562',
      source_url: 'https://tj.test/882562',
      title_primary: '櫻star',
      artist_primary: 'Division All Stars',
      karaoke_numbers: { tj: '882562', ky: null, joysound: null },
    });
    const joyPlus = record({
      id: 'joysound-882562',
      source_url: 'https://www.joysound.com/web/search/song/882562',
      title_primary: '桜star +',
      artist_primary: 'Division All Stars',
      karaoke_numbers: { tj: null, ky: null, joysound: '498108' },
    });

    const { records, conflicts } = mergeRecords([tjOnly, joyPlus]);

    expect(records).toHaveLength(2);
    expect(conflicts.filter((c) => c.field === 'tier_g_auto_residual_merge')).toHaveLength(0);
  });

  it('does not merge plain lexical artist prefixes such as ALI to AliA', () => {
    const tjOnly = record({
      id: 'tj-prefix-1',
      source_url: 'https://tj.test/prefix-1',
      title_primary: 'Prefix Collision',
      artist_primary: 'ALI',
      karaoke_numbers: { tj: '991001', ky: null, joysound: null },
    });
    const joyOnly = record({
      id: 'joysound-prefix-1',
      source_url: 'https://www.joysound.com/web/search/song/prefix-1',
      title_primary: 'Prefix Collision',
      artist_primary: 'AliA',
      karaoke_numbers: { tj: null, ky: null, joysound: '991001' },
    });

    const { records, conflicts } = mergeRecords([tjOnly, joyOnly]);

    expect(records).toHaveLength(2);
    expect(conflicts.filter((c) => c.field === 'tier_g_auto_residual_merge')).toHaveLength(0);
  });

  it('requires one-to-one uniqueness across the full plausible target/candidate graph', () => {
    const targetA = record({
      id: 'tj-graph-a',
      source_url: 'https://tj.test/graph-a',
      title_primary: '櫻 Graph Song',
      artist_primary: 'Alpha',
      karaoke_numbers: { tj: '992001', ky: null, joysound: null },
    });
    const targetB = record({
      id: 'tj-graph-b',
      source_url: 'https://tj.test/graph-b',
      title_primary: '櫻 Graph Song',
      artist_primary: 'Beta',
      artist_ko: '베타',
      karaoke_numbers: { tj: '992002', ky: null, joysound: null },
    });
    const sharedJoy = record({
      id: 'joysound-graph-shared',
      source_url: 'https://www.joysound.com/web/search/song/graph-shared',
      title_primary: '桜 Graph Song',
      artist_primary: 'Alpha',
      artist_ko: '베타',
      karaoke_numbers: { tj: null, ky: null, joysound: '992101' },
    });
    const betaJoy = record({
      id: 'joysound-graph-beta',
      source_url: 'https://www.joysound.com/web/search/song/graph-beta',
      title_primary: '桜 Graph Song',
      artist_primary: 'Beta',
      artist_ko: '베타',
      karaoke_numbers: { tj: null, ky: null, joysound: '992102' },
    });

    const { records, conflicts } = mergeRecords([targetA, targetB, sharedJoy, betaJoy]);

    expect(records).toHaveLength(4);
    expect(conflicts.filter((c) => c.field === 'tier_g_auto_residual_merge')).toHaveLength(0);
  });

  it('keeps JOYSOUND-side rows with unreviewed extra provider numbers out of automatic rules', () => {
    const tjOnly = record({
      id: 'tj-25090',
      source_url: 'https://tj.test/25090',
      title_primary: 'Vanilla',
      artist_primary: 'Gackt',
      karaoke_numbers: { tj: '25090', ky: null, joysound: null },
    });
    const joyWithKy = record({
      id: 'joysound-20605',
      source_url: 'https://www.joysound.com/web/search/song/20605',
      title_primary: 'Vanilla',
      artist_primary: 'GACKT(Gackt)',
      karaoke_numbers: { tj: null, ky: '99999', joysound: '20669' },
    });

    const { records, conflicts } = mergeRecords([tjOnly, joyWithKy]);

    expect(records).toHaveLength(2);
    expect(conflicts.filter((c) => c.field === 'tier_g_auto_residual_merge')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// Cross-record artist_ko propagation
//
// After clusters are materialized, `artist_ko` is propagated across SEPARATE
// records that share the same conservative full-artist identity key
// (`normalize(artist_primary)`). This is NOT a song merge: rows keep their
// own titles and karaoke numbers and never collapse — only a missing
// `artist_ko` is filled when all donors for the artist key agree (after a
// whitespace-insensitive Korean display normalization).
// ---------------------------------------------------------------------
describe('mergeRecords — cross-record artist_ko propagation', () => {
  it('propagates artist_ko from a blog donor to a separate JOYSOUND record sharing the full artist key (no song merge)', () => {
    const blog = record({
      id: 'blog-300-0',
      source_url: 'https://blog.test/300',
      title_primary: '夜に駆ける',
      title_ko: '밤에 달리다',
      artist_primary: 'YOASOBI',
      artist_ko: '요아소비',
      karaoke_numbers: { tj: null, ky: null, joysound: null },
    });
    const js = record({
      id: 'joysound-700100',
      source_url: 'https://www.joysound.com/web/search/song/700100',
      // Different title + a distinct karaoke number — no Tier A/B/C/D/E merge.
      title_primary: 'アイドル',
      artist_primary: 'YOASOBI',
      artist_ko: null,
      karaoke_numbers: { tj: null, ky: null, joysound: '700100' },
    });

    const { records } = mergeRecords([blog, js]);

    // Two distinct songs survive — propagation must NOT union/collapse rows.
    expect(records).toHaveLength(2);
    const joy = records.find((r) => r.id === 'joysound-700100');
    if (!joy) throw new Error('joysound record missing');
    // The missing Korean artist name is filled from the donor.
    expect(joy.artist_ko).toBe('요아소비');
    // Its own song identity is untouched.
    expect(joy.title_primary).toBe('アイドル');
    expect(joy.karaoke_numbers).toEqual({ tj: null, ky: null, joysound: '700100' });
    // Donor is unchanged.
    expect(records.find((r) => r.id === 'blog-300-0')?.artist_ko).toBe('요아소비');
  });

  it('never overwrites an existing non-null artist_ko, even from a higher-priority donor', () => {
    const blog = record({
      id: 'blog-301-0',
      source_url: 'https://blog.test/301',
      title_primary: 'BlogTitle',
      artist_primary: 'YOASOBI',
      artist_ko: '요아소비', // blog (rank 1) — unspaced form
      karaoke_numbers: { tj: null, ky: null, joysound: null },
    });
    const js = record({
      id: 'joysound-700200',
      source_url: 'https://www.joysound.com/web/search/song/700200',
      title_primary: 'JoyTitle',
      artist_primary: 'YOASOBI',
      // Existing non-null value (a spacing variant of the donor) — must survive.
      artist_ko: '요아 소비',
      karaoke_numbers: { tj: null, ky: null, joysound: '700200' },
    });

    const { records } = mergeRecords([blog, js]);

    expect(records).toHaveLength(2);
    // JOYSOUND keeps its OWN value — a higher-priority donor never overwrites it.
    expect(records.find((r) => r.id === 'joysound-700200')?.artist_ko).toBe('요아 소비');
    // Donor value is left exactly as-is.
    expect(records.find((r) => r.id === 'blog-301-0')?.artist_ko).toBe('요아소비');
  });

  it('skips the whole artist-key group when donor Korean names conflict after whitespace-insensitive normalization', () => {
    // Real case: the 槇原敬之 artist key carries a genuinely different Korean
    // name on a cover credit (하타 모토히로). Conflicting donors must block any
    // fill for the entire key — no partial fill, no source-priority pick.
    const makihara = record({
      id: 'blog-302-0',
      source_url: 'https://blog.test/302',
      title_primary: 'もう恋なんてしない',
      artist_primary: '槇原敬之',
      artist_ko: '마키하라 노리유키',
      karaoke_numbers: { tj: null, ky: null, joysound: null },
    });
    const hata = record({
      id: 'blog-303-0',
      source_url: 'https://blog.test/303',
      title_primary: '別の曲',
      artist_primary: '槇原敬之',
      artist_ko: '하타 모토히로',
      karaoke_numbers: { tj: null, ky: null, joysound: null },
    });
    const js = record({
      id: 'joysound-700300',
      source_url: 'https://www.joysound.com/web/search/song/700300',
      title_primary: 'JOYSOUNDの曲',
      artist_primary: '槇原敬之',
      artist_ko: null,
      karaoke_numbers: { tj: null, ky: null, joysound: '700300' },
    });

    const { records } = mergeRecords([makihara, hata, js]);

    expect(records).toHaveLength(3);
    // Conflicting donors → no fill at all.
    expect(records.find((r) => r.id === 'joysound-700300')?.artist_ko).toBeNull();
    // Both donors keep their distinct values.
    expect(records.find((r) => r.id === 'blog-302-0')?.artist_ko).toBe('마키하라 노리유키');
    expect(records.find((r) => r.id === 'blog-303-0')?.artist_ko).toBe('하타 모토히로');
  });

  it('treats spacing-only Korean variants as equivalent and fills with the highest-priority ownership display', () => {
    const blog = record({
      id: 'blog-304-0',
      source_url: 'https://blog.test/304',
      title_primary: 'BlogSong',
      artist_primary: '槇原敬之',
      artist_ko: '마키하라 노리유키', // blog (rank 1) — spaced display form
      karaoke_numbers: { tj: null, ky: null, joysound: null },
    });
    const tj = record({
      id: 'tj-70400',
      source_url: 'https://tj.test/70400',
      title_primary: 'TjSong',
      artist_primary: '槇原敬之',
      artist_ko: '마키하라노리유키', // tj (rank 2) — unspaced, same display key
      karaoke_numbers: { tj: '70400', ky: null, joysound: null },
    });
    const js = record({
      id: 'joysound-700400',
      source_url: 'https://www.joysound.com/web/search/song/700400',
      title_primary: 'JoySong',
      artist_primary: '槇原敬之',
      artist_ko: null,
      karaoke_numbers: { tj: null, ky: null, joysound: '700400' },
    });

    const { records } = mergeRecords([blog, tj, js]);

    expect(records).toHaveLength(3);
    // No conflict (spacing-insensitive). Blog (KO_CHAIN first) provides the
    // display form — propagation ranks by KO ownership, not the id SOURCE_RANK.
    expect(records.find((r) => r.id === 'joysound-700400')?.artist_ko).toBe('마키하라 노리유키');
  });

  it('matches on the normalized full artist surface — spaced 尾崎 豊 donor fills a 尾崎豊 JOYSOUND row', () => {
    const blog = record({
      id: 'blog-305-0',
      source_url: 'https://blog.test/305',
      title_primary: 'I LOVE YOU',
      artist_primary: '尾崎 豊', // spaced surface
      artist_ko: '오자키 유타카',
      karaoke_numbers: { tj: null, ky: null, joysound: null },
    });
    const js = record({
      id: 'joysound-700500',
      source_url: 'https://www.joysound.com/web/search/song/700500',
      title_primary: '卒業',
      artist_primary: '尾崎豊', // unspaced surface — same normalize() key
      artist_ko: null,
      karaoke_numbers: { tj: null, ky: null, joysound: '700500' },
    });

    const { records } = mergeRecords([blog, js]);

    expect(records).toHaveLength(2);
    expect(records.find((r) => r.id === 'joysound-700500')?.artist_ko).toBe('오자키 유타카');
  });
});

describe('mergeRecords — title_ruby (carried from the title donor)', () => {
  it('keeps title_ruby on a JOYSOUND-only singleton (title donor is the joysound record)', () => {
    const js = record({
      id: 'joysound-622657',
      source_url: 'https://www.joysound.com/web/search/song/622657',
      title_primary: '○',
      artist_primary: 'いきものがかり',
      karaoke_numbers: { tj: null, ky: null, joysound: '622657' },
      title_ruby: 'マル',
    });
    const { records } = mergeRecords([js]);
    expect(records).toHaveLength(1);
    expect(records[0]?.title_ruby).toBe('マル');
    // Emitted as the last key (schema-canonical trailing position).
    expect(Object.keys(records[0] ?? {}).at(-1)).toBe('title_ruby');
  });

  it('carries the JOYSOUND ruby onto the merged record when the joysound side also wins the title', () => {
    // Tier A union by shared joysound#; TJ has no title, so the title (and its
    // ruby) come from the joysound record.
    const js = record({
      id: 'joysound-631234',
      source_url: 'https://www.joysound.com/web/search/song/631234',
      title_primary: 'アイドル',
      artist_primary: 'YOASOBI',
      karaoke_numbers: { tj: null, ky: null, joysound: '631234' },
      title_ruby: 'アイドル',
    });
    const { records } = mergeRecords([js]);
    expect(records[0]?.title_ruby).toBe('アイドル');
  });

  it('drops the JOYSOUND ruby when a higher-priority source donates the title', () => {
    // Shared TJ# clusters a TJ title-owner with a JOYSOUND ruby-carrier. The TJ
    // record wins the title (TITLE_ARTIST_CHAIN puts joysound last), so the
    // JOYSOUND reading — which reads the JOYSOUND surface, possibly a
    // dash/spacing variant — is intentionally not grafted onto the TJ title.
    const tj = record({
      id: 'tj-68923',
      source_url: 'https://tj.test/68923',
      title_primary: '群青',
      artist_primary: 'YOASOBI',
      karaoke_numbers: { tj: '68923', ky: null, joysound: null },
    });
    const js = record({
      id: 'joysound-500001',
      source_url: 'https://www.joysound.com/web/search/song/500001',
      title_primary: '群 青',
      artist_primary: 'YOASOBI',
      karaoke_numbers: { tj: '68923', ky: null, joysound: '500001' },
      title_ruby: 'グンジョウ',
    });
    const { records } = mergeRecords([tj, js]);
    expect(records).toHaveLength(1);
    expect(records[0]?.title_primary).toBe('群青');
    expect(records[0]).not.toHaveProperty('title_ruby');
  });
});

// ---------------------------------------------------------------------
// Tier B same-source survivor determinism (commutativity)
//
// Audit 2026-07-09: two same-source records with identical normalized
// title+artist but different tj# collapse via Tier B (partitions.size === 1),
// and the equal-SOURCE_RANK ownership/priority tiebreaks used to fall to input
// order — so `mergeRecords([A,B])` and `mergeRecords([B,A])` picked DIFFERENT
// survivors. The merger now sorts each cluster's members by `compareMergedRecords`
// before merging, so the survivor is fixed regardless of input order.
//
// (The owner HELD whether such same-source records should collapse at all; this
// suite pins ONLY that the collapse is order-independent, not that it happens.)
// ---------------------------------------------------------------------
describe('mergeRecords — Tier B same-source survivor determinism', () => {
  it('picks the same survivor for [A,B] and [B,A] (audit repro: same-source, same key, different tj#)', () => {
    const lo = record({
      id: 'tj-1000',
      source_url: 'https://tj.test/1000',
      title_primary: 'SameSong',
      artist_primary: 'SameArtist',
      karaoke_numbers: { tj: '1000', ky: null, joysound: null },
    });
    const hi = record({
      id: 'tj-2000',
      source_url: 'https://tj.test/2000',
      title_primary: 'SameSong',
      artist_primary: 'SameArtist',
      karaoke_numbers: { tj: '2000', ky: null, joysound: null },
    });

    const forward = mergeRecords([lo, hi]);
    const backward = mergeRecords([hi, lo]);

    // Both orders collapse the same-source twins into one record.
    expect(forward.records).toHaveLength(1);
    expect(backward.records).toHaveLength(1);

    // Commutative: byte-identical merged record output regardless of input order.
    expect(JSON.stringify(forward.records)).toBe(JSON.stringify(backward.records));
    // This cluster's conflict is emitted from mergeKaraokeNumbers over the
    // now-sorted cluster, so its reporting is order-independent too. (This is
    // NOT a global guarantee — e.g. Tier D BLOCKED-conflict rows are still
    // reported in input order; only the record SURVIVOR is fully determinized.)
    expect(JSON.stringify(forward.conflicts)).toBe(JSON.stringify(backward.conflicts));

    // Survivor pinned by compareMergedRecords: the lower tj# ('1000') sorts
    // first, so its id / source_url / tj win the equal-rank tiebreak.
    const m = forward.records[0];
    if (!m) throw new Error('no record');
    expect(m.id).toBe('tj-1000');
    expect(m.source_url).toBe('https://tj.test/1000');
    expect(m.karaoke_numbers.tj).toBe('1000');

    // The tj# disagreement is still surfaced as a conflict (winner = survivor).
    const tjConflicts = forward.conflicts.filter((c) => c.field === 'tj');
    expect(tjConflicts).toHaveLength(1);
    expect(tjConflicts[0]?.winner).toBe('1000');
    expect(tjConflicts[0]?.values.map((v) => v.value).sort()).toEqual(['1000', '2000']);
  });

  it('survivor does not depend on which tj# is numerically/lexically smaller vs input position', () => {
    // Same shape, but the FIRST-in-input record carries the HIGHER tj#. Pre-fix,
    // input-order tiebreak would let it win; the deterministic rule still picks
    // the lower-tj survivor.
    const hiFirst = record({
      id: 'tj-2000',
      source_url: 'https://tj.test/2000',
      title_primary: 'OtherSong',
      artist_primary: 'OtherArtist',
      karaoke_numbers: { tj: '2000', ky: null, joysound: null },
    });
    const loSecond = record({
      id: 'tj-1000',
      source_url: 'https://tj.test/1000',
      title_primary: 'OtherSong',
      artist_primary: 'OtherArtist',
      karaoke_numbers: { tj: '1000', ky: null, joysound: null },
    });

    const { records } = mergeRecords([hiFirst, loSecond]);
    expect(records).toHaveLength(1);
    expect(records[0]?.id).toBe('tj-1000');
    expect(records[0]?.karaoke_numbers.tj).toBe('1000');
  });
});

describe('mergeRecords — KY source rank + blog graduation (R5)', () => {
  it('graduates a standalone blog row to ky-* when it shares a ky number with a live KY record', () => {
    const ky = record({
      id: 'ky-41637',
      source_url: 'https://kysing.kr/search/?category=1&keyword=41637',
      title_primary: '雪の華', // KY primary (Japanese)
      artist_primary: '中島美嘉',
      karaoke_numbers: { tj: null, ky: '41637', joysound: null },
    });
    const blog = record({
      id: 'blog-523-1',
      source_url: 'https://blog.test/523',
      title_primary: '유키노하나', // blog title (Korean render)
      title_ko: '눈의 꽃',
      artist_primary: '中島美嘉',
      artist_ko: '나카시마 미카',
      karaoke_numbers: { tj: null, ky: '41637', joysound: null },
    });

    const { records, conflicts } = mergeRecords([ky, blog]);
    expect(records).toHaveLength(1);
    expect(conflicts).toHaveLength(0);
    const m = records[0];
    if (!m) throw new Error('no record');
    // id/source_url: ky (rank 4) beats blog (rank 5) → the blog row graduates.
    expect(m.id).toBe('ky-41637');
    expect(m.source_url).toBe('https://kysing.kr/search/?category=1&keyword=41637');
    // TITLE_ARTIST_CHAIN puts ky LAST, so the blog title wins over the KY title
    // (a truncation-risky KY title never beats a higher-confidence source).
    expect(m.title_primary).toBe('유키노하나');
    // KO chain: blog contributes the Korean fields (KY contributes none).
    expect(m.title_ko).toBe('눈의 꽃');
    expect(m.karaoke_numbers.ky).toBe('41637');
  });

  it('joysound (rank 3) beats ky (rank 4) on the cluster id', () => {
    // A blog row carrying BOTH a ky and a joysound number Tier-A-unions with the
    // live ky-* and joysound-* records; the highest-rank source wins the id.
    const blog = record({
      id: 'blog-9-1',
      source_url: 'https://blog.test/9',
      title_primary: 'T',
      artist_primary: 'A',
      karaoke_numbers: { tj: null, ky: '200', joysound: '300' },
    });
    const kyRec = record({
      id: 'ky-200',
      source_url: 'https://kysing.kr/search/?category=1&keyword=200',
      title_primary: 'T',
      artist_primary: 'A',
      karaoke_numbers: { tj: null, ky: '200', joysound: null },
    });
    const joy = record({
      id: 'joysound-300',
      source_url: 'https://www.joysound.com/web/search/song/300',
      title_primary: 'T',
      artist_primary: 'A',
      karaoke_numbers: { tj: null, ky: null, joysound: '300' },
    });

    const { records } = mergeRecords([blog, kyRec, joy]);
    expect(records).toHaveLength(1);
    expect(records[0]?.id).toBe('joysound-300');
    expect(records[0]?.karaoke_numbers).toEqual({ tj: null, ky: '200', joysound: '300' });
  });

  it('passes a standalone ky-* record through unchanged', () => {
    const ky = record({
      id: 'ky-44655',
      source_url: 'https://kysing.kr/search/?category=1&keyword=44655',
      title_primary: '怪物',
      artist_primary: 'YOASOBI',
      karaoke_numbers: { tj: null, ky: '44655', joysound: null },
    });
    const { records } = mergeRecords([ky]);
    expect(records).toHaveLength(1);
    expect(records[0]?.id).toBe('ky-44655');
  });
});
