import { describe, expect, it } from 'vitest';
import {
  filterTranslatableRecords,
  chunkRecords,
} from './translate_title_ko_via_agents.mjs';

describe('filterTranslatableRecords', () => {
  it('keeps records with null title_ko and CJK in title_primary', () => {
    const records = [
      { id: 'tj-1', title_ko: null, title_primary: '愛が見えない' },
    ];
    expect(filterTranslatableRecords(records)).toHaveLength(1);
  });

  it('drops records with non-null title_ko', () => {
    const records = [
      { id: 'blog-1', title_ko: '엑스', title_primary: 'X' },
    ];
    expect(filterTranslatableRecords(records)).toHaveLength(0);
  });

  it('drops records with pure-Latin title_primary', () => {
    const records = [
      { id: 'tj-1', title_ko: null, title_primary: 'Bloomin' },
    ];
    expect(filterTranslatableRecords(records)).toHaveLength(0);
  });

  it('keeps records with hiragana, katakana, or kanji', () => {
    const records = [
      { id: 'tj-1', title_ko: null, title_primary: 'おもかげ' },     // hiragana
      { id: 'tj-2', title_ko: null, title_primary: 'コイシイヒト' }, // katakana
      { id: 'tj-3', title_ko: null, title_primary: '冬のリヴィエラ' }, // kanji+kana
    ];
    expect(filterTranslatableRecords(records)).toHaveLength(3);
  });

  it('drops records that already have a title_ko_source', () => {
    const records = [
      { id: 'tj-1', title_ko: null, title_primary: '愛', title_ko_source: 'llm-translated' },
    ];
    expect(filterTranslatableRecords(records)).toHaveLength(0);
  });
});

describe('chunkRecords', () => {
  it('splits into chunks of the requested size', () => {
    const records = Array.from({ length: 1050 }, (_, i) => ({ id: `tj-${i}` }));
    const chunks = chunkRecords(records, 500);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(500);
    expect(chunks[1]).toHaveLength(500);
    expect(chunks[2]).toHaveLength(50);
  });

  it('returns an empty array when input is empty', () => {
    expect(chunkRecords([], 500)).toEqual([]);
  });

  it('returns one chunk when input is smaller than chunk size', () => {
    const records = [{ id: 'tj-1' }, { id: 'tj-2' }];
    expect(chunkRecords(records, 500)).toEqual([records]);
  });

  it('preserves record order across chunks', () => {
    const records = Array.from({ length: 7 }, (_, i) => ({ id: `tj-${i}` }));
    const chunks = chunkRecords(records, 3);
    expect(chunks.flat().map((r) => r.id)).toEqual([
      'tj-0', 'tj-1', 'tj-2', 'tj-3', 'tj-4', 'tj-5', 'tj-6',
    ]);
  });
});
