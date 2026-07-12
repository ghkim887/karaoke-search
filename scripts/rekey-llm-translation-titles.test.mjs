import { describe, expect, it } from 'vitest';
import {
  coreTitle,
  coresMatch,
  isDestructiveNullout,
  rekeyEntries,
} from './rekey-llm-translation-titles.mjs';

/** Minimal Stage-2 cache entry. */
function cacheEntry(overrides = {}) {
  return {
    id: 'tj-1',
    title_primary: 'x',
    title_ko: '가',
    media_context_ko: null,
    confidence: 'high',
    reasoning: 'r',
    web_sources: [],
    ...overrides,
  };
}

/** Minimal corpus record. */
function corpusRec(overrides = {}) {
  return {
    id: 'tj-1',
    title_primary: 'x',
    title_ko: null,
    title_ko_source: null,
    ...overrides,
  };
}

describe('coreTitle / coresMatch — positive (the observed drift classes)', () => {
  it('space-before-paren drift matches', () => {
    expect(coresMatch('マイフレンド (SLAM DUNK ED)', 'マイフレンド(SLAM DUNK ED)')).toBe(true);
  });

  it('tie-up paren present in corpus but absent in cache matches', () => {
    expect(coresMatch('ゆらめき', 'ゆらめき(日本一の男の魂 OP)')).toBe(true);
  });

  it('whitespace drift around an ASCII ~…~ subtitle bracket matches', () => {
    expect(
      coresMatch(
        'secret base~君がくれたもの~(あの日見た花の名前を僕達はまだ知らない ED)',
        'secret base ~君がくれたもの~(あの日見た花の名前を僕達はまだ知らない ED)',
      ),
    ).toBe(true);
  });

  it('whitespace drift around a non-ASCII wave-dash (∼ U+223C) subtitle bracket matches', () => {
    expect(
      coresMatch('ヴェル・エール∼空白の瞬間の中で∼', 'ヴェル・エール ∼空白の瞬間の中で∼'),
    ).toBe(true);
  });

  it('multiple/adjacent tie-up parens are all stripped', () => {
    expect(
      coresMatch(
        '勇者王誕生 (神話 Ver.)(勇者王ガオガイガー OP)',
        '勇者王誕生(神話 Ver.)(勇者王ガオガイガー OP)',
      ),
    ).toBe(true);
  });
});

describe('coreTitle / coresMatch — negative (must refuse to re-key)', () => {
  it('genuinely different songs (re-assigned blog id) do NOT match', () => {
    expect(coresMatch('My Dearest(ギルティクラウン OP)', 'さよならメモリーズ')).toBe(false);
  });

  it('a space INSIDE the base title (not adjacent to a paren/tilde) does NOT match', () => {
    // Conservative: collapse/trim only, never remove interior whitespace, so a
    // corpus row that inserted a mid-title space stays distinct.
    expect(coresMatch('君にこの声が届きますように', '君にこの声が 届きますように')).toBe(false);
  });

  it('a space inside a ~…~ bracket body (not adjacent to the tilde) does NOT match', () => {
    expect(
      coresMatch(
        'POISON~言いたい事も言えないこんな世の中は~',
        'POISON~言いたい事も 言えないこんな世の中は~',
      ),
    ).toBe(false);
  });

  it('a ♀/suffix variant does NOT match the bare title', () => {
    expect(coresMatch('うらたねこ', 'うらたねこ♀')).toBe(false);
  });

  it('two titles that are nothing but parentheticals (empty core) do NOT match', () => {
    expect(coreTitle('(A OP)')).toBe('');
    expect(coresMatch('(A OP)', '(B ED)')).toBe(false);
  });
});

describe('isDestructiveNullout', () => {
  it('flags a null cache decision over a non-manual existing title_ko', () => {
    expect(
      isDestructiveNullout(
        cacheEntry({ title_ko: null }),
        corpusRec({ title_ko: '가', title_ko_source: 'blog' }),
      ),
    ).toBe(true);
  });

  it('does NOT flag when the corpus title_ko is manual-sourced (merge-protected)', () => {
    expect(
      isDestructiveNullout(
        cacheEntry({ title_ko: null }),
        corpusRec({ title_ko: '가', title_ko_source: 'manual' }),
      ),
    ).toBe(false);
  });

  it('does NOT flag when the cache carries a translation', () => {
    expect(
      isDestructiveNullout(
        cacheEntry({ title_ko: '나' }),
        corpusRec({ title_ko: '가', title_ko_source: 'blog' }),
      ),
    ).toBe(false);
  });
});

describe('rekeyEntries', () => {
  it('re-keys a drifted entry, preserving every other field and key order', () => {
    const entries = [
      cacheEntry({
        id: 'tj-25003',
        title_primary: 'マイフレンド (SLAM DUNK ED)',
        title_ko: '마이 프렌드',
        media_context_ko: '(슬램덩크 ED)',
        confidence: 'high',
        reasoning: 'keep me',
        web_sources: ['https://x.test'],
      }),
    ];
    const byId = new Map([
      ['tj-25003', corpusRec({ id: 'tj-25003', title_primary: 'マイフレンド(SLAM DUNK ED)' })],
    ]);
    const before = structuredClone(entries[0]);
    const result = rekeyEntries(entries, byId);

    expect(result.rekeyed).toHaveLength(1);
    expect(result.held).toHaveLength(0);
    expect(result.remainder).toHaveLength(0);
    const out = result.entries[0];
    expect(out.title_primary).toBe('マイフレンド(SLAM DUNK ED)');
    // Every other field byte-preserved.
    for (const k of ['title_ko', 'media_context_ko', 'confidence', 'reasoning', 'web_sources']) {
      expect(out[k]).toEqual(before[k]);
    }
    // Key order unchanged (title_primary replaced in place).
    expect(Object.keys(out)).toEqual(Object.keys(before));
    // Input not mutated.
    expect(entries[0].title_primary).toBe('マイフレンド (SLAM DUNK ED)');
  });

  it('leaves a genuinely different (re-keyed blog id) song untouched, as remainder', () => {
    const entries = [
      cacheEntry({
        id: 'blog-442-6',
        title_primary: 'My Dearest(ギルティクラウン OP)',
        title_ko: '마이 디어리스트',
      }),
    ];
    const byId = new Map([
      [
        'blog-442-6',
        corpusRec({ id: 'blog-442-6', title_primary: 'さよならメモリーズ', title_ko: null }),
      ],
    ]);
    const result = rekeyEntries(entries, byId);
    expect(result.rekeyed).toHaveLength(0);
    expect(result.remainder.map((r) => r.id)).toEqual(['blog-442-6']);
    expect(result.entries[0]).toEqual(entries[0]);
  });

  it('HOLDS (does not re-key) an entry whose alignment would null a blog title_ko', () => {
    const entries = [
      cacheEntry({
        id: 'blog-537-16',
        title_primary: "It's all too much (カイジ人生逆転ゲーム 主題歌)",
        title_ko: null,
      }),
    ];
    const byId = new Map([
      [
        'blog-537-16',
        corpusRec({
          id: 'blog-537-16',
          title_primary: "It's all too much(カイジ人生逆転ゲーム 主題歌)",
          title_ko: '전부 너무해',
          title_ko_source: 'blog',
        }),
      ],
    ]);
    const result = rekeyEntries(entries, byId);
    expect(result.rekeyed).toHaveLength(0);
    expect(result.held.map((h) => h.id)).toEqual(['blog-537-16']);
    expect(result.entries[0]).toEqual(entries[0]);
  });

  it('re-keys a manual-sourced nullout (merge-protected, so alignment is inert)', () => {
    const entries = [
      cacheEntry({ id: 'tj-25863', title_primary: '冷たい海 (名探偵コナン ED)', title_ko: null }),
    ];
    const byId = new Map([
      [
        'tj-25863',
        corpusRec({
          id: 'tj-25863',
          title_primary: '冷たい海(名探偵コナン ED)',
          title_ko: '차가운 바다',
          title_ko_source: 'manual',
        }),
      ],
    ]);
    const result = rekeyEntries(entries, byId);
    expect(result.rekeyed.map((r) => r.id)).toEqual(['tj-25863']);
    expect(result.held).toHaveLength(0);
  });

  it('passes through a non-drifted entry and an id absent from the corpus', () => {
    const entries = [
      cacheEntry({ id: 'tj-1', title_primary: '愛' }),
      cacheEntry({ id: 'tj-ghost', title_primary: '幻' }),
    ];
    const byId = new Map([['tj-1', corpusRec({ id: 'tj-1', title_primary: '愛' })]]);
    const result = rekeyEntries(entries, byId);
    expect(result.rekeyed).toHaveLength(0);
    expect(result.remainder).toHaveLength(0);
    expect(result.held).toHaveLength(0);
    expect(result.entries).toEqual(entries);
  });

  it('is idempotent: a second pass re-keys nothing', () => {
    const entries = [
      cacheEntry({
        id: 'tj-25003',
        title_primary: 'マイフレンド (SLAM DUNK ED)',
        title_ko: '마이 프렌드',
      }),
    ];
    const byId = new Map([
      ['tj-25003', corpusRec({ id: 'tj-25003', title_primary: 'マイフレンド(SLAM DUNK ED)' })],
    ]);
    const first = rekeyEntries(entries, byId);
    const second = rekeyEntries(first.entries, byId);
    expect(first.rekeyed).toHaveLength(1);
    expect(second.rekeyed).toHaveLength(0);
    expect(JSON.stringify(second.entries)).toBe(JSON.stringify(first.entries));
  });
});
