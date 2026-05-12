import { describe, expect, it } from 'vitest';
import { applyManualFixesToCorpus } from './apply-manual-title-ko-fixes.mjs';

function baseRecord(overrides = {}) {
  return {
    id: 'tj-1',
    source_url: 'https://x.test/1',
    title_primary: '愛',
    title_ko: null,
    artist_primary: 'A',
    artist_ko: null,
    karaoke_numbers: { tj: '1', ky: null, joysound: null },
    categories: ['jpop'],
    crawled_at: '2026-05-06T00:00:00.000Z',
    ...overrides,
  };
}

describe('applyManualFixesToCorpus', () => {
  it('applies a fix when id and title_primary match', () => {
    const records = [baseRecord()];
    const fixes = [{ id: 'tj-1', title_primary: '愛', title_ko: '사랑' }];
    const result = applyManualFixesToCorpus(records, fixes);
    expect(result.applied).toBe(1);
    expect(result.notFound).toBe(0);
    expect(result.titleMismatch).toBe(0);
    expect(result.records[0].title_ko).toBe('사랑');
    expect(result.records[0].title_ko_source).toBe('manual');
    expect(result.records[0]).not.toHaveProperty('title_ko_confidence');
  });

  it('applies a fix across NFKC-equivalent CJK Compatibility Ideographs', () => {
    // Same render, different code point: U+F90A (compat) vs U+91D1 (canonical)
    // for 金. `===` returns false but NFKC normalizes them equal.
    const corpusTitle = `白\u{F90A}ディスコ`;
    const fixTitle = `白\u{91D1}ディスコ`;
    const records = [baseRecord({ title_primary: corpusTitle })];
    const fixes = [{ id: 'tj-1', title_primary: fixTitle, title_ko: '백금 디스코' }];
    const result = applyManualFixesToCorpus(records, fixes);
    expect(result.applied).toBe(1);
    expect(result.titleMismatch).toBe(0);
    expect(result.records[0].title_ko).toBe('백금 디스코');
    expect(result.records[0].title_ko_source).toBe('manual');
  });

  it('skips with notFound when the record id is absent from the corpus', () => {
    const records = [baseRecord()];
    const fixes = [{ id: 'tj-missing', title_primary: '愛', title_ko: '사랑' }];
    const result = applyManualFixesToCorpus(records, fixes);
    expect(result.applied).toBe(0);
    expect(result.notFound).toBe(1);
    expect(result.titleMismatch).toBe(0);
    expect(result.records[0]).toEqual(records[0]);
  });

  it('skips with titleMismatch when title_primary is not NFKC-equal', () => {
    const records = [baseRecord({ title_primary: 'NewTitle' })];
    const fixes = [{ id: 'tj-1', title_primary: 'OldTitle', title_ko: '낡은 제목' }];
    const result = applyManualFixesToCorpus(records, fixes);
    expect(result.applied).toBe(0);
    expect(result.titleMismatch).toBe(1);
    expect(result.notFound).toBe(0);
    expect(result.records[0].title_ko).toBe(null);
    expect(result.records[0]).not.toHaveProperty('title_ko_source');
  });

  it('preserves canonical key order (crawled_at, media_context_ko, title_ko_source)', () => {
    const records = [baseRecord({ media_context_ko: '(에어 OP)' })];
    const fixes = [{ id: 'tj-1', title_primary: '愛', title_ko: '사랑' }];
    const result = applyManualFixesToCorpus(records, fixes);
    const keys = Object.keys(result.records[0]);
    const crawledAtIdx = keys.indexOf('crawled_at');
    const mediaIdx = keys.indexOf('media_context_ko');
    const sourceIdx = keys.indexOf('title_ko_source');
    expect(crawledAtIdx).toBeGreaterThanOrEqual(0);
    expect(mediaIdx).toBe(crawledAtIdx + 1);
    expect(sourceIdx).toBe(mediaIdx + 1);
    expect(keys).not.toContain('title_ko_confidence');
  });

  it('is idempotent on a second pass (byte-equal serialisation)', () => {
    const records = [baseRecord(), baseRecord({ id: 'tj-2', title_primary: '光' })];
    const fixes = [
      { id: 'tj-1', title_primary: '愛', title_ko: '사랑' },
      { id: 'tj-2', title_primary: '光', title_ko: '빛' },
    ];
    const first = applyManualFixesToCorpus(records, fixes);
    const second = applyManualFixesToCorpus(first.records, fixes);
    expect(JSON.stringify(second.records)).toBe(JSON.stringify(first.records));
    expect(second.applied).toBe(2);
  });

  it('drops title_ko_confidence on records that previously carried one', () => {
    // Cross-field constraint: confidence is only valid with source='llm-translated'.
    // A record promoted from llm-translated to manual must shed the confidence tag.
    const records = [
      baseRecord({
        title_ko: 'old-translation',
        title_ko_source: 'llm-translated',
        title_ko_confidence: 'medium',
      }),
    ];
    const fixes = [{ id: 'tj-1', title_primary: '愛', title_ko: '사랑' }];
    const result = applyManualFixesToCorpus(records, fixes);
    expect(result.applied).toBe(1);
    expect(result.records[0].title_ko).toBe('사랑');
    expect(result.records[0].title_ko_source).toBe('manual');
    expect(result.records[0]).not.toHaveProperty('title_ko_confidence');
  });
});
