import { validateSongRecord } from '@karaoke/schema';
import { describe, expect, it } from 'vitest';
import {
  kySourceUrl,
  normalizeKyRecord,
  normalizeKyTitle,
} from '../../../src/adapters/ky-kysing/normalizer.js';
import { mergeRecords } from '../../../src/merge.js';

const CRAWLED_AT = '2026-07-16T00:00:00.000Z';

describe('normalizeKyRecord', () => {
  it('builds a valid SongRecord populating only karaoke_numbers.ky', () => {
    const rec = normalizeKyRecord({
      ky: '44655',
      title: '怪物',
      artist: 'YOASOBI',
      crawledAt: CRAWLED_AT,
    });
    expect(rec.id).toBe('ky-44655');
    expect(rec.source_url).toBe('https://kysing.kr/search/?category=1&keyword=44655');
    expect(rec.title_primary).toBe('怪物');
    expect(rec.artist_primary).toBe('YOASOBI');
    expect(rec.karaoke_numbers).toEqual({ tj: null, ky: '44655', joysound: null });
    // KY contributes no Korean fields.
    expect(rec.title_ko).toBeNull();
    expect(rec.artist_ko).toBeNull();
    expect(rec.artist_aliases).toBeUndefined();
    expect(rec.crawled_at).toBe(CRAWLED_AT);
    expect(() => validateSongRecord(rec)).not.toThrow();
  });

  it('kySourceUrl points at the per-song category=1 detail page', () => {
    expect(kySourceUrl('12345')).toBe('https://kysing.kr/search/?category=1&keyword=12345');
  });

  it('throws on a non-digit / invalid ky number', () => {
    expect(() =>
      normalizeKyRecord({ ky: '12a', title: 't', artist: 'a', crawledAt: CRAWLED_AT }),
    ).toThrow(/valid KY number/);
  });

  it('throws on an empty title or artist', () => {
    expect(() =>
      normalizeKyRecord({ ky: '1', title: '   ', artist: 'a', crawledAt: CRAWLED_AT }),
    ).toThrow(/empty title/);
    expect(() =>
      normalizeKyRecord({ ky: '1', title: 't', artist: '', crawledAt: CRAWLED_AT }),
    ).toThrow(/empty artist/);
  });

  it('strips the tie-up suffix so title_primary is tie-up-canonical', () => {
    const rec = normalizeKyRecord({
      ky: '1',
      title: 'この世の限り (映画"さくらん")',
      artist: '椎名林檎,椎名純平',
      crawledAt: CRAWLED_AT,
    });
    expect(rec.title_primary).toBe('この世の限り');
  });
});

describe('normalizeKyTitle', () => {
  it('peels media-name context parens — real KY tie-up formats (Phase 1b)', () => {
    // Real KY rows (ky-42263 / ky-42655 / ky-40538) whose dominant tie-up format
    // — `(映画"X")` / `(ドラマ"X")` — the role-tail stripper missed.
    expect(normalizeKyTitle('この世の限り (映画"さくらん")')).toBe('この世の限り');
    expect(normalizeKyTitle('be with you. (映画"犬と私の10の約束")')).toBe('be with you.');
    expect(normalizeKyTitle('STEADY (ドラマ"イタズラなKiss")')).toBe('STEADY');
  });
  it('still peels a trailing ROLE parenthetical (real ky-44218 / ky-41905 format)', () => {
    expect(normalizeKyTitle('fake town baby ("血界戦線 & BEYOND"OP)')).toBe('fake town baby');
    expect(normalizeKyTitle('* ~アスタリスク~ ("BLEACH"OP)')).toBe('* ~アスタリスク~');
  });
  it('KEEPS a version/cut marker (distinct karaoke cut, must not merge)', () => {
    expect(normalizeKyTitle('メルト(Short Ver.)')).toBe('メルト(Short Ver.)');
    expect(normalizeKyTitle('曲名(Live)')).toBe('曲名(Live)');
    // Media keyword AND a version marker → version wins (distinct cut kept).
    expect(normalizeKyTitle('曲名 (アニメ Ver.)')).toBe('曲名 (アニメ Ver.)');
  });
  it('KEEPS a plain title with no tie-up suffix', () => {
    expect(normalizeKyTitle('怪物')).toBe('怪物');
  });
  it('does NOT strip to empty when the title is only a parenthetical', () => {
    expect(normalizeKyTitle('(映画"さくらん")')).toBe('(映画"さくらん")');
  });
});

describe('KY tie-up strip — end-to-end merge lock (audit follow-up A)', () => {
  it('a stripped KY row now clusters with its clean-titled JOYSOUND twin (Tier C)', () => {
    // Real audit miss (ky-42263): KY `この世の限り (映画"さくらん")` /
    // `椎名林檎,椎名純平` did not merge with JOYSOUND `この世の限り` /
    // `椎名林檎×斎藤ネコ+椎名純平` (Tier C blocked by the raw media suffix; Tier D
    // by the whole-artist key). With the adapter strip, the KY title is clean and
    // Tier C's title+lead-artist key matches.
    const ky = normalizeKyRecord({
      ky: '1',
      title: 'この世の限り (映画"さくらん")',
      artist: '椎名林檎,椎名純平',
      crawledAt: CRAWLED_AT,
    });
    const joy = {
      id: 'joysound-2',
      source_url: 'https://www.joysound.com/web/search/song/2',
      title_primary: 'この世の限り',
      title_ko: null,
      artist_primary: '椎名林檎×斎藤ネコ+椎名純平',
      artist_ko: null,
      karaoke_numbers: { tj: null, ky: null, joysound: '2' },
      crawled_at: CRAWLED_AT,
    };
    const { records } = mergeRecords([ky, joy]);
    expect(records).toHaveLength(1);
    // joysound (rank 3) wins the id over ky (rank 4); both numbers union.
    expect(records[0]?.id).toBe('joysound-2');
    expect(records[0]?.karaoke_numbers).toEqual({ tj: null, ky: '1', joysound: '2' });
  });

  it('a preserved version/cut suffix does NOT merge a KY row into a clean twin (negative lock)', () => {
    // Review M1: the strip KEEPS version/cut markers (a distinct karaoke cut).
    // `メルト(Short Ver.)` must therefore stay SEPARATE from the studio `メルト`
    // — the normalizer leaves the suffix on, so no tier's title key matches and
    // the two rows do not merge. Guards against a future over-eager strip that
    // would collapse distinct cuts.
    const ky = normalizeKyRecord({
      ky: '1',
      title: 'メルト(Short Ver.)',
      artist: 'supercell',
      crawledAt: CRAWLED_AT,
    });
    expect(ky.title_primary).toBe('メルト(Short Ver.)'); // suffix preserved
    const joy = {
      id: 'joysound-2',
      source_url: 'https://www.joysound.com/web/search/song/2',
      title_primary: 'メルト',
      title_ko: null,
      artist_primary: 'supercell',
      artist_ko: null,
      karaoke_numbers: { tj: null, ky: null, joysound: '2' },
      crawled_at: CRAWLED_AT,
    };
    const { records } = mergeRecords([ky, joy]);
    // NOT merged — two distinct cuts survive as two records.
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.id).sort()).toEqual(['joysound-2', 'ky-1']);
  });
});
