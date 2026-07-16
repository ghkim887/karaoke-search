import { validateSongRecord } from '@karaoke/schema';
import { describe, expect, it } from 'vitest';
import { kySourceUrl, normalizeKyRecord } from '../../../src/adapters/ky-kysing/normalizer.js';

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
});
