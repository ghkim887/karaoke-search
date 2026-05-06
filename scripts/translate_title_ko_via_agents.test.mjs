import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyDecisionsToCorpus,
  chunkRecords,
  filterTranslatableRecords,
  loadAndValidateChunkOutputs,
  writeChunkInputs,
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

describe('writeChunkInputs', () => {
  let workdir;
  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'title-ko-stage2-'));
  });
  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it('writes one file per chunk with zero-padded NN', () => {
    const chunks = [
      [{ id: 'tj-1' }, { id: 'tj-2' }],
      [{ id: 'tj-3' }],
    ];
    writeChunkInputs(workdir, chunks);
    const files = readdirSync(workdir).sort();
    expect(files).toEqual([
      'llm-translations-chunk-00-input.json',
      'llm-translations-chunk-01-input.json',
    ]);
  });

  it('produces JSON arrays matching input chunks', () => {
    const chunks = [
      [{ id: 'tj-1', title_primary: 'X' }],
    ];
    writeChunkInputs(workdir, chunks);
    const written = JSON.parse(
      readFileSync(join(workdir, 'llm-translations-chunk-00-input.json'), 'utf-8'),
    );
    expect(written).toEqual([{ id: 'tj-1', title_primary: 'X' }]);
  });

  it('is byte-stable on identical input (idempotent)', () => {
    const chunks = [[{ id: 'tj-1' }]];
    writeChunkInputs(workdir, chunks);
    const first = readFileSync(join(workdir, 'llm-translations-chunk-00-input.json'));
    writeChunkInputs(workdir, chunks);
    const second = readFileSync(join(workdir, 'llm-translations-chunk-00-input.json'));
    expect(first.equals(second)).toBe(true);
  });
});

describe('loadAndValidateChunkOutputs', () => {
  let workdir;
  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'title-ko-merge-'));
  });
  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it('loads chunks and merges entries into a Map by id', () => {
    writeFileSync(
      join(workdir, 'llm-translations-chunk-00.json'),
      JSON.stringify([
        {
          id: 'tj-1',
          title_primary: 'X',
          title_ko: '엑스',
          media_context_ko: null,
          confidence: 'high',
          reasoning: 'r',
          web_sources: [],
        },
      ]),
    );
    writeFileSync(
      join(workdir, 'llm-translations-chunk-01.json'),
      JSON.stringify([
        {
          id: 'tj-2',
          title_primary: 'Y',
          title_ko: null,
          media_context_ko: null,
          confidence: 'low',
          reasoning: 'r',
          web_sources: [],
        },
      ]),
    );
    const result = loadAndValidateChunkOutputs(workdir);
    expect(result.size).toBe(2);
    expect(result.get('tj-1').confidence).toBe('high');
    expect(result.get('tj-2').title_ko).toBe(null);
  });

  it('throws when an entry is missing a required field', () => {
    writeFileSync(
      join(workdir, 'llm-translations-chunk-00.json'),
      JSON.stringify([{ id: 'tj-1' }]),
    );
    expect(() => loadAndValidateChunkOutputs(workdir)).toThrow(/missing/i);
  });

  it('throws on unknown confidence value', () => {
    writeFileSync(
      join(workdir, 'llm-translations-chunk-00.json'),
      JSON.stringify([
        {
          id: 'tj-1',
          title_primary: 'X',
          title_ko: '엑스',
          media_context_ko: null,
          confidence: 'super-high',
          reasoning: 'r',
          web_sources: [],
        },
      ]),
    );
    expect(() => loadAndValidateChunkOutputs(workdir)).toThrow(/confidence/i);
  });

  it('throws on duplicate id across chunks', () => {
    writeFileSync(
      join(workdir, 'llm-translations-chunk-00.json'),
      JSON.stringify([
        { id: 'tj-1', title_primary: 'X', title_ko: '엑스', media_context_ko: null, confidence: 'high', reasoning: 'r', web_sources: [] },
      ]),
    );
    writeFileSync(
      join(workdir, 'llm-translations-chunk-01.json'),
      JSON.stringify([
        { id: 'tj-1', title_primary: 'X', title_ko: '엑스2', media_context_ko: null, confidence: 'high', reasoning: 'r', web_sources: [] },
      ]),
    );
    expect(() => loadAndValidateChunkOutputs(workdir)).toThrow(/duplicate/i);
  });
});

describe('applyDecisionsToCorpus', () => {
  it('sets title_ko, media_context_ko, source, confidence on decided records', () => {
    const records = [
      { id: 'tj-1', title_ko: null, title_primary: '愛', artist_primary: 'A' },
    ];
    const decisions = new Map([
      [
        'tj-1',
        {
          id: 'tj-1',
          title_primary: '愛',
          title_ko: '사랑',
          media_context_ko: '(진격의 거인 OP)',
          confidence: 'high',
          reasoning: 'r',
          web_sources: [],
        },
      ],
    ]);
    const out = applyDecisionsToCorpus(records, decisions);
    expect(out[0].title_ko).toBe('사랑');
    expect(out[0].media_context_ko).toBe('(진격의 거인 OP)');
    expect(out[0].title_ko_source).toBe('llm-translated');
    expect(out[0].title_ko_confidence).toBe('high');
  });

  it('skips records the decisions Map does not cover', () => {
    const records = [{ id: 'blog-1', title_ko: '엑스', title_primary: 'X' }];
    const out = applyDecisionsToCorpus(records, new Map());
    expect(out[0]).toEqual({ id: 'blog-1', title_ko: '엑스', title_primary: 'X' });
  });

  it('omits media_context_ko key when decision has null value', () => {
    const records = [{ id: 'tj-1', title_ko: null, title_primary: '愛' }];
    const decisions = new Map([
      [
        'tj-1',
        {
          id: 'tj-1',
          title_primary: '愛',
          title_ko: '사랑',
          media_context_ko: null,
          confidence: 'high',
          reasoning: 'r',
          web_sources: [],
        },
      ],
    ]);
    const out = applyDecisionsToCorpus(records, decisions);
    expect(out[0]).not.toHaveProperty('media_context_ko');
  });

  it('does not set title_ko_source when title_ko stays null (low-confidence)', () => {
    const records = [{ id: 'tj-1', title_ko: null, title_primary: '愛' }];
    const decisions = new Map([
      [
        'tj-1',
        {
          id: 'tj-1',
          title_primary: '愛',
          title_ko: null,
          media_context_ko: null,
          confidence: 'low',
          reasoning: 'unknown song',
          web_sources: [],
        },
      ],
    ]);
    const out = applyDecisionsToCorpus(records, decisions);
    expect(out[0].title_ko).toBe(null);
    expect(out[0]).not.toHaveProperty('title_ko_source');
    expect(out[0]).not.toHaveProperty('title_ko_confidence');
  });
});
